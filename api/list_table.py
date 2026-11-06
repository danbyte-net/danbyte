"""Server-side paging, sorting and filtering for the big lists (#482, #487).

The Devices, Interfaces, Cables and Virtual machines lists page on the
server: the SPA asks for one page at a time and the API sorts, filters and
counts. A viewset opts in with :class:`TableListMixin` and a
:class:`TableSpec`; every parameter below is ignored by every other action,
so API clients and detail views see the list exactly as before.

``GET <list>/?…``

* ``ordering=<column>`` or ``-<column>`` - one column id of the list's table
  (``name``, ``site``, ``updated``…), a catalog column's key (``site.region``,
  ``serial_number``) or ``custom_fields.<key>``. Names sort naturally
  (``Ethernet1/2`` before ``Ethernet1/10``); empty values sort last both
  ways. An id the table cannot sort by is a 400.
* ``f_<facet>=a,b`` - the rail's selection, in the URL codec of
  ``frontend/src/lib/url-filters.ts`` (comma-separated, ``\\`` escapes).
  ``__none__`` is the empty bucket. A range facet takes ``min..max``. Values
  within a facet OR, facets AND. An unknown facet is a 400.
* ``expr=<AST as JSON>`` - the advanced filter (``lib/filter-expr.ts``),
  compiled to SQL here with the client's semantics.
* ``view=table`` - the slim row: only what the table's columns, custom
  columns and row actions read (:attr:`TableSpec.fields`). ``include=a,b``
  adds full-row fields a catalog column (#243) shows.

``GET <list>/facets/?…`` - the rail: ``{facets: {id: [{value, label, color,
text_color, count}]}, sortable: [...]}``. Each facet counts the rows every
other filter leaves (the search box, the other facets, the expression), so
ticking a value never hides its neighbours. Scoped like the list: tenant,
RBAC rows, site scope.
"""
from __future__ import annotations

import datetime
import json
import re
import uuid
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field

from django.db import models
from django.db.models import Count, F, Q
from django.db.models.fields.json import KeyTransform
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema
from rest_framework import serializers
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response

from .natural import natural

NONE = "__none__"
#: Buckets one facet returns at most - most used first, the selected always.
FACET_CAP = 500
#: Expression limits, as for compliance rules (core.expressions).
MAX_LEAVES = 50
MAX_DEPTH = 4
MAX_VALUES = 200
MAX_EXPR = 16 * 1024

_CF_KEY = re.compile(r"^[A-Za-z0-9_-]+$")
_NUM = re.compile(r"^-?\d+(\.\d+)?$")


# ─── The URL codec ───────────────────────────────────────────────────────────

def decode_list(raw: str | None) -> list[str]:
    """``a,b\\,c`` → ``["a", "b,c"]`` - ``decodeList`` in lib/url-filters."""
    if not raw:
        return []
    out, cur, i = [], "", 0
    while i < len(raw):
        c = raw[i]
        if c == "\\" and i + 1 < len(raw):
            cur += raw[i + 1]
            i += 2
            continue
        if c == ",":
            out.append(cur)
            cur = ""
        else:
            cur += c
        i += 1
    out.append(cur)
    seen: list[str] = []
    for v in out:
        if v and v not in seen:
            seen.append(v)
    return seen


def decode_range(raw: str | None) -> tuple[float | None, float | None]:
    """``min..max`` → numbers; a side that is not a number is open."""
    parts = (raw or "").split("..")
    if len(parts) != 2:
        return None, None

    def side(s):
        s = s.strip()
        return float(s) if _NUM.match(s) else None

    return side(parts[0]), side(parts[1])


