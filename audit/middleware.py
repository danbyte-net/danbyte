"""Stash the request user + a request id into the audit context so model
signals can attribute changes to whoever made them."""
from __future__ import annotations

import uuid

from .context import clear_context, set_context


class AuditContextMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        set_context(getattr(request, "user", None), uuid.uuid4().hex)
        try:
            return self.get_response(request)
        finally:
            clear_context()
