"""HTML email - the shared way Danbyte sends a formatted email.

Every email Danbyte sends (monitoring digest, certificate digest, alert
notifications, sign-in codes, invites, task mail, connectivity tests) is built
from the small component kit in this module, so they share one identity:
a document, not a marketing card. White paper, black ink, hairlines, bold
for emphasis - and colour only where something needs acting on (a red
critical count, a red "Down"). The deployment's logo heads every mail.

Design constraints (why it looks the way it does):

* **Tables + inline CSS only.** Outlook/Gmail/Apple Mail ignore ``<style>``
  blocks, flexbox, and CSS variables, so every rule is inline and layout is
  table-based - the lowest common denominator that renders everywhere.
* **A hidden preheader.** The one line an inbox shows next to the subject.
* **One ink.** :data:`PALETTE` is zinc; :data:`STATUS_BG` / :data:`STATUS_TEXT`
  resolve every state to ink except the ones that mean trouble, which are
  red. A warning is bold, not orange; an "up" is plain, not green.
* **The logo is embedded.** :func:`email_logo` finds the uploaded branding
  logo (or Danbyte's own) and :func:`send_html_email` attaches it inline
  under ``cid:logo`` - a ``data:`` URI would be stripped by Gmail.

Build a body from the component helpers (:func:`section`, :func:`stat_grid`,
:func:`pill`, :func:`kv_table`, :func:`callout`, :func:`email_button`, …), wrap
it with :func:`render_layout`, and send it with :func:`send_html_email`. All
values passed to the helpers are escaped here - callers pass plain strings.
"""
from __future__ import annotations

import logging
from functools import lru_cache
from pathlib import Path

from django.conf import settings
from django.utils.html import escape

logger = logging.getLogger("danbyte.email")

# ── palette ──────────────────────────────────────────────────────────────────
# Zinc, and one red. "brand" stays for callers that ask for an accent; it is
# ink now, so a count that used to be blue reads as a bold black figure.
PALETTE = {
    "brand": "#18181b",
    "brand_dark": "#09090b",
    "ink": "#18181b",         # zinc-900 - headings, figures
    "text": "#27272a",        # zinc-800 - body copy
    "muted": "#71717a",       # zinc-500 - labels, secondary text
    "faint": "#a1a1aa",       # zinc-400
    "rule": "#d4d4d8",        # zinc-300 - the strong hairline
    "line": "#e4e4e7",        # zinc-200 - borders
    "hair": "#f1f1f3",        # zinc-100 - row separators
    "panel": "#fafafa",       # zinc-50
    "page": "#f4f4f5",        # zinc-100 page backdrop
    "card": "#ffffff",
    "critical": "#b91c1c",    # red-700 - the one colour
    "critical_soft": "#fdecec",
}

_RED = {"down", "critical", "expired", "stale", "expiring_critical"}
# What a status is drawn with. Trouble is red; everything else is ink, and
# the shipped kinds keep their names so callers need not change.
STATUS_TEXT = {k: PALETTE["critical"] for k in _RED}
STATUS_TEXT.update({
    "up": PALETTE["ink"], "ok": PALETTE["ink"], "success": PALETTE["ink"],
    "degraded": PALETTE["ink"], "warning": PALETTE["ink"], "expiring": PALETTE["ink"],
    "expiring_warning": PALETTE["ink"],
    "info": PALETTE["ink"], "unknown": PALETTE["muted"], "skipped": PALETTE["muted"],
})
STATUS_BG = dict(STATUS_TEXT)  # a figure's accent: red for trouble, ink otherwise
STATUS_TINT = {k: (PALETTE["critical_soft"] if k in _RED else PALETTE["card"])
               for k in STATUS_TEXT}

_FONT = ("-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,"
         "sans-serif")
_MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace"


# ── component kit ────────────────────────────────────────────────────────────
# Each returns a small, self-contained HTML fragment. Compose a body by joining
# fragments, then pass the result to render_layout().

def section(title: str) -> str:
    """A section heading: a small tracked label with a rule under it."""
    return (
        f'<h2 style="margin:28px 0 12px;padding:0 0 6px;font-size:11px;'
        f'font-weight:700;letter-spacing:.08em;text-transform:uppercase;'
        f'color:{PALETTE["ink"]};border-bottom:1px solid {PALETTE["rule"]};">'
        f'{escape(title)}</h2>'
    )


