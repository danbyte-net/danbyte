"""The PRTG API surface.

Every viewset carries ``integration_keys = ("prtg",)`` so the whole surface
404s while the tenant switch is off - a disabled integration is invisible, not
merely inert. The push receiver (:mod:`prtg.hook`) is the one exception: it
has no session and checks the switch itself.
"""
from __future__ import annotations

import uuid

from django.db.models import Case, Count, IntegerField, Max, Q, Value, When
from django.db.models.functions import Coalesce
from django.utils import timezone
from drf_spectacular.utils import extend_schema, inline_serializer
from rest_framework import serializers
from rest_framework.decorators import action
from rest_framework.exceptions import (
    MethodNotAllowed,
    NotFound,
    PermissionDenied,
    ValidationError,
)
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from api.models import Device, IPAddress, VirtualMachine
from api.views import _get_active_tenant
from api.viewsets import TenantScopedReadViewSet, TenantScopedViewSet
from auth_api import rbac
from integrations.toggles import IntegrationToggleMixin, integration_enabled
from monitoring.external.queue import ChangeQueueMixin

from . import status as st
from .models import (
    PrtgAdoptionRule,
    PrtgChange,
    PrtgConnection,
    PrtgDeviceLink,
    PrtgRetireRule,
    PrtgSensor,
)
from .serializers import (
    PrtgAdoptionRuleSerializer,
    PrtgChangeSerializer,
    PrtgConnectionSerializer,
    PrtgDefaultsSerializer,
    PrtgDeviceLinkSerializer,
    PrtgRetireRuleSerializer,
    PrtgSensorSerializer,
)

_TestResult = inline_serializer("PrtgTestResult", fields={
    "ok": serializers.BooleanField(),
    "detail": serializers.CharField(),
    "version": serializers.CharField(),
    "probes": serializers.IntegerField(allow_null=True),
    "sensors": serializers.IntegerField(allow_null=True),
    "v2_available": serializers.BooleanField(allow_null=True),
    "v2_detail": serializers.CharField(),
})

_HookToken = inline_serializer("PrtgHookToken", fields={
    "token": serializers.CharField(),
    "path": serializers.CharField(),
})


def _uuid(value, field: str) -> str:
    try:
        return str(uuid.UUID(str(value)))
    except ValueError:
        raise ValidationError({field: "Not an id."}) from None


class _ByConnection:
    """``?connection=<id>`` narrows a list to one connection."""

    def get_queryset(self):
        qs = super().get_queryset()
        conn = self.request.query_params.get("connection") if self.request else None
        return qs.filter(connection_id=conn) if conn else qs


