"""Pluggable round-trip export/import handlers.

A *round-trip* file carries each object's ``id`` (UUID) plus stable, human-readable
keys for its foreign keys, tags and custom fields - so it can be exported, edited
offline, and re-uploaded to **update** existing rows (matched by ``id``, then by a
natural key, else created). This is distinct from the pretty client-side export in
``frontend/src/lib/table-export.ts`` (visible columns, not reimportable).

Every registered, tenant-scoped model gets a working handler for free (the
synthesized :class:`ModelIOHandler`). A model with special keys overrides it by
subclassing and calling :func:`register_io`. A plugin app does the same from its
``<app>/io.py`` (auto-imported in ``ApiConfig.ready``), making import/export
genuinely pluggable.

Reuses the helpers in :mod:`api.bulk_import` (``_resolve_fk``, ``_coerce``,
``_importable_fields``) for field coercion and reference lookup. On top of those,
a reference is resolved within the row's own scope (its device, VRF, site) and
every row is validated as the API validates it - see :meth:`ModelIOHandler.apply`.
"""
from __future__ import annotations

import csv
import io
import json
import uuid
from functools import lru_cache

from django.core.exceptions import PermissionDenied, ValidationError
from django.db.models import F, Q, UniqueConstraint

from auth_api.object_types import model_for, registry_payload, slug_for_model
from core.models import CustomFieldsMixin, TaggableMixin, Tag
from core.tags import TAGS, tags_of

from .bulk_import import (
    _SKIP,
    NONE_WORDS,
    _coerce,
    _exportable_fields,
    _importable_fields,
    _resolve_fk,
    check_status_offered,
    importable_field_names,
    parse_json_cell,
    scope_fields,
)


def _is_tenant_scoped(model) -> bool:
    return any(f.name == "tenant" for f in model._meta.concrete_fields)


def _is_taggable(model) -> bool:
    return issubclass(model, TaggableMixin)


def _has_custom_fields(model) -> bool:
    return issubclass(model, CustomFieldsMixin)


def _unique_sets(model) -> list[list[str]]:
    """Unconditional unique field sets, tenant left out."""
    sets = [list(ut) for ut in model._meta.unique_together or ()]
    for c in model._meta.constraints:
        if isinstance(c, UniqueConstraint) and c.fields and c.condition is None:
            sets.append(list(c.fields))
    return [[x for x in s if x != "tenant"] for s in sets]


def _infer_natural_key(model) -> list[str]:
    """A fallback upsert key: a single unique field, else slug/name, else none.

    A key that is only part of a unique set (a rack's name, unique per site)
    is widened to the whole set, so a keyless row for another site creates a
    new object instead of moving this one (#352)."""
    if model is None:
        return []
    key = _narrow_natural_key(model)
    importable = {f.name for f in _importable_fields(model)}
    for s in sorted(_unique_sets(model), key=len):
        if key and set(key) < set(s) and set(s) <= importable:
            return s
    return key


def _narrow_natural_key(model) -> list[str]:
    for f in model._meta.concrete_fields:
        if f.name in ("id", "tenant") or f.auto_created:
            continue
        if getattr(f, "unique", False):
            return [f.name]
    for ut in model._meta.unique_together or ():
        fields = [x for x in ut if x != "tenant"]
        if len(fields) == 1:
            return fields
    for c in model._meta.constraints:
        if isinstance(c, UniqueConstraint):
            fields = [x for x in c.fields if x != "tenant"]
            if len(fields) == 1:
                return fields
    names = {f.name for f in model._meta.concrete_fields}
    if "slug" in names:
        return ["slug"]
    if "name" in names:
        return ["name"]
    return []


# Readable keys tried, in order, when a reference is written to a file.
_READABLE_KEYS = ("cidr", "ip_address", "address", "vlan_id", "name", "rd", "slug")
_UNKNOWN = object()


def format_tag_cell(names) -> str:
    """Tag names for one cell, ``;``-separated. A name holding ``;`` or a
    quote is quoted CSV-style, so it reads back as one tag (#355)."""
    buf = io.StringIO()
    csv.writer(buf, delimiter=";", lineterminator="").writerow(list(names))
    return buf.getvalue()


