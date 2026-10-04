"""The list-column catalog: every field a list's rows already carry that is
worth a column, described well enough for the SPA to render one.

``GET /api/list-fields/?path=/api/devices/`` answers "what could this table
show?" for any routed list endpoint - core, monitoring, routing, planning and
plugin routers alike, because it resolves the path the page itself fetches.

The rule is the reverse of :mod:`api.editable_fields`. There the field *names*
are curated and their metadata derived; here names and metadata are both
derived from the viewset's list serializer and the model behind it, and only
the exclusions are curated:

* ``@detail_only`` getters (``api.serializers.detail_only``) - they read 0 or
  empty on a list, so a column of them would be a column of lies;
* a serializer's ``list_columns_exclude`` - internal render settings, flags
  and figure sets nobody wants as a column, and single-instance tab counts
  that are not ``@detail_only`` (they gate on ``isinstance(self.instance, …)``
  because the serializer is also nested ``many=True`` elsewhere);
* a nested list of records none of which has a name (a circuit's
  terminations, an OSPF instance's interfaces) - a cell has nothing to say.

The catalog never adds data. It describes what the list serializer already
returns; a new column comes from a reviewed serializer change (with its
``tests_list_queries`` assertion) and then appears here by itself.
"""
from __future__ import annotations

import datetime
import decimal
import types
import typing
from dataclasses import asdict, dataclass
from urllib.parse import urlsplit

from django.db import models
from django.urls import Resolver404, resolve
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, OpenApiResponse, extend_schema
from rest_framework import serializers
from rest_framework.decorators import api_view, permission_classes
from rest_framework.exceptions import NotFound, PermissionDenied
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response

from api.editable_fields import DCIM_CHOICE_KEYS
from api.field_labels import humanize, label_for_field, label_for_name

# Never a column: identity and plumbing every row carries.
SKIP_NAMES = frozenset({
    "id", "numid", "permissions", "custom_fields", "tenant", "url", "display",
})

# Serializer field classes whose values are structures, not cell values.
SKIP_FIELD_CLASSES = (
    serializers.JSONField, serializers.DictField, serializers.ListField,
    serializers.HStoreField, serializers.FileField, serializers.HiddenField,
    serializers.ManyRelatedField, serializers.PrimaryKeyRelatedField,
    serializers.MultipleChoiceField,
)

# Keys that name an object in a cell - the SPA's objectName() reads the same
# (frontend/src/components/columns/auto-columns.tsx).
NAME_KEYS = (
    "name", "label", "display", "cidr", "ip_address", "prefix", "address",
    "mac_address", "cid", "username", "slug", "asn",
)

# Inline an option list up to this long; longer lists are either named in
# /api/dcim/choices/ (DCIM_CHOICE_KEYS) or shown as their stored value.
MAX_INLINE_OPTIONS = 40

# Shapes derivation cannot read, keyed (model label, field name).
LIST_FIELD_HINTS: dict[tuple[str, str], dict] = {
    # {own, resolved}: the column is the template the device renders with.
    ("api.device", "config_template"): {
        "path": "config_template.resolved", "kind": "object",
        "related": "api.exporttemplate",
    },
    # The device's platform, else its type's default: a platform all the same.
    ("api.device", "effective_platform"): {
        "kind": "object", "related": "api.platform",
    },
    # A model property: the device's airflow, else its type's default.
    ("api.device", "effective_airflow"): {
        "kind": "choice", "options_from": "airflow",
    },
}

# Device fields an administrator can switch off (Settings → Device fields).
# The catalog names the switch; the SPA applies it, so this answer does not
# depend on tenant settings.
DEVICE_FIELD_SWITCHES: dict[str, str] = {
    "comments": "comments", "location": "location", "cluster": "cluster",
    "airflow": "airflow", "effective_airflow": "airflow",
    "latitude": "latitude", "longitude": "longitude",
}

KINDS = (
    "text", "longtext", "ip", "number", "bool", "choice", "date", "datetime",
    "color", "object", "objects", "tags", "auto",
)


@dataclass
class ListField:
    key: str
    label: str
    kind: str
    group: str                      # fields | related
    path: str | None = None         # where the value sits, when not `key`
    related: str | None = None      # "api.region" - the SPA maps it to a route
    via: str | None = None          # the parent's label, for nested fields
    options: list[dict] | None = None
    choices: str | None = None      # a /api/dcim/choices/ list key
    setting: str | None = None      # a device-field switch that hides it
    source: str = ""                # dedupe key; not serialised

    def payload(self) -> dict:
        return {
            k: v for k, v in asdict(self).items()
            if v is not None and k != "source"
        }


