"""The Oxidized API surface (#35).

Connections and links are ordinary RBAC object types, and the whole surface
404s while the tenant's Oxidized switch is off.

The device and virtual-machine endpoints are the ones that return
configuration text, and they need ``view_config`` on the object - a capability
verb no built-in group holds, because a running config carries SNMP
communities, password hashes and keys. ``view`` alone shows that a node
exists, never what it says. A virtual router is a VM (#384), so the VM
endpoints mirror the device ones with ``virtualmachine.view_config``.
"""
from __future__ import annotations

import re

from django.utils import timezone
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import (
    OpenApiParameter,
    OpenApiResponse,
    extend_schema,
    extend_schema_view,
    inline_serializer,
)
from rest_framework import serializers
from rest_framework.decorators import action
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from api.models import Device, VirtualMachine
from api.views import _get_active_tenant
from api.viewsets import TenantScopedViewSet
from auth_api import rbac
from integrations.toggles import IntegrationToggleMixin, integration_enabled

from . import configs
from .client import (
    OxidizedClient,
    OxidizedError,
    OxidizedNotFound,
    OxidizedTooLarge,
    OxidizedUnreachable,
)
from .models import OxidizedConnection, OxidizedNodeLink
from .serializers import (
    OxidizedConnectionSerializer,
    OxidizedNodeLinkSerializer,
    require_connection_change,
)
from .sync import reasons_for, remember_unlinked, sync_nodes

OID = re.compile(r"^[0-9a-f]{4,64}$")


class OxidizedConnectionViewSet(IntegrationToggleMixin, TenantScopedViewSet):
    integration_keys = ("oxidized",)
    queryset = OxidizedConnection.objects.all().order_by("name")
    serializer_class = OxidizedConnectionSerializer

    @action(detail=True, methods=["post"])
    def test(self, request, pk=None):
        """Reach oxidized-web and count its nodes. Records what it learned."""
        conn = self.get_object()
        result = {"ok": False, "detail": "", "nodes": None}
        try:
            nodes = OxidizedClient.for_connection(conn).nodes()
            result.update(ok=True, nodes=len(nodes), detail=(
                f"Connected - {len(nodes)} node{'' if len(nodes) == 1 else 's'}."
            ))
            conn.node_count = len(nodes)
            conn.last_error = ""
        except OxidizedUnreachable as exc:
            result["detail"] = f"Could not reach {conn.url}: {exc}"
            conn.last_error = result["detail"][:500]
        except OxidizedError as exc:
            result["detail"] = str(exc)
            conn.last_error = result["detail"][:500]
        conn.last_checked_at = timezone.now()
        conn.save(update_fields=["node_count", "last_error", "last_checked_at", "updated_at"])
        return Response(result, status=200 if result["ok"] else 502)

    @action(detail=True, methods=["post"])
    def sync(self, request, pk=None):
        """Read the node list now and re-match every link that is not pinned."""
        conn = self.get_object()
        summary = sync_nodes(conn)
        summary = {
            **summary,
            "unmatched": reasons_for(summary.get("unmatched"), request.user, conn.tenant),
            "warnings": reasons_for(summary.get("warnings"), request.user, conn.tenant),
        }
        return Response(summary, status=502 if summary["error"] else 200)

    @action(detail=True, methods=["get"])
    def unmatched(self, request, pk=None):
        """The nodes the last sync could not pair with a device, and why;
        ``warnings`` lists the links it kept despite namesakes (#400)."""
        conn = self.get_object()
        s = conn.last_sync_summary or {}
        # A reason names a device or VM only for a caller who can view it.
        return Response({
            "results": reasons_for(s.get("unmatched"), request.user, conn.tenant),
            "count": s.get("unmatched_count") or 0,
            "warnings": reasons_for(s.get("warnings"), request.user, conn.tenant),
            "warning_count": s.get("warning_count") or 0,
        })


