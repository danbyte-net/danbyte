"""Sensitivity labels: the starter set, and a label as a report marking.

**Seeds.** A tenant starts with four editable labels - Public, Internal,
Confidential and Restricted - because a report dialog with an empty picker
leaves every operator to invent the same scheme before they can mark their
first PDF. They are ordinary catalog rows: renamed, recoloured, deleted or
joined by others as the tenant likes. They are seeded once per tenant
(``TenantSettings.sensitivity_labels_seeded``), so a label the tenant deletes
does not come back on the next ``bootstrap``, and a row the tenant already has
under a seed's slug is never touched. None is the default: a report carries
no marking until the tenant names a default or the reader picks one.

**Marking.** :func:`marking_for` turns a label into the dict a report renders
on its cover and on every page's header and footer -
``{name, color, text_color, icon_svg}`` (the report framework's
``ReportContext.marking``). The icon is the label's Lucide icon from the
bundled SVGs (``api/lucide/``), stroked in the text colour.
"""

from __future__ import annotations

import re
from html import escape

from rest_framework.exceptions import ValidationError

# (slug, name, color, icon, weight, description)
STARTER_LABELS = [
    ("public", "Public", "#16a34a", "globe", 10, "May be shared outside the organisation."),
    ("internal", "Internal", "#2563eb", "building-2", 20, "For people inside the organisation."),
    ("confidential", "Confidential", "#d97706", "shield", 30,
     "For the people who need it; not to be passed on."),
    ("restricted", "Restricted", "#dc2626", "shield-alert", 40,
     "For named people only."),
]

#: A label with no colour prints as the neutral pill.
NEUTRAL = "#e4e4e7"
INK = "#18181b"
HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


def seed_sensitivity_labels(tenant, *, SensitivityLabel=None, TenantSettings=None) -> int:
    """Create the starter labels for ``tenant`` the first time it is seeded.
    Returns the number of new rows. A data migration passes its historical
    models."""
    if SensitivityLabel is None:
        from api.models import SensitivityLabel
    if TenantSettings is None:
        from core.models import TenantSettings

    settings, _ = TenantSettings.objects.get_or_create(tenant=tenant)
    if settings.sensitivity_labels_seeded:
        return 0
    have = set(SensitivityLabel.objects.filter(tenant=tenant).values_list("slug", flat=True))
    created = 0
    for slug, name, color, icon, weight, description in STARTER_LABELS:
        if slug in have:
            continue
        row = SensitivityLabel(
            tenant=tenant, slug=slug, name=name, color=color, icon=icon,
            weight=weight, description=description,
        )
        row.save()
        created += 1
    TenantSettings.objects.filter(pk=settings.pk).update(sensitivity_labels_seeded=True)
    return created


def icon_svg(name: str, color: str, size_pt: float = 8.0) -> str:
    """The Lucide icon ``name`` as inline SVG, ``size_pt`` square, stroked in
    ``color``; "" for no icon or one the bundle doesn't have."""
    from .templatetags.api_extras import lucide_html

    svg = lucide_html((name or "").strip(), "marking-icon")
    if not svg:
        return ""
    stroke = color if HEX.match(color or "") else INK
    svg = svg.replace('stroke="currentColor"', f'stroke="{stroke}"')
    return svg.replace("<svg", f'<svg width="{size_pt}pt" height="{size_pt}pt"', 1)


def marking_for(label) -> dict | None:
    """``{name, color, text_color, icon_svg}`` for ``label``; None for none."""
    if label is None:
        return None
    color = label.color.lower() if HEX.match(label.color or "") else ""
    text = label.text_color if color else INK
    text = {"#fff": "#ffffff", "#000": "#000000"}.get(text, text)
    return {
        "name": label.name,
        "color": color or NEUTRAL,
        "text_color": text,
        "icon_svg": icon_svg(label.icon, text),
    }


def label_for_request(request, tenant, label_id):
    """The tenant's label ``label_id`` that the reader may view. Raises a 400
    naming ``options.sensitivity_label`` otherwise - another tenant's label
    and a hidden one read the same."""
    from auth_api.rbac import restrict_queryset

    from .models import SensitivityLabel

    if not label_id:
        return None
    qs = restrict_queryset(
        SensitivityLabel.objects.filter(tenant=tenant),
        request.user, tenant, "sensitivitylabel", "view",
    )
    label = qs.filter(pk=label_id).first()
    if label is None:
        raise ValidationError({"options": {"sensitivity_label": ["No such sensitivity label."]}})
    return label


def default_label(request, tenant):
    """The tenant's default label, when the reader may view it."""
    from auth_api.rbac import restrict_queryset

    from .models import SensitivityLabel

    qs = restrict_queryset(
        SensitivityLabel.objects.filter(tenant=tenant, is_default=True),
        request.user, tenant, "sensitivitylabel", "view",
    )
    return qs.first()


# ─── Rendering ───────────────────────────────────────────────────────────────


def pill_html(marking: dict, cls: str = "marking") -> str:
    """The marking as a pill: icon and name in capitals on its colour."""
    return (
        f"<span class='{cls}' style='background:{marking['color']};"
        f"color:{marking['text_color']}'>{marking['icon_svg']}"
        f"<span class='marking-name'>{escape(marking['name'])}</span></span>"
    )


def running_html(marking: dict | None) -> str:
    """The running elements the page header and footer show: the first thing
    in the report's ``<body>``."""
    if not marking:
        return ""
    return (
        f"<div class='marking-top'>{pill_html(marking)}</div>"
        f"<div class='marking-bottom'>{pill_html(marking)}</div>"
    )


def marking_css(marking: dict | None) -> str:
    """The marking's rules for the report's ``<style>``: the pill, at the
    centre of every page's header and footer."""
    if not marking:
        return ""
    return (
        "@page{@top-center{content:element(marking-top);vertical-align:middle}"
        "@bottom-center{content:element(marking-bottom);vertical-align:middle}}"
        ".marking-top{position:running(marking-top)}"
        ".marking-bottom{position:running(marking-bottom)}"
        ".marking{display:inline-block;padding:0.5mm 2.4mm;border-radius:0.8mm;"
        "font-family:Inter,'DejaVu Sans',sans-serif;font-size:7pt;font-weight:700;"
        "letter-spacing:0.08em;text-transform:uppercase;white-space:nowrap;line-height:1.3}"
        ".marking svg{vertical-align:-1pt;margin-right:1.2mm}"
    )
