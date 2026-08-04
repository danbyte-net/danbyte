"""HTML email — the shared, good-looking way Danbyte sends a formatted email.

Every email Danbyte sends (monitoring digest, certificate digest, alert
notifications, sign-in codes, invites, connectivity tests) is built from the
small component kit in this module so they all share one restrained, email-
client-safe design: a branded header, generous spacing, the app's zinc/blue
palette, and the same status colours the UI uses.

Design constraints (why it looks the way it does):

* **Tables + inline CSS only.** Outlook/Gmail/Apple Mail ignore ``<style>``
  blocks, flexbox, and CSS variables, so every rule is inline and layout is
  table-based — the lowest common denominator that renders everywhere.
* **A hidden preheader.** The one line an inbox shows next to the subject.
* **One palette.** :data:`PALETTE` and :data:`STATUS_BG` mirror the SPA tokens
  (``frontend/src/styles.css`` + the monitoring charts) so an email reads as the
  same product, resolved to hex because clients can't evaluate CSS variables.

Build a body from the component helpers (:func:`section`, :func:`stat_grid`,
:func:`pill`, :func:`kv_table`, :func:`callout`, :func:`email_button`, …), wrap
it with :func:`render_layout`, and send it with :func:`send_html_email`. All
values passed to the helpers are escaped here — callers pass plain strings.
"""
from __future__ import annotations

import logging

from django.conf import settings
from django.utils.html import escape

logger = logging.getLogger("danbyte.email")

# ── palette (resolved from the SPA's zinc/blue design tokens) ────────────────
PALETTE = {
    "brand": "#1667e6",       # --primary
    "brand_dark": "#1252b8",  # header gradient foot
    "ink": "#18181b",         # zinc-900 — body text
    "muted": "#71717a",       # zinc-500 — secondary text
    "faint": "#a1a1aa",       # zinc-400
    "line": "#e4e4e7",        # zinc-200 — borders
    "hair": "#f4f4f5",        # zinc-100 — row separators
    "panel": "#fafafa",       # zinc-50 — footer / stat fill
    "page": "#f4f4f5",        # page backdrop
    "card": "#ffffff",
}

# Status → (background, foreground). Mirrors the digest's old map + the app's
# STATUS_COLOR so a badge in an email is the same green/red/amber as the UI.
STATUS_BG = {
    "up": "#10b981", "ok": "#10b981", "success": "#10b981",
    "down": "#ef4444", "critical": "#ef4444", "expired": "#ef4444",
    "stale": "#991b1b",
    "degraded": "#f59e0b", "warning": "#f59e0b", "expiring": "#f59e0b",
    "info": "#1667e6",
    "unknown": "#a1a1aa",
    "skipped": "#d4d4d8",
}
STATUS_FG = {
    "up": "#ffffff", "ok": "#ffffff", "success": "#ffffff",
    "down": "#ffffff", "critical": "#ffffff", "expired": "#ffffff",
    "stale": "#ffffff",
    "degraded": "#422006", "warning": "#422006", "expiring": "#422006",
    "info": "#ffffff",
    "unknown": "#ffffff",
    "skipped": "#3f3f46",
}

_FONT = ("-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,"
         "sans-serif")


# ── component kit ────────────────────────────────────────────────────────────
# Each returns a small, self-contained HTML fragment. Compose a body by joining
# fragments, then pass the result to render_layout().

def section(title: str) -> str:
    """A section heading — a small, tracked-out label above a block."""
    return (
        f'<h2 style="margin:26px 0 10px;font-size:13px;font-weight:600;'
        f'letter-spacing:.04em;text-transform:uppercase;color:{PALETTE["muted"]};">'
        f'{escape(title)}</h2>'
    )


def lead(text: str) -> str:
    """The intro paragraph under the title."""
    return (
        f'<p style="margin:0 0 18px;font-size:15px;line-height:1.55;'
        f'color:{PALETTE["ink"]};">{escape(text)}</p>'
    )


def paragraph(text: str) -> str:
    return (
        f'<p style="margin:0 0 14px;font-size:14px;line-height:1.55;'
        f'color:{PALETTE["ink"]};">{escape(text)}</p>'
    )


def muted(text: str) -> str:
    return (
        f'<p style="margin:0 0 12px;font-size:13px;line-height:1.5;'
        f'color:{PALETTE["muted"]};">{escape(text)}</p>'
    )