class PrtgConnectionViewSet(IntegrationToggleMixin, TenantScopedViewSet):
    integration_keys = ("prtg",)
    queryset = PrtgConnection.objects.select_related(
        "adopt_site", "adopt_role", "adopt_device_type"
    ).order_by("name")
    serializer_class = PrtgConnectionSerializer

    @action(detail=False, methods=["get"])
    def defaults(self, request):
        """Status codes, their default states and the states they may map
        onto, so the form hard-codes neither PRTG's codes nor Danbyte's."""
        return Response(PrtgDefaultsSerializer.payload(_get_active_tenant(request)))

    @extend_schema(request=None, responses={200: _TestResult, 502: _TestResult})
    @action(detail=True, methods=["post"])
    def test(self, request, pk=None):
        """Reach PRTG and describe it: version, probes, sensors, API v2.
        Records what it learned on the connection."""
        from .connection import test_connection

        result = test_connection(self.get_object())
        return Response(result, status=200 if result["ok"] else 502)

    @action(detail=True, methods=["post"], url_path="status-now")
    def status_now(self, request, pk=None):
        """Read PRTG now: devices, sensors, links, roll-ups. The same pass the
        beat runs, so the button and the timer cannot drift apart."""
        from .client import PrtgError
        from .reader import _stamp, read_status

        conn = self.get_object()
        if not conn.api_key_set:
            return Response({"detail": "No API key is set."}, status=400)
        now = timezone.now()
        try:
            counts = read_status(conn, now)
        except PrtgError as exc:
            _stamp(conn, now, error=str(exc))
            return Response({"detail": str(exc)[:300]}, status=502)
        _stamp(conn, now, summary=counts)
        return Response(counts)

    @action(detail=True, methods=["post"], url_path="maintenance-now")
    def maintenance_now(self, request, pk=None):
        """Reconcile the maintenance pauses now - the pass the beat and a
        changed window run."""
        from .client import PrtgError
        from .maintenance import reconcile

        conn = self.get_object()
        if not (conn.sync_maintenance and conn.api_key_set):
            return Response({"detail": "Maintenance sync is off."}, status=400)
        try:
            counts = reconcile(conn)
        except PrtgError as exc:
            return Response({"detail": str(exc)[:300]}, status=502)
        if counts.get("error"):
            return Response({"detail": counts["error"]}, status=502)
        return Response(counts)

    @action(detail=True, methods=["post"], url_path="plan-now")
    def plan_now(self, request, pk=None):
        """Work out what PRTG should have now and refresh the planned
        changes in the queue. Reads PRTG's devices and groups; writes
        nothing to PRTG."""
        from .client import PrtgError
        from .provision import plan, stamp

        conn = self.get_object()
        if not conn.api_key_set:
            return Response({"detail": "No API key is set."}, status=400)
        now = timezone.now()
        try:
            counts = plan(conn, now=now)
        except PrtgError as exc:
            stamp(conn, now, {"error": str(exc)[:300]})
            return Response({"detail": str(exc)[:300]}, status=502)
        stamp(conn, now, counts)
        return Response(counts)

    @action(detail=True, methods=["post"], url_path="check-writes")
    def check_writes(self, request, pk=None):
        """Ask PRTG what it can create through its API and keep the answer:
        ``{mode: v2 | seed | none, detail, version}``."""
        from .writer import check_writes

        conn = self.get_object()
        if not conn.api_key_set:
            return Response({"detail": "No API key is set."}, status=400)
        return Response(check_writes(conn))

    @action(detail=True, methods=["get"], url_path="prtg-devices")
    def prtg_devices(self, request, pk=None):
        """PRTG's devices, for the seed device picker: ``[{objid, name,
        host, group, paused}]``, read live."""
        from .client import PrtgError
        from .reader import client_for

        conn = self.get_object()
        if not conn.api_key_set:
            return Response([])
        try:
            rows = client_for(conn).devices().rows
        except PrtgError as exc:
            return Response({"detail": str(exc)[:300]}, status=502)
        return Response([
            {"objid": str(r["objid"]), "name": r.get("name", ""), "host": r.get("host", ""),
             "group": r.get("group", ""), "paused": r.get("status_raw") in st.PAUSED}
            for r in rows
        ])

    @action(detail=True, methods=["get"], url_path="layout-preview")
    def layout_preview(self, request, pk=None):
        """The group layout for up to 20 of the tenant's devices and VMs,
        from Danbyte's data and the last group list - nothing is asked of
        PRTG. ``?layout=`` ``&regions=`` ``&locations=`` ``&root=`` preview
        a setting before it is saved; each defaults to the stored one."""
        from .layout import preview, root_of

        conn = self.get_object()
        q = request.query_params
        layout = q.get("layout") or conn.group_layout
        if layout not in dict(PrtgConnection.GROUP_LAYOUT_CHOICES):
            return Response({"detail": "Unknown layout."}, status=400)

        def flag(name, stored):
            value = q.get(name)
            return stored if value is None else value in ("1", "true")

        if q.get("root") is not None:
            # Previewing an unsaved root; blank is the registration group.
            objid = q["root"].strip()
            if objid and not objid.isdigit():
                return Response({"detail": "A PRTG object id is a number."}, status=400)
            conn.layout_root_id = objid
            conn.layout_root_path = objid
        root = root_of(conn)
        tenant = conn.tenant
        devices = rbac.restrict_queryset(
            Device.objects.filter(tenant=tenant), request.user, tenant, "device", "view",
        ).select_related("site", "location", "role").order_by("site__name", "name")[:20]
        objects = list(devices)
        if len(objects) < 20:
            vms = rbac.restrict_queryset(
                VirtualMachine.objects.filter(tenant=tenant), request.user, tenant,
                "virtualmachine", "view",
            ).select_related("site", "cluster", "device", "role").order_by("name")
            objects.extend(vms[: 20 - len(objects)])
        return Response(preview(
            conn, objects, layout=layout,
            regions=flag("regions", conn.layout_regions),
            locations=flag("locations", conn.layout_locations), root=root,
        ))

    @action(detail=True, methods=["get"], url_path="credential-state")
    def credential_state(self, request, pk=None):
        """What PRTG has in effect for credential sections on a probe, group
        or device, read live: ``?objid=&kind=group|probe|device&sections=a,b``
        answers ``{objid, sections: {section: {set, inherited, source,
        text}}}``. Never a value."""
        from .credentials import describe, read_effective, section_label

        conn = self.get_object()
        objid = (request.query_params.get("objid") or "").strip()
        kind = request.query_params.get("kind") or "group"
        sections = [s for s in (request.query_params.get("sections") or "").split(",") if s]
        if not objid.isdigit() or kind not in ("group", "probe", "device") or not sections:
            return Response({"detail": "objid, kind and sections are needed."}, status=400)
        if not conn.api_key_set:
            return Response({"objid": objid, "sections": {}, "error": "No API key is set."})
        state = read_effective(conn, objid, kind, sections[:20])
        if state is None:
            return Response({"objid": objid, "sections": {},
                             "error": "PRTG did not answer through API v2."})
        return Response({"objid": objid, "sections": {
            name: {**value, "text": describe(value, section_label(name))}
            for name, value in state.items()
        }})

    @action(detail=True, methods=["get"], url_path="sensor-kinds")
    def sensor_kinds(self, request, pk=None):
        """The sensor kinds this PRTG offers to add by hand, cached for a
        day (``?refresh=1`` reads again; ``?link=`` names the device to ask
        about; without it the first linked device is): ``{mode, source,
        read_at, kinds: [{id, name, description, category, form,
        danbyte_form, danbyte_kind, scan, needs_scan, credential_group,
        copy_from_seed}], danbyte_forms}``."""
        from .actions import ActionError
        from .manual import catalog

        conn = self.get_object()
        link = None
        if request.query_params.get("link"):
            link = PrtgDeviceLink.objects.filter(
                connection=conn, pk=_uuid(request.query_params["link"], "link"),
            ).first()
        try:
            return Response(catalog(conn, link=link,
                                    refresh=request.query_params.get("refresh") in ("1", "true")))
        except ActionError as exc:
            return Response({"detail": exc.detail}, status=exc.status)

    @action(detail=True, methods=["get"], url_path="sensor-schema")
    def sensor_schema(self, request, pk=None):
        """PRTG's create form for one sensor kind (``?kind=``) at connection
        level, for the profile editor: ``{kind, fields, scan}``, kept a day
        (``?refresh=1`` reads again; ``?link=`` names the device to ask)."""
        from .actions import ActionError
        from .manual import connection_schema

        conn = self.get_object()
        kind = (request.query_params.get("kind") or "").strip()
        if not kind:
            raise ValidationError({"kind": "Which sensor kind?"})
        link = None
        if request.query_params.get("link"):
            link = PrtgDeviceLink.objects.filter(
                connection=conn, pk=_uuid(request.query_params["link"], "link"),
            ).first()
        try:
            return Response(connection_schema(
                conn, kind, link=link,
                refresh=request.query_params.get("refresh") in ("1", "true"),
            ))
        except ActionError as exc:
            return Response({"detail": exc.detail}, status=exc.status)

    @action(detail=True, methods=["get"], url_path="device-templates")
    def device_templates(self, request, pk=None):
        """PRTG's device templates for a discovery (API v2, cached for a
        day; ``?refresh=1``), or the stock ones when the list cannot be
        read: ``{source, read_at, templates: [{file_name, name}]}``."""
        from .actions import ActionError
        from .manual import templates

        conn = self.get_object()
        try:
            return Response(templates(
                conn, refresh=request.query_params.get("refresh") in ("1", "true"),
            ))
        except ActionError as exc:
            return Response({"detail": exc.detail}, status=exc.status)

    @extend_schema(request=None, responses={200: _HookToken})
    @action(detail=True, methods=["post"], url_path="rotate-hook-token")
    def rotate_hook_token(self, request, pk=None):
        """Make a new push token and return it - once. Only its hash is kept,
        so the old token stops working and the new one cannot be read back."""
        from .hook import new_token

        conn = self.get_object()
        token = new_token(conn)
        return Response({"token": token, "path": f"/api/prtg/hook/{token}/"})