# ─── Facets ──────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Facet:
    """One rail facet of a list.

    ``group`` buckets rows by the value at ``field`` (an FK id, a choice, a
    name), labelled from ``label`` / ``color`` / ``text_color`` paths.
    ``buckets`` names its values up front, each with a ``Q`` (a status
    derived from dates). ``tags`` buckets by tag slug. ``range`` filters a
    number between two bounds and has no options."""

    kind: str = "group"
    field: str = ""
    label: str = ""
    color: str = ""
    #: ``color -> text colour`` for a coloured bucket (a status, a tag).
    text_color: Callable | None = None
    #: Label of the empty bucket; None leaves the wording to the SPA.
    none_label: str | None = None
    #: The empty bucket's key - the SPA facet's own (``__none__``).
    none_key: str = NONE
    #: An empty string is the empty bucket too.
    blank: bool = False
    #: Bucket values are UUIDs: a malformed one matches nothing.
    uuid: bool = False
    #: Labels for coded values (choices) - a mapping, or a callable that
    #: returns one; a value not listed shows as itself.
    labels: Mapping[str, str] | Callable | None = None
    #: Annotations ``field`` / the buckets read: ``(qs, request) -> qs``.
    prepare: Callable | None = None
    #: ``buckets``: ``request -> {value: Q}``.
    buckets: Callable | None = None
    #: ``range``: ``(qs, request, lo, hi) -> qs``.
    between: Callable | None = None

    def filter(self, qs, request, values):
        if self.kind == "range":
            lo, hi = decode_range(values)
            if lo is None and hi is None:
                return qs
            return self.between(qs, request, lo, hi)
        wanted = decode_list(values)
        if not wanted:
            return qs
        if len(wanted) > MAX_VALUES:
            raise ValidationError({"facets": "Too many values in one facet."})
        if self.kind == "tags":
            model = qs.model
            holders = model.objects.filter(tags__slug__in=wanted).values("pk")
            return qs.filter(pk__in=holders)
        if self.prepare:
            qs = self.prepare(qs, request)
        if self.kind == "buckets":
            known = self.buckets(request)
            q = Q(pk__in=[])
            for v in wanted:
                if v in known:
                    q |= known[v]
            return qs.filter(q)
        values_ = [v for v in wanted if v != self.none_key]
        if self.uuid:
            values_ = [v for v in values_ if _is_uuid(v)]
        q = Q(**{f"{self.field}__in": values_}) if values_ else Q(pk__in=[])
        if self.none_key in wanted:
            q |= Q(**{f"{self.field}__isnull": True})
            if self.blank:
                q |= Q(**{self.field: ""})
        return qs.filter(q)

    def count(self, qs, request, selected: list[str]) -> list[dict]:
        if self.kind == "range":
            return []
        if self.kind == "tags":
            return _tag_buckets(qs, selected)
        if self.prepare:
            qs = self.prepare(qs, request)
        if self.kind == "buckets":
            known = self.buckets(request)
            got = qs.order_by().aggregate(**{
                f"b{i}": Count("pk", filter=q, distinct=True)
                for i, q in enumerate(known.values())
            })
            out = [
                {"value": v, "label": (self.labels or {}).get(v), "count": got[f"b{i}"]}
                for i, v in enumerate(known)
            ]
            out = [o for o in out if o["count"]]
            out.sort(key=lambda o: -o["count"])
            return out
        labels = self.labels() if callable(self.labels) else self.labels
        paths = [p for p in (self.label, self.color) if p]
        rows = (
            qs.order_by().values(self.field, *paths)
            .annotate(_n=Count("pk", distinct=True)).order_by("-_n")
        )
        merged: dict[str, dict] = {}
        for r in rows:
            raw = r[self.field]
            empty = raw is None or (self.blank and raw == "")
            key = self.none_key if empty else str(raw)
            got = merged.get(key)
            if got is None:
                # No label: the SPA words the value itself (a choice, a name).
                label = self.none_label if empty else (
                    r[self.label] if self.label
                    else (labels.get(key, key) if labels is not None else None)
                )
                got = merged[key] = {"value": key, "label": label, "count": 0}
                if self.color and not empty:
                    got["color"] = r[self.color] or None
                    if self.text_color is not None:
                        got["text_color"] = self.text_color(r[self.color])
            got["count"] += r["_n"]
        out = sorted(merged.values(), key=lambda o: -o["count"])
        return _cap(out, selected)


def _is_uuid(v: str) -> bool:
    try:
        uuid.UUID(str(v))
    except ValueError:
        return False
    return True