# ─── Resolving the list endpoint ─────────────────────────────────────────────

def resolve_list_view(path: str):
    """``(viewset class, initkwargs, actions, match)`` for the list route at
    ``path``, or NotFound. Only ``/api/…`` paths routed to a viewset's
    ``list`` action qualify - anything else is not a table's data source."""
    path = urlsplit(path or "").path
    if not path.startswith("/api/"):
        raise NotFound("Not an API list path.")
    if not path.endswith("/"):
        path += "/"
    try:
        match = resolve(path)
    except Resolver404 as exc:
        raise NotFound("No such list.") from exc
    func = match.func
    cls = getattr(func, "cls", None)
    actions = getattr(func, "actions", None) or {}
    if cls is None or actions.get("get") != "list":
        raise NotFound("Not a list endpoint.")
    return cls, dict(getattr(func, "initkwargs", None) or {}), actions, match


def build_list_view(request, path: str):
    """The viewset instance for ``path`` as its list action would see it, with
    the caller's permission gate already run (raises exactly as the list
    would: 403 without view, 404 for a disabled plugin)."""
    cls, initkwargs, actions, match = resolve_list_view(path)
    view = cls(**initkwargs)
    view.action_map = actions
    view.action = "list"
    view.args = match.args
    view.kwargs = match.kwargs
    view.request = request
    view.headers = {}
    view.format_kwarg = None
    # Run the list's own gate (authentication, RBAC, plugin enablement). It
    # re-negotiates content on the shared request - keep ours.
    kept = {
        k: getattr(request, k, None)
        for k in ("accepted_renderer", "accepted_media_type", "version",
                  "versioning_scheme")
    }
    try:
        view.initial(request, *match.args, **match.kwargs)
    finally:
        for k, v in kept.items():
            setattr(request, k, v)
    return view


# ─── Deriving fields ─────────────────────────────────────────────────────────

def _model_field(model, source: str):
    """The model field a dotted ``source`` lands on, or None."""
    if model is None or not source or source == "*":
        return None
    field = None
    current = model
    for part in source.split("."):
        if current is None:
            return None
        try:
            field = current._meta.get_field(part)
        except Exception:
            return None
        current = field.related_model if field.is_relation else None
    return field


def _is_fk_id(model, field, name: str) -> bool:
    """A raw id column: a foreign key's (``site_id``, a ReadOnlyField sourced
    from ``manufacturer_id``) or an annotated one with no model field behind
    it (``synced_from_id``). A real field whose name happens to end in
    ``_id`` - VLAN ``vlan_id``, rack ``facility_id``, ``router_id`` - is data."""
    source = field.source if field.source not in (None, "*") else name
    if model is None or not source.endswith("_id"):
        return False
    attname = source.split(".")[-1]
    for f in model._meta.concrete_fields:
        if f.attname == attname:
            return f.is_relation
    return "." not in source and not isinstance(field, serializers.SerializerMethodField)


def _method(serializer, field):
    return getattr(serializer, field.method_name, None)


def _strip_optional(tp):
    args = typing.get_args(tp)
    origin = typing.get_origin(tp)
    if origin in (typing.Union, types.UnionType):
        rest = [a for a in args if a is not type(None)]
        return rest[0] if len(rest) == 1 else None
    return tp


def _kind_from_python(tp) -> str | None:
    tp = _strip_optional(tp)
    if tp is None:
        return None
    origin = typing.get_origin(tp) or tp
    if origin is bool:
        return "bool"
    if origin in (int, float, decimal.Decimal):
        return "number"
    if origin is str:
        return "text"
    if origin is datetime.datetime:
        return "datetime"
    if origin is datetime.date:
        return "date"
    if origin in (dict, list, tuple, set):
        return "skip-structure" if origin is not dict else None
    return None


_OPENAPI_KINDS = {
    OpenApiTypes.STR: "text", OpenApiTypes.INT: "number",
    OpenApiTypes.FLOAT: "number", OpenApiTypes.DOUBLE: "number",
    OpenApiTypes.NUMBER: "number", OpenApiTypes.DECIMAL: "number",
    OpenApiTypes.BOOL: "bool", OpenApiTypes.DATE: "date",
    OpenApiTypes.DATETIME: "datetime", OpenApiTypes.IP4: "ip",
    OpenApiTypes.IP6: "ip",
}


