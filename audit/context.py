"""Per-request audit context (the acting user + a request id).

Uses ``contextvars`` so it's safe under async and never leaks between requests
(the middleware resets it in a ``finally``).
"""
from __future__ import annotations

import contextlib
import contextvars

_user: contextvars.ContextVar = contextvars.ContextVar("audit_user", default=None)
_request_id: contextvars.ContextVar = contextvars.ContextVar(
    "audit_request_id", default=""
)
_suspended: contextvars.ContextVar = contextvars.ContextVar(
    "audit_suspended", default=False
)


@contextlib.contextmanager
def suspended():
    """Stop recording change-log entries for the duration of the block.

    For tearing down a tenant. Its change log is owned by the tenant and goes
    with it, so logging each cascaded delete writes rows pointing at a tenant
    row the same transaction is removing — the deferred foreign key then fails
    at COMMIT and rolls the whole deletion back. There is also nothing to
    record: the log those entries would land in no longer exists.

    Deliberately narrow. Anything that isn't deleting the owning tenant should
    still be audited.
    """
    token = _suspended.set(True)
    try:
        yield
    finally:
        _suspended.reset(token)


def is_suspended() -> bool:
    return _suspended.get()


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
