"""Report kinds and their sections, as plug-ins.

A **kind** (:class:`ReportKind`) is what the reader picks: the device,
prefix or IP address report, the topology report… It names its scope and
an ordered list of section keys. A **section** (:class:`SectionSpec`) is
what the reader ticks: a block of the report with a key, a label, the
object types the reader needs view on, its columns, and the function that
builds its HTML. Kinds and sections register here
(:func:`register_kind`, :func:`register_section`), each from its own module
under ``api/reports/kinds/``, and :func:`kinds` lists them.

Sections read their rows only through the list endpoints
(``api.object_report.list_view``) or the helpers the detail pages use, so a
section shows what the reader's list would show and nothing else.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field


@dataclass
class Built:
    """A section's output: its HTML, its contents entries and the table
    cells it holds (for the estimate)."""

    html: str
    toc: list = field(default_factory=list)
    cells: int = 0


@dataclass(frozen=True)
class SectionSpec:
    key: str
    label: str
    #: The kinds' scopes it can run on: "device", "topology_view"…
    applies_to: tuple[str, ...]
    #: Object types the reader needs view on; left out with a note otherwise.
    rbac: tuple[str, ...] = ()
    #: The list path its columns come from, and the ones it shows by default.
    path: str = ""
    columns: tuple[str, ...] = ()
    #: ``(ctx, scope, options) -> Built``; None for a section its kind draws.
    build: Callable | None = None
    default: bool = True
    chapter: str = ""


@dataclass(frozen=True)
class ReportKind:
    slug: str
    label: str
    scope: str
    sections: tuple[str, ...]
    #: Where it is made, for the dialog.
    path: str = ""


_SECTIONS: dict[str, SectionSpec] = {}
_KINDS: dict[str, ReportKind] = {}


def _key(scope_kind: str, key: str) -> str:
    return f"{scope_kind}:{key}"


def register_section(spec: SectionSpec) -> SectionSpec:
    """Add ``spec`` for each scope it applies to. Registering a key again
    replaces it, so a module can be reloaded."""
    for scope in spec.applies_to:
        _SECTIONS[_key(scope, spec.key)] = spec
    return spec


def register_kind(kind: ReportKind) -> ReportKind:
    _KINDS[kind.slug] = kind
    return kind


def kinds() -> dict[str, ReportKind]:
    _load()
    return dict(_KINDS)


def get_kind(slug: str) -> ReportKind | None:
    _load()
    return _KINDS.get(slug)


def sections_for(kind: ReportKind) -> list[SectionSpec]:
    """``kind``'s sections in its order; one not registered is skipped."""
    _load()
    out = []
    for key in kind.sections:
        spec = _SECTIONS.get(_key(kind.scope, key))
        if spec is not None:
            out.append(spec)
    return out


_loaded = False


def _load() -> None:
    """Import the built-in kinds once, so they register themselves."""
    global _loaded
    if _loaded:
        return
    _loaded = True
    from .kinds import objects  # noqa: F401
