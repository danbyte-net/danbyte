"""Generic bulk import - create rows of any registered, tenant-scoped object
type from CSV or JSON.

Works directly off the Django model (no per-type wiring): scalar columns are
coerced to the field type, foreign keys are resolved by pk / slug / name within
the active tenant, and each row is validated with ``full_clean`` before saving.
Per-row errors are collected so one bad row doesn't sink the batch. A dry run
validates without writing.

Trade-off (documented): this bypasses DRF serializer logic (e.g. gateway
autospawn, IP-in-prefix checks). It's a bulk-load tool, not the per-object API.
The round-trip import in :mod:`api.io` adds the type's serializer validation on
top; the field helpers here are shared by both.
"""
from __future__ import annotations

import csv
import io
import json

from django.core.exceptions import FieldError, ValidationError
from django.db import DatabaseError, transaction

# Field names never set from import input (managed by the system).
_SKIP = {"id", "created_at", "updated_at", "tenant"}
# Natural keys tried, in order, when resolving a FK by value. Includes the
# human-readable keys the round-trip exporter writes (cidr, vlan number, IP,
# rd…) so an edited spreadsheet resolves back to the right object.
_FK_LOOKUPS = [
    "pk", "slug", "name", "model", "cidr", "rd", "vlan_id", "ip_address",
    "address", "asn",
]
# Cell values that mean "no link" on a nullable foreign key (a VRF cell left
# empty is the global table).
NONE_WORDS = ("", "global", "none", "-")
# Related models never used to narrow a reference to the row's scope: they
# describe an object rather than contain it, so sharing one says nothing about
# which same-named object a cell means.
_NON_SCOPE_MODELS = {"api.status", "auth.user", "auth.group", "contenttypes.contenttype"}


def _exportable_fields(model):
    """Concrete fields a round-trip file carries: everything but the system
    columns and secrets. Includes read-only columns such as ``numid``."""
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


def _importable_fields(model):
    """The exportable fields an import may set. A column the model marks
    ``editable=False`` (``numid``) is export-only, as it is read-only in the
    API (#349). So is a stored file: a cell could otherwise point the object
    at any file in media storage."""
    from django.db.models import FileField

    return [
        f for f in _exportable_fields(model)
        if f.editable and not isinstance(f, FileField)
    ]


def importable_field_names(model) -> list[dict]:
    info = []
    for f in _importable_fields(model):
        info.append({
            "name": f.name,
            "kind": "fk" if f.is_relation else f.get_internal_type(),
            "required": not (f.blank or f.null or f.has_default()),
        })
    return info


def fk_base_queryset(field, tenant, user=None):
    """The objects a foreign-key cell may name: the related model's rows in
    the tenant, narrowed to what ``user`` may view."""
    related = field.related_model
    qs = related._default_manager.all()
    if any(c.name == "tenant" for c in related._meta.concrete_fields):
        qs = qs.filter(tenant=tenant)
    else:
        # Rows tenant-scoped through a parent (an interface through its
        # device) resolve inside the tenant too, as their API fields do.
        from .serializers import _PARENT_TENANT_PATH

        path = _PARENT_TENANT_PATH.get(related.__name__)
        if path is not None:
            qs = qs.filter(**{path: tenant})
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
        if slug in ("user", "group") and not rbac.has_action(user, tenant, slug, "view"):
            # People and groups are not user administration here: a created_by
            # or assigned_group cell names someone in the tenant, the same
            # accounts the tenant's pickers offer (deactivated ones too, so an
            # old row still round-trips).
            from auth_api.people_api import tenant_groups, tenant_members

            members = (
                tenant_members(tenant, user, active_only=False)
                if slug == "user"
                else tenant_groups(tenant, user)
            )
            qs = qs.filter(pk__in=members.values("pk"))
        elif slug and is_registered(slug):
            qs = rbac.restrict_queryset(qs, user, tenant, slug, "view")
    return qs


def scope_fields(field) -> list:
    """Fields on ``field``'s related model that may narrow a reference to the
    row's scope - the containers (site, VRF, device, …), never descriptive
    catalogs such as status."""
    related = field.related_model
    out = []
    for g in related._meta.concrete_fields:
        if not g.is_relation or g.name == "tenant" or g.related_model is related:
            continue
        if g.related_model._meta.label_lower in _NON_SCOPE_MODELS:
            continue
        out.append(g)
    return out


def _candidates(field, value, tenant, user=None):
    """The objects ``value`` names, by the first lookup that matches any."""
    base = fk_base_queryset(field, tenant, user)
    for lookup in _FK_LOOKUPS:
        try:
            qs = base.filter(**{lookup: value})
            if qs.exists():
                return qs
        except (ValueError, TypeError, ValidationError, FieldError):
            continue
    return None


# More same-named objects than this are not ranked in Python; the reference
# must then match the row's scope exactly, or name the object by id.
_MAX_RANKED = 100


