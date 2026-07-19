"""Validate / coerce a ``custom_fields`` dict against a tenant's definitions.

Used by the domain serializers (api/serializers.py) so that values written
through any object form are typed, choice-checked, and required-enforced
according to the tenant's :class:`~customization.models.CustomField` rows.
"""
from __future__ import annotations

import datetime

from .models import CustomField


def _coerce(d: CustomField, raw, tenant):
    """Return ``(ok, coerced_value, error_message)`` for one field value."""
    t = d.type
    if t in ("text", "textarea", "url"):
        return True, str(raw), ""
    if t == "integer":
        try:
            return True, int(raw), ""
        except (TypeError, ValueError):
            return False, None, "Must be a whole number."
    if t == "decimal":
        try:
            return True, float(raw), ""
        except (TypeError, ValueError):
            return False, None, "Must be a number."
    if t == "boolean":
        if isinstance(raw, bool):
            return True, raw, ""
        s = str(raw).lower()
        if s in ("true", "1", "yes"):
            return True, True, ""
        if s in ("false", "0", "no"):
            return True, False, ""
        return False, None, "Must be true or false."
    if t == "date":
        try:
            datetime.date.fromisoformat(str(raw))
            return True, str(raw), ""
        except ValueError:
            return False, None, "Must be a date (YYYY-MM-DD)."
    if t == "select":
        if str(raw) in d.choices:
            return True, str(raw), ""
        return False, None, f"Must be one of: {', '.join(d.choices)}."
    if t == "multiselect":
        if not isinstance(raw, list):
            return False, None, "Must be a list."
        bad = [x for x in raw if str(x) not in d.choices]
        if bad:
            return False, None, f"Invalid option(s): {', '.join(map(str, bad))}."
        return True, [str(x) for x in raw], ""
    if t == "object":
        from .object_registry import reference_model

        ref = reference_model(d.related_model)
        if ref is None:
            return False, None, "This field's target model no longer exists."
        try:
            qs = ref.model.objects.filter(pk=str(raw))
            if ref.tenant_field:
                qs = qs.filter(**{ref.tenant_field: tenant})
            from .scopes import apply_scope_to_queryset

            exists = apply_scope_to_queryset(qs, d.related_model, d.scope_rules or {}).exists()
        except (ValueError, TypeError):  # malformed pk (e.g. non-int for users)
            exists = False
        if not exists:
            return False, None, f"No such {ref.label.rstrip('s').lower()}."
        return True, str(raw), ""
    return True, raw, ""


def clean_custom_fields(tenant, model_slug: str, value):
    """Validate ``value`` against the tenant's defs for ``model_slug``.

    Returns ``(cleaned, errors)``. Defined keys are coerced to their type;
    required defs must carry a non-empty value; empty values are dropped so
    we never persist ``null``. Keys with no matching definition pass through
    untouched (legacy / ad-hoc data isn't clobbered).
    """
    if not isinstance(value, dict):
        return {}, {"custom_fields": "Must be an object."}
    defs = list(
        CustomField.objects.filter(tenant=tenant, applies_to__contains=[model_slug])
    )
    cleaned = dict(value)
    errors: dict[str, str] = {}
    for d in defs:
        raw = value.get(d.key)
        empty = d.key not in value or raw in (None, "", [])
        if empty:
            if d.required:
                errors[d.key] = "This field is required."
            cleaned.pop(d.key, None)
            continue
        ok, coerced, msg = _coerce(d, raw, tenant)
        if not ok:
            errors[d.key] = msg
        else:
            cleaned[d.key] = coerced
    return cleaned, errors
