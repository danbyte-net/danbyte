"""Label rendering - per-object Jinja2 in a sandbox.

Renders one :class:`~api.models.LabelTemplate` against a single object into a
sized HTML label. Uses Jinja's ``SandboxedEnvironment`` (like
:mod:`api.export_templates`) so a template can't reach code-exec/mutating
attributes, and - unlike export configs - with **autoescape on** so a field value
containing markup is escaped, not injected. The rendered HTML is then run through
``nh3`` (``sanitize_label_html``) to strip any ``<script>``/event handlers/unsafe
URLs the *author's own* markup carries, so the frontend can print it inline (the
label page IS the printed sheet) without an XSS vector.
"""
from __future__ import annotations

import re

# object_type slug (model_name) → frontend detail route prefix, so `{{ url }}`
# and the default QR resolve to the object's page. Only the labelable types need
# an entry; anything else falls back to the origin.
FRONTEND_ROUTES = {
    "device": "/devices",
    "rack": "/racks",
    "ipaddress": "/ip-addresses",
    "interface": "/interfaces",
    "cable": "/cables",
    "inventoryitem": "/inventory-items",
    "site": "/sites",
    "location": "/locations",
    "powerfeed": "/power-feeds",
    "powerpanel": "/power-panels",
    "circuit": "/circuits",
    "virtualmachine": "/virtual-machines",
    "prefix": "/prefixes",
}

# Relations worth exposing to a label template when the object has them.
_RELATIONS = (
    "site", "rack", "location", "tenant", "role", "status", "platform",
    "device_type", "manufacturer", "primary_ip", "primary_ip4", "primary_ip6",
    "device", "interfaces", "ip_addresses",
)


# Extra top-level tokens a given object type exposes beyond `url`/`qr`/`obj`.
_TYPE_SPECIALS = {
    # A cable's two ends: the terminated device + the port at each end.
    # `*_port` stringifies with its device; `*_port_name` is the bare port
    # name for short labels.
    "cable": ["a", "b", "a_port", "b_port", "a_port_name", "b_port_name"],
}


def available_fields(object_type, tenant=None) -> dict | None:
    """The token tree offered to the label editor for ``object_type``.

    Returns ``{"object", "tokens", "special"}`` where ``tokens`` are
    ``{{ device.name }}``-style references the author can click to insert - the
    object's own fields, a few curated one-hop relations, and (when ``tenant`` is
    given) that tenant's custom fields for the type. Derived from the model so it
    tracks the schema instead of a hard-coded list.
    """
    from auth_api.object_types import model_for

    model = model_for(object_type)
    if model is None:
        return None
    name = model._meta.model_name
    tokens: list[str] = []
    for f in model._meta.concrete_fields:
        # FK → offer the common `.name`/`.address` sub-attr, not the raw id.
        if f.is_relation:
            tokens.append(f"{name}.{f.name}.name")
        else:
            tokens.append(f"{name}.{f.name}")
    # Curated one-hop relations that aren't concrete FKs on the row, mapped to
    # the sub-attribute that actually holds their display value (an IPAddress
    # has `ip_address`, not `name`, so `primary_ip.name` would render blank).
    rel_attr = {
        "primary_ip": "ip_address",
        "primary_ip4": "ip_address",
        "primary_ip6": "ip_address",
    }
    for rel in ("primary_ip", "site", "rack", "tenant", "role", "status"):
        if hasattr(model, rel):
            tokens.append(f"{name}.{rel}.{rel_attr.get(rel, 'name')}")
    # Custom fields: one clickable token per defined field for this type/tenant,
    # so authors don't have to know the JSON key. `custom_fields.<key>` resolves
    # via dict lookup at render time.
    if hasattr(model, "custom_fields"):
        tokens.append(f"{name}.custom_fields")
        if tenant is not None:
            from customization.models import CustomField

            for key in (
                CustomField.objects.filter(
                    tenant=tenant, applies_to__contains=[name]
                )
                .values_list("key", flat=True)
                .order_by("key")
            ):
                tokens.append(f"{name}.custom_fields.{key}")
    return {
        "object": name,
        "tokens": sorted(set(tokens)),
        # Always in the render context, plus any per-type extras.
        "special": [
            "url", "short_url", "short_id", "qr", "obj",
            *_TYPE_SPECIALS.get(name, []),
        ],
    }