def lead(text: str) -> str:
    """The intro paragraph under the title."""
    return (
        f'<p style="margin:0 0 18px;font-size:15px;line-height:1.55;'
        f'color:{PALETTE["text"]};">{escape(text)}</p>'
    )


def paragraph(text: str) -> str:
    return (
        f'<p style="margin:0 0 14px;font-size:14px;line-height:1.55;'
        f'color:{PALETTE["text"]};">{escape(text)}</p>'
    )


def muted(text: str) -> str:
    return (
        f'<p style="margin:0 0 12px;font-size:13px;line-height:1.5;'
        f'color:{PALETTE["muted"]};">{escape(text)}</p>'
    )


def pill(text: str, kind: str = "unknown") -> str:
    """A status, as a word: bold, uppercase, hairline-boxed - red when the
    state means trouble, ink otherwise. Never a coloured fill."""
    fg = STATUS_TEXT.get(kind, PALETTE["muted"])
    border = PALETTE["critical"] if kind in _RED else PALETTE["rule"]
    return (
        f'<span style="display:inline-block;color:{fg};border:1px solid {border};'
        f'font-size:10.5px;font-weight:700;letter-spacing:.06em;'
        f'text-transform:uppercase;line-height:1.3;padding:2px 6px;'
        f'border-radius:3px;white-space:nowrap;">{escape(text)}</span>'
    )


def stat_grid(cells: list) -> str:
    """A row of figures ruled above and below, like a statement line: a big
    bold number over a small tracked label, hairlines between.

    ``cells`` = ``[(value, label)]`` or ``[(value, label, accent_hex)]``. Pass
    :data:`STATUS_BG` reds only for a count that needs acting on.
    """
    if not cells:
        return ""
    n = len(cells)
    tds = []
    for i, cell in enumerate(cells):
        value, label = cell[0], cell[1]
        accent = cell[2] if len(cell) > 2 else PALETTE["ink"]
        divider = f"border-left:1px solid {PALETTE['line']};" if i else ""
        tds.append(
            f'<td style="width:{100 // n}%;padding:14px 14px 12px;{divider}'
            f'vertical-align:top;text-align:left;">'
            f'<div style="font-size:26px;font-weight:700;line-height:1;'
            f'letter-spacing:-.02em;color:{accent};'
            f'font-variant-numeric:tabular-nums;">{escape(str(value))}</div>'
            f'<div style="margin-top:6px;font-size:10.5px;font-weight:600;'
            f'letter-spacing:.06em;text-transform:uppercase;'
            f'color:{PALETTE["muted"]};">{escape(str(label))}</div>'
            f'</td>'
        )
    return (
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'style="margin:4px 0 18px;table-layout:fixed;'
        f'border-top:1px solid {PALETTE["rule"]};border-bottom:1px solid {PALETTE["rule"]};">'
        '<tr>' + "".join(tds) + "</tr></table>"
    )


def progress_bar(pct: int, label: str = "", *, accent: str = "") -> str:
    """A slim track with a filled portion - for a single headline ratio
    (reachability, coverage). Ink fill; red once it is below 60 %."""
    pct = max(0, min(100, int(pct)))
    fill = accent or (PALETTE["ink"] if pct >= 60 else PALETTE["critical"])
    head = (
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'style="margin:0 0 8px;"><tr>'
        f'<td style="font-size:13px;color:{PALETTE["muted"]};">{escape(label)}</td>'
        f'<td style="text-align:right;font-size:14px;font-weight:700;'
        f'color:{PALETTE["ink"]};">{pct}%</td></tr></table>'
        if label else ""
    )
    return (
        f'<div style="margin:0 0 18px;">{head}'
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'style="background:{PALETTE["line"]};">'
        f'<tr><td style="height:6px;line-height:6px;font-size:0;">'
        f'<table role="presentation" width="{pct}%" cellpadding="0" cellspacing="0" '
        f'style="min-width:6px;"><tr><td style="height:6px;line-height:6px;'
        f'font-size:0;background:{fill};">&nbsp;</td></tr>'
        f'</table></td></tr></table></div>'
    )