class PrtgDeviceLinkViewSet(IntegrationToggleMixin, _ByConnection, TenantScopedViewSet):
    """Read-only: a link is made by matching. Deleting one says "that pairing
    is wrong"; the next pass matches the device from scratch. ``pause/`` and
    ``resume/`` pause or resume the PRTG device itself; ``sensors/``,
    ``scan/``, ``discover/`` and ``sensor-schema/`` add sensors to it by hand
    (:mod:`prtg.manual`) and need ``change`` on PRTG sensors."""

    integration_keys = ("prtg",)
    # Adding a sensor changes PRTG sensors, not the link: the link needs
    # view, the sensor grant is checked in the action.
    rbac_action_map = {"sensors": "view", "scan": "view", "discover": "view"}
    http_method_names = ["get", "post", "delete", "head", "options"]
    queryset = PrtgDeviceLink.objects.select_related(
        "device", "virtual_machine", "connection"
    ).order_by("name")
    serializer_class = PrtgDeviceLinkSerializer

    def get_queryset(self):
        qs = super().get_queryset()
        params = self.request.query_params if self.request else {}
        if params.get("device"):
            qs = qs.filter(device_id=params["device"])
        if params.get("virtual_machine"):
            qs = qs.filter(virtual_machine_id=params["virtual_machine"])
        return qs

    def create(self, request, *args, **kwargs):
        # POST is open for the actions only; links come from matching.
        raise MethodNotAllowed("POST")

    def _link_for_write(self, request):
        link = self.get_object()
        if not _parent_visible(request, _get_active_tenant(request), link):
            raise NotFound()
        if not link.connection.enabled or not link.connection.api_key_set:
            raise ValidationError({"detail": "The PRTG connection is off."})
        return link

    def _act(self, fn, *args, **kwargs):
        from .actions import ActionError

        try:
            link = fn(*args, **kwargs)
        except ActionError as exc:
            return Response({"detail": exc.detail}, status=exc.status)
        return Response(PrtgDeviceLinkSerializer(link, context={"request": self.request}).data)

    @extend_schema(
        request=inline_serializer("PrtgLinkPause", fields={
            "minutes": serializers.IntegerField(required=False, allow_null=True),
            "note": serializers.CharField(required=False, allow_blank=True),
        }),
        responses={200: PrtgDeviceLinkSerializer},
    )
    @action(detail=True, methods=["post"])
    def pause(self, request, pk=None):
        """Pause the PRTG device - and with it its sensors - for
        ``minutes``, or until resumed when ``minutes`` is empty."""
        from .actions import pause_link

        link = self._link_for_write(request)
        return self._act(
            pause_link, link, request.user, request.data.get("minutes"),
            str(request.data.get("note") or ""),
        )

    @extend_schema(request=None, responses={200: PrtgDeviceLinkSerializer})
    @action(detail=True, methods=["post"])
    def resume(self, request, pk=None):
        """Resume the PRTG device."""
        from .actions import resume_link

        link = self._link_for_write(request)
        return self._act(resume_link, link, request.user)

    # ── adding sensors by hand (prtg.manual) ─────────────────────────

    def _link_for_sensors(self, request):
        """The link a sensor is added to: ``change`` on PRTG sensors, view
        on the device or VM, and a connection that is on."""
        link = self._link_for_write(request)
        tenant = _get_active_tenant(request)
        if not rbac.has_action(request.user, tenant, "prtgsensor", "change"):
            raise PermissionDenied("Adding sensors needs the change permission on PRTG sensors.")
        return link

    @staticmethod
    def _manual(fn, *args, **kwargs):
        from .actions import ActionError

        try:
            return fn(*args, **kwargs), None
        except ActionError as exc:
            body = {"detail": exc.detail}
            if getattr(exc, "fields", None):
                body["fields"] = exc.fields
            return None, Response(body, status=exc.status)

    @action(detail=True, methods=["get"], url_path="sensor-schema")
    def sensor_schema(self, request, pk=None):
        """PRTG's create form for one sensor kind (``?kind=``) as fields:
        ``{kind, fields: [{key, label, type, default, options, ...}], scan}``."""
        from .manual import schema_fields

        link = self._link_for_sensors(request)
        kind = (request.query_params.get("kind") or "").strip()
        if not kind:
            raise ValidationError({"kind": "Which sensor kind?"})
        out, error = self._manual(schema_fields, link, kind)
        return error or Response(out)

    @action(detail=True, methods=["post"])
    def scan(self, request, pk=None):
        """PRTG's metascan of the device for ``kind`` (SNMP traffic): the
        rows to pick from, ``{kind, rows: [{value, name, status,
        connected}]}``."""
        from .manual import scan

        link = self._link_for_sensors(request)
        out, error = self._manual(scan, link, str(request.data.get("kind") or ""))
        return error or Response(out)

    @action(detail=True, methods=["post"])
    def sensors(self, request, pk=None):
        """Add a sensor in PRTG now: ``{kind, name?, params, interval_seconds?,
        tags?, interfaces?, request_id?}``. Answers with the new sensor
        rows as the re-read imported them."""
        from .manual import add_sensor

        link = self._link_for_sensors(request)
        data = request.data if isinstance(request.data, dict) else {}
        out, error = self._manual(add_sensor, link, data, request.user)
        if error:
            return error
        ctx = {"request": request}
        return Response({
            "detail": out["detail"], "objids": out["objids"], "failed": out["failed"],
            "sensors": PrtgSensorSerializer(out["sensors"], many=True, context=ctx).data,
        }, status=201)

    @action(detail=True, methods=["post"])
    def discover(self, request, pk=None):
        """Run PRTG's auto-discovery on the device, with an optional device
        ``template`` (file name). Found sensors arrive with the next read."""
        from .manual import discover

        link = self._link_for_sensors(request)
        out, error = self._manual(discover, link, str(request.data.get("template") or ""),
                                  request.user)
        return error or Response(out)