def _text_color(color: str | None) -> str | None:
    """A tag's or a status's badge text on ``color`` (the same luminance rule)."""
    if not color:
        return None
    from core.models import Tag

    return Tag(color=color).text_color or None


def _cap(out: list[dict], selected: list[str]) -> list[dict]:
    if len(out) <= FACET_CAP:
        return out
    keep = out[:FACET_CAP]
    have = {o["value"] for o in keep}
    keep += [o for o in out[FACET_CAP:] if o["value"] in selected and o["value"] not in have]
    return keep


def _tag_buckets(qs, selected):
    rows = (
        qs.order_by().filter(tags__isnull=False)
        .values("tags__id", "tags__slug", "tags__name", "tags__color")
        .annotate(_n=Count("pk", distinct=True)).order_by("-_n")
    )
    merged: dict[str, dict] = {}
    for r in rows:
        slug = r["tags__slug"]
        got = merged.get(slug)
        if got is None:
            got = merged[slug] = {
                "value": slug, "label": r["tags__name"], "count": 0,
                "color": r["tags__color"] or None,
                "text_color": _text_color(r["tags__color"]),
                "id": r["tags__id"],
            }
        got["count"] += r["_n"]
    return _cap(sorted(merged.values(), key=lambda o: -o["count"]), selected)


def fk(field: str, *, label: str = "name", color: str = "", none_label: str | None = None,
       none_key: str = NONE, text: bool = False) -> Facet:
    """A facet over a foreign key: bucket = the related id, label = its name
    (and ``color``, with a badge text colour when ``text``)."""
    base = field.removesuffix("_id")
    return Facet(
        field=f"{base}_id" if "__" not in base else f"{base}__id",
        label=f"{base}__{label}" if label else "",
        color=f"{base}__{color}" if color else "",
        text_color=_text_color if text else None,
        none_label=none_label, none_key=none_key, uuid=True,
    )


def value(field: str, *, labels: Mapping[str, str] | None = None,
          none_label: str | None = None, prepare=None) -> Facet:
    """A facet over a plain value (a choice, a name): bucket = the value."""
    return Facet(field=field, labels=labels, none_label=none_label, blank=True,
                 prepare=prepare)


TAGS_FACET = Facet(kind="tags")


# ─── Sorting ─────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Sort:
    """How one column orders: ORM paths or expressions, first to last.
    ``prepare(qs, request)`` adds the annotations they read."""

    keys: tuple
    prepare: Callable | None = None


def nat(path: str) -> Sort:
    """A name: the natural collation."""
    return Sort((natural(path),))


def by(*paths) -> Sort:
    return Sort(tuple(paths))


def _order_terms(sort: Sort, desc: bool):
    out = []
    for k in sort.keys:
        expr = F(k) if isinstance(k, str) else k
        out.append(expr.desc(nulls_last=True) if desc else expr.asc(nulls_last=True))
    return out


# ─── The spec ────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class TableSpec:
    #: Facet id (the SPA column's) → Facet.
    facets: Mapping[str, Facet] = field(default_factory=dict)
    #: Column id → Sort. Catalog keys resolve from the model by themselves.
    sorts: Mapping[str, Sort] = field(default_factory=dict)
    #: The slim row's serializer fields (``view=table``).
    fields: tuple[str, ...] = ()
    #: Full-row fields ``include`` may add without the full queryset, and
    #: what each needs on the queryset: ``(qs) -> qs`` or None.
    cheap: Mapping[str, Callable | None] = field(default_factory=dict)
    #: The advanced filter's field paths that name something else on the
    #: model (``device_type`` for the SPA's ``type``…): path → ORM path.
    aliases: Mapping[str, str] = field(default_factory=dict)