def parse_tag_cell(raw) -> list[str]:
    if isinstance(raw, (list, tuple)):
        names = [str(n) for n in raw]
    else:
        text = str(raw or "")
        names = next(csv.reader([text], delimiter=";"), []) if text.strip() else []
    out = []
    for n in names:
        n = n.strip()
        if n and n not in out:
            out.append(n)
    return out


class ModelIOHandler:
    """Round-trip export/import for one model. Subclass to customise; the defaults
    cover any tenant-scoped model."""

    model = None
    slug: str | None = None
    columns: list[str] | None = None      # explicit order, else auto
    natural_key: list[str] | None = None  # fallback upsert key, else inferred
    fk_keys: dict[str, str] = {}          # field_name → attr on related to key by
    # field_name → {related field: row field}: the row columns that say which
    # of several same-named objects a reference means. Inferred when a
    # container (site, VRF, device, …) appears once on both sides.
    fk_scopes: dict[str, dict[str, str]] = {}

    def __init__(self):
        if self.slug is None and self.model is not None:
            self.slug = slug_for_model(self.model)
        if self.natural_key is None:
            self.natural_key = _infer_natural_key(self.model)
        self._fields = {f.name: f for f in _importable_fields(self.model)}
        self._scopes: dict[str, list[tuple[str, str]]] = {}
        self._write_map: dict[str, str] | None = None

    # ── the API write path ────────────────────────────────────────────────
    #: The viewset whose serializer and create/update hooks own this type's
    #: writes. Found on the URL routes when not set.
    viewset = None

    def write_viewset(self):
        """The routed viewset that creates and edits this type through the
        API, or ``None`` when the API cannot write it."""
        if self.viewset is not None:
            return self.viewset
        return _write_viewsets().get(self.model)

    def importable(self) -> bool:
        """Import writes only what the API can write (#364): a type with no
        API write path is export-only."""
        return self.write_viewset() is not None

    def _view(self, request, action):
        return self.write_viewset()(
            request=request, args=(), kwargs={}, format_kwarg=None, action=action,
        )

    def write_map(self) -> dict[str, str]:
        """``{model field: serializer field}`` for every column an import may
        set: the fields the type's API serializer writes. A field the API
        holds read-only (a script's ``trusted`` and ``owner``, a discovered
        timestamp) or does not offer at all (a PSK's store path) is
        export-only, as ``numid`` is (#349, #364)."""
        if self._write_map is not None:
            return self._write_map
        from rest_framework import serializers

        out: dict[str, str] = {}
        if self.importable():
            view = self._view(None, "partial_update")
            try:
                ser_cls = view.get_serializer_class()
            except Exception:  # noqa: BLE001 - a class that reads the request
                ser_cls = view.serializer_class
            fields = ser_cls(context={"view": view}).fields
            for sname, sf in fields.items():
                if sf.read_only or isinstance(sf, (serializers.BaseSerializer,
                                                   serializers.FileField)):
                    continue
                src = sf.source
                target = src if src in self._fields else next(
                    (n for n, f in self._fields.items() if f.attname == src), None
                )
                if target and target != "custom_fields":
                    out.setdefault(target, sname)
        self._write_map = out
        return out

    # ── columns / schema ──────────────────────────────────────────────────
    def column_names(self) -> list[str]:
        if self.columns is not None:
            return list(self.columns)
        cols = ["id"]
        for f in _exportable_fields(self.model):
            if f.name == "custom_fields":
                continue
            cols.append(f.name)
        if _is_taggable(self.model):
            cols.append("tags")
        if _has_custom_fields(self.model):
            cols.append("custom_fields")
        return cols

    def field_info(self) -> list[dict]:
        """The columns an import sets, plus the natural-key columns it
        matches on."""
        writable = self.write_map()
        nk_names = set(self.natural_key or [])
        info = [
            f for f in importable_field_names(self.model)
            if f["name"] != "custom_fields"
            and (f["name"] in writable or f["name"] in nk_names)
        ]
        if _is_taggable(self.model):
            info.append({"name": "tags", "kind": "tags", "required": False})
        if _has_custom_fields(self.model):
            info.append({"name": "custom_fields", "kind": "json", "required": False})
        # Flag natural-key columns so the UI can hint "match key".
        nk = set(self.natural_key or [])
        for f in info:
            f["natural_key"] = f["name"] in nk
        return info

    # ── references ────────────────────────────────────────────────────────
    def scope_pairs(self, field) -> list[tuple[str, str]]:
        """``(related_field, row_field)`` pairs that narrow ``field``'s
        reference to the row's own scope: the interface within the row's
        device, the prefix within its VRF, the rack within its site."""
        if field.name in self._scopes:
            return self._scopes[field.name]
        if field.name in self.fk_scopes:
            pairs = list(self.fk_scopes[field.name].items())
        else:
            by_model: dict = {}
            for f in self._fields.values():
                if f.is_relation and f.name != field.name:
                    by_model.setdefault(f.related_model, []).append(f.name)
            pairs = []
            for g in scope_fields(field):
                names = by_model.get(g.related_model, [])
                if len(names) == 1:
                    pairs.append((g.name, names[0]))
        self._scopes[field.name] = pairs
        return pairs

    def _resolve_fks(self, row, tenant, user=None, existing=None, only=None) -> dict:
        """The row's reference cells as objects (``None`` = no link), each
        resolved within the scope the row's other columns give it."""
        present = {}
        for col, raw in row.items():
            key = (col or "").strip()
            field = self._fields.get(key)
            if field is not None and field.is_relation:
                present[field.name] = raw
        resolved: dict = {}
        visiting: set = set()

        def scope_value(name):
            if name in present:
                resolve(name)
                return resolved.get(name, _UNKNOWN)
            if existing is not None and name in self._fields:
                return getattr(existing, self._fields[name].attname)
            return _UNKNOWN

        def resolve(name):
            if name in resolved or name in visiting or name not in present:
                return
            visiting.add(name)
            field = self._fields[name]
            raw = present[name]
            if field.null and (raw is None or (
                isinstance(raw, str) and raw.strip().lower() in NONE_WORDS
            )):
                resolved[name] = None
            else:
                scope = {}
                for rel_name, row_name in self.scope_pairs(field):
                    if row_name in visiting:
                        continue
                    val = scope_value(row_name)
                    if val is not _UNKNOWN:
                        scope[rel_name] = val
                resolved[name] = _coerce(field, raw, tenant, user, scope=scope)
            visiting.discard(name)

        for name in (only if only is not None else list(present)):
            resolve(name)
        return resolved

    def _readable(self, rel, f) -> str | None:
        attr = self.fk_keys.get(f.name)
        if attr:
            v = getattr(rel, attr, None)
            return str(v) if v not in (None, "") else None
        for cand in _READABLE_KEYS:
            v = getattr(rel, cand, None)
            if v not in (None, ""):
                return str(v)
        return None

    def _ref_value(self, obj, f, refs=None) -> str:
        """A reference cell: the readable key when it reads back to this very
        object in the row's scope, else the object's id (#330)."""
        rel_pk = getattr(obj, f.attname, None)
        if rel_pk is None:
            return ""  # empty cell = "none"/global (phpIPAM convention)
        rel = getattr(obj, f.name, None)
        if rel is None:
            return ""
        key = self._readable(rel, f)
        if key is None:
            return str(rel.pk)
        if f.null and key.strip().lower() in NONE_WORDS:
            # A region named "Global" or a VRF named "none" would read back
            # as "no link" (#371).
            return str(rel.pk)
        scope = {
            g: getattr(obj, self._fields[h].attname)
            for g, h in self.scope_pairs(f) if h in self._fields
        }
        cache_key = (f.name, key, tuple(sorted(scope.items(), key=lambda kv: kv[0])))
        if refs is None:
            refs = {}
        if cache_key not in refs:
            try:
                tenant = getattr(obj, "tenant_id", None)
                refs[cache_key] = _resolve_fk(f, key, tenant, None, scope=scope).pk
            except ValidationError:
                refs[cache_key] = None
        return key if refs[cache_key] == rel.pk else str(rel.pk)

    # ── export ────────────────────────────────────────────────────────────
    def export_queryset(self, qs):
        if _is_taggable(self.model):
            qs = qs.prefetch_related(TAGS)
        return qs

    def _export_value(self, obj, f, refs=None) -> str:
        from core.secret_fields import is_secret_field

        if is_secret_field(self.model, f):
            return ""  # defence in depth - secrets are not even columns
        if f.is_relation:
            return self._ref_value(obj, f, refs)
        val = getattr(obj, f.attname, None)
        if val is None or val == "":
            return ""
        if f.get_internal_type() == "JSONField" or isinstance(val, (list, dict)):
            # An empty list stays "[]": a blank cell would read back as
            # something else (#354).
            return json.dumps(val)
        return str(val)

    def _display(self, f, value) -> str:
        """A value as the preview shows it."""
        if value is None:
            return ""
        if f.is_relation:
            rel = f.related_model._default_manager.filter(pk=value).first()
            if rel is None:
                return str(value)
            return self._readable(rel, f) or str(rel.pk)
        if f.get_internal_type() == "JSONField" or isinstance(value, (list, dict)):
            return json.dumps(value)
        return str(value)

    def to_row(self, obj, refs=None) -> dict:
        """One object as a file row. ``refs`` is a cache shared across the
        rows of one export."""
        row = {"id": str(obj.pk)}
        for f in _exportable_fields(self.model):
            if f.name == "custom_fields":
                continue
            row[f.name] = self._export_value(obj, f, refs)
        if _is_taggable(self.model):
            row["tags"] = format_tag_cell(t.name for t in tags_of(obj))
        if _has_custom_fields(self.model):
            cf = obj.custom_fields or {}
            row["custom_fields"] = json.dumps(cf) if cf else ""
        return {c: row.get(c, "") for c in self.column_names()}

    # ── import ────────────────────────────────────────────────────────────
    def lookup(self, row, tenant, user=None):
        """Find the existing row to update: by id, then natural key. ``None`` →
        a new object will be created. Raises on an ambiguous natural key.

        A natural-key column missing from the file leaves that part of the key
        open; present but empty, it matches an empty value."""
        base = self.model._default_manager.all()
        if _is_tenant_scoped(self.model):
            base = base.filter(tenant=tenant)
        id_val = str(row.get("id") or "").strip()
        if id_val:
            try:
                uuid.UUID(id_val)
                obj = base.filter(pk=id_val).first()
                if obj is not None:
                    return obj
            except (ValueError, TypeError):
                pass
        if not self.natural_key:
            return None
        def cell(nk):
            raw = row.get(nk)
            return str(raw if raw is not None else "").strip()

        filt = {}
        refs = [
            nk for nk in self.natural_key
            if nk in row and self.model._meta.get_field(nk).is_relation
            and cell(nk).lower() not in NONE_WORDS
        ]
        resolved = self._resolve_fks(row, tenant, user, only=refs) if refs else {}
        for nk in self.natural_key:
            field = self.model._meta.get_field(nk)
            if nk not in row:
                # Not in the file: not part of this match, nullable or not;
                # several matches are then an "ambiguous" row error (#370).
                continue
            if field.is_relation:
                val = resolved.get(field.name)
                if val is None:
                    if not field.null:
                        return None
                    filt[f"{nk}__isnull"] = True
                else:
                    filt[nk] = val
                continue
            val = cell(nk)
            if val == "":
                if not field.null:
                    return None
                filt[f"{nk}__isnull"] = True
            else:
                filt[nk] = val
        if not filt:
            return None
        matches = list(base.filter(**filt)[:2])
        if len(matches) > 1:
            key = " / ".join(str(row.get(k, "")) for k in self.natural_key)
            raise ValidationError(
                f"More than one {self.model._meta.verbose_name} matches "
                f"{'+'.join(self.natural_key)} '{key}' - use its id."
            )
        return matches[0] if matches else None

    def apply(self, existing, row, tenant, user=None, request=None):
        """Build/mutate + validate (no save). Returns
        ``(obj, action, changes, tag_names)``. ``tag_names`` is ``None`` when the
        file has no ``tags`` column (leave tags untouched).

        Validation is the API's: the model's own checks with the tenant set
        (so tenant-wide uniqueness is a row error, #353), custom fields
        against their definitions (#348), then - given the ``request`` - the
        type's serializer over the fields the row sets or changes (#351).

        Only the columns the API can write are set (:meth:`write_map`); the
        rest are export-only. With a ``request`` the validated serializer is
        kept on the object, and :meth:`commit` saves through the viewset's
        own create/update hooks (#364, #365)."""
        if existing is None:
            obj = self.model()
            if _is_tenant_scoped(self.model):
                obj.tenant = tenant
            action = "create"
            old = {}
            old_cf = {}
        else:
            obj = existing
            action = "update"
            old = self._raw_snapshot(obj)
            old_cf = dict(getattr(obj, "custom_fields", None) or {})

        writable = self.write_map()
        resolved = self._resolve_fks(
            row, tenant, user, existing,
            only=[n for n in writable if self._fields[n].is_relation],
        )
        # A reference resolved only to narrow another one is not written.
        resolved = {n: v for n, v in resolved.items() if n in writable}
        supplied = set(resolved)
        for col, raw in row.items():
            key = (col or "").strip()
            if not key or key in ("id", "tags", "custom_fields") or key in _SKIP:
                continue
            field = self._fields.get(key)
            if field is None or field.is_relation or key not in writable:
                continue  # unknown or export-only column ignored; refs above
            # An empty cell on a required column with a default means "the
            # default" (gateway_policy, status flags), not an empty string.
            if (
                existing is None and not field.blank
                and field.has_default() and isinstance(raw, str) and raw.strip() == ""
            ):
                continue
            setattr(obj, field.attname, self._coerce_scalar(field, raw, tenant, user))
            supplied.add(field.name)
        for name, val in resolved.items():
            check_status_offered(self._fields[name], val, existing)
            setattr(obj, name, val)

        if _has_custom_fields(self.model) and "custom_fields" in row:
            self._apply_custom_fields(obj, existing, row.get("custom_fields"), tenant)

        obj.full_clean()

        if existing is None:
            touched = supplied
        else:
            new = self._raw_snapshot(obj)
            touched = {k for k in new if old.get(k) != new[k]}
        if _has_custom_fields(self.model) and (obj.custom_fields or {}) != old_cf:
            touched.add("custom_fields")
        self._api_validate(obj, existing, touched, request)

        tag_names = None
        if _is_taggable(self.model) and "tags" in row:
            tag_names = parse_tag_cell(row.get("tags"))

        changes = {}
        if action == "update":
            new = self._raw_snapshot(obj)
            changes = {
                k: [self._display(self._fields[k], old.get(k)),
                    self._display(self._fields[k], new[k])]
                for k in new if old.get(k) != new[k]
            }
        return obj, action, changes, tag_names

    def _coerce_scalar(self, field, raw, tenant, user):
        if field.get_internal_type() == "ArrayField" and (
            raw is None or (isinstance(raw, str) and raw.strip() == "")
        ):
            return parse_json_cell(field, raw)
        return _coerce(field, raw, tenant, user)

    def _apply_custom_fields(self, obj, existing, cfraw, tenant):
        from customization.cf_validation import clean_custom_fields

        if isinstance(cfraw, str):
            cfraw = cfraw.strip()
        if not cfraw:
            return  # an empty cell leaves the values as they are
        if isinstance(cfraw, dict):
            cf = cfraw
        else:
            try:
                cf = json.loads(cfraw)
            except (TypeError, ValueError):
                raise ValidationError({"custom_fields": "Not valid JSON."}) from None
        if not isinstance(cf, dict):
            raise ValidationError({"custom_fields": "Must be a JSON object."})
        if existing is not None and cf == (existing.custom_fields or {}):
            return
        cleaned, errors = clean_custom_fields(tenant, self.model._meta.model_name, cf)
        if errors:
            raise ValidationError({k: [str(v)] for k, v in errors.items()})
        obj.custom_fields = cleaned

    def _api_validate(self, obj, existing, names, request) -> None:
        """Run the type's API serializer over the fields this row sets (a
        create) or changes (an update), as a POST or PATCH would, and keep
        what it normalises. The validated serializer and its view are kept
        on ``obj`` for :meth:`commit`. Nothing to validate (no request, no
        API write path, an unchanged row) keeps nothing."""
        obj._io_write = None
        if request is None or not self.importable() or (existing is not None and not names):
            return
        view = self._view(request, "create" if existing is None else "partial_update")
        fields = view.get_serializer().fields
        to_ser = self.write_map()
        payload = {}
        for name in names:
            sname = to_ser.get(name)
            if sname is None:
                continue
            field = self._fields[name]
            value = getattr(obj, name if field.is_relation else field.attname)
            if value is None:
                if existing is not None:
                    payload[sname] = None
                continue
            payload[sname] = fields[sname].to_representation(value)
        instance = (
            None if existing is None
            else self.model._default_manager.get(pk=existing.pk)
        )
        ser = view.get_serializer(instance, data=payload, partial=existing is not None)
        if not ser.is_valid():
            raise ValidationError(_django_errors(ser.errors, to_ser))
        for key, value in ser.validated_data.items():
            field = self._fields.get(key)
            if field is not None and key != "custom_fields" and not field.many_to_many:
                setattr(obj, key, value)
        obj._io_write = (ser, view)

    def _save_through_api(self, obj, ser, view):
        """Save as the API saves: the viewset's ``perform_create`` or
        ``perform_update`` over the validated serializer, so the checks and
        side effects that live there (a deployment-admin gate, a cleared
        trust, a stamped owner) apply to the row (#364, #365). Returns the
        saved object."""
        from rest_framework import exceptions as drf

        if _has_custom_fields(self.model):
            ser.validated_data["custom_fields"] = obj.custom_fields
        try:
            if ser.instance is None:
                view.perform_create(ser)
            else:
                view.perform_update(ser)
        except (drf.PermissionDenied, drf.NotAuthenticated) as exc:
            raise PermissionDenied(" ".join(_flat(exc.detail))) from None
        except drf.ValidationError as exc:
            raise ValidationError(_django_errors(exc.detail, self.write_map())) from None
        return ser.instance

    def commit(self, obj, tag_names):
        """Save the row and its tags; returns the saved object. A row that
        :meth:`apply` validated through the API is saved through it."""
        write = getattr(obj, "_io_write", None)
        if write is not None:
            obj = self._save_through_api(obj, *write)
        else:
            obj.save()
        if tag_names is not None:
            # Tags are tenant-scoped (name unique per tenant). A tenant-less
            # (deployment-wide) tag of that name is the same tag the API
            # offers, so it is reused rather than copied (#355).
            tenant = getattr(obj, "tenant", None)
            tags = []
            for name in tag_names:
                t = (
                    Tag.objects.filter(name=name)
                    .filter(Q(tenant=tenant) | Q(tenant__isnull=True))
                    .order_by(F("tenant").asc(nulls_last=True))
                    .first()
                )
                if t is None:
                    t = Tag(name=name, tenant=tenant)
                    t.save()
                tags.append(t)
            obj.tags.set(tags)
        return obj

    def _raw_snapshot(self, obj) -> dict:
        return {
            f.name: f.value_from_object(obj)
            for f in self._fields.values()
            if f.name != "custom_fields"
        }