def pill(text: str, kind: str = "unknown") -> str:
    """A coloured status badge — the same treatment as the app's StatusBadge."""
    bg = STATUS_BG.get(kind, STATUS_BG["unknown"])
    fg = STATUS_FG.get(kind, "#ffffff")
    return (
        f'<span style="display:inline-block;background:{bg};color:{fg};'
        f'font-size:11px;font-weight:600;line-height:1;padding:4px 9px;'
        f'border-radius:999px;white-space:nowrap;">{escape(text)}</span>'
    )


def stat_grid(cells: list) -> str:
    """A row of stat tiles. ``cells`` = ``[(value, label)]`` or
    ``[(value, label, accent_hex)]``. Wraps by rendering as a table row."""
    if not cells:
        return ""
    tds = []
    for cell in cells:
        value, label = cell[0], cell[1]
        accent = cell[2] if len(cell) > 2 else PALETTE["ink"]
        tds.append(
            f'<td style="padding:0 6px 0 0;vertical-align:top;width:{100 // len(cells)}%;">'
            f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
            f'style="background:{PALETTE["panel"]};border:1px solid {PALETTE["line"]};'
            f'border-radius:10px;"><tr><td style="padding:12px 14px;">'
            f'<div style="font-size:24px;font-weight:700;line-height:1.1;'
            f'color:{accent};">{escape(str(value))}</div>'
            f'<div style="margin-top:3px;font-size:12px;color:{PALETTE["muted"]};">'
            f'{escape(str(label))}</div>'
            f'</td></tr></table></td>'
        )
    return (
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        'style="margin:0 0 8px;table-layout:fixed;"><tr>' + "".join(tds) + "</tr></table>"
    )


def kv_table(rows: list) -> str:
    """A two-column label/value table. ``rows`` = ``[(label, value_html)]`` —
    values are treated as pre-built HTML (use :func:`pill` etc.), labels are
    escaped."""
    if not rows:
        return ""
    trs = "".join(
        f'<tr>'
        f'<td style="padding:7px 12px 7px 0;font-size:13px;color:{PALETTE["muted"]};'
        f'white-space:nowrap;vertical-align:top;border-bottom:1px solid {PALETTE["hair"]};">'
        f'{escape(str(label))}</td>'
        f'<td style="padding:7px 0;font-size:13px;color:{PALETTE["ink"]};'
        f'vertical-align:top;border-bottom:1px solid {PALETTE["hair"]};">{value}</td>'
        f'</tr>'
        for label, value in rows
    )
    return (
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0">'
        f'{trs}</table>'
    )


def data_table(headers: list, rows: list) -> str:
    """A bordered data table. ``headers`` = ``[str]``; ``rows`` =
    ``[[cell_html, …]]`` — cells are pre-built HTML, headers escaped."""
    ths = "".join(
        f'<th style="text-align:left;padding:8px 12px;font-size:11px;font-weight:600;'
        f'letter-spacing:.03em;text-transform:uppercase;color:{PALETTE["muted"]};'
        f'background:{PALETTE["panel"]};border-bottom:1px solid {PALETTE["line"]};">'
        f'{escape(str(h))}</th>'
        for h in headers
    )
    trs = "".join(
        "<tr>" + "".join(
            f'<td style="padding:8px 12px;font-size:13px;color:{PALETTE["ink"]};'
            f'border-bottom:1px solid {PALETTE["hair"]};vertical-align:top;">{c}</td>'
            for c in row
        ) + "</tr>"
        for row in rows
    )
    return (
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'style="border:1px solid {PALETTE["line"]};border-radius:10px;'
        f'border-collapse:separate;overflow:hidden;">'
        f'<tr>{ths}</tr>{trs}</table>'
    )


_CALLOUT = {
    "info": ("#eff4ff", "#1252b8", PALETTE["brand"]),
    "success": ("#ecfdf5", "#065f46", "#10b981"),
    "warning": ("#fffbeb", "#92400e", "#f59e0b"),
    "critical": ("#fef2f2", "#991b1b", "#ef4444"),
}


def callout(text: str, kind: str = "info") -> str:
    """A tinted box with a coloured left rule — for the one thing that matters."""
    bg, fg, bar = _CALLOUT.get(kind, _CALLOUT["info"])
    return (
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'style="margin:0 0 16px;background:{bg};border-radius:8px;">'
        f'<tr><td style="width:4px;background:{bar};border-radius:8px 0 0 8px;"></td>'
        f'<td style="padding:12px 14px;font-size:14px;line-height:1.5;color:{fg};">'
        f'{escape(text)}</td></tr></table>'
    )


