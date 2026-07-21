"""HTML email helper — the shared way Danbyte sends a formatted email.

The first HTML email in the app. Wraps content in a minimal, email-client-safe
layout (table-based, inline CSS, Danbyte header/footer) and sends it as
multipart HTML + plain-text through the effective SMTP cascade
(``effective_email`` → ``build_email_connection``). Best-effort: it logs and
returns False on failure instead of raising into the caller.

Use ``send_html_email(...)`` for any new formatted email; use ``render_layout``
if you only need the branded wrapper.
"""
from __future__ import annotations

import logging

from django.conf import settings
from django.utils.html import escape

logger = logging.getLogger("danbyte.email")

# Brand blue (matches the app's --primary, roughly) for the header bar.
BRAND = "#1667e6"


def render_layout(title: str, body_html: str, *, deployment_name: str = "Danbyte",
                  footer_html: str = "") -> str:
    """Wrap ``body_html`` in the branded, inline-styled email shell.

    Table + inline CSS only — the lowest common denominator that renders in
    Outlook/Gmail/Apple Mail. ``body_html`` is trusted (built by callers from
    escaped data); ``title``/``deployment_name`` are escaped here.
    """
    name = escape(deployment_name or "Danbyte")
    heading = escape(title)
    footer = footer_html or (
        f'<p style="margin:0;color:#71717a;font-size:12px;">'
        f'Sent by {name}. You are receiving this because you are on its '
        f'notification list.</p>'
    )
    return f"""\
<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;
 font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18181b;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:24px 0;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0"
 style="width:600px;max-width:100%;background:#ffffff;border:1px solid #e4e4e7;border-radius:10px;overflow:hidden;">
  <tr><td style="background:{BRAND};padding:16px 24px;">
    <span style="color:#ffffff;font-size:16px;font-weight:600;letter-spacing:.02em;">{name}</span>
  </td></tr>
  <tr><td style="padding:24px;">
    <h1 style="margin:0 0 16px;font-size:18px;font-weight:600;color:#18181b;">{heading}</h1>
    {body_html}
  </td></tr>
  <tr><td style="padding:16px 24px;border-top:1px solid #e4e4e7;background:#fafafa;">
    {footer}
  </td></tr>
</table>
</td></tr></table>
</body></html>"""


def send_html_email(
    subject: str,
    recipients: list[str],
    *,
    html_body: str,
    text_body: str,
    tenant=None,
    site=None,
) -> bool:
    """Send a multipart HTML+text email via the effective SMTP for the tenant/
    site. Returns True if a send was attempted with at least one recipient.

    Does NOT check ``email_enabled`` — callers decide whether the feature is on;
    the connection falls back to Django's configured backend when no SMTP host
    is set (console in dev, locmem in tests).
    """
    from django.core.mail import EmailMultiAlternatives

    from core.effective_settings import effective_email
    from monitoring.notify import build_email_connection

    recipients = [r.strip() for r in (recipients or []) if r and r.strip()]
    if not recipients:
        return False

    eff = effective_email(tenant, site)
    from_email = getattr(eff, "email_from", "") or settings.DEFAULT_FROM_EMAIL
    try:
        conn = build_email_connection(eff)
        msg = EmailMultiAlternatives(
            subject, text_body, from_email, recipients, connection=conn
        )
        msg.attach_alternative(html_body, "text/html")
        msg.send(fail_silently=False)
        return True
    except Exception as exc:  # noqa: BLE001 — best-effort, never break the caller
        logger.warning("send_html_email failed (%s): %s", subject, exc)
        return False


def parse_recipients(raw: str) -> list[str]:
    """Split a comma/newline/space-separated recipient string into addresses."""
    import re

    return [a for a in re.split(r"[\s,;]+", raw or "") if a]