class OxidizedNodeLinkViewSet(IntegrationToggleMixin, TenantScopedViewSet):
    """The mapping table: list, pin a node to a device, unlink."""

    integration_keys = ("oxidized",)
    http_method_names = ["get", "post", "delete", "head", "options"]
    queryset = OxidizedNodeLink.objects.select_related(
        "device", "virtual_machine", "connection"
    ).order_by("full_name")
    serializer_class = OxidizedNodeLinkSerializer
    #: Confirming a proposed link is a pin in effect.
    rbac_action_map = {"confirm": "add"}

    def get_queryset(self):
        qs = super().get_queryset()
        params = self.request.query_params if self.request else {}
        if params.get("connection"):
            qs = qs.filter(connection_id=params["connection"])
        if params.get("device"):
            qs = qs.filter(device_id=params["device"])
        if params.get("virtual_machine"):
            qs = qs.filter(virtual_machine_id=params["virtual_machine"])
        return qs

    def perform_destroy(self, instance):
        """Unlinking needs ``change`` on the connection, like pinning (#386).
        The node remembers where it pointed, so a later pin is judged as a
        move from there (#398)."""
        require_connection_change(self.request.user, instance.connection)
        remember_unlinked([instance])
        super().perform_destroy(instance)

    @action(detail=True, methods=["post"])
    def confirm(self, request, pk=None):
        """Confirm a link the sync proposed (#399). Held to the rules of
        pinning the node to that object by hand: ``change`` on the connection,
        ``add`` on the link in its site, and no config the confirmer could not
        already read."""
        link = self.get_object()
        user, conn = request.user, link.connection
        if not rbac.restrict_queryset(
            OxidizedNodeLink.objects.filter(pk=link.pk), user, conn.tenant,
            "oxidizednodelink", "add",
        ).exists():
            raise NotFound("No such link.")
        require_connection_change(user, conn)
        if not link.proposed:
            raise ValidationError({"detail": "This link is not proposed."})
        slug = "device" if link.device_id else "virtualmachine"
        if not rbac.can_act_on(user, conn.tenant, slug, "view", link.target):
            raise NotFound("No such link.")
        OxidizedNodeLinkSerializer._check_pin_scope(
            user, conn, link.full_name, link.target, slug
        )
        link.proposed = False
        link.save(update_fields=["proposed", "updated_at"])
        return Response(self.get_serializer(link).data)


# ─── a device's or a virtual machine's configuration ─────────────────────────


class _DeviceConfigView(APIView):
    """Shared gate for every endpoint that returns configuration text.

    Order matters: tenant, integration switch, the object visible to this
    user (404 otherwise, so a foreign or hidden object is indistinguishable
    from a missing one), then ``view_config`` on that object (403).

    Subclassed per object kind: devices here, virtual machines through
    :class:`_VmConfig`. The URL captures the object as ``obj_id``.
    """

    permission_classes = [IsAuthenticated]
    model = Device
    slug = "device"
    link_field = "device"
    noun = "device"

    def _device(self, request, obj_id):
        tenant = _get_active_tenant(request)
        if tenant is None or not integration_enabled(tenant, "oxidized"):
            raise NotFound("Integration not enabled.")
        qs = rbac.restrict_queryset(
            self.model.objects.filter(tenant=tenant), request.user, tenant, self.slug, "view"
        )
        obj = qs.filter(pk=obj_id).first()
        if obj is None:
            raise NotFound(f"No such {self.noun}.")
        if not rbac.can_act_on(request.user, tenant, self.slug, "view_config", obj):
            raise PermissionDenied(
                f"Viewing {self.noun} configurations needs the view config permission "
                f"on {self.noun}s."
            )
        return tenant, obj

    def _links(self, tenant, obj):
        # A proposed link serves nothing until it is confirmed (#399).
        return list(
            OxidizedNodeLink.objects.filter(
                tenant=tenant, **{self.link_field: obj},
                connection__tenant=tenant, connection__enabled=True, proposed=False,
            ).select_related("connection").order_by("connection__name")
        )

    def _link(self, request, obj_id):
        tenant, obj = self._device(request, obj_id)
        links = self._links(tenant, obj)
        wanted = request.query_params.get("link") or (request.data or {}).get("link")
        if wanted:
            link = next((lk for lk in links if str(lk.id) == str(wanted)), None)
        else:
            link = links[0] if links else None
        if link is None:
            raise NotFound(f"This {self.noun} has no Oxidized node.")
        return link

    @staticmethod
    def _fail(exc: OxidizedError) -> Response:
        if isinstance(exc, OxidizedNotFound):
            return Response({"detail": f"Oxidized: {exc}"}, status=404)
        if isinstance(exc, OxidizedTooLarge):
            return Response({"detail": str(exc)}, status=413)
        return Response({"detail": f"Oxidized: {exc}"}, status=502)