def kv_table(rows: list) -> str:
    """A two-column label/value table. ``rows`` = ``[(label, value_html)]`` -
    values are treated as pre-built HTML (use :func:`pill` etc.), labels are
    escaped."""
    if not rows:
        return ""
    trs = "".join(
        f'<tr>'
        f'<td style="padding:8px 16px 8px 0;font-size:13px;color:{PALETTE["muted"]};'
        f'white-space:nowrap;vertical-align:top;border-bottom:1px solid {PALETTE["hair"]};'
        f'width:1%;">{escape(str(label))}</td>'
        f'<td style="padding:8px 0;font-size:13px;color:{PALETTE["ink"]};'
        f'vertical-align:top;border-bottom:1px solid {PALETTE["hair"]};">{value}</td>'
        f'</tr>'
        for label, value in rows
    )
    return (
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'style="margin:0 0 6px;">{trs}</table>'
    )


def data_table(headers: list, rows: list) -> str:
    """A ruled data table. ``headers`` = ``[str]``; ``rows`` =
    ``[[cell_html, …]]`` - cells are pre-built HTML, headers escaped."""
    ths = "".join(
        f'<th style="text-align:left;padding:0 12px 8px 0;font-size:10.5px;'
        f'font-weight:700;letter-spacing:.06em;text-transform:uppercase;'
        f'color:{PALETTE["muted"]};border-bottom:1px solid {PALETTE["rule"]};">'
        f'{escape(str(h))}</th>'
        for h in headers
    )
    trs = "".join(
        "<tr>" + "".join(
            f'<td style="padding:9px 12px 9px 0;font-size:13px;color:{PALETTE["ink"]};'
            f'border-bottom:1px solid {PALETTE["hair"]};vertical-align:middle;">{c}</td>'
            for c in row
        ) + "</tr>"
        for row in rows
    )
    return (
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'style="margin:0 0 10px;">'
        f'<tr>{ths}</tr>{trs}</table>'
    )


_CALLOUT = {
    # (rule colour, label)
    "info": (PALETTE["ink"], "Note"),
    "success": (PALETTE["ink"], "Healthy"),
    "warning": (PALETTE["ink"], "Warning"),
    "critical": (PALETTE["critical"], "Attention"),
}


def callout(text: str, kind: str = "info", *, label: str = "") -> str:
    """The headline fact: a rule down the left and a bold label. Red rule and
    label for critical; ink for everything else - no tinted panels."""
    rule, default_label = _CALLOUT.get(kind, _CALLOUT["info"])
    lbl = label or default_label
    return (
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" '
        f'style="margin:0 0 18px;">'
        f'<tr><td style="padding:2px 0 2px 14px;border-left:3px solid {rule};">'
        f'<div style="margin:0 0 3px;font-size:10.5px;font-weight:700;'
        f'letter-spacing:.06em;text-transform:uppercase;color:{rule};">'
        f'{escape(lbl)}</div>'
        f'<div style="font-size:14px;line-height:1.5;color:{PALETTE["ink"]};'
        f'font-weight:500;">{escape(text)}</div>'
        f'</td></tr></table>'
    )


def email_button(url: str, label: str) -> str:
    """A solid ink button (bulletproof VML-free table button)."""
    safe_url = escape(url)  # django's escape() always escapes quotes
    return (
        f'<table role="presentation" cellpadding="0" cellspacing="0" '
        f'style="margin:6px 0 20px;"><tr><td style="border-radius:4px;'
        f'background:{PALETTE["ink"]};">'
        f'<a href="{safe_url}" style="display:inline-block;padding:10px 18px;'
        f'font-size:13px;font-weight:600;color:#ffffff;text-decoration:none;'
        f'border-radius:4px;">{escape(label)}</a></td></tr></table>'
    )


def bullet_list(items: list) -> str:
    if not items:
        return ""
    lis = "".join(
        f'<li style="margin:0 0 6px;font-size:14px;line-height:1.5;'
        f'color:{PALETTE["text"]};">{escape(str(i))}</li>'
        for i in items
    )
    return f'<ul style="margin:0 0 14px;padding-left:20px;">{lis}</ul>'


def divider() -> str:
    return (
        f'<div style="border-top:1px solid {PALETTE["line"]};margin:22px 0;">'
        f'</div>'
    )


def code_line(text: str) -> str:
    """A monospace value block - for a one-time code or a fingerprint."""
    return (
        f'<div style="display:inline-block;font-family:{_MONO};'
        f'font-size:24px;font-weight:700;letter-spacing:.2em;'
        f'color:{PALETTE["ink"]};border:1px solid {PALETTE["rule"]};'
        f'border-radius:4px;padding:12px 18px 12px 22px;'
        f'margin:2px 0 18px;">{escape(text)}</div>'
    )


# ── the logo ─────────────────────────────────────────────────────────────────

