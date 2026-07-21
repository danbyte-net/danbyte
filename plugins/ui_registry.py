"""Server-driven plugin UI registry.

A plugin describes its UI as data — nav items, pages (backed by an object type +
API endpoint), and dashboard panels — from its ``danbyte_plugin`` module. The
generic React frontend renders these with no plugin JavaScript and no rebuild,
extending the custom-fields "server describes, client renders" pattern.

Specs are intentionally simple/declarative so the generic renderer can build a
``DataTable`` (list) or ``DetailShell`` (detail) from them.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field


@dataclass(frozen=True)
class ColumnSpec:
    key: str
    label: str
    # Optional cell hint the renderer understands: text | mono | badge | tags | time
    kind: str = "text"


@dataclass(frozen=True)
class NavItemSpec:
    plugin: str            # owning plugin slug (for enable filtering)
    title: str
    url: str               # SPA path, e.g. "/p/example/widgets"
    icon: str = "puzzle"   # lucide kebab name (dynamic-icon)
    section: str = "Plugins"
    object_type: str | None = None  # RBAC gate slug (frontend itemVisible)
    perm: str | None = None


@dataclass(frozen=True)
class PageSpec:
    plugin: str
    path: str              # under /p/<plugin>/ , e.g. "widgets" or "widgets/$id"
    kind: str              # "list" | "detail"
    title: str
    endpoint: str          # API URL ("/api/plugins/example/widgets/")
    object_type: str | None = None
    columns: tuple[ColumnSpec, ...] = ()      # list pages
    detail_route: str | None = None           # list → row link template
    title_field: str = "name"                 # detail pages
    fields: tuple[ColumnSpec, ...] = ()       # detail attribute rows
    tabs: tuple[str, ...] = ("overview",)     # e.g. ("overview","history")
    audited: bool = False


@dataclass(frozen=True)
class PanelSpec:
    plugin: str
    title: str
    endpoint: str
    kind: str = "count"    # count | list


_NAV: list[NavItemSpec] = []
_PAGES: list[PageSpec] = []
_PANELS: list[PanelSpec] = []


def register_nav_item(item: NavItemSpec) -> None:
    _NAV.append(item)


def register_page(page: PageSpec) -> None:
    _PAGES.append(page)


def register_dashboard_panel(panel: PanelSpec) -> None:
    _PANELS.append(panel)


def _dump(seq) -> list[dict]:
    return [asdict(x) for x in seq]


def ui_payload(enabled: set[str]) -> dict:
    """Serialisable nav/pages/panels for the plugins whose slug is ``enabled``."""
    return {
        "nav": _dump(n for n in _NAV if n.plugin in enabled),
        "pages": _dump(p for p in _PAGES if p.plugin in enabled),
        "panels": _dump(p for p in _PANELS if p.plugin in enabled),
    }
