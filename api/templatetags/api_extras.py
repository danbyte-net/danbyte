import re
from pathlib import Path

from django import template
from django.utils.safestring import mark_safe

register = template.Library()


# ─── Lucide icon rendering ───────────────────────────────────────────────
#
# {% lucide "router" %}                     →  <svg class="lucide ..." ...>
# {% lucide "router" "h-4 w-4 text-zinc-500" %}
#                                            →  <svg class="h-4 w-4 ..." ...>
#
# Source SVGs come from the lucide-static NPM package (~1900 icons) staged
# under api/lucide/. We read each file once and cache an HTML-ready string.
# The class attribute is replaced wholesale by the second arg so callers
# get Tailwind sizing/colour in one shot.

LUCIDE_DIR = Path(__file__).resolve().parent.parent / "lucide"

_LUCIDE_CACHE: dict[str, str] = {}
# License banner sits on its own line; ``.*?`` with re.S handles the dashes
# inside ("@license lucide-static v… - ISC") that a character-class regex
# would choke on.
_LICENSE_RE = re.compile(r"<!--.*?-->", re.S)
_CLASS_ATTR_RE = re.compile(r'class="[^"]*"')
# Strip width/height ONLY from the <svg> opening tag — we always size via
# class. Earlier this used a global ` (width|height)="\d+"` which also ate
# the inner <rect width="14" height="14"/> on copy/grid/server icons, so
# every rect-based icon rendered as a path-only ghost. The regex now
# matches the entire <svg ...> tag and rewrites it without those two attrs.
_SVG_OPEN_RE = re.compile(r"<svg\b([^>]*)>", re.S)
_SVG_TAG_WH_RE = re.compile(r' (width|height)="\d+"')


def _strip_top_level_width_height(text: str) -> str:
    """Remove width=/height= only from the top-level <svg ...> tag."""
    m = _SVG_OPEN_RE.search(text)
    if not m:
        return text
    cleaned_attrs = _SVG_TAG_WH_RE.sub("", m.group(1))
    return text[: m.start()] + f"<svg{cleaned_attrs}>" + text[m.end():]


def _load_lucide(name: str) -> str:
    """Read + normalise a Lucide SVG by name."""
    cached = _LUCIDE_CACHE.get(name)
    if cached is not None:
        return cached
    if not re.fullmatch(r"[a-z0-9-]+", name or ""):
        _LUCIDE_CACHE[name] = ""
        return ""
    path = LUCIDE_DIR / f"{name}.svg"
    if not path.is_file():
        _LUCIDE_CACHE[name] = ""
        return ""
    raw = path.read_text(encoding="utf-8")
    raw = _LICENSE_RE.sub("", raw)
    raw = _strip_top_level_width_height(raw)
    # Collapse whitespace BETWEEN attrs only (don't touch attr values).
    # Lucide SVGs put each attribute on its own line; we just want it on
    # one line. Splitting on newlines then re-joining with spaces is safer
    # than a global \s+ collapse, which would mangle multi-line path d="".
    raw = "\n".join(line.strip() for line in raw.splitlines() if line.strip())
    raw = re.sub(r"\n", " ", raw)
    raw = re.sub(r" +", " ", raw)
    _LUCIDE_CACHE[name] = raw
    return raw


def lucide_html(name: str, classes: str = "h-4 w-4") -> str:
    """Return a Lucide icon as a raw HTML string.

    This is the Python-level helper — use it from form widgets, view code,
    or anywhere outside a Django template. Templates should use
    ``{% lucide … %}`` (which delegates here).
    """
    svg = _load_lucide(name)
    if not svg:
        return ""
    cls = (classes or "").strip()
    if cls:
        svg = _CLASS_ATTR_RE.sub(f'class="{cls}"', svg, count=1)
    return svg


@register.simple_tag(name="lucide")
def lucide(name: str, classes: str = "h-4 w-4"):
    """Render a Lucide icon inline.

    Usage:
        {% lucide "router" %}                      ← default h-4 w-4
        {% lucide "router" "h-3 w-3 text-zinc-500" %}

    Unknown names render as an empty string (never break the page).
    """
    return mark_safe(lucide_html(name, classes))


# ─── Bulk-action helpers ──────────────────────────────────────────────────
#
# The shared "select rows + act on them" UX is built from three pieces:
#   * {% bulk_th %}              first column header (master checkbox)
#   * {% bulk_td obj.id %}       first column cell  (per-row checkbox)
#   * {% include "api/_bulk_bar.html" with ... %}
# All three live in one place so plugin pages and new features just call
# them — no checkbox styling, no event wiring, no per-page JS.

@register.simple_tag(name="bulk_th")
def bulk_th():
    """Header cell hosting the select-all checkbox."""
    return mark_safe(
        '<th data-col="_bulk" data-col-label="Select" data-col-locked="1" '
        'class="w-10 px-3 py-2 align-middle text-left">'
        '<input type="checkbox" class="ck" data-bulk-all aria-label="Select all rows" />'
        '</th>'
    )