LOGO_CID = "logo"
_LOGO_HEIGHT = 24   # CSS px in the header; the file is served at 2x or more

_BUNDLED_LOGO = (
    Path(settings.BASE_DIR) / "frontend" / "dist" / "branding" / "logo-full.png",
    Path(settings.BASE_DIR) / "frontend" / "public" / "branding" / "logo-full.png",
)


def email_logo() -> tuple[bytes, str] | None:
    """The image that heads every mail: the uploaded login logo when the
    install has one, else Danbyte's own. ``(bytes, mime)`` or None when
    neither can be read - the layout then shows the deployment name in bold.
    An SVG upload is skipped: mail clients do not draw SVG."""
    from core.models import DeploymentSettings

    try:
        dep = DeploymentSettings.load()
        if dep.login_logo:
            name = dep.login_logo.name.lower()
            mime = ("image/png" if name.endswith(".png") else
                    "image/jpeg" if name.endswith((".jpg", ".jpeg")) else
                    "image/gif" if name.endswith(".gif") else "")
            if mime:
                with dep.login_logo.open("rb") as fh:
                    return fh.read(), mime
    except Exception as exc:  # noqa: BLE001 - a bad upload must not block mail
        logger.warning("email logo: uploaded logo unreadable: %s", exc)
    return _bundled_logo()


@lru_cache(maxsize=1)
def _bundled_logo() -> tuple[bytes, str] | None:
    for path in _BUNDLED_LOGO:
        if path.is_file():
            return path.read_bytes(), "image/png"
    return None


def logo_size(data: bytes, mime: str) -> tuple[int, int]:
    """The header ``<img>`` size for this logo, height fixed, width to scale -
    a mail client needs both or it reflows when the image lands."""
    try:
        from io import BytesIO

        from PIL import Image

        w, h = Image.open(BytesIO(data)).size
        return max(1, round(w * _LOGO_HEIGHT / h)), _LOGO_HEIGHT
    except Exception:  # noqa: BLE001 - PIL missing or an odd file
        return 120, _LOGO_HEIGHT


def inline_logo_for_preview(html: str) -> str:
    """A rendered mail with its ``cid:logo`` swapped for a ``data:`` URI, so a
    browser (the Settings preview) draws the logo the way a mail client
    will from the inline part."""
    import base64

    logo = email_logo()
    if not logo:
        return html
    data, mime = logo
    uri = f"data:{mime};base64,{base64.b64encode(data).decode()}"
    return html.replace(f"cid:{LOGO_CID}", uri)


# ── layout shell ─────────────────────────────────────────────────────────────

