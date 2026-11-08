"""``/api/prtg/sensor-overrides/``: turn one wanted PRTG sensor off - or on -
for one device or VM, against what its policies say.

``PUT {device | virtual_machine, definition_key, enabled, note?, connection?}``
sets the override; ``DELETE`` with the same object and key (in the body or
the query string) removes it, so the policies decide again.
``definition_key`` is the sensor's ``danbyte-def-`` key, as the plan's
Coverage rows name it, and must be one the object's policies want on the
connection. ``connection`` may be left out: the connection whose plan wants
that key is used.

Needs ``prtgsensoroverride.change`` (site-scoped through the object) and
change on the device or VM. Each change is journalled on the object and the
object is planned again at once, so the review queue follows.
"""
from __future__ import annotations

import logging
import uuid

from django.db import transaction
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from auth_api import rbac

from .models import PrtgConnection, PrtgSensorOverride
from .registration_api import _gate

log = logging.getLogger("prtg.overrides")

SLUG = "prtgsensoroverride"


def _id(value, field: str) -> str:
    try:
        return str(uuid.UUID(str(value)))
    except (TypeError, ValueError):
        raise ValidationError({field: "Not an id."}) from None


def _object(request, tenant, data):
    """The device or VM the request names, with change on it."""
    from api.models import Device, VirtualMachine

    named = [f for f in ("device", "virtual_machine") if data.get(f)]
    if len(named) != 1:
        raise ValidationError({"device": "Name one device or virtual machine."})
    field = named[0]
    model, slug = (Device, "device") if field == "device" else (VirtualMachine, "virtualmachine")
    obj_id = _id(data.get(field), field)
    obj = rbac.restrict_queryset(
        model.objects.filter(tenant=tenant), request.user, tenant, slug, "view"
    ).filter(id=obj_id).first()
    if obj is None:
        raise NotFound()
    if not rbac.can_act_on(request.user, tenant, slug, "change", obj):
        raise PermissionDenied("Changing PRTG sensors here needs change on the object.")
    return field, obj


def _wanted(conn, obj) -> dict:
    """The sensors the object's policies want on ``conn``, by key."""
    from .models import PrtgDeviceLink
    from .provision import _parent, _prepare, decide, sensors_for

    ctx, checked = _prepare(conn)
    link = PrtgDeviceLink.objects.filter(connection=conn, **_parent(obj)).first()
    want = decide(conn, obj, ctx, linked=link is not None and not link.created_here,
                  checked=checked)
    if not want.managed:
        return {}
    return {i["key"]: i for i in sensors_for(want) if not i.get("template")}


def _connection_and_sensor(tenant, obj, key: str, conn_id):
    conns = PrtgConnection.objects.filter(tenant=tenant)
    if conn_id:
        conns = conns.filter(id=_id(conn_id, "connection"))
        if not conns.exists():
            raise ValidationError({"connection": "Unknown connection."})
    else:
        conns = conns.filter(enabled=True).order_by("name")
    for conn in conns:
        inst = _wanted(conn, obj).get(key)
        if inst is not None:
            return conn, inst
    raise ValidationError({"definition_key": "No policy wants this sensor on this object."})


def _replan(conn, obj) -> None:
    from .provision import plan_object

    try:
        plan_object(conn, obj)
    except Exception:  # noqa: BLE001 - the beat plans it again anyway
        log.exception("prtg plan after an override failed for %s", obj.pk)


class PrtgSensorOverrideView(APIView):
    permission_classes = [IsAuthenticated]

    def _start(self, request, data):
        tenant = _gate(request)
        if not rbac.has_action(request.user, tenant, SLUG, "change"):
            raise PermissionDenied("You may not change PRTG sensor overrides.")
        field, obj = _object(request, tenant, data)
        key = str(data.get("definition_key") or "").strip()
        if not key:
            raise ValidationError({"definition_key": "Which sensor?"})
        return tenant, field, obj, key

    def put(self, request):
        from .writer import record

        data = request.data if hasattr(request.data, "get") else {}
        tenant, field, obj, key = self._start(request, data)
        enabled = data.get("enabled")
        if not isinstance(enabled, bool):
            raise ValidationError({"enabled": "true or false."})
        note = str(data.get("note") or "").strip()
        if len(note) > 255:
            raise ValidationError({"note": "At most 255 characters."})
        conn, inst = _connection_and_sensor(tenant, obj, key, data.get("connection"))
        with transaction.atomic():
            row, _ = PrtgSensorOverride.objects.update_or_create(
                **{field: obj}, definition_key=key,
                defaults={"tenant": tenant, "connection": conn, "enabled": enabled,
                          "note": note, "created_by": request.user},
            )
            if not rbac.can_act_on(request.user, tenant, SLUG, "change", row):
                transaction.set_rollback(True)
                raise PermissionDenied("You may not change PRTG sensor overrides here.")
            state = "on" if enabled else "off"
            text = f"PRTG sensor {inst['name']} turned {state} for this object"
            record(obj, f"{text}: {note}." if note else f"{text}.", request.user,
                   field="prtg_sensor_override")
        _replan(conn, obj)
        return Response(self._out(row, inst))

    def delete(self, request):
        from .writer import record

        data = request.data if hasattr(request.data, "get") and request.data else (
            request.query_params
        )
        tenant, field, obj, key = self._start(request, data)
        row = PrtgSensorOverride.objects.filter(
            tenant=tenant, **{field: obj}, definition_key=key
        ).select_related("connection").first()
        if row is None:
            raise NotFound()
        if not rbac.can_act_on(request.user, tenant, SLUG, "change", row):
            raise PermissionDenied("You may not change PRTG sensor overrides here.")
        conn = row.connection
        inst = _wanted(conn, obj).get(key)
        name = inst["name"] if inst else key
        with transaction.atomic():
            row.delete()
            record(obj, f"PRTG sensor {name} follows the policies again for this object.",
                   request.user, field="prtg_sensor_override")
        _replan(conn, obj)
        return Response(status=204)

    @staticmethod
    def _out(row, inst) -> dict:
        from .provision import override_detail

        return {
            "id": str(row.id), "connection": str(row.connection_id),
            "device": str(row.device_id) if row.device_id else None,
            "virtual_machine": str(row.virtual_machine_id) if row.virtual_machine_id else None,
            "definition_key": row.definition_key, "name": inst["name"],
            **override_detail(row),
        }