@register.simple_tag(name="bulk_td")
def bulk_td(row_id):
    """Row cell hosting the per-row checkbox."""
    if row_id in (None, ""):
        return ""
    return mark_safe(
        f'<td class="w-10 px-3 py-1.5 align-middle">'
        f'<input type="checkbox" class="ck" name="bulk_ids" value="{row_id}" '
        f'data-bulk-row aria-label="Select row" />'
        f'</td>'
    )


# ─── Prefix-status badge ──────────────────────────────────────────────────
#
# The CLAUDE.md design system defines a status badge: coloured background +
# coloured dot + label. Prefix rows still used the dot-only variant in lots
# of places; this helper centralises the badge so every list / detail /
# row partial reads the same way and a palette tweak lands in one place.

_PREFIX_STATUS_PALETTE = {
    # status_slug: (display_label, base, dot, bg-light, text-light, bg-dark, text-dark)
    "active":     ("Active",     "emerald", "bg-emerald-500", "bg-emerald-50",  "text-emerald-700",  "dark:bg-emerald-950", "dark:text-emerald-300"),
    "reserved":   ("Reserved",   "amber",   "bg-amber-500",   "bg-amber-50",    "text-amber-700",    "dark:bg-amber-950",   "dark:text-amber-300"),
    "deprecated": ("Deprecated", "red",     "bg-red-500",     "bg-red-50",      "text-red-700",      "dark:bg-red-950",     "dark:text-red-300"),
    "container":  ("Container",  "zinc",    "bg-zinc-400",    "bg-zinc-100",    "text-zinc-700",     "dark:bg-zinc-800",    "dark:text-zinc-300"),
}


@register.simple_tag(name="prefix_status_badge")
def prefix_status_badge(status: str):
    """Render a Prefix.status value as the canonical pill-shape badge.

    Usage:
        {% prefix_status_badge p.status %}
        {% prefix_status_badge "active" %}

    Falls back to a neutral zinc badge with the raw value for any status
    we don't have palette entries for (so future user-defined statuses
    don't crash the page — they just render plainly).
    """
    key = (status or "").lower()
    entry = _PREFIX_STATUS_PALETTE.get(key)
    if entry is None:
        label = (status or "—").title()
        return mark_safe(
            f'<span class="inline-flex items-center gap-1.5 rounded-md bg-zinc-100 '
            f'px-1.5 py-0.5 text-[11px] font-medium text-zinc-700 dark:bg-zinc-800 '
            f'dark:text-zinc-300"><span class="h-1.5 w-1.5 rounded-full bg-zinc-400">'
            f'</span>{label}</span>'
        )
    label, _base, dot, bg, fg, dbg, dfg = entry
    return mark_safe(
        f'<span class="inline-flex items-center gap-1.5 rounded-md {bg} px-1.5 py-0.5 '
        f'text-[11px] font-medium {fg} {dbg} {dfg}">'
        f'<span class="h-1.5 w-1.5 rounded-full {dot}"></span>{label}</span>'
    )


@register.filter
def get(d, key):
    """Dict-by-key lookup in templates: ``{{ mydict|get:keyvar }}``."""
    if d is None:
        return None
    try:
        return d.get(key)
    except AttributeError:
        return None


@register.filter
def index(seq, i):
    """List-by-index lookup with a variable index: ``{{ mylist|index:n }}``."""
    try:
        return seq[int(i)]
    except (TypeError, IndexError, ValueError):
        return None


# ─── Role-icon registry ───────────────────────────────────────────────────
#
# A closed set of Lucide icon names usable inside role chips. The IPRoleForm
# exposes these names as choices. Anything outside this list renders as no
# icon — we never inject arbitrary user strings into SVG. All bodies come
# from api/lucide/<name>.svg (two locally-extended icons — `crown-off`,
# `broadcast` — live there alongside the upstream set).

ROLE_ICONS: tuple[str, ...] = (
    # Crowns — HSRP/VRRP/FHRP master / standby distinctions.
    "crown", "crown-off",
    # Routers / network gear
    "router", "network", "server",
    # Redundancy / standby
    "shield-check", "shield-x", "shield",
    # Direction / gateway
    "arrow-right", "anchor", "copy", "link", "key", "workflow",
    "waves", "satellite", "broadcast",
)

ROLE_ICON_CHOICES = sorted(ROLE_ICONS)


def _role_icon_svg(name: str, *, size_class: str = "h-3 w-3") -> str:
    """Render a registered role icon via Lucide. Empty string if unknown."""
    key = (name or "").strip().lower()
    if not key or key not in ROLE_ICONS:
        return ""
    return lucide_html(key, size_class)


@register.filter
def role_icon_svg(role, size_class: str = "h-3 w-3"):
    """Inline-SVG-render the icon for an IPRole instance.

    Usage: ``{{ ip.role|role_icon_svg }}``. Returns "" when the role has no
    icon or an unrecognised name.
    """
    if role is None:
        return ""
    return mark_safe(_role_icon_svg(getattr(role, "icon", "") or "",
                                    size_class=size_class))


@register.filter
def role_icon_svg_by_name(name: str, size_class: str = "h-3 w-3"):
    """Render an icon by name directly (no IPRole instance). Used by the
    role create/edit form to preview the chosen icon."""
    return mark_safe(_role_icon_svg(name or "", size_class=size_class))