def email_button(url: str, label: str) -> str:
    """A solid brand button (bulletproof VML-free table button)."""
    safe_url = escape(url)  # django's escape() always escapes quotes
    return (
        f'<table role="presentation" cellpadding="0" cellspacing="0" '
        f'style="margin:6px 0 18px;"><tr><td style="border-radius:8px;'
        f'background:{PALETTE["brand"]};">'
        f'<a href="{safe_url}" style="display:inline-block;padding:11px 20px;'
        f'font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;'
        f'border-radius:8px;">{escape(label)}</a></td></tr></table>'
    )


def bullet_list(items: list) -> str:
    if not items:
        return ""
    lis = "".join(
        f'<li style="margin:0 0 6px;font-size:14px;line-height:1.5;'
        f'color:{PALETTE["ink"]};">{escape(str(i))}</li>'
        for i in items
    )
    return f'<ul style="margin:0 0 14px;padding-left:20px;">{lis}</ul>'


def divider() -> str:
    return (
        f'<div style="border-top:1px solid {PALETTE["line"]};margin:22px 0;">'
        f'</div>'
    )


def code_line(text: str) -> str:
    """A monospace value block — for a one-time code or a fingerprint."""
    return (
        f'<div style="display:inline-block;font-family:ui-monospace,SFMono-Regular,'
        f'Menlo,Consolas,monospace;font-size:22px;font-weight:700;letter-spacing:.18em;'
        f'color:{PALETTE["ink"]};background:{PALETTE["panel"]};'
        f'border:1px solid {PALETTE["line"]};border-radius:8px;padding:12px 18px;'
        f'margin:2px 0 18px;">{escape(text)}</div>'
    )


# ── layout shell ─────────────────────────────────────────────────────────────

def render_layout(
    title: str,
    body_html: str,
    *,
    deployment_name: str = "Danbyte",
    footer_html: str = "",
    preheader: str = "",
    kicker: str = "",
) -> str:
    """Wrap ``body_html`` in the branded, inline-styled email shell.

    ``body_html`` is trusted (built by callers from escaped data via the helpers
    above); ``title`` / ``deployment_name`` / ``preheader`` / ``kicker`` are
    escaped here. ``preheader`` is the hidden inbox-preview line; ``kicker`` is a
    small label above the title (e.g. "Monitoring digest").
    """
    name = escape(deployment_name or "Danbyte")
    heading = escape(title)
    pre = escape(preheader) if preheader else ""
    preheader_html = (
        f'<div style="display:none;max-height:0;overflow:hidden;opacity:0;'
        f'color:transparent;height:0;width:0;">{pre}</div>' if pre else ""
    )
    kicker_html = (
        f'<div style="margin:0 0 4px;font-size:12px;font-weight:600;'
        f'letter-spacing:.05em;text-transform:uppercase;color:{PALETTE["brand"]};">'
        f'{escape(kicker)}</div>' if kicker else ""
    )
    footer = footer_html or (
        f'<p style="margin:0;color:{PALETTE["muted"]};font-size:12px;line-height:1.5;">'
        f'Sent by {name}. You are receiving this because you are on its '
        f'notification list.</p>'
    )
    return f"""\
<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only"></head>
<body style="margin:0;padding:0;background:{PALETTE['page']};
 font-family:{_FONT};color:{PALETTE['ink']};-webkit-font-smoothing:antialiased;">
{preheader_html}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:{PALETTE['page']};padding:28px 0;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0"
 style="width:600px;max-width:100%;background:{PALETTE['card']};border:1px solid {PALETTE['line']};border-radius:14px;overflow:hidden;">
  <tr><td style="background:{PALETTE['brand']};padding:18px 28px;">
    <span style="color:#ffffff;font-size:16px;font-weight:700;letter-spacing:.01em;">{name}</span>
  </td></tr>
  <tr><td style="padding:26px 28px 28px;">
    {kicker_html}
    <h1 style="margin:0 0 18px;font-size:21px;font-weight:700;line-height:1.3;color:{PALETTE['ink']};">{heading}</h1>
    {body_html}
  </td></tr>
  <tr><td style="padding:18px 28px;border-top:1px solid {PALETTE['line']};background:{PALETTE['panel']};">
    {footer}
  </td></tr>
</table>
<div style="max-width:600px;margin:14px auto 0;color:{PALETTE['faint']};font-size:11px;text-align:center;">
  {name} · network operations
</div>
</td></tr></table>
</body></html>"""


# ── send ─────────────────────────────────────────────────────────────────────

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