class _VmConfig:
    """Mixin: the same endpoints, for a virtual machine (#384)."""

    model = VirtualMachine
    slug = "virtualmachine"
    link_field = "virtual_machine"
    noun = "virtual machine"


def _link_payload(link) -> dict:
    return {
        "id": str(link.id),
        "connection": str(link.connection_id),
        "connection_name": link.connection.name,
        "full_name": link.full_name,
        "node_ip": link.node_ip,
        "node_model": link.node_model,
        "matched_by": link.matched_by,
        "last_seen_at": link.last_seen_at.isoformat() if link.last_seen_at else None,
    }


class DeviceNodesView(_DeviceConfigView):
    """Which Oxidized nodes back this device. No config text."""

    def get(self, request, obj_id):
        tenant, obj = self._device(request, obj_id)
        return Response({"links": [_link_payload(lk) for lk in self._links(tenant, obj)]})


class DeviceConfigView(_DeviceConfigView):
    """The configuration Oxidized holds now. ``?refresh=1`` skips the cache."""

    def get(self, request, obj_id):
        link = self._link(request, obj_id)
        refresh = request.query_params.get("refresh") in ("1", "true")
        try:
            text, cached = configs.current(link, refresh=refresh)
        except OxidizedError as exc:
            return self._fail(exc)
        return Response({
            "link": _link_payload(link),
            "config": text,
            "bytes": len(text.encode()),
            "lines": text.count("\n") + (0 if text.endswith("\n") or not text else 1),
            "cached": cached,
        })


class DeviceVersionsView(_DeviceConfigView):
    """The node's git history in Oxidized, newest first."""

    def get(self, request, obj_id):
        link = self._link(request, obj_id)
        refresh = request.query_params.get("refresh") in ("1", "true")
        try:
            rows, cached = configs.versions(link, refresh=refresh)
        except OxidizedError as exc:
            # The file output keeps no history; that is not an outage.
            return Response({"results": [], "history": False, "detail": str(exc)[:300]})
        return Response({"results": rows, "history": True, "cached": cached})


class DeviceVersionView(_DeviceConfigView):
    """One version's text."""

    def get(self, request, obj_id, oid):
        if not OID.match(oid):
            raise ValidationError({"oid": "Not a commit id."})
        link = self._link(request, obj_id)
        try:
            text, cached = configs.version(link, oid)
        except OxidizedError as exc:
            return self._fail(exc)
        return Response({"oid": oid, "config": text, "cached": cached})


class DeviceDiffView(_DeviceConfigView):
    """A unified diff between two versions, or a version and the current
    config (``to=current``)."""

    def get(self, request, obj_id):
        old, new = request.query_params.get("from", ""), request.query_params.get("to", "")
        for name, value in (("from", old), ("to", new)):
            if value != "current" and not OID.match(value):
                raise ValidationError({name: "A commit id, or current."})
        link = self._link(request, obj_id)

        def text(ref):
            return configs.current(link)[0] if ref == "current" else configs.version(link, ref)[0]

        try:
            a, b = text(old), text(new)
        except OxidizedError as exc:
            return self._fail(exc)
        def label(ref):
            return ref if ref == "current" else ref[:12]

        diff = configs.unified_diff(a, b, label(old), label(new))
        return Response({"from": old, "to": new, **diff})


class DeviceFetchNowView(_DeviceConfigView):
    """Ask Oxidized to back this node up next (``/node/next``).

    Gated on ``view_config`` like the reads: it changes nothing but the order
    of Oxidized's queue, and the person asking is the one waiting to read it.
    """

    def post(self, request, obj_id):
        link = self._link(request, obj_id)
        try:
            OxidizedClient.for_connection(link.connection).next(
                link.node_name, link.node_group,
                user=request.user.get_username(), msg="Requested from Danbyte",
            )
        except OxidizedError as exc:
            return self._fail(exc)
        configs.forget(link)
        return Response({"queued": True})


class VmNodesView(_VmConfig, DeviceNodesView):
    pass


class VmConfigView(_VmConfig, DeviceConfigView):
    pass


class VmVersionsView(_VmConfig, DeviceVersionsView):
    pass


class VmVersionView(_VmConfig, DeviceVersionView):
    pass


class VmDiffView(_VmConfig, DeviceDiffView):
    pass


class VmFetchNowView(_VmConfig, DeviceFetchNowView):
    pass


# ─── OpenAPI ──────────────────────────────────────────────────────────────────
# The config views are plain APIViews, so the schema is spelled out here once
# and applied to the device and the VM class of each endpoint.

