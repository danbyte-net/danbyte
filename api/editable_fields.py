"""Field-level write metadata: which fields of a model may be set, and with
what editor.

``GET /api/editable-fields/`` answers "what can I change here?" for any viewset
that declares a :class:`~api.viewsets.FieldWriteAllowList`. Two consumers need
that answer — the bulk-edit dialog, which has historically carried a
hand-written field list per call site, and planning's *planned changes*, where a
task declares "interface Gi2/1: Enabled Yes → No".

The design rule is **names are curated, metadata is derived**. The only
hand-written thing is which field names a field-level write path may touch (on
the viewset, next to the code that enforces it). Everything else — editor kind,
label, hint, option list, nullability — comes from ``model._meta`` and the
registries that already exist, so this module cannot drift from the model.

:func:`coerce_value` and :func:`read_value` are deliberately shared with the
planned-change *apply* path, so validating a value at plan time and at apply
time is literally the same code.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from dataclasses import field as dc_field

from django.apps import apps
from django.db import models
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import (
    OpenApiParameter,
    OpenApiResponse,
    extend_schema,
)
from rest_framework.decorators import api_view, permission_classes
from rest_framework.exceptions import NotFound, PermissionDenied, ValidationError
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from auth_api import rbac

# Long taxonomies already published by /api/dcim/choices/ — the frontend fetches
# that payload once, so the descriptor names the list instead of inlining a few
# hundred options per request. Verified against the model's own flatchoices by
# api/tests_editable_fields.py, which is what stops this map drifting.
DCIM_CHOICE_KEYS: dict[tuple[str, str], str] = {
    ("api.interface", "type"): "interface_types",
    ("api.interface", "mode"): "interface_modes",
    ("api.interface", "duplex"): "interface_duplex",
    ("api.interface", "poe_mode"): "poe_modes",
    ("api.interface", "poe_type"): "poe_types",
    ("api.vminterface", "mode"): "interface_modes",
    ("api.consoleport", "type"): "console_port_types",
    ("api.consoleserverport", "type"): "console_port_types",
    ("api.powerport", "type"): "power_port_types",
    ("api.poweroutlet", "type"): "power_outlet_types",
    ("api.poweroutlet", "feed_leg"): "feed_legs",
    ("api.frontport", "type"): "front_port_types",
    ("api.rearport", "type"): "front_port_types",
    ("api.cable", "type"): "cable_types",
}

# Free-text fields with well-known values worth offering as suggestions. The
# resolved list travels with the descriptor (a handful of short strings) rather
# than a key the client must look up — `suggestions` is a value list on both the
# wire type and the frontend's authored spec union.
def _speed_suggestions() -> list[str]:
    from api.dcim_choices import COMMON_SPEEDS

    return list(COMMON_SPEEDS)


SUGGESTION_SOURCES: dict[tuple[str, str], callable] = {
    ("api.interface", "speed"): _speed_suggestions,
    ("api.vminterface", "speed"): _speed_suggestions,
}

# verbose_name is right almost everywhere; these read badly capitalised, and
# acronyms lose their case through `verbose_name.capitalize()`.
LABEL_OVERRIDES: dict[tuple[str, str], str] = {
    ("api.interface", "mode"): "802.1Q mode",
    ("api.vminterface", "mode"): "802.1Q mode",
    ("api.interface", "mtu"): "MTU",
    ("api.vminterface", "mtu"): "MTU",
    ("api.interface", "mgmt_only"): "Management only",
    ("api.interface", "poe_mode"): "PoE mode",
    ("api.interface", "poe_type"): "PoE type",
    ("api.interface", "vlan"): "Untagged VLAN",
    ("api.vminterface", "vlan"): "Untagged VLAN",
}

# Field names whose verbose_name is an acronym, on every model.
ACRONYM_LABELS: dict[str, str] = {
    "vlan": "VLAN", "vrf": "VRF", "mtu": "MTU", "asn": "ASN", "rir": "RIR",
    "ip": "IP", "vm": "VM",
}


@dataclass(frozen=True)
class EditableField:
    """One writable field, described well enough to render an editor for it.

    ``kind`` matches the frontend's ``BulkFieldSpec`` union so a single editor
    component serves bulk edit and planned changes.
    """

    key: str            # the payload key = the model attname ("enabled", "status_id")
    label: str
    kind: str           # text|int|bool|choice|options|status|bytes|vlan|vrf|object
    nullable: bool
    hint: str = ""
    choices: str | None = None                 # /api/dcim/choices/ list key
    options: list[dict] | None = None          # inline [{value, label}]
    suggestions: list[str] | None = None       # offered values, field stays free text
    status_model: str | None = None            # Status.available_to slug
    object_model: str | None = None            # customization reference slug
    endpoint: str | None = None
    picker: bool = False
    # Not serialised — the model field this descriptor came from.
    _field: object = dc_field(default=None, repr=False, compare=False)

    def payload(self) -> dict:
        return {k: v for k, v in asdict(self).items() if not k.startswith("_")}


def _viewsets():
    """Every routed viewset that declares a field-write allow-list, with its
    model and the merged allow-list. Walking the router means there is no list
    of covered models to maintain anywhere."""
    from api.api_urls import router  # lazy: api_urls imports this module's siblings

    for _prefix, viewset, _basename in router.registry:
        allow = getattr(viewset, "field_write_allow_list", None)
        if allow is None:
            continue
        spec = allow()
        if not any(spec.values()):
            continue
        model = getattr(viewset, "queryset", None)
        if model is None:
            continue
        yield model.model, viewset, spec


def _label_for_field(label: str, f) -> str:
    override = LABEL_OVERRIDES.get((label, f.name))
    if override:
        return override
    acronym = ACRONYM_LABELS.get(f.name)
    if acronym:
        return acronym
    verbose = str(getattr(f, "verbose_name", "") or f.name.replace("_", " "))
    return verbose[:1].upper() + verbose[1:]


def _endpoint_map() -> dict[str, str]:
    """model label → its routed list endpoint, read off the router.

    The customization reference registry knows endpoints for the models it
    covers, but not for every FK target (IP roles and zones aren't reference
    models). Deriving from the router covers everything that has an API at all,
    with no second list to maintain."""
    from api.api_urls import router

    out: dict[str, str] = {}
    for prefix, viewset, _basename in router.registry:
        qs = getattr(viewset, "queryset", None)
        if qs is None:
            continue
        out.setdefault(qs.model._meta.label_lower, f"/api/{prefix}/")
    return out


def _describe(model, key: str, target_model=None, *, is_fk=False) -> EditableField | None:
    """Derive a descriptor for one allow-listed field name."""
    label = model._meta.label_lower  # "api.interface"
    # FK allow-lists use the "<name>_id" payload key while the model field is
    # <name>. Only strip for FK keys — InventoryItem.part_id is a real CharField
    # whose name genuinely ends in _id.
    name = key[:-3] if (is_fk and key.endswith("_id")) else key
    try:
        f = model._meta.get_field(name)
    except Exception:
        return None

    common = {
        "key": key,
        "label": _label_for_field(label, f),
        "nullable": bool(getattr(f, "null", False)),
        "hint": str(getattr(f, "help_text", "") or ""),
        "_field": f,
    }

    if isinstance(f, models.ForeignKey):
        related = target_model or f.related_model
        rel_label = related._meta.label_lower
        if rel_label == "api.status":
            # The Status catalog filtered to the owning model, which is the slug
            # Status.available_to stores and /api/statuses/?available_to= filters.
            return EditableField(
                kind="status", status_model=model._meta.model_name, **common
            )
        if rel_label == "api.vlan":
            return EditableField(kind="vlan", **common)
        if rel_label == "api.vrf":
            return EditableField(kind="vrf", **common)
        from customization.object_registry import reference_model

        ref = reference_model(related._meta.model_name)
        return EditableField(
            kind="object",
            object_model=related._meta.model_name,
            # Prefer the reference registry (it knows about ?picker=1 support);
            # fall back to the router so an unregistered FK target is still
            # selectable rather than silently unplannable.
            endpoint=(ref.endpoint if ref else None) or _endpoint_map().get(rel_label),
            picker=bool(ref.picker) if ref else False,
            **common,
        )

    if isinstance(f, models.BooleanField):
        return EditableField(kind="bool", **common)

    if isinstance(f, models.IntegerField):
        # A byte quantity is entered as value + unit; the name is the only honest
        # signal Django gives us, and it's asserted by the tests.
        kind = "bytes" if key.endswith("_bytes") else "int"
        return EditableField(kind=kind, **common)

    if isinstance(f, (models.CharField, models.TextField)):
        flat = list(getattr(f, "flatchoices", []) or [])
        if flat:
            key_name = DCIM_CHOICE_KEYS.get((label, f.name))
            if key_name:
                return EditableField(kind="choice", choices=key_name, **common)
            return EditableField(
                kind="options",
                options=[{"value": v, "label": str(text)} for v, text in flat],
                **common,
            )
        source = SUGGESTION_SOURCES.get((label, f.name))
        return EditableField(
            kind="text", suggestions=source() if source else None, **common,
        )

    # Anything else (dates, JSON, decimals) is not offered rather than guessed at.
    return None


def fields_for(model) -> list[EditableField]:
    """Descriptors for every allow-listed field of ``model``, or ``[]`` when the
    model has no viewset declaring one."""
    for m, _viewset, spec in _viewsets():
        if m is not model:
            continue
        out: list[EditableField] = []
        for key in spec["str"] + spec["bool"] + spec["int"]:
            d = _describe(model, key)
            if d is not None:
                out.append(d)
        for key, target in spec["fk"].items():
            d = _describe(model, key, target_model=target, is_fk=True)
            if d is not None:
                out.append(d)
        return sorted(out, key=lambda d: d.label.lower())
    return []


def field_for(model, key: str) -> EditableField | None:
    for d in fields_for(model):
        if d.key == key:
            return d
    return None


def serializer_for(model):
    """The viewset serializer that owns this model's write invariants — the
    planned-change apply path writes through it rather than setattr."""
    for m, viewset, _spec in _viewsets():
        if m is model:
            return getattr(viewset, "serializer_class", None)
    return None


def covered_models() -> list[tuple[object, dict]]:
    return [(m, spec) for m, _vs, spec in _viewsets()]


# ─── Value coercion, shared with the planned-change apply path ──────────────

def _display_for_fk(spec: EditableField, obj) -> str:
    return str(obj) if obj is not None else ""


def coerce_value(model, spec: EditableField, raw, *, tenant):
    """Validate ``raw`` against the descriptor and the tenant.

    Returns ``(db_value, human_display)``. Raises DRF ``ValidationError`` keyed
    on the field. Mirrors ``ComponentBulkMixin.bulk_update``'s per-kind checks,
    plus ``Status.available_to``, which the bulk path does not check today.
    """
    key = spec.key

    if spec.kind == "bool":
        if not isinstance(raw, bool):
            raise ValidationError({key: "Must be true or false."})
        return raw, "Yes" if raw else "No"

    if spec.kind in {"int", "bytes"}:
        if raw is None:
            if not spec.nullable:
                raise ValidationError({key: "This field can't be empty."})
            return None, ""
        if isinstance(raw, bool) or not isinstance(raw, int):
            raise ValidationError({key: "Must be an integer or null."})
        return raw, str(raw)

    if spec.kind in {"status", "vlan", "vrf", "object"}:
        if raw in (None, ""):
            if not spec.nullable:
                raise ValidationError({key: "This field can't be empty."})
            return None, ""
        related = spec._field.related_model
        qs = related.objects.filter(pk=raw)
        if any(f.name == "tenant" for f in related._meta.get_fields()):
            qs = qs.filter(tenant=tenant)
        obj = qs.first()
        if obj is None:
            raise ValidationError({key: "Not found in this tenant."})
        if spec.kind == "status":
            available = list(getattr(obj, "available_to", None) or [])
            if available and spec.status_model not in available:
                raise ValidationError({
                    key: f"'{obj}' is not available to {spec.status_model}s."
                })
        return str(obj.pk), _display_for_fk(spec, obj)

    # str-backed: choice / options / text
    value = "" if raw is None else str(raw)
    flat = dict(getattr(spec._field, "flatchoices", []) or [])
    if flat and value and value not in flat:
        opts = sorted(flat)
        hint = ", ".join(opts) if len(opts) <= 12 else "see /api/dcim/choices/"
        raise ValidationError(
            {key: f"'{value}' is not a valid choice. Options: {hint}"}
        )
    return value, str(flat.get(value, value))


def read_value(obj, spec: EditableField):
    """The object's current ``(db_value, human_display)`` for this descriptor."""
    if spec.kind in {"status", "vlan", "vrf", "object"}:
        related = getattr(obj, spec._field.name, None)
        return (
            str(related.pk) if related is not None else None,
            _display_for_fk(spec, related),
        )
    raw = getattr(obj, spec.key, None)
    if spec.kind == "bool":
        return bool(raw), "Yes" if raw else "No"
    if spec.kind in {"int", "bytes"}:
        return raw, "" if raw is None else str(raw)
    value = "" if raw is None else str(raw)
    flat = dict(getattr(spec._field, "flatchoices", []) or [])
    return value, str(flat.get(value, value))