def detail_path(obj) -> str:
    """Frontend detail path for an object, e.g. ``/devices/<id>`` (or "")."""
    prefix = FRONTEND_ROUTES.get(obj._meta.model_name)
    return f"{prefix}/{obj.pk}" if prefix else ""


def short_link_path(obj) -> str:
    """Compact SPA path keyed on the object's per-tenant human number (numid) -
    ``/l/<tenant>/<type>/<numid>`` - which the ``/l`` route resolves to the real
    detail page. Encoding this instead of the full UUID URL keeps the QR small.

    The tenant slug is part of the path because ``numid`` is only unique *within*
    a tenant: without it, scanning a label while a different tenant is active
    would 404 or, worse, resolve a different tenant's object with the same
    number. With it the resolver switches to the label's tenant. Empty when the
    object has no numid/tenant (e.g. not yet backfilled)."""
    numid = getattr(obj, "numid", None)
    tenant = getattr(obj, "tenant", None)
    slug = getattr(tenant, "slug", "") if tenant else ""
    if not (numid and slug):
        return ""
    return f"/l/{slug}/{obj._meta.model_name}/{numid}"


def _cable_ends(cable) -> dict:
    """`{a, b, a_port, b_port}` for a cable - the terminated device + the port
    object at each end. Missing/half-terminated ends resolve to None instead of
    raising, so a template referencing them just renders blank."""
    ends: dict = {}
    try:
        terminations = list(cable.terminations.all())
    except Exception:  # noqa: BLE001
        return ends
    for term in terminations:
        end = (term.end or "").lower()
        if end not in ("a", "b"):
            continue
        point = term.point  # the interface / port / feed at this end
        ends[f"{end}_port"] = point
        # Bare port name for short labels - `a_port` renders with its device.
        ends[f"{end}_port_name"] = getattr(point, "name", "") or ""
        ends[end] = getattr(point, "device", None) if point is not None else None
    return ends


def _context(obj, url: str) -> dict:
    """Template context: the object under its type name, plus `obj`, `url`,
    common relations (managers materialised to lists), and - for a cable - its
    A/B ends (`a`/`b` devices + `a_port`/`b_port`)."""
    ctx = {obj._meta.model_name: obj, "obj": obj, "url": url}
    for attr in _RELATIONS:
        if attr in ctx or not hasattr(obj, attr):
            continue
        try:
            val = getattr(obj, attr)
        except Exception:  # noqa: BLE001 - a missing FK etc. just isn't exposed
            continue
        if hasattr(val, "all"):  # a related manager
            try:
                val = list(val.all())
            except Exception:  # noqa: BLE001
                continue
        ctx[attr] = val
    if obj._meta.model_name == "cable":
        ctx.update(_cable_ends(obj))
    return ctx


# Rendered label HTML is author-controlled markup - Jinja autoescaping only
# escapes the {{ values }}, not the literal template body. Since a label prints
# inline in the app origin, sanitize it: keep structural/formatting tags + inline
# style, strip <script>, event handlers, and unsafe URLs. The QR is composited
# separately from qrcode.react (trusted), so it doesn't pass through here.
_LABEL_TAGS = {
    "div", "span", "p", "br", "hr", "b", "strong", "i", "em", "u", "s",
    "small", "sub", "sup", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol",
    "li", "table", "thead", "tbody", "tfoot", "tr", "td", "th", "img",
    "section", "header", "footer", "figure", "figcaption", "font", "center",
}
_LABEL_ATTRS = {
    "*": {"style", "class", "id", "align", "dir", "title", "width", "height"},
    "img": {"src", "alt", "width", "height"},
    "td": {"colspan", "rowspan"},
    "th": {"colspan", "rowspan"},
}


def sanitize_label_html(html: str) -> str:
    import nh3

    return nh3.clean(
        html or "",
        tags=_LABEL_TAGS,
        attributes=_LABEL_ATTRS,
        url_schemes={"http", "https", "mailto", "data"},
    )