class PrtgChangeViewSet(
    IntegrationToggleMixin, ChangeQueueMixin, TenantScopedViewSet
):
    """The review queue: apply, dismiss, restore, apply-all (the shared
    actions). Proposals come from the status pass, never from here."""

    integration_keys = ("prtg",)
    http_method_names = ["get", "post", "head", "options"]
    queryset = (
        PrtgChange.objects.select_related("device", "virtual_machine", "connection")
        .order_by("kind", "-created_at")
    )
    serializer_class = PrtgChangeSerializer
    change_model = PrtgChange
    connection_model = PrtgConnection
    rbac_action_map = {"apply_object": "change", "decide": "change"}

    @action(detail=True, methods=["post"])
    def decide(self, request, pk=None):
        """Settle a decision row at once: ``{"link": {kind, id}}`` links the
        row's PRTG device to that candidate, ``{"remote": objid}`` links the
        row's object to that PRTG device, ``{"create": true}`` creates a
        separate PRTG device for the row's object. The row stays as Applied
        with the result."""
        from .client import PrtgError
        from .reader import decide_ambiguous
        from .writer import change_status

        change = self.get_object()
        try:
            detail = decide_ambiguous(change, request.data or {}, user=request.user)
        except ValueError as exc:
            return Response({"ok": False, "detail": str(exc)}, status=400)
        except PrtgError as exc:
            return Response({"ok": False, "detail": str(exc)}, status=502)
        change.refresh_from_db()
        return Response({"ok": True, "detail": detail, "status": change_status(change),
                         "result": (change.detail or {}).get("result") or {}})

    def get_queryset(self):
        """``?device=``, ``?virtual_machine=`` or ``?object=`` (either)
        narrow the queue to one object's rows."""
        qs = super().get_queryset()
        params = self.request.query_params if self.request else {}
        for key in ("device", "virtual_machine"):
            if params.get(key):
                qs = qs.filter(**{f"{key}_id": _uuid(params[key], key)})
        if params.get("object"):
            oid = _uuid(params["object"], "object")
            qs = qs.filter(Q(device_id=oid) | Q(virtual_machine_id=oid))
        return qs

    @action(detail=False, methods=["post"], url_path="apply-object")
    def apply_object(self, request):
        """Add one device or VM to PRTG now - ``{device}`` or
        ``{virtual_machine}``, optionally ``{connection}``: plans it, then
        writes its ready planned rows, the device before its sensors.
        Removals are never applied here. Answers per connection
        ``{connection, applied, failed, results: [{id, kind, ok, detail,
        status}], link}``. Needs change on the review queue and view on the
        object."""
        from .client import PrtgError
        from .writer import _lock, _unlock, apply_object

        tenant = _get_active_tenant(request)
        data = request.data or {}
        if data.get("device"):
            obj = rbac.restrict_queryset(
                Device.objects.filter(tenant=tenant), request.user, tenant, "device", "view",
            ).filter(id=_uuid(data["device"], "device")).first()
        elif data.get("virtual_machine"):
            obj = rbac.restrict_queryset(
                VirtualMachine.objects.filter(tenant=tenant), request.user, tenant,
                "virtualmachine", "view",
            ).filter(id=_uuid(data["virtual_machine"], "virtual_machine")).first()
        else:
            return Response({"detail": "device or virtual_machine is required."}, status=400)
        if obj is None:
            raise NotFound()
        conns = PrtgConnection.objects.filter(tenant=tenant, enabled=True).order_by("name")
        if data.get("connection"):
            conns = conns.filter(pk=_uuid(data["connection"], "connection"))
        out = []
        for conn in conns:
            if not conn.api_key_set:
                continue
            if not _lock(conn):
                return Response(
                    {"detail": "Danbyte is writing to PRTG now. Try again in a moment."},
                    status=409,
                )
            try:
                r = apply_object(conn, obj, user=request.user)
            except PrtgError as exc:
                return Response({"detail": str(exc)}, status=502)
            finally:
                _unlock(conn)
            out.append({"connection": {"id": str(conn.id), "name": conn.name}, **r})
        if not out:
            return Response({"detail": "No PRTG connection can write."}, status=400)
        return Response(out)

    def apply_change(self, change) -> str:
        from .adopt import apply_adoption
        from .reader import apply_link
        from .writer import apply

        if change.planned:
            # A write to PRTG (prtg.writer): the operator's act, logged
            # under their name.
            return apply(change, user=self.request.user)["detail"]
        if change.kind == PrtgChange.LINK:
            return apply_link(change)
        if change.kind == PrtgChange.ADOPT:
            return apply_adoption(change)
        raise ValueError("This proposal needs a decision, not an apply.")

    @action(detail=True, methods=["post"])
    def apply(self, request, pk=None):
        """Apply one row. A planned row stays in the queue afterwards,
        marked applied or failed, with the PRTG objects it made."""
        response = super().apply(request, pk)
        change = PrtgChange.objects.filter(pk=pk).first()
        if change is not None:
            from .writer import change_status

            response.data["status"] = change_status(change)
            response.data["result"] = (change.detail or {}).get("result") or {}
        return response

    def _one(self, change) -> dict:
        from .client import PrtgError

        try:
            return {"id": str(change.id), "ok": True, "detail": self.apply_change(change)}
        except (ValueError, PrtgError) as exc:
            return {"id": str(change.id), "ok": False, "detail": str(exc)[:4000]}

    def _skip(self, change) -> bool:
        from monitoring.external.adoption import applicable

        from .writer import ready

        if change.planned:
            return not ready(change)
        if change.kind == PrtgChange.ADOPT:
            return not applicable(change.detail or {})
        return False

    def apply_pending(self, conn) -> dict:
        """Every applicable proposal: links, adoptions whose placement is
        complete, and planned writes that are ready. Ambiguities and
        removals wait for a person, one row at a time."""
        results = [
            self._one(change)
            for change in PrtgChange.applicable(conn).select_related(
                "device", "virtual_machine", "connection", "connection__tenant"
            ).order_by("kind", "created_at")
            if not self._skip(change)
        ]
        return {"applied": sum(1 for r in results if r["ok"]),
                "failed": [r for r in results if not r["ok"]], "results": results}

    @action(detail=False, methods=["post"], url_path="apply-selected")
    def apply_selected(self, request):
        """Apply the rows named by ``ids`` (of one tenant's queue), one at a
        time: ``{applied, failed, results: [{id, ok, detail, status}]}``.
        A selected removal is applied too - picking it is the confirmation.
        Ambiguities, applied rows and rows that cannot be written as they
        stand come back as not applied, with the reason."""
        from .writer import change_status

        ids = request.data.get("ids")
        if not isinstance(ids, list) or not ids or len(ids) > 500:
            return Response({"ids": "A list of 1-500 change ids."}, status=400)
        rows = self.get_queryset().filter(id__in=[str(i) for i in ids]).select_related(
            "device", "virtual_machine", "connection", "connection__tenant"
        ).order_by("kind", "created_at")
        results = []
        found = set()
        for change in rows:
            found.add(str(change.id))
            if change.kind == PrtgChange.AMBIGUOUS:
                r = {"id": str(change.id), "ok": False,
                     "detail": "This proposal needs a decision, not an apply."}
            else:
                r = self._one(change)
            fresh = PrtgChange.objects.filter(pk=change.pk).first()
            r["status"] = change_status(fresh) if fresh is not None else "applied"
            results.append(r)
        for i in ids:
            if str(i) not in found:
                results.append({"id": str(i), "ok": False, "detail": "Not found.",
                                "status": "missing"})
        return Response({"applied": sum(1 for r in results if r["ok"]),
                         "failed": [r for r in results if not r["ok"]],
                         "results": results})

    @action(detail=False, methods=["post"], url_path="dismiss-selected")
    def dismiss_selected(self, request):
        """Dismiss the rows named by ``ids``."""
        ids = request.data.get("ids")
        if not isinstance(ids, list) or not ids or len(ids) > 500:
            return Response({"ids": "A list of 1-500 change ids."}, status=400)
        n = self.get_queryset().filter(id__in=[str(i) for i in ids]).update(ignored=True)
        return Response({"dismissed": n})

    def remote_errors(self) -> tuple:
        from .client import PrtgError

        return (PrtgError,)


