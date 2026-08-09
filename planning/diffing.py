"""Turn a submitted edit form into a change set.

Planning reuses the object's real edit form, which (like every form in Danbyte)
submits the **complete** write payload rather than a diff. So the diff is computed
here, once, on the server:

1. validate the payload through the **target's own serializer**, so a plan is
   held to exactly the rules a real write would be, and
2. compare each validated key against the object's current write-shaped value,
   keeping only what actually differs.

Doing it server-side is what keeps ~70 forms free of diff logic, and keeps the
serializer the single authority on what a valid write is.
"""
from __future__ import annotations

from django.db import models
from rest_framework.exceptions import ValidationError

from api.editable_fields import field_for, serializer_for

# Sentinel: the object has no such attribute (so we cannot diff that key).
_ABSENT = object()


def _is_m2m(field) -> bool:
    """Many-to-many by *behaviour*, not by class.

    ``isinstance(field, ManyToManyField)`` is not enough: taggit's
    ``TaggableManager`` sets ``many_to_many = True`` without subclassing it, and
    checking the class let a list value fall through to the scalar branch, where
    a choices lookup raised ``unhashable type: 'list'``.
    """
    return bool(getattr(field, "many_to_many", False))


def _plain(value) -> str:
    """Last-resort rendering for a value with no field-specific treatment.

    Lists and dicts get a readable summary rather than a repr — and, crucially,
    never reach a dict lookup, which would raise on an unhashable value.
    """
    if isinstance(value, (list, tuple)):
        return ", ".join(str(v) for v in value) if value else "none"
    if isinstance(value, dict):
        if not value:
            return "none"
        return ", ".join(f"{k}: {v}" for k, v in sorted(value.items()))[:200]
    return str(value)


def _related_names(field, value) -> str:
    related = getattr(field, "related_model", None)
    ids = list(value) if isinstance(value, (list, tuple)) else [value]
    if related is None:
        return _plain(value)
    names = [str(o) for o in related._default_manager.filter(pk__in=ids)]
    return ", ".join(names) if names else _plain(value)


def _display_of(model, key: str, value):
    """A human string for one write value.

    FKs carry ids, which read as noise in a task; resolve them to the object's
    own ``__str__``. Booleans read as Yes/No, matching the rest of the UI.
    """
    if value is None or value == "":
        return ""
    field = _model_field(model, key)
    if field is None:
        return _plain(value)
    if isinstance(field, models.BooleanField):
        return "Yes" if value else "No"
    if _is_m2m(field):
        return _related_names(field, value)
    if isinstance(field, models.ForeignKey):
        obj = field.related_model._default_manager.filter(pk=value).first()
        return str(obj) if obj is not None else _plain(value)
    # Only scalars can index a choices map; anything else (JSON blobs, lists)
    # renders generically.
    if isinstance(value, (list, tuple, dict)):
        return _plain(value)
    flat = dict(getattr(field, "flatchoices", []) or [])
    return str(flat.get(value, value))


def _model_field(model, key: str):
    """The model field a write key targets. ``role_id`` → the ``role`` FK,
    ``tag_ids`` → the ``tags`` m2m. Returns None for keys that are not plain
    model fields (``custom_fields`` handling lives with the serializer)."""
    for candidate in (key, key[:-3] if key.endswith("_id") else None,
                      f"{key[:-4]}s" if key.endswith("_ids") else None):
        if not candidate:
            continue
        try:
            return model._meta.get_field(candidate)
        except Exception:
            continue
    return None


def _label_of(model, key: str) -> str:
    """The field's human label. Prefers the editable-field registry (which
    already curates labels like "802.1Q mode"), else the model's verbose name."""
    spec = field_for(model, key)
    if spec is not None:
        return spec.label
    field = _model_field(model, key)
    if field is None:
        return key.replace("_", " ").capitalize()
    verbose = str(getattr(field, "verbose_name", "") or field.name)
    return verbose[:1].upper() + verbose[1:]


def current_write_value(obj, key: str):
    """The object's current value for a *write* key, in write shape.

    ``role_id`` → the raw FK id; ``tag_ids`` → the current id list; anything else
    → the attribute. Returns ``_ABSENT`` when the key isn't readable off the
    instance, so the caller can decline to diff it rather than guess.
    """
    model = type(obj)
    field = _model_field(model, key)
    if field is None:
        return getattr(obj, key, _ABSENT)
    if _is_m2m(field):
        manager = getattr(obj, field.name, None)
        if manager is None:
            return _ABSENT
        return sorted(str(pk) for pk in manager.values_list("pk", flat=True))
    if isinstance(field, models.ForeignKey):
        value = getattr(obj, field.attname, _ABSENT)
        return str(value) if value not in (None, _ABSENT) else value
    return getattr(obj, field.name, _ABSENT)


def _normalise(value):
    """Comparable form. UUIDs and Decimals arrive as objects on one side and
    strings on the other; lists of ids may differ only in order."""
    if isinstance(value, (list, tuple)):
        return sorted(str(v) for v in value)
    if value is None:
        return None
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float, dict)):
        return value
    return str(value)


def validate_payload(model, payload: dict, instance=None, *, request=None) -> dict:
    """Run the payload through the target's serializer and return it unchanged
    on success. Raises the serializer's own ``ValidationError`` otherwise, so a
    plan fails with the same field errors a real write would produce.

    ``request`` is not optional in practice: the serializers' FK fields are
    ``TenantScopedPrimaryKeyRelatedField``, which reads the active tenant off
    the request context. Without it a plan could reference another tenant's site
    and only fail later, at apply time.
    """
    serializer_cls = serializer_for(model)
    if serializer_cls is None:
        raise ValidationError(
            "This object type can't be written through the API."
        )
    ser = serializer_cls(
        instance, data=payload, partial=instance is not None,
        context={"request": request} if request is not None else {},
    )
    ser.is_valid(raise_exception=True)
    return payload


def diff_update(obj, payload: dict) -> tuple[dict, dict, list[dict]]:
    """``(changed, before, display)`` for an edit of ``obj``.

    ``changed`` holds only the keys whose submitted value differs from the live
    one. Keys the instance can't answer for are skipped rather than guessed at —
    a write key with no readable counterpart would otherwise always look changed.
    """
    model = type(obj)
    changed: dict = {}
    before: dict = {}
    display: list[dict] = []
    for key, new in payload.items():
        live = current_write_value(obj, key)
        if live is _ABSENT:
            continue
        if _normalise(live) == _normalise(new):
            continue
        changed[key] = new
        before[key] = live if not isinstance(live, (list, tuple)) else list(live)
        display.append({
            "field": key,
            "label": _label_of(model, key),
            "from": _display_of(model, key, live),
            "to": _display_of(model, key, new),
        })
    return changed, before, display


def describe_create(model, payload: dict) -> list[dict]:
    """``display`` rows for a create: every value that was actually filled in.
    An empty field on a new object says nothing worth showing."""
    rows = []
    for key, value in payload.items():
        if value in (None, "", [], {}):
            continue
        rows.append({
            "field": key,
            "label": _label_of(model, key),
            "from": "",
            "to": _display_of(model, key, value),
        })
    return rows


def stale_keys(obj, before: dict) -> list[str]:
    """Which snapshotted keys no longer match the live object — the premise of
    the plan, re-checked at apply time."""
    out = []
    for key, was in (before or {}).items():
        live = current_write_value(obj, key)
        if live is _ABSENT:
            continue
        if _normalise(live) != _normalise(was):
            out.append(key)
    return out
