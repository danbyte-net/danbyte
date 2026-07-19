"""Content-Security-Policy violation report sink.

The CSP is served enforcing with a ``report-uri`` pointing here, so any resource
the policy blocks in a real browser is reported back and logged. That's the
safety net for tightening the policy (e.g. dropping ``'unsafe-inline'`` for a
nonce-based script-src) without silently breaking the SPA: watch
``danbyte.csp`` for violations, then adjust.

Unauthenticated + CSRF-exempt by necessity — the browser posts these reports
with no session cookie and no CSRF token. It only logs; it never trusts the
payload for anything.
"""
from __future__ import annotations

import json
import logging

from django.http import HttpResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

log = logging.getLogger("danbyte.csp")

# A single oversized/garbage body can't be used to flood logs or memory.
_MAX_BODY = 16 * 1024


@csrf_exempt
@require_POST
def csp_report(request):
    raw = request.body[:_MAX_BODY]
    try:
        payload = json.loads(raw.decode("utf-8", "replace") or "{}")
    except ValueError:
        return HttpResponse(status=204)  # ignore malformed reports quietly

    # report-uri sends {"csp-report": {...}}; the Reporting API sends a list of
    # {"type": "csp-violation", "body": {...}} — normalise to the inner dict(s).
    reports = []
    if isinstance(payload, dict) and "csp-report" in payload:
        reports = [payload["csp-report"]]
    elif isinstance(payload, list):
        reports = [r.get("body", r) for r in payload if isinstance(r, dict)]
    elif isinstance(payload, dict):
        reports = [payload.get("body", payload)]

    for r in reports:
        if not isinstance(r, dict):
            continue
        log.warning(
            "CSP violation: directive=%s blocked=%s document=%s",
            r.get("violated-directive") or r.get("effectiveDirective"),
            r.get("blocked-uri") or r.get("blockedURL"),
            r.get("document-uri") or r.get("documentURL"),
        )
    return HttpResponse(status=204)
