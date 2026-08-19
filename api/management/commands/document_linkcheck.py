"""Sweep external-link documents and reconcile their dead-link status.

Run daily by ``danbyte-document-linkcheck.timer``. For every URL-bearing
:class:`api.models.Document` it does a short, SSRF-guarded ``GET`` (redirects are
disabled and the connection is pinned to a validated public IP) and records
whether the link is reachable - so a broken datasheet/runbook link surfaces in
the UI without a user clicking it.

    manage.py document_linkcheck

A 2xx/3xx response is ``ok``; a 4xx/5xx, a timeout, or an SSRF rejection (the
target now resolves to a private address) is ``broken``.
"""
from __future__ import annotations

from django.core.management.base import BaseCommand
from django.utils import timezone

from core.scheduled_runs import record_run
from core.ssrf import SSRFError, safe_get

# Keep the sweep snappy: a slow host must not stall the whole run.
_TIMEOUT = 10


def _check_one(url: str) -> tuple[str, int | None]:
    """Return ``(link_status, status_code)`` for one URL."""
    from api.models import Document

    try:
        resp = safe_get(url, timeout=_TIMEOUT)
    except SSRFError:
        return Document.LinkStatus.BROKEN, None
    except Exception:  # noqa: BLE001 - any transport error is a broken link
        return Document.LinkStatus.BROKEN, None
    code = resp.status_code
    ok = 200 <= code < 400
    return (Document.LinkStatus.OK if ok else Document.LinkStatus.BROKEN), code


class Command(BaseCommand):
    help = "Check external-link documents and update their dead-link status."

    def handle(self, *args, **opts):
        from api.models import Document

        with record_run("document-linkcheck", "Document link check") as run:
            qs = Document.objects.exclude(url="").order_by("tenant_id", "id")
            checked = ok = broken = 0
            for doc in qs.iterator():
                status, code = _check_one(doc.url)
                doc.link_status = status
                doc.link_status_code = code
                doc.link_checked_at = timezone.now()
                doc.save(
                    update_fields=[
                        "link_status", "link_status_code", "link_checked_at",
                    ]
                )
                checked += 1
                if status == Document.LinkStatus.OK:
                    ok += 1
                else:
                    broken += 1
            self.stdout.write(
                self.style.SUCCESS(
                    f"document link check: {checked} links, {ok} ok, {broken} broken"
                )
            )
            run.note(
                f"{checked} links, {ok} ok, {broken} broken",
                checked=checked, ok=ok, broken=broken,
            )