class PrtgAdoptionRuleViewSet(IntegrationToggleMixin, _ByConnection, TenantScopedViewSet):
    """Where an adopted PRTG device lands. First match wins in weight order."""

    integration_keys = ("prtg",)
    queryset = (
        PrtgAdoptionRule.objects.select_related("site", "role", "device_type")
        .order_by("weight", "pattern")
    )
    serializer_class = PrtgAdoptionRuleSerializer


class PrtgRetireRuleViewSet(IntegrationToggleMixin, _ByConnection, TenantScopedViewSet):
    """What happens in PRTG to a linked device or VM that retires, in order
    (:mod:`prtg.retire`). The next planning pass applies a change."""

    integration_keys = ("prtg",)
    queryset = PrtgRetireRule.objects.select_related("connection").order_by(
        "position", "name"
    )
    serializer_class = PrtgRetireRuleSerializer


def _visible_devices(request, tenant):
    return rbac.restrict_queryset(
        Device.objects.filter(tenant=tenant), request.user, tenant, "device", "view",
    )


def _visible_vms(request, tenant):
    return rbac.restrict_queryset(
        VirtualMachine.objects.filter(tenant=tenant), request.user, tenant,
        "virtualmachine", "view",
    )


def _parent_visible(request, tenant, obj) -> bool:
    """Whether the caller may view the device or VM a link or sensor is for."""
    if obj.device_id:
        return _visible_devices(request, tenant).filter(id=obj.device_id).exists()
    return _visible_vms(request, tenant).filter(id=obj.virtual_machine_id).exists()


