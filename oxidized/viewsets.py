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
from .serializers import OxidizedConnectionSerializer, OxidizedNodeLinkSerializer
from .sync import sync_nodes

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
        summary = sync_nodes(self.get_object())
        return Response(summary, status=502 if summary["error"] else 200)

    @action(detail=True, methods=["get"])
    def unmatched(self, request, pk=None):
        """The nodes the last sync could not pair with a device, and why."""
        s = self.get_object().last_sync_summary or {}
        return Response({
            "results": s.get("unmatched") or [],
            "count": s.get("unmatched_count") or 0,
        })


class OxidizedNodeLinkViewSet(IntegrationToggleMixin, TenantScopedViewSet):
    """The mapping table: list, pin a node to a device, unlink."""

    integration_keys = ("oxidized",)
    http_method_names = ["get", "post", "delete", "head", "options"]
    queryset = OxidizedNodeLink.objects.select_related(
        "device", "virtual_machine", "connection"
    ).order_by("full_name")
    serializer_class = OxidizedNodeLinkSerializer

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
        return list(
            OxidizedNodeLink.objects.filter(
                tenant=tenant, **{self.link_field: obj},
                connection__tenant=tenant, connection__enabled=True,
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
