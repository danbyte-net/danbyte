"""The floor plan detail panel's layouts (``api.models.PanelLayout``).

A layout is an ordered list of sections and fields for one kind of object -
device, rack or cabinet. The fields are the built-in attributes, computed
blocks (``preview``, ``monitoring``, ``ports``, ``ips``, ``cables``,
``devices``) and the tenant's custom fields as ``cf:<key>``. A tenant's
layouts are scoped: a device takes the layout of its device type, else
of its role, else of the first of its profiles that has one, else the
tenant's default; a rack or cabinet its type's, else its role's, else the
default. With no layout at
all the built-in default here applies, so nothing is seeded.

``resolve`` finds the layout for an object, ``validate`` checks one sent
by the settings page, and ``custom_field_values`` reads the custom fields a
layout names - only the definitions the reader may see, only where a
definition's own scope rules match the object.
"""
from __future__ import annotations

import re

from rest_framework.exceptions import ValidationError

#: field key → label, by kind; computed blocks last. The settings page
#: lists them in this order.
FIELDS: dict[str, dict[str, str]] = {
    "device": {
        "role": "Role",
        "status": "Status",
        "device_type": "Type",
        "platform": "Platform",
        "software_version": "Software",
        "serial_number": "Serial",
        "asset_tag": "Asset tag",
        "numid": "ID",
        "site": "Site",
        "location": "Location",
        "position": "Rack position",
        "primary_ip": "Primary IP",
        "secondary_ip": "Secondary IP",
        "oob_ip": "OOB IP",
        "tenant": "Tenant",
        "profiles": "Profiles",
        "tags": "Tags",
        "description": "Description",
        "preview": "Preview",
        "monitoring": "Monitoring",
        "ports": "Port summary",
        "ips": "IP addresses",
        "cables": "Cables on this plan",
    },
    "rack": {
        "role": "Role",
        "status": "Status",
        "rack_type": "Type",
        "facility_id": "Facility ID",
        "numid": "ID",
        "site": "Site",
        "location": "Location",
        "space": "Space",
        "tenant": "Tenant",
        "tags": "Tags",
        "description": "Description",
        "monitoring": "Monitoring",
        "devices": "Devices",
        "cables": "Cables on this plan",
    },
    "cabinet": {
        "role": "Role",
        "status": "Status",
        "cabinet_type": "Type",
        "facility_id": "Facility ID",
        "numid": "ID",
        "site": "Site",
        "location": "Location",
        "size": "Size",
        "tenant": "Tenant",
        "tags": "Tags",
        "description": "Description",
        "monitoring": "Monitoring",
        "devices": "Devices",
        "cables": "Cables on this plan",
    },
}

#: The computed blocks (the rest are attributes).
COMPUTED = frozenset({"preview", "monitoring", "ports", "ips", "cables", "devices"})


def _items(*parts):
    out = []
    for p in parts:
        if isinstance(p, str) and p.startswith("#"):
            out.append({"section": p[1:]})
        else:
            out.append({"field": p})
    return out


#: The built-in layouts: what a panel shows until a tenant saves its own.
DEFAULTS: dict[str, list[dict]] = {
    "device": _items(
        # The photo, else the 3D model: above the first heading.
        "preview",
        "#Device", "role", "status", "device_type", "platform", "serial_number",
        "asset_tag", "site", "location", "position", "primary_ip", "secondary_ip",
        "oob_ip", "tenant", "profiles", "tags",
        "#Monitoring", "monitoring",
        "#Ports", "ports",
        "#Cables on this plan", "cables",
    ),
    "rack": _items(
        "#Rack", "role", "status", "rack_type", "facility_id", "site", "location",
        "space", "monitoring", "tenant", "tags",
        "#Devices", "devices",
        "#Cables on this plan", "cables",
    ),
    "cabinet": _items(
        "#Cabinet", "role", "status", "cabinet_type", "facility_id", "site",
        "location", "size", "monitoring", "tenant", "tags",
        "#Devices", "devices",
        "#Cables on this plan", "cables",
    ),
}

#: The fields a callout on the 2D plan may add under the object's name: the
#: short single-line attributes (and ``cf:<key>``), never a block. A callout
#: takes at most ``CALLOUT_MAX``; with none chosen it shows the name alone.
CALLOUT_FIELDS: dict[str, tuple[str, ...]] = {
    "device": (
        "role", "status", "device_type", "platform", "software_version",
        "serial_number", "asset_tag", "numid", "location", "position",
        "primary_ip", "oob_ip", "tenant", "description",
    ),
    "rack": (
        "role", "status", "rack_type", "facility_id", "numid", "location",
        "tenant", "description",
    ),
    "cabinet": (
        "role", "status", "cabinet_type", "facility_id", "numid", "location",
        "size", "tenant", "description",
    ),
}
CALLOUT_MAX = 3

