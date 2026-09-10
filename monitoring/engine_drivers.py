"""Engine kinds beyond the two Danbyte ships.

A :class:`~monitoring.models.MonitoringEngine` says *where* a target's checks
run. Two kinds are built in - ``local`` (the core's RQ workers) and ``remote``
(a Danbyte Outpost) - and both are Danbyte running Danbyte's own checkers.

A **driver** is the third shape: an external monitoring system that already
watches the estate and can answer for it. Danbyte does not run the checks; it
asks the system what it knows and folds the answer through the same finalise
path an Outpost reports through, so alerts, silences, flapping, escalation and
every notification channel behave identically whichever engine produced the
result.

Registering a driver is how Zabbix - and, later, anything with the same shape -
becomes selectable. Its declared ``fields`` are rendered by the engine form the
way :func:`monitoring.secret_store.register_secret_store` fields are rendered by
the Security card, so a driver contributes its own connection UI without the
SPA knowing about it.

**A driver never dispatches on its own.** The scheduler asks
:meth:`EngineDriver.claimable` first, and a driver that says no is treated as
having no work rather than as an engine that has gone quiet - which is what
stops a switched-off integration paging somebody (see ``usable``).
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Protocol


class EngineDriver(Protocol):
    """What an external monitoring system has to be able to do.

    Only :meth:`test` and :meth:`usable` are needed to *register* - a driver
    can land its connection and its Test button before it can answer for a
    single check, which is exactly how this one is being built.
    """

    def test(self, engine) -> dict:
        """Reach the system and describe it.

        Returns ``{"ok": bool, "detail": str, "version": str}``. Never raises -
        a connection test that 500s tells the operator nothing.
        """
        ...

    def usable(self, engine) -> bool:
        """Whether this engine may be handed work **right now**.

        False when the tenant's integration switch is off, the connection is
        unconfigured, or the remote version is below the driver's floor. The
        resolver skips an unusable engine and the health sweep ignores it, so
        turning an integration off does not read as an outage.
        """
        ...

    def claim(self, engine, now) -> int:
        """Materialise and claim the states this engine will answer for.

        Optional. A driver that does not implement it simply never has work,
        which is the correct behaviour for one that is still read-only.
        """
        ...


@dataclass(frozen=True)
class EngineKind:
    kind: str
    label: str
    driver: Callable[[], EngineDriver]
    description: str = ""
    #: Connection fields the engine form renders. Same shape as a secret
    #: store's: name, label, type (text | password | checkbox), placeholder,
    #: default, hint, and set_flag for a write-only secret.
    fields: tuple[dict, ...] = field(default_factory=tuple)

    def payload(self) -> dict:
        return {
            "kind": self.kind,
            "label": self.label,
            "description": self.description,
            "fields": [dict(f) for f in self.fields],
        }


_REGISTRY: dict[str, EngineKind] = {}


def register_monitoring_engine(
    kind: str,
    label: str,
    driver: Callable[[], EngineDriver],
    *,
    description: str = "",
    fields: tuple[dict, ...] | list[dict] = (),
) -> EngineKind:
    """Make ``kind`` selectable as a monitoring engine.

    ``driver`` is a zero-argument callable returning the driver - deferred so
    registration at import time never touches the database.
    """
    kind = (kind or "").strip()
    if not kind:
        raise ValueError("engine kind must be non-empty")
    if kind in ("local", "remote"):
        raise ValueError(f"'{kind}' is a built-in engine kind")
    entry = EngineKind(
        kind=kind, label=label, driver=driver, description=description,
        fields=tuple(dict(f) for f in fields),
    )
    _REGISTRY[kind] = entry
    return entry


def engine_kinds() -> list[EngineKind]:
    """Registered driver kinds, in registration order."""
    return list(_REGISTRY.values())


def driver_kinds() -> set[str]:
    return set(_REGISTRY)


def driver_for(engine) -> EngineDriver | None:
    """The driver behind ``engine``, or ``None`` for a built-in kind (or one
    whose driver is no longer registered - a removed plugin fails closed)."""
    entry = _REGISTRY.get(getattr(engine, "kind", ""))
    return entry.driver() if entry is not None else None


def engine_usable(engine) -> bool:
    """Whether ``engine`` may be resolved to and handed work.

    Built-in kinds are always usable when enabled - that is what ``enabled``
    means for them. A driver kind additionally has to say yes, so an
    integration switched off for the tenant stops being chosen instead of
    being chosen and then going quiet.
    """
    if not getattr(engine, "enabled", False):
        return False
    driver = driver_for(engine)
    if driver is None:
        # Either a built-in kind, or a driver kind whose driver vanished. The
        # first is fine; the second must not silently keep collecting work.
        return getattr(engine, "kind", "") in ("local", "remote")
    try:
        return bool(driver.usable(engine))
    except Exception:
        # An unusable driver is a reason to stop choosing this engine, never a
        # reason to fail the whole resolve for every other target.
        return False