#: Worst first, for the alarms ordering.
_STATE_RANK = Case(
    When(state="down", then=Value(0)),
    When(state="degraded", then=Value(1)),
    When(state="unknown", then=Value(2)),
    When(state="up", then=Value(3)),
    default=Value(4),
    output_field=IntegerField(),
)

_SENSOR_ORDERINGS = {
    "name": ("name", "objid"),
    "-name": ("-name", "objid"),
    # Worst first, newest problem first within a state.
    "alarms": (
        "_rank", Coalesce("last_down_at", "last_check_at").desc(nulls_last=True), "name",
    ),
}


class PrtgSensorViewSet(IntegrationToggleMixin, _ByConnection, TenantScopedReadViewSet):
    """Every imported sensor. Read-only: the rows are PRTG's.

    Filters: ``connection``, ``device``, ``virtual_machine``, the object a
    sensor watches (``ip_address``, ``interface`` - a device or VM interface -
    and ``service``), ``state``
    (comma-separated; ``paused`` names the paused sensors whatever their
    state), ``kind`` (raw or display name), ``probe``, ``group``,
    ``alarms=1`` (down and degraded only, not paused), ``hide_paused=1``,
    ``search`` (sensor, device, VM, message, PRTG device, object id) and
    ``ordering`` (``name``, ``-name``, ``alarms``).

    ``channels/`` and ``history/`` read PRTG on demand and need view on the
    device or VM as well; ``summary/`` counts per state in one query.
    """

    integration_keys = ("prtg",)
    queryset = PrtgSensor.objects.select_related(
        "device", "virtual_machine", "connection", "link",
        "ip_address", "interface", "vm_interface", "service",
    )
    serializer_class = PrtgSensorSerializer

    def filter_sensors(self, qs):
        p = self.request.query_params if self.request else {}
        for key in ("ip_address", "interface", "service"):
            if p.get(key):
                try:
                    uuid.UUID(str(p[key]))
                except ValueError:
                    raise ValidationError({key: "Not an id."}) from None
        if p.get("ip_address"):
            qs = qs.filter(ip_address_id=p["ip_address"])
        if p.get("interface"):
            # A device interface or a VM interface: the ids never collide.
            qs = qs.filter(Q(interface_id=p["interface"]) | Q(vm_interface_id=p["interface"]))
        if p.get("service"):
            qs = qs.filter(service_id=p["service"])
        if p.get("device"):
            qs = qs.filter(device_id=p["device"])
        if p.get("virtual_machine"):
            qs = qs.filter(virtual_machine_id=p["virtual_machine"])
        if p.get("state"):
            wanted = {v.strip() for v in p["state"].split(",") if v.strip()}
            q = Q(state__in=wanted - {"paused"}) & ~Q(status_raw__in=st.PAUSED)
            if "paused" in wanted:
                q |= Q(status_raw__in=st.PAUSED)
            qs = qs.filter(q)
        if p.get("kind"):
            qs = qs.filter(Q(kind__iexact=p["kind"]) | Q(kind_label__iexact=p["kind"]))
        if p.get("probe"):
            qs = qs.filter(probe_name=p["probe"])
        if p.get("group"):
            qs = qs.filter(group_path=p["group"])
        if p.get("alarms") in ("1", "true"):
            qs = qs.filter(state__in=("down", "degraded")).exclude(status_raw__in=st.PAUSED)
        if p.get("hide_paused") in ("1", "true"):
            qs = qs.exclude(status_raw__in=st.PAUSED)
        term = (p.get("search") or "").strip()
        if term:
            qs = qs.filter(
                Q(name__icontains=term) | Q(device__name__icontains=term)
                | Q(virtual_machine__name__icontains=term) | Q(message__icontains=term)
                | Q(link__name__icontains=term) | Q(kind_label__icontains=term)
                | Q(objid=term)
            )
        return qs

    def get_queryset(self):
        qs = super().get_queryset()
        if self.action in ("list", "summary"):
            qs = self.filter_sensors(qs)
        ordering = (self.request.query_params.get("ordering") if self.request else "") or "name"
        qs = qs.annotate(_rank=_STATE_RANK)
        return qs.order_by(*_SENSOR_ORDERINGS.get(ordering, _SENSOR_ORDERINGS["name"]))

    def _sensor_for_read(self, request):
        sensor = self.get_object()
        tenant = _get_active_tenant(request)
        if not _parent_visible(request, tenant, sensor):
            raise NotFound()
        if not sensor.connection.enabled or not sensor.connection.api_key_set:
            raise NotFound("The PRTG connection is off.")
        return sensor

    def _sensor_for_write(self, request):
        """The sensor an action is for: ``change`` on PRTG sensors (the
        queryset is narrowed by it), view on the device or VM, and a
        connection that can be written."""
        sensor = self.get_object()
        if not _parent_visible(request, _get_active_tenant(request), sensor):
            raise NotFound()
        if not sensor.connection.enabled or not sensor.connection.api_key_set:
            raise ValidationError({"detail": "The PRTG connection is off."})
        return sensor

    def _act(self, fn, *args, **kwargs):
        from .actions import ActionError

        try:
            sensor = fn(*args, **kwargs)
        except ActionError as exc:
            return Response({"detail": exc.detail}, status=exc.status)
        sensor = self.get_queryset().get(pk=sensor.pk)
        return Response(PrtgSensorSerializer(sensor, context={"request": self.request}).data)

    @extend_schema(
        request=inline_serializer("PrtgAcknowledge", fields={
            "note": serializers.CharField(required=False, allow_blank=True),
        }),
        responses={200: PrtgSensorSerializer},
    )
    @action(detail=True, methods=["post"])
    def acknowledge(self, request, pk=None):
        """Acknowledge a down sensor in PRTG with an optional ``note``. Needs
        the connection's acknowledgement write-back switch."""
        from .actions import acknowledge

        sensor = self._sensor_for_write(request)
        return self._act(acknowledge, sensor, request.user, str(request.data.get("note") or ""))

    @extend_schema(
        request=inline_serializer("PrtgPause", fields={
            "minutes": serializers.IntegerField(required=False, allow_null=True),
            "note": serializers.CharField(required=False, allow_blank=True),
        }),
        responses={200: PrtgSensorSerializer},
    )
    @action(detail=True, methods=["post"])
    def pause(self, request, pk=None):
        """Pause the sensor in PRTG for ``minutes``, or until resumed when
        ``minutes`` is empty."""
        from .actions import pause

        sensor = self._sensor_for_write(request)
        return self._act(
            pause, sensor, request.user, request.data.get("minutes"),
            str(request.data.get("note") or ""),
        )

    @extend_schema(request=None, responses={200: PrtgSensorSerializer})
    @action(detail=True, methods=["post"])
    def resume(self, request, pk=None):
        """Resume a paused sensor in PRTG."""
        from .actions import resume

        sensor = self._sensor_for_write(request)
        return self._act(resume, sensor, request.user)

    @action(detail=False, methods=["get"])
    def summary(self, request):
        """Counts per state for a status strip, in one query: ``down``,
        ``degraded``, ``up``, ``unknown`` over sensors that are not paused,
        ``paused``, ``acknowledged``, ``total``, and ``read_at`` (the latest
        read that saw one of them). Takes the list's filters."""
        qs = self.get_queryset().order_by()
        live = ~Q(status_raw__in=st.PAUSED)
        agg = qs.aggregate(
            total=Count("id"),
            paused=Count("id", filter=Q(status_raw__in=st.PAUSED)),
            acknowledged=Count("id", filter=Q(status_raw=st.DOWN_ACKNOWLEDGED)),
            down=Count("id", filter=live & Q(state="down")),
            degraded=Count("id", filter=live & Q(state="degraded")),
            up=Count("id", filter=live & Q(state="up")),
            unknown=Count("id", filter=live & ~Q(state__in=("down", "degraded", "up"))),
            read_at=Max("last_seen_at"),
        )
        return Response(agg)

    @action(detail=True, methods=["get"])
    def channels(self, request, pk=None):
        """The sensor's channels, read from PRTG at most once per status
        interval (see :mod:`prtg.channels`)."""
        from .channels import read_channels
        from .client import PrtgError

        sensor = self._sensor_for_read(request)
        try:
            return Response(read_channels(sensor))
        except PrtgError as exc:
            return Response({"detail": str(exc)[:300]}, status=502)

    @action(detail=True, methods=["get"])
    def history(self, request, pk=None):
        """``?range=1h|24h|7d`` (1h by default) and optional ``channel=<id>``:
        ``{range, avg, fetched_at, stale, channels: [{id, name, unit, points:
        [{t, v}]}]}``, read from PRTG at most once per range and interval."""
        from .channels import RANGES, read_history
        from .client import PrtgError

        rng = request.query_params.get("range") or "1h"
        if rng not in RANGES:
            return Response({"range": f"One of {', '.join(RANGES)}."}, status=400)
        sensor = self._sensor_for_read(request)
        try:
            data = read_history(sensor, rng)
        except PrtgError as exc:
            return Response({"detail": str(exc)[:300]}, status=502)
        wanted = request.query_params.get("channel")
        channels = [
            {"id": cid, **entry}
            for cid, entry in (data.get("series") or {}).items()
            if wanted in (None, "", cid)
        ]
        return Response({
            "range": data.get("range", rng), "avg": data.get("avg"),
            "fetched_at": data.get("fetched_at"), "stale": bool(data.get("stale")),
            "channels": channels,
        })