def _fmt_date(value, fmt="%Y-%m-%d"):
    """`| date` - a datetime/date rendered short (default YYYY-MM-DD) instead of
    the raw `2026-07-31 18:34:55.339089+00:00`. Non-dates pass through as text."""
    if value in (None, ""):
        return ""
    return value.strftime(fmt) if hasattr(value, "strftime") else str(value)


def _fmt_datetime(value, fmt="%Y-%m-%d %H:%M"):
    """`| datetime` - date + HH:MM, no microseconds/timezone noise."""
    return _fmt_date(value, fmt)


def _register_filters(env):
    env.filters["date"] = _fmt_date
    env.filters["datetime"] = _fmt_datetime
    return env


def _qr_span(value: str, size_mm: float) -> str:
    """A QR as an inline SVG sized to exactly ``size_mm`` - the print counterpart
    of the frontend's qrcode.react composite, so a PDF label carries a crisp
    vector QR at the right size. Generated with segno (pure-Python, no native
    deps). Sizing via ``unit="mm"`` + a computed ``scale`` bakes both a mm
    width/height AND a viewBox into the SVG, so it renders at true size - a
    CSS ``width:100%`` alone won't scale a viewBox-less QR."""
    import io

    import segno

    qr = segno.make(value or " ", error="m")
    border = 2  # quiet zone, matching the on-screen QR
    modules = qr.symbol_size(scale=1, border=border)[0]  # width incl. border
    buf = io.BytesIO()
    qr.save(
        buf,
        kind="svg",
        scale=size_mm / modules,
        unit="mm",
        border=border,
        xmldecl=False,
        svgns=True,
    )
    return buf.getvalue().decode("utf-8")


# Inject the QR into the first `class="qr"` element - same contract as the
# frontend's injectQr so HTML authored in the editor prints identically.
_QR_PLACEHOLDER = re.compile(
    r'(<([a-z]+)[^>]*class="[^"]*\bqr\b[^"]*"[^>]*>)(</\2>)', re.IGNORECASE
)


def _inject_qr(html: str, qr: str, size_mm: float) -> str:
    span = _qr_span(qr, size_mm)
    if _QR_PLACEHOLDER.search(html):
        return _QR_PLACEHOLDER.sub(lambda m: f"{m.group(1)}{span}{m.group(3)}", html, count=1)
    # No placeholder in the template → append so the QR is never lost.
    return f"{html}{span}" if qr else html


# Office paper sizes for the tiled-sheet layout (mm), used when the target is a
# normal A4/Letter printer rather than a dedicated label roll.
PAPER_SIZES = {"a4": "A4", "letter": "Letter"}


def _sheet_css(template, paper: str = "label") -> str:
    """Print stylesheet for the PDF.

    ``paper="label"`` - one label per page, ``@page`` sized to the label with
    zero margin so a **label printer** produces true physical dimensions.

    ``paper="a4"`` / ``"letter"`` - the page is that office size and labels are
    **tiled** at their true mm size (dashed cut guides between them). Because the
    PDF page then matches the printer's paper, the print dialog has nothing to
    scale up - so labels come out at real size on an ordinary printer even at the
    default "Fit to page".
    """
    lbl_box = (
        f"width:{template.width_mm}mm;height:{template.height_mm}mm;"
        f"padding:{template.margin_mm}mm;"
        "font-family:sans-serif;font-size:9pt;color:#000;background:#fff;"
        "overflow:hidden;"
    )
    if paper in PAPER_SIZES:
        return f"""
    *{{box-sizing:border-box}}
    html,body{{margin:0;padding:0;background:#fff}}
    @page{{ size:{PAPER_SIZES[paper]}; margin:8mm; }}
    .lbl{{
      {lbl_box}
      display:inline-block;vertical-align:top;margin:2mm;
      outline:0.2mm dashed #bbb;  /* cut guide */
    }}
    {template.css or ""}
    """
    return f"""
    *{{box-sizing:border-box}}
    html,body{{margin:0;padding:0;background:#fff}}
    @page{{ size:{template.width_mm}mm {template.height_mm}mm; margin:0; }}
    .lbl{{
      {lbl_box}
      page-break-after:always;
    }}
    .lbl:last-child{{page-break-after:auto}}
    {template.css or ""}
    """