def _catalog_sort(model, key: str, serializer_cls) -> Sort | None:
    """A catalog column's key → how it sorts, when it lands on a column of
    the model (``site.region`` → the region's name); None otherwise. A custom
    field is ``custom_fields.<key>`` or its column id ``cf_<key>``."""
    if key.startswith(("custom_fields.", "cf_")):
        cf = key.split(".", 1)[1] if key.startswith("custom_fields.") else key[3:]
        if not _CF_KEY.match(cf):
            return None
        return Sort((KeyTransform(cf, "custom_fields"),))
    path = _orm_path(model, key, serializer_cls)
    if path is None:
        return None
    f = _model_field(model, path)
    if f is None or f.many_to_many or f.one_to_many:
        return None
    if f.is_relation:
        target = f.related_model
        for name in ("name", "label", "slug"):
            try:
                target._meta.get_field(name)
            except Exception:
                continue
            return Sort((natural(f"{path}__{name}"),))
        return None
    if isinstance(f, (models.CharField, models.TextField)) and not getattr(f, "choices", None):
        return Sort((natural(path),))
    return Sort((path,))


def _model_field(model, path: str):
    current, f = model, None
    for part in path.split("__"):
        if current is None:
            return None
        try:
            f = current._meta.get_field(part)
        except Exception:
            return None
        current = f.related_model if f.is_relation else None
    return f


#: The keys a hand-built object (a method field's dict) names itself by - the
#: one hop past such a field a sort or a filter may take.
_NAME_KEYS = frozenset({"name", "slug", "label", "ip_address", "dns_name", "vlan_id", "model"})


def _readable(serializer_cls, name: str):
    """``(declared field or None, readable)`` - whether the list's rows carry
    ``name``. Only what a row shows can be sorted or filtered by: a model
    field the serializer leaves out (or writes only) is out of reach."""
    meta = getattr(serializer_cls, "Meta", None)
    listed = getattr(meta, "fields", ()) or ()
    declared = getattr(serializer_cls, "_declared_fields", {}).get(name)
    if declared is not None:
        return declared, not declared.write_only and (listed == "__all__" or name in listed)
    return None, listed == "__all__" or name in listed


def _orm_path(model, key: str, serializer_cls=None) -> str | None:
    """A row key → its ORM path (``site.region`` → ``site__region``), when
    the rows carry it and every hop is a model field: the first hop through
    the serializer field's ``source``, a nested serializer's own fields
    after it, and past a hand-built object only its name."""
    parts = key.split(".")
    if serializer_cls is not None:
        f, ok = _readable(serializer_cls, parts[0])
        if not ok or isinstance(f, serializers.ListSerializer):
            return None
        src = parts[0]
        if f is not None and not isinstance(f, serializers.SerializerMethodField):
            s = getattr(f, "source", None)
            if s == "*" or (s and "." in s):
                return None
            src = s or src
        rest = parts[1:]
        if rest:
            if isinstance(f, serializers.BaseSerializer):
                child, ok = _readable(type(f), rest[0])
                if not ok or isinstance(child, serializers.ListSerializer) or (
                    len(rest) > 1 and rest[-1] not in _NAME_KEYS
                ):
                    return None
            elif len(rest) != 1 or rest[0] not in _NAME_KEYS:
                return None
        parts = [src, *rest]
    path = "__".join(parts)
    return path if _model_field(model, path) is not None else None


# ─── The advanced filter ─────────────────────────────────────────────────────

