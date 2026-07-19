"""Pluggable round-trip export/import handlers.

A *round-trip* file carries each object's ``id`` (UUID) plus stable, human-readable
keys for its foreign keys, tags and custom fields — so it can be exported, edited
offline, and re-uploaded to **update** existing rows (matched by ``id``, then by a
natural key, else created). This is distinct from the pretty client-side export in
``frontend/src/lib/table-export.ts`` (visible columns, not reimportable).

Every registered, tenant-scoped model gets a working handler for free (the
synthesized :class:`ModelIOHandler`). A model with special keys overrides it by
subclassing and calling :func:`register_io`. A plugin app does the same from its
``<app>/io.py`` (auto-imported in ``ApiConfig.ready``), making import/export
genuinely pluggable.

Reuses the proven helpers in :mod:`api.bulk_import` (``_resolve_fk``, ``_coerce``,
``_importable_fields``) so field coercion and FK lookup behave identically to the
existing bulk-create import.
"""
from __future__ import annotations

import json
import uuid
from functools import lru_cache

from django.core.exceptions import ValidationError
from django.db.models import UniqueConstraint
from django.utils.text import slugify

from auth_api.object_types import model_for, registry_payload, slug_for_model
from core.models import CustomFieldsMixin, TaggableMixin, Tag

from .bulk_import import _SKIP, _coerce, _importable_fields, importable_field_names


def _is_tenant_scoped(model) -> bool:
    return any(f.name == "tenant" for f in model._meta.concrete_fields)


def _is_taggable(model) -> bool:
    return issubclass(model, TaggableMixin)


def _has_custom_fields(model) -> bool:
    return issubclass(model, CustomFieldsMixin)


def _infer_natural_key(model) -> list[str]:
    """A fallback upsert key: a single unique field, else slug/name, else none."""
    if model is None:
        return []
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


