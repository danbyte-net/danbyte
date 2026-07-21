"""Pluggable integration providers.

Registries for the swappable backends behind Danbyte's integration flows so a
plugin can add its own from its ``danbyte_plugin`` module:

- **automation runners** (deploy dispatch) — built-in ``awx`` + ``webhook``.
- **import sources** — built-in ``netbox``.
- **notification channels** — plugin-supplied transports.

Selection is by ``kind`` string. Registration is idempotent (last wins). The
automation selector degrades to the ``webhook`` provider for an unknown kind
rather than crashing — mirroring the check engine's "unknown degrades" rule.

An automation runner is ``run(target, payload, event) -> (status, detail)``
where ``status`` is ``"launched"`` or ``"failed"``.
"""
from __future__ import annotations

from typing import Callable

_AUTOMATION: dict[str, Callable] = {}
_IMPORT_SOURCES: dict[str, Callable] = {}
_NOTIFICATION_CHANNELS: dict[str, Callable] = {}


# ── automation runners ───────────────────────────────────────────────────────
def register_automation_provider(kind: str, runner: Callable) -> None:
    _AUTOMATION[kind] = runner


def automation_provider(kind: str) -> Callable | None:
    return _AUTOMATION.get(kind)


def automation_kinds() -> list[str]:
    return sorted(_AUTOMATION)


# ── import sources ───────────────────────────────────────────────────────────
def register_import_source(kind: str, handler: Callable) -> None:
    _IMPORT_SOURCES[kind] = handler


def import_source(kind: str) -> Callable | None:
    return _IMPORT_SOURCES.get(kind)


def import_source_kinds() -> list[str]:
    return sorted(_IMPORT_SOURCES)


# ── notification channels ────────────────────────────────────────────────────
def register_notification_channel(kind: str, sender: Callable) -> None:
    _NOTIFICATION_CHANNELS[kind] = sender


def notification_channel(kind: str) -> Callable | None:
    return _NOTIFICATION_CHANNELS.get(kind)


def notification_channel_kinds() -> list[str]:
    return sorted(_NOTIFICATION_CHANNELS)
