"""Generic bulk import — create rows of any registered, tenant-scoped object
type from CSV or JSON.

Works directly off the Django model (no per-type wiring): scalar columns are
coerced to the field type, foreign keys are resolved by pk / slug / name within
the active tenant, and each row is validated with ``full_clean`` before saving.
Per-row errors are collected so one bad row doesn't sink the batch. A dry run
validates without writing.

Trade-off (documented): this bypasses DRF serializer logic (e.g. gateway
autospawn, IP-in-prefix checks). It's a bulk-load tool, not the per-object API.
"""
from __future__ import annotations

import csv
import io
import json

from django.core.exceptions import FieldError, ValidationError
from django.db import transaction

# Field names never set from import input (managed by the system).
_SKIP = {"id", "created_at", "updated_at", "tenant"}
# Natural keys tried, in order, when resolving a FK by value. Includes the
# human-readable keys the round-trip exporter writes (cidr, vlan number, IP,
# rd…) so an edited spreadsheet resolves back to the right object.
_FK_LOOKUPS = [
    "pk", "slug", "name", "model", "cidr", "rd", "vlan_id", "ip_address",
    "address", "rd",
]


def _importable_fields(model):
    from core.secret_fields import is_secret_field

    out = []
    for f in model._meta.concrete_fields:
        if f.name in _SKIP or f.auto_created:
            continue
        # Credentials never round-trip through spreadsheets: no export
        # column (EncryptedJSONField decrypts on read!) and no import
        # column (set secrets through their own endpoints).
        if is_secret_field(model, f):
            continue
        out.append(f)
    return out


def importable_field_names(model) -> list[dict]:
    info = []
    for f in _importable_fields(model):
        info.append({
            "name": f.name,
            "kind": "fk" if f.is_relation else f.get_internal_type(),
            "required": not (f.blank or f.null or f.has_default()),
        })
    return info


def _resolve_fk(field, value, tenant, user=None):
    related = field.related_model
    qs = related._default_manager.all()
    if any(c.name == "tenant" for c in related._meta.concrete_fields):
        qs = qs.filter(tenant=tenant)
    # Site scope: a Site-A importer must not be able to link a row to a Site-B
    # object by naming it. When a user is supplied, resolve the FK only among
    # rows they may view (constraints AND ObjectPermission.sites), same as the
    # per-object API. Tenant-only when the related type isn't RBAC-registered.
    if user is not None and not getattr(user, "is_superuser", False):
        from auth_api import rbac
        from auth_api.object_types import is_registered, slug_for_model

        try:
            slug = slug_for_model(related)
        except Exception:  # noqa: BLE001
            slug = None
        if slug and is_registered(slug):
            qs = rbac.restrict_queryset(qs, user, tenant, slug, "view")
    for lookup in _FK_LOOKUPS:
        try:
            obj = qs.filter(**{lookup: value}).first()
        except (ValueError, TypeError, ValidationError, FieldError):
            continue
        if obj is not None:
            return obj
    raise ValidationError(
        f"{field.name}: no {related._meta.verbose_name} matching '{value}'."
    )


def _coerce(field, value, tenant, user=None):
    if value is None:
        return None
    if isinstance(value, str):
        value = value.strip()
    if value == "" and (field.null or field.blank):
        return None if field.null else ""
    if field.is_relation:
        return _resolve_fk(field, value, tenant, user)
    if field.get_internal_type() == "JSONField":
        if isinstance(value, (dict, list)):
            return value
        return json.loads(value) if value else {}
    return field.to_python(value)


def _build(model, tenant, row, fields, user=None):
    obj = model()
    if any(c.name == "tenant" for c in model._meta.concrete_fields):
        obj.tenant = tenant
    fk_set = {}
    for col, raw in row.items():
        key = (col or "").strip()
        if not key or key in _SKIP:
            continue
        field = fields.get(key)
        if field is None:
            continue  # unknown column — ignored
        val = _coerce(field, raw, tenant, user)
        if field.is_relation:
            fk_set[field.name] = val
        else:
            setattr(obj, field.attname, val)
    for name, val in fk_set.items():
        setattr(obj, name, val)
    return obj


def import_rows(model, tenant, rows, *, dry_run=False, user=None) -> dict:
    fields = {f.name: f for f in _importable_fields(model)}
    created, errors = 0, []
    for i, row in enumerate(rows):
        try:
            with transaction.atomic():
                obj = _build(model, tenant, row, fields, user)
                obj.full_clean(exclude=["tenant"])
                if not dry_run:
                    obj.save()
                created += 1
        except ValidationError as exc:
            msgs = exc.messages if hasattr(exc, "messages") else [str(exc)]
            errors.append({"row": i + 1, "error": "; ".join(msgs)})
        except Exception as exc:  # noqa: BLE001
            errors.append({"row": i + 1, "error": str(exc)})
    return {"total": len(rows), "created": created, "errors": errors,
            "dry_run": dry_run}


def parse_rows(content: str, fmt: str) -> list[dict]:
    """Parse uploaded text into a list of row dicts."""
    content = content or ""
    if fmt == "json":
        data = json.loads(content or "[]")
        if isinstance(data, dict):
            data = [data]
        if not isinstance(data, list):
            raise ValueError("JSON must be a list of objects.")
        return [d for d in data if isinstance(d, dict)]
    # CSV
    reader = csv.DictReader(io.StringIO(content))
    return list(reader)