class ModelIOHandler:
    """Round-trip export/import for one model. Subclass to customise; the defaults
    cover any tenant-scoped model."""

    model = None
    slug: str | None = None
    columns: list[str] | None = None      # explicit order, else auto
    natural_key: list[str] | None = None  # fallback upsert key, else inferred
    fk_keys: dict[str, str] = {}          # field_name → attr on related to key by

    def __init__(self):
        if self.slug is None and self.model is not None:
            self.slug = slug_for_model(self.model)
        if self.natural_key is None:
            self.natural_key = _infer_natural_key(self.model)
        self._fields = {f.name: f for f in _importable_fields(self.model)}

    # ── columns / schema ──────────────────────────────────────────────────
    def column_names(self) -> list[str]:
        if self.columns is not None:
            return list(self.columns)
        cols = ["id"]
        for f in _importable_fields(self.model):
            if f.name == "custom_fields":
                continue
            cols.append(f.name)
        if _is_taggable(self.model):
            cols.append("tags")
        if _has_custom_fields(self.model):
            cols.append("custom_fields")
        return cols

    def field_info(self) -> list[dict]:
        info = [
            f for f in importable_field_names(self.model)
            if f["name"] != "custom_fields"
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

    # ── export ────────────────────────────────────────────────────────────
    def export_queryset(self, qs):
        if _is_taggable(self.model):
            qs = qs.prefetch_related("tags")
        return qs

    def _export_value(self, obj, f) -> str:
        from core.secret_fields import is_secret_field

        if is_secret_field(self.model, f):
            return ""  # defence in depth — secrets are not even columns
        if f.is_relation:
            rel = getattr(obj, f.name, None)
            if rel is None:
                return ""  # empty cell = "none"/global (phpIPAM convention)
            attr = self.fk_keys.get(f.name)
            if attr:
                return str(getattr(rel, attr, "") or "")
            # Prefer a human-readable natural key over the opaque UUID, in the
            # same order the importer resolves them back.
            for cand in (
                "cidr", "ip_address", "address", "vlan_id", "name", "rd", "slug"
            ):
                v = getattr(rel, cand, None)
                if v not in (None, ""):
                    return str(v)
            return str(rel.pk)
        val = getattr(obj, f.name, None)
        if val in (None, ""):
            return ""
        if f.get_internal_type() == "JSONField":
            return json.dumps(val) if val else ""
        return str(val)

    def to_row(self, obj) -> dict:
        row = {"id": str(obj.pk)}
        for f in _importable_fields(self.model):
            if f.name == "custom_fields":
                continue
            row[f.name] = self._export_value(obj, f)
        if _is_taggable(self.model):
            row["tags"] = ";".join(t.name for t in obj.tags.all())
        if _has_custom_fields(self.model):
            cf = obj.custom_fields or {}
            row["custom_fields"] = json.dumps(cf) if cf else ""
        return {c: row.get(c, "") for c in self.column_names()}

    # ── import ────────────────────────────────────────────────────────────
    def lookup(self, row, tenant):
        """Find the existing row to update: by id, then natural key. ``None`` →
        a new object will be created. Raises on an ambiguous natural key."""
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
        if self.natural_key:
            filt = {}
            for nk in self.natural_key:
                if nk not in row:
                    return None
                val = str(row.get(nk) or "").strip()
                if val == "":
                    return None
                field = self.model._meta.get_field(nk)
                if field.is_relation:
                    filt[field.name] = _coerce(field, val, tenant)
                else:
                    filt[nk] = val
            matches = list(base.filter(**filt)[:2])
            if len(matches) > 1:
                raise ValidationError(
                    f"Ambiguous {'+'.join(self.natural_key)} '{val}' — supply id."
                )
            if matches:
                return matches[0]
        return None

    def apply(self, existing, row, tenant):
        """Build/mutate + validate (no save). Returns
        ``(obj, action, changes, tag_names)``. ``tag_names`` is ``None`` when the
        file has no ``tags`` column (leave tags untouched)."""
        if existing is None:
            obj = self.model()
            if _is_tenant_scoped(self.model):
                obj.tenant = tenant
            action = "create"
            old = {}
        else:
            obj = existing
            action = "update"
            old = self._scalar_snapshot(obj)

        fk_set = {}
        for col, raw in row.items():
            key = (col or "").strip()
            if not key or key in ("id", "tags", "custom_fields") or key in _SKIP:
                continue
            field = self._fields.get(key)
            if field is None:
                continue  # unknown column ignored
            # A nullable FK left blank — or written as "global"/"none"/"-" —
            # means "no link" (e.g. VRF empty = the global table).
            if (
                field.is_relation
                and field.null
                and isinstance(raw, str)
                and raw.strip().lower() in ("", "global", "none", "-")
            ):
                fk_set[field.name] = None
                continue
            val = _coerce(field, raw, tenant)
            if field.is_relation:
                fk_set[field.name] = val
            else:
                setattr(obj, field.attname, val)
        for name, val in fk_set.items():
            setattr(obj, name, val)

        if _has_custom_fields(self.model) and "custom_fields" in row:
            cfraw = row.get("custom_fields")
            if isinstance(cfraw, str):
                cfraw = cfraw.strip()
            if cfraw:
                cf = cfraw if isinstance(cfraw, dict) else json.loads(cfraw)
                if not isinstance(cf, dict):
                    raise ValidationError("custom_fields must be a JSON object.")
                obj.custom_fields = cf

        obj.full_clean(exclude=["tenant"])

        tag_names = None
        if _is_taggable(self.model) and "tags" in row:
            tag_names = [
                t.strip() for t in str(row.get("tags") or "").split(";") if t.strip()
            ]

        changes = {}
        if action == "update":
            new = self._scalar_snapshot(obj)
            changes = {k: [old.get(k), new[k]] for k in new if old.get(k) != new[k]}
        return obj, action, changes, tag_names

    def commit(self, obj, tag_names):
        obj.save()
        if tag_names is not None:
            tags = []
            for name in tag_names:
                t, _ = Tag.objects.get_or_create(
                    name=name, defaults={"slug": slugify(name)}
                )
                tags.append(t)
            obj.tags.set(tags)

    def _scalar_snapshot(self, obj) -> dict:
        return {
            f.name: self._export_value(obj, f)
            for f in _importable_fields(self.model)
            if f.name != "custom_fields"
        }


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
        })
    return out


def _handler(model, **attrs) -> ModelIOHandler:
    cls = type(f"IO_{model.__name__}", (ModelIOHandler,), {"model": model, **attrs})
    return cls()


def register_builtins() -> None:
    """High-value models whose natural keys / FK keys we pin explicitly.

    Prefix / IPAddress / VLAN have no DB-unique field, so without these the
    auto-inferred key would be empty (id-only) and every keyless row would
    create a duplicate. Called from ``ApiConfig.ready``.
    """
    from .models import Device, IPAddress, IPRange, Prefix, VLAN

    register_io(_handler(
        Prefix, natural_key=["cidr"],
        fk_keys={"site": "name", "vlan": "vlan_id", "vrf": "name"},
    ))
    register_io(_handler(
        IPAddress, natural_key=["ip_address"], fk_keys={"vrf": "name"}
    ))
    register_io(_handler(
        IPRange, natural_key=["start_address", "end_address"],
        fk_keys={"prefix": "cidr", "vrf": "name"},
    ))
    register_io(_handler(
        VLAN, natural_key=["vlan_id"], fk_keys={"site": "name"}
    ))
    register_io(_handler(
        Device, natural_key=["name", "site"], fk_keys={"site": "name"}
    ))
