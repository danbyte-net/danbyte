"""Query parameter parsing for views that read ``request.query_params``
by hand. A value that does not parse is the caller's input: each helper
raises a 400 naming the parameter, never lets ``int()`` or ``UUID()``
escape as a 500 (#373)."""
from __future__ import annotations

import uuid

from rest_framework.exceptions import ValidationError

_TRUE = ("1", "true", "yes", "on")
_FALSE = ("0", "false", "no", "off")


def _raw(request, name):
    params = getattr(request, "query_params", None)
    if params is None:
        params = request.GET
    raw = params.get(name)
    return None if raw is None or str(raw).strip() == "" else str(raw).strip()


def int_param(request, name, default=None, *, min_value=None, max_value=None):
    """``name`` as an int, clamped to ``[min_value, max_value]``; ``default``
    when absent."""
    raw = _raw(request, name)
    if raw is None:
        return default
    try:
        value = int(raw)
    except ValueError:
        raise ValidationError({name: ["A whole number is required."]}) from None
    if min_value is not None:
        value = max(value, min_value)
    if max_value is not None:
        value = min(value, max_value)
    return value


def bool_param(request, name, default=None):
    """``name`` as a bool (1/true/yes/on, 0/false/no/off); ``default`` when
    absent."""
    raw = _raw(request, name)
    if raw is None:
        return default
    if raw.lower() in _TRUE:
        return True
    if raw.lower() in _FALSE:
        return False
    raise ValidationError({name: ["Must be true or false."]})


def uuid_param(request, name, default=None):
    """``name`` as a ``uuid.UUID``; ``default`` when absent."""
    raw = _raw(request, name)
    if raw is None:
        return default
    try:
        return uuid.UUID(raw)
    except ValueError:
        raise ValidationError({name: ["Not a valid id."]}) from None