class PrtgDeviceStatusView(APIView):
    """What PRTG says about a device - ``?device=<id>`` or ``?ip=<id>``.

    One entry per link. Read access is the device's own: a viewer who may see
    the device may see what PRTG says about it.
    """

    permission_classes = [IsAuthenticated]

    def get(self, request):
        tenant = _get_active_tenant(request)
        if tenant is None or not integration_enabled(tenant, "prtg"):
            raise NotFound("Integration not enabled.")
        device_id = (request.query_params.get("device") or "").strip()
        vm_id = (request.query_params.get("virtual_machine") or "").strip()
        ip_id = (request.query_params.get("ip") or "").strip()
        if vm_id:
            vm = _visible_vms(request, tenant).filter(id=vm_id).first()
            if vm is None:
                return Response([])
            return Response(self._entries(
                PrtgDeviceLink.objects.filter(virtual_machine=vm, connection__enabled=True)
            ))
        if ip_id and not device_id:
            ip = rbac.restrict_queryset(
                IPAddress.objects.filter(tenant=tenant, id=ip_id),
                request.user, tenant, "ipaddress", "view",
            ).first()
            if ip is None or not ip.assigned_device_id:
                return Response([])
            device_id = str(ip.assigned_device_id)
        if not device_id:
            return Response(
                {"detail": "device, virtual_machine or ip is required."}, status=400
            )
        device = _visible_devices(request, tenant).filter(id=device_id).first()
        if device is None:
            return Response([])
        return Response(self._entries(
            PrtgDeviceLink.objects.filter(device=device, connection__enabled=True)
        ))

    @staticmethod
    def _entries(links) -> list:
        from .reader import problems_for

        links = links.select_related("connection").order_by("connection__name")
        return [
            {
                "connection": {"id": str(lk.connection_id), "name": lk.connection.name,
                               "url": lk.connection.url},
                "device": {"objid": lk.objid, "name": lk.name, "host": lk.host,
                           "url": lk.connection.device_url(lk.objid)},
                "link": {"matched_by": lk.matched_by, "tagged": lk.tagged},
                "status": {"state": lk.state or None, "counts": lk.sensor_counts,
                           "problems": problems_for(lk), "read_at": lk.status_read_at},
            }
            for lk in links
        ]