def _kind_from_method(serializer, field) -> str | None:
    fn = _method(serializer, field)
    if fn is None:
        return None
    # ``@extend_schema_field(X)`` stores ``{"field": X, …}`` on the getter.
    # Only a scalar type decides the kind here: a getter typed as a list or
    # dict field often returns named objects (MAC addresses), which the
    # model field or the value's own shape describes better.
    ann = getattr(fn, "_spectacular_annotation", None)
    annotated = ann.get("field") if isinstance(ann, dict) else ann
    if annotated is not None:
        if isinstance(annotated, OpenApiTypes):
            kind = _OPENAPI_KINDS.get(annotated)
            if kind:
                return kind
        else:
            inst = annotated() if isinstance(annotated, type) else annotated
            if isinstance(inst, serializers.Field):
                kind = _kind_from_field_class(inst)
                if kind and kind != "skip-structure":
                    return kind
    try:
        hints = typing.get_type_hints(fn)
    except Exception:
        return None
    if "return" not in hints:
        return None
    return _kind_from_python(hints["return"])


def _kind_from_field_class(field) -> str | None:
    """The kind a declared serializer field class implies on its own."""
    if isinstance(field, SKIP_FIELD_CLASSES):
        return "skip-structure"
    if isinstance(field, serializers.BooleanField):
        return "bool"
    if isinstance(field, (serializers.IntegerField, serializers.FloatField,
                          serializers.DecimalField)):
        return "number"
    if isinstance(field, serializers.DateTimeField):
        return "datetime"
    if isinstance(field, serializers.DateField):
        return "date"
    if isinstance(field, serializers.IPAddressField):
        return "ip"
    if isinstance(field, serializers.ChoiceField):
        return "choice"
    return None


def _kind_from_model_field(f) -> str | None:
    if f is None:
        return None
    if isinstance(f, models.JSONField) or isinstance(f, (models.FileField,)):
        return "skip-structure"
    if f.many_to_many or f.one_to_many:
        from core.models import Tag

        return "tags" if f.related_model is Tag else "objects"
    if f.is_relation:
        return "object"
    if isinstance(f, models.BooleanField):
        return "bool"
    if isinstance(f, (models.IntegerField, models.DecimalField, models.FloatField)):
        return "number"
    if isinstance(f, models.DateTimeField):
        return "datetime"
    if isinstance(f, models.DateField):
        return "date"
    if isinstance(f, models.GenericIPAddressField):
        return "ip"
    if getattr(f, "flatchoices", None):
        return "choice"
    if isinstance(f, models.TextField):
        return "longtext"
    if isinstance(f, models.CharField):
        if "color" in f.name or "colour" in f.name:
            return "color"
        return "text"
    return None


def _options(model_label: str, f, field) -> tuple[list[dict] | None, str | None]:
    """``(inline options, dcim choices key)`` for a choice field."""
    name = getattr(f, "name", None)
    if name and (model_label, name) in DCIM_CHOICE_KEYS:
        return None, DCIM_CHOICE_KEYS[(model_label, name)]
    flat = list(getattr(f, "flatchoices", None) or [])
    if not flat and isinstance(field, serializers.ChoiceField):
        flat = list(field.choices.items())
    flat = [(v, t) for v, t in flat if v not in ("", None)]
    if not flat or len(flat) > MAX_INLINE_OPTIONS:
        return None, None
    return [{"value": v, "label": str(t)} for v, t in flat], None


def _is_display_twin(serializer, name, field) -> bool:
    """``type_display`` next to ``type``: the choice column already shows the
    label, so the ``get_<x>_display`` twin is not a second column."""
    if not name.endswith("_display"):
        return False
    return name[: -len("_display")] in serializer.fields