# ─── Endpoint ───────────────────────────────────────────────────────────────

@extend_schema(
    summary="Which fields of a model a field-level write path may set",
    tags=["dcim"],
    request=None,
    parameters=[
        OpenApiParameter(
            "model", str, description="Registry slug ('interface') or app label "
            "('api.interface'). Omit to list the covered models.",
        )
    ],
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description=(
            "Editor metadata per writable field (kind, label, nullability, "
            "option-list key). Derived from the viewset's own write allow-list "
            "plus the model's field definitions, so it cannot drift from what a "
            "write accepts. Filtered by the caller's change permission."
        ),
    ),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def editable_fields_view(request):
    from api.views import _get_active_tenant
    from auth_api.object_types import label_for

    tenant = _get_active_tenant(request)
    if tenant is None:
        raise PermissionDenied("No active tenant selected.")

    def may_change(model) -> bool:
        return rbac.has_action(
            request.user, tenant, model._meta.model_name, "change"
        )

    wanted = (request.query_params.get("model") or "").strip()
    if not wanted:
        models_out = []
        for model, _spec in covered_models():
            if not may_change(model):
                continue
            models_out.append({
                "slug": model._meta.model_name,
                "model": model._meta.label_lower,
                "label": str(model._meta.verbose_name_plural).capitalize(),
                "field_count": len(fields_for(model)),
            })
        models_out.sort(key=lambda m: m["label"])
        return Response({"models": models_out})

    # Normalise slug or "app.model" through the RBAC registry, the same rule
    # TaskLinkSerializer.validate_object_type uses.
    label = label_for(wanted)
    if label is None:
        raise NotFound("Unknown object type.")
    try:
        model = apps.get_model(label)
    except LookupError as exc:
        raise NotFound("Unknown object type.") from exc
    if not may_change(model):
        raise PermissionDenied(f"{model._meta.model_name}:change required.")
    specs = fields_for(model)
    if not specs:
        raise NotFound("No editable fields are declared for this model.")
    return Response({
        "model": model._meta.label_lower,
        "slug": model._meta.model_name,
        "label": str(model._meta.verbose_name_plural).capitalize(),
        "fields": [s.payload() for s in specs],
    })