def _resolve_fk(field, value, tenant, user=None, scope=None):
    """The related object a cell names, or a ``ValidationError`` in plain
    words.

    A cell can name more than one object - ``eth0`` on every device, rack
    ``R1`` in every site. ``scope`` is ``{related_field_name: value}`` taken
    from the row itself (its device, site, VRF); the object that agrees with
    the row on the most of them wins, and a nullable one left empty counts as
    a near match, so a global VLAN still fits a site's prefix. A tie is an
    error, never a guess (#330).
    """
    related = field.related_model
    noun = related._meta.verbose_name
    qs = _candidates(field, value, tenant, user)
    if qs is None:
        raise ValidationError(f"{field.name}: no {noun} matching '{value}'.")
    scope = scope or {}
    rows = list(qs[:2])
    if len(rows) == 1:
        return rows[0]
    if scope:
        exact = {}
        for name, val in scope.items():
            exact[name if val is not None else f"{name}__isnull"] = (
                val if val is not None else True
            )
        rows = list(qs.filter(**exact)[:2])
        if len(rows) == 1:
            return rows[0]
        if not rows:
            ranked = _rank(qs, related, scope)
            if ranked is not None:
                return ranked
    raise ValidationError(
        f"{field.name}: '{value}' matches more than one {noun} here; "
        "use its id to say which."
    )


def _rank(qs, related, scope):
    """The single best match for ``scope`` among ``qs``, else ``None``."""
    attnames = {n: related._meta.get_field(n).attname for n in scope}
    cands = list(qs.only("pk", *attnames.values())[: _MAX_RANKED + 1])
    if len(cands) > _MAX_RANKED:
        return None
    nullable = {n: related._meta.get_field(n).null for n in scope}

    def score(obj):
        total = 0
        for name, val in scope.items():
            have = getattr(obj, attnames[name])
            want = getattr(val, "pk", val)
            if have == want:
                continue
            total += 1 if (have is None and nullable[name]) else 2
        return total

    scored = sorted(((score(c), c) for c in cands), key=lambda t: t[0])
    if len(scored) > 1 and scored[0][0] == scored[1][0]:
        return None
    return related._default_manager.get(pk=scored[0][1].pk)


def check_status_offered(field, value, instance=None) -> None:
    """Refuse a ``status`` the catalog doesn't offer the row's kind of object,
    as the API's single and bulk edits do (#292). A row that already wears it
    keeps it, so an exported sheet imports back unchanged."""
    from .models import Status
    from .status_registry import status_label, status_offered

    if field.name != "status" or not isinstance(value, Status):
        return
    if status_offered(value, field.model):
        return
    if instance is not None and getattr(instance, "status_id", None) == value.id:
        return
    raise ValidationError(f"“{value.name}” isn't a status for {status_label(field.model)}.")


def parse_json_cell(field, value):
    """A JSON column's cell as a Python value. An empty cell is the field's
    default (``[]`` / ``{}``), never an empty string (#354)."""
    if isinstance(value, (dict, list)):
        return value
    if value is None or (isinstance(value, str) and value.strip() == ""):
        if field.null:
            return None
        return field.get_default() if field.has_default() else {}
    try:
        return json.loads(value)
    except (TypeError, ValueError):
        raise ValidationError(f"{field.name}: not valid JSON.") from None


def _coerce(field, value, tenant, user=None, scope=None):
    if value is None:
        return None
    if isinstance(value, str):
        value = value.strip()
    if field.get_internal_type() == "JSONField":
        return parse_json_cell(field, value)
    if value == "" and (field.null or field.blank):
        return None if field.null else ""
    if field.is_relation:
        return _resolve_fk(field, value, tenant, user, scope=scope)
    return field.to_python(value)


def plain_db_error(exc: BaseException) -> str:
    """A database error as a sentence for the row's error column - never the
    driver's text, which names constraints and internal ids (#353)."""
    from .exception_handler import (
        _CHECK_VIOLATION,
        _FOREIGN_KEY_VIOLATION,
        _NOT_NULL_VIOLATION,
        _UNIQUE_VIOLATION,
        _column,
        _sqlstate,
    )

    code = _sqlstate(exc)
    col = _column(exc)
    where = f" ({col})" if col else ""
    if code == _UNIQUE_VIOLATION:
        return "This row conflicts with existing data (a duplicate value for a unique field)."
    if code == _NOT_NULL_VIOLATION:
        return f"A required field was left empty{where}."
    if code == _FOREIGN_KEY_VIOLATION:
        return f"A referenced object doesn't exist or can't be used{where}."
    if code == _CHECK_VIOLATION:
        return "A value isn't allowed by a database rule."
    return "The database refused this row."


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
            continue  # unknown column - ignored
        val = _coerce(field, raw, tenant, user)
        if field.is_relation:
            check_status_offered(field, val)
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
                # The tenant is set, so uniqueness that includes it is checked
                # here rather than surfacing as a database error (#353).
                obj.full_clean()
                if not dry_run:
                    obj.save()
                created += 1
        except ValidationError as exc:
            msgs = exc.messages if hasattr(exc, "messages") else [str(exc)]
            errors.append({"row": i + 1, "error": "; ".join(msgs)})
        except DatabaseError as exc:
            errors.append({"row": i + 1, "error": plain_db_error(exc)})
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
    # CSV - Excel writes ";" in half of Europe, so take the delimiter from
    # the header line rather than assuming a comma.
    head = content.lstrip("\ufeff").split("\n", 1)[0]
    try:
        dialect = csv.Sniffer().sniff(head, delimiters=",;\t|")
        delimiter = dialect.delimiter
    except csv.Error:
        delimiter = ","
    reader = csv.DictReader(io.StringIO(content.lstrip("\ufeff")), delimiter=delimiter)
    from .spreadsheet import csv_unescape

    # Our own exports mark text that looks like a formula; take that off again.
    return [{k: csv_unescape(v) for k, v in row.items()} for row in reader]