def _describe(serializer, name, field, model, model_label, *, nested=False) -> ListField | None:
    """One field of ``serializer`` as a column, or None when it is not one."""
    if name in SKIP_NAMES or field.write_only:
        return None
    if _is_display_twin(serializer, name, field):
        return None
    if _is_fk_id(model, field, name):
        return None
    if isinstance(field, serializers.SerializerMethodField):
        fn = _method(serializer, field)
        if fn is not None and getattr(fn, "detail_only", False):
            return None
        source = name
    else:
        source = field.source if field.source not in (None, "*") else name

    f = _model_field(model, source)
    related = None
    kind = None
    if isinstance(field, serializers.ListSerializer):
        child_model = getattr(getattr(field.child, "Meta", None), "model", None)
        from core.models import Tag

        child_fields = getattr(field.child, "fields", {})
        if not any(k in child_fields for k in NAME_KEYS):
            return None  # records without a name: nothing for a cell to say
        kind = "tags" if child_model is Tag else "objects"
        related = child_model._meta.label_lower if child_model else None
    elif isinstance(field, serializers.BaseSerializer):
        child_model = getattr(getattr(field, "Meta", None), "model", None)
        kind = "object"
        related = child_model._meta.label_lower if child_model else None
    elif isinstance(field, serializers.SerializerMethodField):
        kind = _kind_from_method(serializer, field)
    elif isinstance(field, serializers.RelatedField):
        kind = "text"  # StringRelatedField, SlugRelatedField: a rendered name
    else:
        kind = _kind_from_field_class(field)
        if kind is None and isinstance(field, serializers.CharField):
            kind = _kind_from_model_field(f) or "text"
            if kind in ("object", "objects", "tags"):
                kind = "text"
    if kind is None:
        kind = _kind_from_model_field(f)
    if kind == "skip-structure":
        return None
    if kind is None:
        kind = "auto"
    if kind in ("object", "objects", "tags") and related is None and f is not None \
            and f.is_relation:
        related = f.related_model._meta.label_lower

    label = label_for_field(model_label, f) if (f is not None and f.name == name.split(".")[-1]) \
        else label_for_name(name)
    options = choices = None
    if f is not None and (model_label, f.name) in DCIM_CHOICE_KEYS and kind == "text":
        kind = "choice"  # a lenient CharField over a published taxonomy
    if kind == "choice":
        options, choices = _options(model_label, f, field)
    return ListField(
        key=name, label=label, kind=kind,
        group="related" if (nested or kind in ("object", "objects")) else "fields",
        related=related, options=options, choices=choices, source=source,
    )


def _nested_children(serializer, parent: ListField, field) -> list[ListField]:
    """One hop into a nested serializer field: its declared children that are
    relations on the child model (``site.region``). Only through a real nested
    serializer - a method field's dict is hand-built and its keys are not
    knowable here."""
    child_model = getattr(getattr(field, "Meta", None), "model", None)
    if child_model is None:
        return []
    out = []
    child_label = child_model._meta.label_lower
    for cname, cfield in field.fields.items():
        if cname in SKIP_NAMES or cfield.write_only:
            continue
        source = name_source(cname, cfield)
        f = _model_field(child_model, source)
        if f is None or not f.is_relation:
            continue
        d = _describe(field, cname, cfield, child_model, child_label, nested=True)
        if d is None:
            continue
        d.key = f"{parent.key}.{cname}"
        d.source = f"{parent.source}.{d.source}"
        d.via = parent.label
        out.append(d)
    return out


def name_source(name: str, field) -> str:
    if isinstance(field, serializers.SerializerMethodField):
        return name
    return field.source if field.source not in (None, "*") else name


def _apply_hint(d: ListField, model_label: str, model):
    hint = LIST_FIELD_HINTS.get((model_label, d.key))
    if not hint:
        return
    d.path = hint.get("path", d.path)
    d.kind = hint.get("kind", d.kind)
    d.related = hint.get("related", d.related)
    if d.kind in ("object", "objects"):
        d.group = "related"
    source = hint.get("options_from")
    if source:
        f = _model_field(model, source)
        d.options, d.choices = _options(model_label, f, None)


def _disambiguate(fields: list[ListField]) -> None:
    """A nested label that repeats a top-level one names its parent: "Site
    region" next to a row's own "Region"."""
    seen: dict[str, int] = {}
    for d in fields:
        seen[d.label.lower()] = seen.get(d.label.lower(), 0) + 1
    for d in fields:
        if d.via and seen[d.label.lower()] > 1:
            first, _, rest = d.label.partition(" ")
            lowered = first if first.isupper() else first.lower()
            d.label = humanize(f"{d.via} {lowered}{(' ' + rest) if rest else ''}")


