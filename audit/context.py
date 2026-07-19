"""Per-request audit context (the acting user + a request id).

Uses ``contextvars`` so it's safe under async and never leaks between requests
(the middleware resets it in a ``finally``).
"""
from __future__ import annotations

import contextvars

_user: contextvars.ContextVar = contextvars.ContextVar("audit_user", default=None)
_request_id: contextvars.ContextVar = contextvars.ContextVar(
    "audit_request_id", default=""
)


def set_context(user, request_id: str) -> None:
    _user.set(user)
    _request_id.set(request_id)


def clear_context() -> None:
    _user.set(None)
    _request_id.set("")


def current_user():
    u = _user.get()
    if u is not None and getattr(u, "is_authenticated", False):
        return u
    return None


def current_request_id() -> str:
    return _request_id.get()