def _flat(err) -> list[str]:
    if isinstance(err, dict):
        return [m for v in err.values() for m in _flat(v)]
    if isinstance(err, (list, tuple)):
        return [m for v in err for m in _flat(v)]
    return [str(err)]


def _django_errors(detail, to_ser) -> dict | list:
    """A DRF error body as a Django ``ValidationError`` payload, keyed by
    the model field a serializer field writes."""
    if not isinstance(detail, dict):
        return _flat(detail)
    back = {s: m for m, s in to_ser.items()}
    return {
        ("__all__" if k in ("non_field_errors", "detail") else back.get(k, k)): _flat(v)
        for k, v in detail.items()
    }


@lru_cache(maxsize=1)
def _write_viewsets() -> dict:
    """``{model: viewset}`` for every routed viewset that creates and
    partially updates its model, read off the URL routes - every app's
    router, plugins included."""
    from django.urls import URLPattern, URLResolver, get_resolver

    found: dict = {}

    def walk(patterns):
        for p in patterns:
            if isinstance(p, URLResolver):
                walk(p.url_patterns)
            elif isinstance(p, URLPattern):
                cls = getattr(p.callback, "cls", None)
                actions = getattr(p.callback, "actions", None)
                qs = getattr(cls, "queryset", None)
                if cls is None or not actions or qs is None:
                    continue
                found.setdefault(qs.model, {}).setdefault(cls, set()).update(
                    actions.values()
                )

    walk(get_resolver().url_patterns)
    out = {}
    for model, viewsets in found.items():
        for cls, actions in viewsets.items():
            if {"create", "partial_update"} <= actions:
                out[model] = cls
                break
    return out