#: The scopes each kind takes, most specific first (resolution order).
SCOPES: dict[str, tuple[str, ...]] = {
    "device": ("device_type", "device_role", "profile", "default"),
    "rack": ("rack_type", "rack_role", "default"),
    "cabinet": ("cabinet_type", "cabinet_role", "default"),
}

#: The custom-field model slug of each kind.
CF_MODEL = {"device": "device", "rack": "rack", "cabinet": "cabinet"}

MAX_ITEMS = 80
SECTION_MAX = 64
_CF_KEY = re.compile(r"^cf:[-a-zA-Z0-9_]{1,64}$")


def scope_model(scope: str):
    """The model a scope's ``scope_id`` names."""
    from profiles.models import DeviceProfile

    from .models import CabinetRole, CabinetType, DeviceRole, DeviceType, RackRole, RackType

    return {
        "device_type": DeviceType,
        "device_role": DeviceRole,
        "profile": DeviceProfile,
        "rack_type": RackType,
        "rack_role": RackRole,
        "cabinet_type": CabinetType,
        "cabinet_role": CabinetRole,
    }.get(scope)


def scope_name(scope: str, scope_id) -> str:
    model = scope_model(scope)
    if model is None or scope_id is None:
        return ""
    obj = model.objects.filter(pk=scope_id).first()
    return str(obj) if obj is not None else ""


def validate(tenant, kind: str, scope: str, scope_id, items) -> list[dict]:
    """The layout as stored, or a 400 naming what is wrong."""
    from customization.models import CustomField

    if kind not in FIELDS:
        raise ValidationError({"object_kind": "One of device, rack or cabinet."})
    if scope not in SCOPES[kind]:
        raise ValidationError(
            {"scope": f"A {kind} layout applies to: {', '.join(SCOPES[kind])}."}
        )
    if scope == "default":
        if scope_id:
            raise ValidationError({"scope_id": "The default names no object."})
    else:
        model = scope_model(scope)
        if not scope_id or not model.objects.filter(pk=scope_id, tenant=tenant).exists():
            raise ValidationError({"scope_id": "Not one of this tenant's."})
    if not isinstance(items, list) or len(items) > MAX_ITEMS:
        raise ValidationError({"items": f"A list of at most {MAX_ITEMS} entries."})
    cf_keys = set(
        CustomField.objects.filter(
            tenant=tenant, applies_to__contains=[CF_MODEL[kind]]
        ).values_list("key", flat=True)
    )
    out, seen = [], set()
    for i, it in enumerate(items):
        if not isinstance(it, dict) or len(it) != 1:
            raise ValidationError({"items": f"Entry {i + 1}: a section or a field."})
        if "section" in it:
            label = it["section"]
            if not isinstance(label, str) or not label.strip() or len(label) > SECTION_MAX:
                raise ValidationError(
                    {"items": f"Entry {i + 1}: a section label of 1-{SECTION_MAX} characters."}
                )
            out.append({"section": label.strip()})
            continue
        key = it.get("field")
        ok = isinstance(key, str) and (
            key in FIELDS[kind]
            or (_CF_KEY.match(key) is not None and key[3:] in cf_keys)
        )
        if not ok:
            raise ValidationError({"items": f"Entry {i + 1}: unknown field {key!r}."})
        if key in seen:
            raise ValidationError({"items": f"Entry {i + 1}: {key!r} is listed twice."})
        seen.add(key)
        out.append({"field": key})
    return out


def validate_callout(tenant, kind: str, keys) -> list[str]:
    """A layout's callout fields as stored, or a 400 naming what is wrong."""
    from customization.models import CustomField

    if keys is None:
        return []
    if not isinstance(keys, list) or len(keys) > CALLOUT_MAX:
        raise ValidationError({"callout": f"A list of at most {CALLOUT_MAX} fields."})
    cf_keys = None
    out: list[str] = []
    for i, key in enumerate(keys):
        ok = isinstance(key, str) and key in CALLOUT_FIELDS[kind]
        if not ok and isinstance(key, str) and _CF_KEY.match(key):
            if cf_keys is None:
                cf_keys = set(
                    CustomField.objects.filter(
                        tenant=tenant, applies_to__contains=[CF_MODEL[kind]]
                    ).values_list("key", flat=True)
                )
            ok = key[3:] in cf_keys
        if not ok:
            raise ValidationError({"callout": f"Entry {i + 1}: unknown field {key!r}."})
        if key in out:
            raise ValidationError({"callout": f"Entry {i + 1}: {key!r} is listed twice."})
        out.append(key)
    return out