class _Expr:
    """The advanced filter's AST (lib/filter-expr.ts) as a ``Q``, with the
    client evaluator's semantics: strings compare without case, ``~`` is
    containment, ``in`` is equality with any value, a path that lands on an
    object compares its name, a field with no value matches no positive
    comparison and every negative one, a many-valued field (tags) matches
    when any element does and a negative one only when none does."""

    def __init__(self, model, spec: TableSpec, serializer_cls):
        self.model = model
        self.spec = spec
        self.serializer_cls = serializer_cls
        self.leaves = 0

    def q(self, node, depth=1) -> Q:
        if not isinstance(node, dict):
            raise ValidationError({"expr": "Not a filter expression."})
        if depth > MAX_DEPTH:
            raise ValidationError({"expr": "Nested too deep."})
        kind = node.get("kind")
        if kind == "group":
            terms = node.get("terms")
            if not isinstance(terms, list) or not terms:
                raise ValidationError({"expr": "An empty group."})
            parts = [self.q(t, depth + 1) for t in terms]
            out = parts[0]
            for p in parts[1:]:
                out = (out | p) if node.get("op") == "or" else (out & p)
            return out
        self.leaves += 1
        if self.leaves > MAX_LEAVES:
            raise ValidationError({"expr": "Too many conditions."})
        fld = node.get("field")
        if not isinstance(fld, str) or not fld:
            raise ValidationError({"expr": "A condition without a field."})
        target = self._resolve(fld)
        if kind == "empty":
            q = self._empty(target)
            return ~q if node.get("negated") else q
        if kind != "cmp":
            raise ValidationError({"expr": "Not a filter expression."})
        cmp = node.get("cmp")
        if cmp in ("in", "not_in"):
            values = node.get("values")
            if not isinstance(values, list) or len(values) > MAX_VALUES:
                raise ValidationError({"expr": f"{fld}: a list of values."})
            q = Q(pk__in=[])
            for v in values:
                q |= self._cmp(target, "=", str(v))
            return ~q if cmp == "not_in" else q
        v = node.get("value")
        if not isinstance(v, (str, int, float)) or len(str(v)) > 255:
            raise ValidationError({"expr": f"{fld}: a value."})
        v = str(v)
        if cmp in ("!=", "!~", "not_matches"):
            positive = {"!=": "=", "!~": "~", "not_matches": "matches"}[cmp]
            return ~self._cmp(target, positive, v)
        if cmp not in ("=", "~", ">", "<", ">=", "<=", "matches"):
            raise ValidationError({"expr": f"{fld}: unknown comparison."})
        return self._cmp(target, cmp, v)

    def _resolve(self, fld: str):
        """``(kind, orm path)``: kind is ``tags``, ``json``, ``text``,
        ``number``, ``date``, ``bool``."""
        if fld == "tags" or fld.startswith("tags."):
            return ("tags", "")
        if fld.startswith("custom_fields."):
            key = fld.split(".", 1)[1]
            if not _CF_KEY.match(key):
                raise ValidationError({"expr": f"Unknown field: {fld}."})
            return ("json", key)
        alias = self.spec.aliases.get(fld)
        path = alias or _orm_path(self.model, fld, self.serializer_cls)
        if path is None and fld.endswith((".name", ".slug", ".label")):
            path = _orm_path(self.model, fld.rsplit(".", 1)[0], self.serializer_cls)
            if path is not None:
                path = f"{path}__{fld.rsplit('.', 1)[1]}"
        f = _model_field(self.model, path) if path else None
        if f is None or f.one_to_many or f.many_to_many:
            raise ValidationError({"expr": f"Unknown field: {fld}."})
        if f.is_relation:
            target = f.related_model
            for name in ("name", "label", "slug"):
                try:
                    target._meta.get_field(name)
                except Exception:
                    continue
                return ("text", f"{path}__{name}")
            raise ValidationError({"expr": f"Unknown field: {fld}."})
        if isinstance(f, (models.IntegerField, models.FloatField, models.DecimalField)):
            return ("number", path)
        if isinstance(f, (models.DateField, models.DateTimeField)):
            return ("date", path)
        if isinstance(f, models.BooleanField):
            return ("bool", path)
        return ("text", path)

    def _empty(self, target) -> Q:
        kind, path = target
        if kind == "tags":
            return ~Q(pk__in=self.model.objects.filter(tags__isnull=False).values("pk"))
        if kind == "json":
            return (Q(**{f"custom_fields__{path}__isnull": True})
                    | Q(**{f"custom_fields__{path}": ""}))
        q = Q(**{f"{path}__isnull": True})
        if kind == "text":
            q |= Q(**{path: ""})
        return q

    def _cmp(self, target, cmp: str, v: str) -> Q:
        kind, path = target
        if kind == "tags":
            lookup = {"=": "iexact", "~": "icontains", "matches": "regex"}.get(cmp)
            if lookup is None:
                raise ValidationError({"expr": "Tags compare with is, contains or matches."})
            holders = self.model.objects.filter(
                Q(**{f"tags__name__{lookup}": v}) | Q(**{f"tags__slug__{lookup}": v})
            ).values("pk")
            return Q(pk__in=holders)
        if kind == "json":
            path = f"custom_fields__{path}"
            if cmp in (">", "<", ">=", "<=") and _NUM.match(v):
                lookup = {">": "gt", "<": "lt", ">=": "gte", "<=": "lte"}[cmp]
                return Q(**{f"{path}__{lookup}": float(v)})
            kind = "text"
        if cmp == "matches":
            from core.expressions import regex_error

            problem = regex_error(v)
            if problem:
                raise ValidationError({"expr": problem})
            return Q(**{f"{path}__regex": v})
        if kind == "number":
            # Not a number: matches nothing, as the client's comparison.
            if not _NUM.match(v):
                return Q(pk__in=[])
            lookup = {"=": "exact", "~": "exact", ">": "gt", "<": "lt",
                      ">=": "gte", "<=": "lte"}[cmp]
            return Q(**{f"{path}__{lookup}": float(v)})
        if kind == "bool":
            truth = v.strip().lower() in ("true", "yes", "1", "on")
            return Q(**{path: truth})
        if kind == "date":
            # ISO dates compare as text on the client: a day, or a prefix of
            # one (`2026-09`), against the stored value.
            if cmp in ("=", "~"):
                return Q(**{f"{path}__startswith": v})
            try:
                day = datetime.date.fromisoformat(v[:10])
            except ValueError:
                return Q(pk__in=[])
            lookup = {">": "gt", "<": "lt", ">=": "gte", "<=": "lte"}[cmp]
            return Q(**{f"{path}__{lookup}": day})
        lookup = {"=": "iexact", "~": "icontains", ">": "gt", "<": "lt",
                  ">=": "gte", "<=": "lte"}[cmp]
        return Q(**{f"{path}__{lookup}": v})