def render_layout(
    title: str,
    body_html: str,
    *,
    deployment_name: str = "Danbyte",
    footer_html: str = "",
    preheader: str = "",
    kicker: str = "",
    logo_src: str = f"cid:{LOGO_CID}",
) -> str:
    """Wrap ``body_html`` in the email shell: the logo, a kicker on the right,
    the title, the body, a hairline footer.

    ``body_html`` is trusted (built by callers from escaped data via the helpers
    above); ``title`` / ``deployment_name`` / ``preheader`` / ``kicker`` are
    escaped here. ``preheader`` is the hidden inbox-preview line; ``kicker`` is
    the small label beside the logo (e.g. "Monitoring digest"). ``logo_src``
    is ``cid:logo`` for a sent mail - :func:`send_html_email` attaches the
    image - or a ``data:`` URI for an in-app preview.
    """
    name = escape(deployment_name or "Danbyte")
    heading = escape(title)
    pre = escape(preheader) if preheader else ""
    preheader_html = (
        f'<div style="display:none;max-height:0;overflow:hidden;opacity:0;'
        f'color:transparent;height:0;width:0;">{pre}</div>' if pre else ""
    )
    logo = email_logo()
    if logo:
        w, h = logo_size(*logo)
        brand_html = (
            f'<img src="{escape(logo_src)}" width="{w}" height="{h}" alt="{name}" '
            f'style="display:block;width:{w}px;height:{h}px;border:0;">'
        )
    else:
        brand_html = (
            f'<span style="font-size:16px;font-weight:700;letter-spacing:-.01em;'
            f'color:{PALETTE["ink"]};">{name}</span>'
        )
    kicker_html = (
        f'<td style="text-align:right;vertical-align:middle;font-size:11px;'
        f'font-weight:600;letter-spacing:.06em;text-transform:uppercase;'
        f'color:{PALETTE["muted"]};">{escape(kicker)}</td>' if kicker else ""
    )
    footer = footer_html or (
        f'<p style="margin:0;color:{PALETTE["muted"]};font-size:12px;line-height:1.5;">'
        f'Sent by <span style="font-weight:600;color:{PALETTE["ink"]};">{name}</span>. '
        f'You are receiving this because you are on its notification list.</p>'
    )
    return f"""\
<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<meta name="supported-color-schemes" content="light"></head>
<body style="margin:0;padding:0;background:{PALETTE['page']};
 font-family:{_FONT};color:{PALETTE['text']};-webkit-font-smoothing:antialiased;">
{preheader_html}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:{PALETTE['page']};padding:32px 0;">
<tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0"
 style="width:600px;max-width:100%;background:{PALETTE['card']};border:1px solid {PALETTE['line']};">
  <tr><td style="padding:22px 36px 18px;border-bottom:1px solid {PALETTE['rule']};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="vertical-align:middle;">{brand_html}</td>
      {kicker_html}
    </tr></table>
  </td></tr>
  <tr><td style="padding:30px 36px 34px;">
    <h1 style="margin:0 0 18px;font-size:21px;font-weight:700;line-height:1.3;letter-spacing:-.015em;color:{PALETTE['ink']};">{heading}</h1>
    {body_html}
  </td></tr>
  <tr><td style="padding:16px 36px 18px;border-top:1px solid {PALETTE['line']};">
    {footer}
  </td></tr>
</table>
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
    fail_silently: bool = True,
    attachments: list | None = None,
) -> bool:
    """Send a multipart HTML+text email via the effective SMTP for the tenant/
    site. Returns True if a send was attempted with at least one recipient.

    Does NOT check ``email_enabled`` - callers decide whether the feature is on;
    the connection falls back to Django's configured backend when no SMTP host
    is set (console in dev, locmem in tests).
    """
    from email.mime.image import MIMEImage

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
        # The header's logo rides along as an inline part the HTML refers to
        # by Content-ID; a data: URI would be stripped by Gmail and Outlook.
        logo = email_logo() if f"cid:{LOGO_CID}" in html_body else None
        if logo:
            data, mime = logo
            part = MIMEImage(data, _subtype=mime.split("/", 1)[1])
            part.add_header("Content-ID", f"<{LOGO_CID}>")
            part.add_header("Content-Disposition", "inline", filename="logo")
            msg.mixed_subtype = "related"
            msg.attach(part)
        # Files, e.g. an SLA report: ``[(filename, bytes, mimetype), ...]``.
        for name, content, mime in attachments or []:
            msg.attach(name, content, mime)
        msg.send(fail_silently=False)
        return True
    except Exception as exc:  # noqa: BLE001 - best-effort by default
        if not fail_silently:
            raise
        logger.warning("send_html_email failed (%s): %s", subject, exc)
        return False


def describe_smtp_error(exc: Exception) -> str:
    """A human sentence for an SMTP failure - what went wrong and what to do.

    The raw exceptions ("(421, b'Service not available')") are useless in a
    toast; every test/preview endpoint routes its error through here so the UI
    can say something actionable.
    """
    text = str(exc) or exc.__class__.__name__
    code = getattr(exc, "smtp_code", None)
    if code is None:
        import re

        m = re.search(r"\b(4\d\d|5\d\d)\b", text)
        code = int(m.group(1)) if m else None

    if code == 421:
        return (
            "The mail server refused the connection (421 Service not "
            "available). This usually means the server has temporarily "
            "blocked this machine's IP - often after repeated failed logins. "
            "Wait a while before retrying; more attempts extend the block."
        )
    if code in (534, 535):
        return (
            "The mail server rejected the login (535 Authentication failed). "
            "Check the SMTP username and password in Settings → Email & "
            "Delivery."
        )
    if code in (450, 451, 452):
        return f"The mail server deferred the message ({code}). Try again later."
    if code in (550, 551, 553):
        return f"The mail server rejected the recipient ({code}): {text}"
    if isinstance(exc, (TimeoutError, OSError)) and code is None:
        return (
            f"Couldn't reach the mail server: {text}. Check the SMTP host and "
            "port, and that this machine can reach it."
        )
    return f"Sending failed: {text}"


def parse_recipients(raw: str) -> list[str]:
    """Split a comma/newline/space-separated recipient string into addresses."""
    import re

    return [a for a in re.split(r"[\s,;]+", raw or "") if a]