class DeviceIOHandler(ModelIOHandler):
    """Devices: a new one gets its type's components, as through the API."""

    def commit(self, obj, tag_names):
        from .models import materialize_device_components

        # Through the API, DeviceViewSet.perform_create materialises them.
        adding = obj._state.adding and getattr(obj, "_io_write", None) is None
        obj = super().commit(obj, tag_names)
        if adding:
            materialize_device_components(obj)
        return obj


# ── registry ──────────────────────────────────────────────────────────────

_REGISTRY: dict[str, ModelIOHandler] = {}


def register_io(handler: ModelIOHandler) -> None:
    """Register (or override) the handler for ``handler.slug``."""
    _REGISTRY[handler.slug] = handler


@lru_cache(maxsize=None)
def _auto_handler(slug: str):
    model = model_for(slug)
    if model is None or not _is_tenant_scoped(model):
        return None
    cls = type(f"AutoIO_{slug}", (ModelIOHandler,), {"model": model})
    return cls()


def io_for(slug: str):
    """The handler for ``slug``: an explicit registration, else a synthesized
    default for any tenant-scoped registered model, else ``None``."""
    if slug in _REGISTRY:
        return _REGISTRY[slug]
    return _auto_handler(slug)


def io_types() -> list[dict]:
    """``[{slug,label,group,natural_key}]`` for every IO-capable type."""
    out = []
    for entry in registry_payload():
        slug = entry["slug"]
        h = io_for(slug)
        if h is None:
            continue
        out.append({
            "slug": slug,
            "label": entry["label"],
            "group": entry["group"],
            "natural_key": h.natural_key,
            "importable": h.importable(),
        })
    return out


