"""Project-wide DRF exception handler.

DRF's default handler only knows `APIException` / `Http404` / `PermissionDenied`
- a raw `django.db.IntegrityError` (e.g. a unique-constraint violation that a
serializer didn't validate) escapes uncaught and becomes a 500. That's a poor
experience (the user just hit a duplicate) and leaks a traceback.

We convert an uncaught IntegrityError into a clean response and log the
original, so a genuine bug is still visible in the logs but the client gets a
sane, *honest* message. The Postgres SQLSTATE tells us which constraint class
actually failed, so we don't call a not-null (or FK, or check) violation a
"duplicate" - that wording actively misleads debugging. Everything else falls
through to DRF's default handler unchanged. Serializers that validate the
conflict up front (see `PrefixSerializer.validate`) still return the nicer
field-level 400 first; this is the safety net for the ones that don't.
"""
from __future__ import annotations

import logging

from django.db import IntegrityError
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import exception_handler as drf_default

log = logging.getLogger(__name__)

# Postgres SQLSTATE classes we can word honestly. Anything else falls back to a
# generic constraint message (still without the word "duplicate").
_UNIQUE_VIOLATION = "23505"
_NOT_NULL_VIOLATION = "23502"
_FOREIGN_KEY_VIOLATION = "23503"
_CHECK_VIOLATION = "23514"


def _sqlstate(exc: BaseException) -> str | None:
    """Best-effort SQLSTATE for a DB error.

    The driver error is wrapped by Django on ``exc.__cause__``; psycopg3
    exposes it as ``sqlstate`` and psycopg2 as ``pgcode``. Returns None when
    it can't be determined - e.g. a Django-level ``ProtectedError`` raised by
    the delete collector, which has no DB cause at all.
    """
    cause = getattr(exc, "__cause__", None)
    return getattr(cause, "sqlstate", None) or getattr(cause, "pgcode", None)


def _column(exc: BaseException) -> str | None:
    """The offending column name from psycopg diagnostics, when available."""
    cause = getattr(exc, "__cause__", None)
    diag = getattr(cause, "diag", None)
    return getattr(diag, "column_name", None)


def exception_handler(exc, context):
    response = drf_default(exc, context)
    if response is not None:
        return response
    if isinstance(exc, IntegrityError):
        view = context.get("view")
        log.warning(
            "IntegrityError surfaced to the API (%s): %s",
            view.__class__.__name__ if view else "?",
            exc,
        )
        sqlstate = _sqlstate(exc)

        if sqlstate == _UNIQUE_VIOLATION:
            return Response(
                {"detail": "This conflicts with existing data (a duplicate "
                           "value for a unique field). Nothing was saved."},
                status=status.HTTP_409_CONFLICT,
            )

        if sqlstate == _NOT_NULL_VIOLATION:
            col = _column(exc)
            where = f" ('{col}')" if col else ""
            return Response(
                {"detail": f"A required field was left empty{where}. Nothing "
                           "was saved."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if sqlstate == _FOREIGN_KEY_VIOLATION:
            col = _column(exc)
            where = f" ('{col}')" if col else ""
            return Response(
                {"detail": f"A referenced object doesn't exist or can't be "
                           f"used{where}. Nothing was saved."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        if sqlstate == _CHECK_VIOLATION:
            return Response(
                {"detail": "A value violated a database check constraint. "
                           "Nothing was saved."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # SQLSTATE unknown (or a Django-level ProtectedError from a delete of
        # an in-use row): keep the 409, but never call it a "duplicate".
        return Response(
            {"detail": "This conflicts with a database constraint. Nothing "
                       "was saved."},
            status=status.HTTP_409_CONFLICT,
        )
    return None