# ─── The viewset mixin ───────────────────────────────────────────────────────

class TableSerializerMixin:
    """Serializer side of ``view=table``: when the context names the fields
    (``table_fields``), the top-level row keeps only those. Nested
    serializers never receive the key, so they stay whole - except those a
    serializer names in ``table_nested`` (field → factory of a leaner one),
    which the slim row carries in their lean shape unless ``include`` asks
    for the whole field."""

    table_nested: Mapping[str, Callable] = {}

    def get_fields(self):
        fields = super().get_fields()
        ctx = getattr(self, "_context", None) or {}
        keep = ctx.get("table_fields")
        if keep is None:
            return fields
        for name in list(fields):
            if name not in keep:
                fields.pop(name)
        whole = ctx.get("table_include") or ()
        for name, factory in self.table_nested.items():
            if name in fields and name not in whole:
                fields[name] = factory()
        return fields


class TableListMixin:
    """Server paging, sorting and facets for a list (see the module doc).
    The viewset sets ``table_spec`` and, for the slim row, a
    ``table_queryset(qs, include)`` hook that trims its base."""

    table_spec: TableSpec = TableSpec()

    # ── what the request asks ──
    def _params(self):
        return self.request.query_params if getattr(self, "request", None) else {}

    def is_table_view(self) -> bool:
        return (getattr(self, "action", None) in ("list", "table_ids")
                and self._params().get("view") == "table")

    def table_include(self) -> list[str]:
        raw = self._params().get("include") or ""
        return [v for v in (s.strip() for s in raw.split(",")) if v][:100]

    def get_serializer_context(self):
        ctx = super().get_serializer_context()
        if self.is_table_view():
            include = self.table_include()
            ctx["table_fields"] = frozenset({*self.table_spec.fields, *include})
            ctx["table_include"] = frozenset(include)
        return ctx

    def table_uses_full_queryset(self) -> bool:
        """``include`` named a field the slim queryset cannot feed."""
        cheap = self.table_spec.cheap
        return any(
            f not in self.table_spec.fields and f not in cheap
            for f in self.table_include()
        )

    def table_include_needs(self, qs):
        for f in self.table_include():
            need = self.table_spec.cheap.get(f)
            if need is not None:
                qs = need(qs)
        return qs

    # ── filtering ──
    def apply_table_filters(self, qs, *, skip: str | None = None):
        params = self._params()
        facets = self.table_spec.facets
        for key in params:
            if not key.startswith("f_"):
                continue
            fid = key[2:]
            facet = facets.get(fid)
            if facet is None:
                raise ValidationError({key: f"Unknown filter: {fid}."})
            if fid == skip:
                continue
            qs = facet.filter(qs, self.request, params.get(key))
        raw = params.get("expr")
        if raw:
            qs = qs.filter(self._expr_q(raw))
        return qs

    def _expr_q(self, raw: str) -> Q:
        if len(raw) > MAX_EXPR:
            raise ValidationError({"expr": "The filter is too long."})
        try:
            ast = json.loads(raw)
        except ValueError:
            raise ValidationError({"expr": "Not a filter expression."}) from None
        if ast is None:
            return Q()
        compiler = _Expr(self.get_queryset_model(), self.table_spec,
                         self.get_serializer_class())
        return compiler.q(ast)

    def get_queryset_model(self):
        return self.queryset.model

    # ── sorting ──
    def table_sort(self, column: str) -> Sort | None:
        sort = self.table_spec.sorts.get(column)
        if sort is not None:
            return sort
        return _catalog_sort(self.get_queryset_model(), column, self.get_serializer_class())

    def apply_table_ordering(self, qs):
        raw = (self._params().get("ordering") or "").strip()
        if not raw:
            return qs
        desc = raw.startswith("-")
        column = raw.lstrip("-")
        sort = self.table_sort(column) if column else None
        if sort is None:
            raise ValidationError({"ordering": f"This list can't sort by {column or '-'}."})
        if sort.prepare:
            qs = sort.prepare(qs, self.request)
        return qs.order_by(*_order_terms(sort, desc), "pk")

    def filter_queryset(self, queryset):
        queryset = super().filter_queryset(queryset)
        if getattr(self, "action", None) in ("list", "table_ids"):
            queryset = self.apply_table_filters(queryset)
            queryset = self.apply_table_ordering(queryset)
        return queryset

    # ── the rail ──
    @extend_schema(
        summary="Facet counts and sortable columns of the list",
        responses={200: OpenApiTypes.OBJECT},
    )
    @action(detail=False, methods=["get"], url_path="facets")
    def table_facets(self, request):
        """The list's facet counts and sortable columns (api.list_table)."""
        base = self.get_queryset()
        params = request.query_params
        out = {}
        for fid, facet in self.table_spec.facets.items():
            if facet.kind == "range":
                continue
            qs = self.apply_table_filters(base, skip=fid)
            selected = decode_list(params.get(f"f_{fid}"))
            out[fid] = facet.count(qs, request, selected)
        return Response({"facets": out, "sortable": self.table_sortable()})

    def table_sortable(self) -> list[str]:
        """The column ids and catalog keys this list sorts by."""
        out = list(self.table_spec.sorts)
        try:
            from .list_fields import catalog_for

            fields = catalog_for(self)["fields"]
        except Exception:
            fields = []
        model = self.get_queryset_model()
        serializer_cls = self.get_serializer_class()
        for d in fields:
            key = d["key"]
            if key in self.table_spec.sorts:
                continue
            if _catalog_sort(model, key, serializer_cls) is not None:
                out.append(key)
        return out

    @extend_schema(
        summary="Every id the list's filters match",
        responses={200: OpenApiTypes.OBJECT},
    )
    @action(detail=False, methods=["get"], url_path="table-ids")
    def table_ids(self, request):
        """Every id the list's filters match, in its order - what *Select
        all* ticks across pages. Capped at ``API_MAX_SELECT`` ids."""
        from django.conf import settings

        cap = int(getattr(settings, "API_MAX_SELECT", 50_000))
        qs = self.filter_queryset(self.get_queryset())
        ids = [str(pk) for pk in qs.values_list("pk", flat=True)[: cap + 1]]
        return Response({"count": len(ids[:cap]), "truncated": len(ids) > cap,
                         "results": ids[:cap]})