def render_sheet_pdf(
    template, objects, *, base_url: str = "", paper: str = "label"
) -> bytes:
    """Render ``template`` against ``objects`` into a print-ready PDF.

    A browser can't be made to print an HTML page at an exact physical size -
    ``@page { size }`` is advisory and the print dialog's paper size wins - so
    the reliable path is a PDF with the page box baked in. ``paper`` picks the
    box: ``"label"`` (default) makes each page the label's mm size, one per page,
    for a label printer; ``"a4"``/``"letter"`` tiles the labels at true size onto
    that office sheet so an ordinary printer needs no "actual size" toggle. Each
    label reuses :func:`render_label` (sandboxed + sanitized), with the QR
    composited server-side. Raises ``jinja2.TemplateError`` on a template problem.
    """
    import weasyprint

    cells = []
    for obj in objects:
        rendered = render_label(template, obj, base_url=base_url)
        body = rendered["html"]
        if template.qr_enabled:
            body = _inject_qr(body, rendered["qr"], template.qr_size_mm)
        cells.append(f'<div class="lbl">{body}</div>')
    doc = (
        "<!doctype html><html><head><meta charset='utf-8'>"
        f"<style>{_sheet_css(template, paper)}</style></head>"
        f"<body>{''.join(cells)}</body></html>"
    )
    return weasyprint.HTML(string=doc, base_url=base_url or None).write_pdf()


def render_label_text(template, obj, *, base_url: str = "") -> str:
    """The label's visible text as plain multi-line text - for copying into an
    external label printer's software (Phoenix Contact, Weidmüller, DYMO, …).
    Renders the template, drops the markup, and keeps one line per block."""
    import html as _html

    from django.utils.html import strip_tags

    body = render_label(template, obj, base_url=base_url)["html"]
    # Turn block boundaries into newlines before stripping tags so the lines
    # survive (e.g. name / serial / site each on their own line).
    body = re.sub(r"(?i)<\s*br\s*/?>", "\n", body)
    body = re.sub(r"(?i)</(div|p|tr|li|h[1-6]|table)\s*>", "\n", body)
    text = _html.unescape(strip_tags(body))
    lines = [ln.strip() for ln in text.splitlines()]
    return "\n".join(ln for ln in lines if ln)


def render_label(template, obj, *, base_url: str = "") -> dict:
    """Render ``template`` against ``obj``. Returns ``{"html", "qr"}``.

    ``base_url`` (scheme+host) is prepended to the object's detail path for
    ``{{ url }}`` and for the default QR. Raises ``jinja2.TemplateError`` on a
    template problem.
    """
    from jinja2.sandbox import SandboxedEnvironment

    url = f"{base_url}{detail_path(obj)}" if base_url else detail_path(obj)
    short_path = short_link_path(obj)
    short_url = f"{base_url}{short_path}" if (base_url and short_path) else short_path
    ctx = _context(obj, url)
    # `short_id` = the per-tenant human number; `short_url` = the compact `/l/…`
    # link that resolves to this object (keeps the QR small).
    ctx["short_id"] = getattr(obj, "numid", None) or ""
    ctx["short_url"] = short_url

    # HTML body: autoescape ON so a field value with markup is escaped, not
    # injected into the label. `date`/`datetime` filters tame raw timestamps.
    html_env = _register_filters(SandboxedEnvironment(
        trim_blocks=True, lstrip_blocks=True, autoescape=True
    ))
    html = html_env.from_string(template.template_html or "").render(**ctx)
    # Strip anything executable - the label prints inline in the app origin.
    html = sanitize_label_html(html)

    if template.qr_content:
        # The QR payload is a scannable string, NOT HTML - render it with
        # autoescape OFF so e.g. a name with `<`/`&` encodes verbatim in the QR
        # instead of as `&lt;`/`&amp;`.
        qr_env = _register_filters(SandboxedEnvironment(autoescape=False))
        qr = qr_env.from_string(template.qr_content).render(**ctx)
    else:
        # Default QR: the compact short link when the object has a numid (smaller
        # QR), else fall back to the full URL.
        qr = short_url or url
    return {"html": html, "qr": qr}