_LINK = inline_serializer(
    name="OxidizedConfigLink",
    fields={
        "id": serializers.UUIDField(),
        "connection": serializers.UUIDField(),
        "connection_name": serializers.CharField(),
        "full_name": serializers.CharField(),
        "node_ip": serializers.CharField(allow_blank=True),
        "node_model": serializers.CharField(allow_blank=True),
        "matched_by": serializers.CharField(),
        "last_seen_at": serializers.DateTimeField(allow_null=True),
    },
)
_NODES = inline_serializer(
    name="OxidizedNodes", fields={"links": serializers.ListField(child=_LINK)}
)
_CONFIG = inline_serializer(
    name="OxidizedConfig",
    fields={
        "link": _LINK,
        "config": serializers.CharField(),
        "bytes": serializers.IntegerField(),
        "lines": serializers.IntegerField(),
        "cached": serializers.BooleanField(),
    },
)
_VERSIONS = inline_serializer(
    name="OxidizedVersions",
    fields={
        "results": serializers.ListField(child=serializers.DictField()),
        "history": serializers.BooleanField(),
        "cached": serializers.BooleanField(required=False),
        "detail": serializers.CharField(required=False),
    },
)
_VERSION = inline_serializer(
    name="OxidizedVersion",
    fields={
        "oid": serializers.CharField(),
        "config": serializers.CharField(),
        "cached": serializers.BooleanField(),
    },
)
_QUEUED = inline_serializer(
    name="OxidizedFetchNow", fields={"queued": serializers.BooleanField()}
)
_ERR = OpenApiResponse(response=OpenApiTypes.OBJECT, description="``{detail}``")
_LINK_PARAM = OpenApiParameter(
    "link", OpenApiTypes.UUID, description="Which node link, when there are several.",
)
_REFRESH = OpenApiParameter(
    "refresh", OpenApiTypes.BOOL, description="Skip the cache and ask Oxidized.",
)
_ERRORS = {
    403: OpenApiResponse(description="Needs view config on the object."),
    404: _ERR,
    502: _ERR,
}


def _document(view, kind: str, noun: str) -> None:
    """Attach the schema for one config endpoint class (device or VM)."""
    key = "devices" if kind == "device" else "virtual_machines"
    specs = {
        DeviceNodesView: ("get", "nodes", f"Oxidized nodes linked to a {noun}",
                          {200: _NODES, 404: _ERR}, []),
        DeviceConfigView: ("get", "config", f"A {noun}'s current configuration",
                           {200: _CONFIG, 413: _ERR, **_ERRORS}, [_LINK_PARAM, _REFRESH]),
        DeviceVersionsView: ("get", "versions_list", f"A {noun}'s configuration history",
                             {200: _VERSIONS, **_ERRORS}, [_LINK_PARAM, _REFRESH]),
        DeviceVersionView: ("get", "version", f"One version of a {noun}'s configuration",
                            {200: _VERSION, 400: _ERR, 413: _ERR, **_ERRORS}, [_LINK_PARAM]),
        DeviceDiffView: (
            "get", "diff", f"Diff two versions of a {noun}'s configuration",
            {200: OpenApiTypes.OBJECT, 400: _ERR, 413: _ERR, **_ERRORS},
            [
                OpenApiParameter("from", str, required=True,
                                 description="A commit id, or current."),
                OpenApiParameter("to", str, required=True,
                                 description="A commit id, or current."),
                _LINK_PARAM,
            ],
        ),
        DeviceFetchNowView: ("post", "fetch_now", f"Ask Oxidized to back up a {noun} next",
                             {200: _QUEUED, **_ERRORS}, []),
    }
    base = next(b for b in view.__mro__ if b in specs)
    method, op, summary, responses, params = specs[base]
    extend_schema_view(**{method: extend_schema(
        operation_id=f"oxidized_{key}_{op}",
        summary=summary,
        tags=["oxidized"],
        request=None,
        responses=responses,
        parameters=params,
    )})(view)


for _view in (DeviceNodesView, DeviceConfigView, DeviceVersionsView,
              DeviceVersionView, DeviceDiffView, DeviceFetchNowView):
    _document(_view, "device", "device")
for _view in (VmNodesView, VmConfigView, VmVersionsView,
              VmVersionView, VmDiffView, VmFetchNowView):
    _document(_view, "vm", "virtual machine")