def _candidates(kind: str, obj) -> list[tuple[str, object]]:
    """``(scope, scope_id)`` for ``obj``, most specific first."""
    if kind == "device":
        out = [("device_type", obj.device_type_id), ("device_role", obj.role_id)]
        out += [
            ("profile", a.profile_id)
            for a in obj.device_profile_assignments.all()
        ]
    elif kind == "rack":
        out = [("rack_type", obj.rack_type_id), ("rack_role", obj.role_id)]
    else:
        out = [("cabinet_type", obj.cabinet_type_id), ("cabinet_role", obj.role_id)]
    return [(s, i) for s, i in out if i is not None] + [("default", None)]


def resolve(tenant, kind: str, obj) -> dict:
    """The layout ``obj`` takes: ``{id, scope, scope_id, scope_name, items}``
    - ``id`` null for the built-in default."""
    from .models import PanelLayout

    rows = {
        (r.scope, r.scope_id): r
        for r in PanelLayout.objects.filter(tenant=tenant, object_kind=kind)
    }
    for scope, sid in _candidates(kind, obj):
        row = rows.get((scope, sid))
        if row is not None:
            return {
                "id": str(row.id),
                "scope": scope,
                "scope_id": str(sid) if sid else None,
                "scope_name": scope_name(scope, sid),
                "items": row.items,
                "callout": row.callout or [],
            }
    return {"id": None, "scope": "default", "scope_id": None, "scope_name": "",
            "items": DEFAULTS[kind], "callout": []}


class CalloutResolver:
    """The callout fields each object takes, for many objects at once: the
    tenant's layouts read once, each object's resolved as ``resolve`` does
    (type, role, profile, default - the first layout found wins, even one
    with no callout fields)."""

    def __init__(self, tenant):
        from .models import PanelLayout

        self.rows: dict = {
            (r.object_kind, r.scope, r.scope_id): list(r.callout or [])
            for r in PanelLayout.objects.filter(tenant=tenant).only(
                "object_kind", "scope", "scope_id", "callout"
            )
        }

    def any(self) -> bool:
        return any(self.rows.values())

    def fields(self, kind: str, obj) -> list[str]:
        for scope, sid in _candidates(kind, obj):
            got = self.rows.get((kind, scope, sid))
            if got is not None:
                return got[:CALLOUT_MAX]
        return []


def wants(items, key: str) -> bool:
    return any(it.get("field") == key for it in items)


class CustomFieldReader:
    """The custom fields ``keys`` name, read for many objects of one kind:
    only definitions the reader may see (``api.list_fields.
    visible_custom_fields``: not hidden, a site-local one only for its
    site's readers) whose own scope rules match the object, and only those
    with a value. An object reference reads as its label - one the reader
    may view, else nothing. The definitions are read once."""

    def __init__(self, request, tenant, kind: str, keys):
        from customization.models import CustomField

        from .list_fields import visible_custom_fields

        self.request, self.tenant = request, tenant
        self.model = CF_MODEL[kind]
        self.keys = list(keys)
        self.visible = {}
        self.rules = {}
        if self.keys:
            self.visible = {
                d["key"]: d
                for d in visible_custom_fields(request, tenant, self.model, self.model)
            }
            self.rules = dict(
                CustomField.objects.filter(tenant=tenant, key__in=self.keys).values_list(
                    "key", "scope_rules"
                )
            )

    def values(self, obj, keys=None) -> list[dict]:
        from customization.object_registry import resolve_labels
        from customization.scopes import object_matches_scope

        values = obj.custom_fields or {}
        out = []
        for key in self.keys if keys is None else keys:
            d = self.visible.get(key)
            if d is None or not object_matches_scope(
                obj, self.model, self.rules.get(key) or {}
            ):
                continue
            value = values.get(key)
            if value in (None, "", []):
                continue
            display = value
            if d["type"] == "object" and d["related_model"]:
                ids = value if isinstance(value, list) else [value]
                labels = resolve_labels(
                    d["related_model"], [str(v) for v in ids], tenant=self.tenant,
                    user=self.request.user,
                )
                if not labels:
                    continue
                display = ", ".join(lab["label"] for lab in labels)
            elif isinstance(value, list):
                display = ", ".join(str(v) for v in value)
            elif isinstance(value, bool):
                display = "Yes" if value else "No"
            out.append({"key": key, "label": d["label"], "type": d["type"],
                        "value": str(display)})
        return out


def custom_field_values(request, tenant, kind: str, obj, items) -> list[dict]:
    """The custom fields ``items`` names, in its order, with ``obj``'s values
    (``CustomFieldReader``)."""
    keys = [it["field"][3:] for it in items if str(it.get("field", "")).startswith("cf:")]
    if not keys:
        return []
    return CustomFieldReader(request, tenant, kind, keys).values(obj)
