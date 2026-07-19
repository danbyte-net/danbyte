"""Project-wide DRF exception handler.

DRF's default handler only knows `APIException` / `Http404` / `PermissionDenied`
— a raw `django.db.IntegrityError` (e.g. a unique-constraint violation that a
serializer didn't validate) escapes uncaught and becomes a 500. That's a poor
experience (the user just hit a duplicate) and leaks a traceback.

We convert an uncaught IntegrityError into a clean **409 Conflict** and log the
original, so a genuine bug is still visible in the logs but the client gets a
sane response. Everything else falls through to DRF's default handler
unchanged. Serializers that validate the conflict up front (see
`PrefixSerializer.validate`) still return the nicer field-level 400 first; this
is the safety net for the ones that don't.
"""
from __future__ import annotations

import logging

from django.db import IntegrityError
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import exception_handler as drf_default

log = logging.getLogger(__name__)


def exception_handler(exc, context):
    response = drf_default(exc, context)
    if response is not None:
        return response
    if isinstance(exc, IntegrityError):
        log.warning(
            "IntegrityError surfaced to the API (%s): %s",
            context.get("view").__class__.__name__ if context.get("view") else "?",
            exc,
        )
        return Response(
            {"detail": "This conflicts with existing data (a duplicate or a "
                       "constraint violation). Nothing was saved."},
            status=status.HTTP_409_CONFLICT,
        )
    return None