def _handler(model, base=ModelIOHandler, **attrs) -> ModelIOHandler:
    cls = type(f"IO_{model.__name__}", (base,), {"model": model, **attrs})
    return cls()


def register_builtins() -> None:
    """High-value models whose natural keys / FK keys we pin explicitly.

    Prefix / IPAddress / VLAN have no DB-unique field, so without these the
    auto-inferred key would be empty (id-only) and every keyless row would
    create a duplicate. Each key is the whole of what makes the object unique
    - a VLAN number per site or group, a prefix per VRF - so a keyless row
    never lands on its namesake elsewhere (#352). Called from
    ``ApiConfig.ready``.
    """
    from .models import Device, IPAddress, IPRange, Prefix, VLAN

    register_io(_handler(
        Prefix, natural_key=["cidr", "vrf"],
        fk_keys={"site": "name", "vlan": "vlan_id", "vrf": "name"},
    ))
    register_io(_handler(
        IPAddress, natural_key=["ip_address", "vrf"], fk_keys={"vrf": "name"},
        # Two device/interface pairs: the address's own, and the switch port
        # it was seen on. Each interface is looked up on its own device.
        fk_scopes={
            "assigned_interface": {"device": "assigned_device"},
            "switch_interface": {"device": "switch"},
        },
    ))
    register_io(_handler(
        IPRange, natural_key=["start_address", "end_address"],
        fk_keys={"prefix": "cidr", "vrf": "name"},
    ))
    register_io(_handler(
        VLAN, natural_key=["vlan_id", "site", "group"], fk_keys={"site": "name"}
    ))
    register_io(_handler(
        Device, DeviceIOHandler, natural_key=["name", "site"], fk_keys={"site": "name"}
    ))