class PrtgDeviceStatesView(APIView):
    """Every linked device's roll-up, for the device list's PRTG column:
    ``{device id: {state, down, warning, url, name}}``. Only devices the
    caller may view; one connection per device (the first by name).
    :class:`PrtgVmStatesView` is the same for virtual machines."""

    permission_classes = [IsAuthenticated]
    parent_field = "device_id"

    def visible(self, request, tenant):
        return _visible_devices(request, tenant)

    def get(self, request):
        tenant = _get_active_tenant(request)
        if tenant is None or not integration_enabled(tenant, "prtg"):
            raise NotFound("Integration not enabled.")
        visible = self.visible(request, tenant).values("id")
        out: dict = {}
        links = (
            PrtgDeviceLink.objects.filter(
                tenant=tenant, connection__enabled=True,
                **{f"{self.parent_field}__in": visible},
            ).select_related("connection").order_by("connection__name")
        )
        for lk in links:
            key = str(getattr(lk, self.parent_field))
            if key in out:
                continue
            counts = lk.sensor_counts or {}
            out[key] = {
                "state": lk.state or None,
                "down": int(counts.get("down", 0) or 0),
                "warning": int(counts.get("degraded", 0) or 0),
                "name": lk.name,
                "url": lk.connection.device_url(lk.objid),
            }
        return Response(out)


class PrtgVmStatesView(PrtgDeviceStatesView):
    """``{vm id: {state, down, warning, url, name}}`` for the VM list."""

    parent_field = "virtual_machine_id"

    def visible(self, request, tenant):
        return _visible_vms(request, tenant)