def catalog_for(view) -> dict:
    """The column catalog of ``view``'s list serializer. A plain ViewSet that
    builds its list by hand has no serializer to read, so no catalog."""
    if not hasattr(view, "get_serializer_class"):
        return {"model": None, "slug": None, "cf_model": None, "fields": []}
    serializer_cls = view.get_serializer_class()
    serializer = serializer_cls(context=view.get_serializer_context())
    model = getattr(getattr(serializer_cls, "Meta", None), "model", None)
    if model is None:
        qs = getattr(view, "queryset", None)
        model = getattr(qs, "model", None)
    model_label = model._meta.label_lower if model is not None else ""
    exclude = set(getattr(serializer_cls, "list_columns_exclude", ()) or ())

    fields: list[ListField] = []
    for name, field in serializer.fields.items():
        if name in exclude:
            continue
        d = _describe(serializer, name, field, model, model_label)
        if d is None:
            continue
        _apply_hint(d, model_label, model)
        fields.append(d)
        if isinstance(field, serializers.BaseSerializer) and \
                not isinstance(field, serializers.ListSerializer):
            fields.extend(c for c in _nested_children(serializer, d, field)
                          if c.key not in exclude)

    # Aliases (``address = CharField(source="location")``) are one column:
    # keep the field named after its source, else the first.
    by_source: dict[str, ListField] = {}
    for d in fields:
        kept = by_source.get(d.source)
        if kept is None or (d.key == d.source and kept.key != kept.source):
            by_source[d.source] = d
    fields = [d for d in fields if by_source.get(d.source) is d]

    if model_label == "api.device":
        for d in fields:
            d.setting = DEVICE_FIELD_SWITCHES.get(d.key)
    _disambiguate(fields)

    from core.models import CustomFieldsMixin

    cf_model = None
    if model is not None and "custom_fields" in serializer.fields \
            and isinstance(model, type) and issubclass(model, CustomFieldsMixin):
        cf_model = model._meta.model_name

    return {
        "model": model_label or None,
        "slug": model._meta.model_name if model is not None else None,
        "cf_model": cf_model,
        "fields": [d.payload() for d in fields],
    }


def visible_custom_fields(request, tenant, cf_model: str, list_slug: str | None) -> list[dict]:
    """The custom-field definitions a caller who can read the list may see as
    columns: this tenant's non-hidden fields for ``cf_model``, cut to the
    catalog-locality the list's own site scope allows (a site-local field
    belongs to its site's users). Served here, behind the list's gate, because
    a role that can view devices but not the custom-field catalog still sees
    the values in every row."""
    from auth_api import rbac
    from auth_api.site_paths import site_path_for
    from customization.models import CustomField

    qs = (
        CustomField.objects.filter(
            tenant=tenant, applies_to__contains=[cf_model], hidden=False
        )
        .select_related("group")
        .order_by("weight", "label")
    )
    if site_path_for("customfield", tenant) is not None and list_slug:
        scope = rbac.site_scope(request.user, tenant, list_slug, "view")
        if scope is not None:
            from django.db.models import Q

            qs = qs.filter(Q(owning_site__isnull=True) | Q(owning_site_id__in=scope))
    out = []
    for cf in qs:
        out.append({
            "key": cf.key,
            "label": cf.label,
            "type": cf.type,
            "choices": list(cf.choices or []),
            "related_model": cf.related_model or "",
            "weight": cf.weight,
            "group": str(cf.group_id) if cf.group_id else None,
            "group_name": cf.group.name if cf.group_id else None,
            "group_weight": cf.group.weight if cf.group_id else None,
        })
    return out


# ─── Endpoint ───────────────────────────────────────────────────────────────

@extend_schema(
    summary="The columns a list's rows can show",
    tags=["dcim"],
    request=None,
    parameters=[
        OpenApiParameter(
            "path", str, required=True,
            description="The list endpoint's path, e.g. /api/devices/ or "
            "/api/routing/prefix-lists/.",
        )
    ],
    responses=OpenApiResponse(
        response=OpenApiTypes.OBJECT,
        description=(
            "Every field the list serializer returns that can be a column: "
            "key (a dotted path into the row), label, kind, group, and for "
            "choices the options or a /api/dcim/choices/ key. Plus the model's "
            "visible custom-field definitions. Gated exactly like the list."
        ),
    ),
)
@api_view(["GET"])
@permission_classes([IsAuthenticated])
def list_fields_view(request):
    from api.views import _get_active_tenant

    tenant = _get_active_tenant(request)
    if tenant is None:
        raise PermissionDenied("No active tenant selected.")
    path = (request.query_params.get("path") or "").strip()
    view = build_list_view(request, path)
    body = catalog_for(view)
    body["path"] = urlsplit(path).path
    body["custom_fields"] = (
        visible_custom_fields(request, tenant, body["cf_model"], body["slug"])
        if body["cf_model"] else []
    )
    return Response(body)
