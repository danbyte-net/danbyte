"""Where an observation of a device can come from.

Danbyte's own SNMP poll is one. A monitoring system that already watches the
estate is another - and what *it* knows belongs in the drift inbox somebody
already reads, not in a second one beside it.

Sources are **registered, not imported**: ``monitoring`` must not depend on the
apps that integrate with it, which is the direction :mod:`engine_drivers`
already points.

A source hands back something shaped like :class:`~monitoring.models.DeviceSnmp`
- ``data``, ``interfaces``, ``polled_at``, ``reachable`` - because those four
attributes are exactly what :func:`~monitoring.snmp_drift.compute_device_drift`
reads. Nothing has to subclass anything.

An indirect observation always ranks **below** a direct poll: Danbyte walking
the device itself is better evidence than a second-hand account of it, so where
both speak to the same field the poll wins and the indirect one is dropped.
"""
from __future__ import annotations

import logging

log = logging.getLogger("monitoring.observations")

#: name → (label, loader). ``loader(device, tenant)`` returns a state-shaped
#: object or None.
_SOURCES: dict[str, tuple[str, object]] = {}


def register_observation_source(name: str, label: str, loader) -> None:
    """Declare that ``name`` can observe a device. Called from an ``AppConfig``."""
    if name == "snmp":
        raise ValueError("'snmp' is the direct poll - it is not a registered source.")
    _SOURCES[name] = (label, loader)


def observation_sources() -> list[tuple[str, str]]:
    return sorted((name, label) for name, (label, _) in _SOURCES.items())


def source_label(name: str) -> str:
    entry = _SOURCES.get(name)
    return entry[0] if entry else name


def observations_for(device, tenant) -> list[tuple[str, object]]:
    """Every indirect observation of this device, as ``(source, state)``.

    One integration being unreachable, misconfigured or mid-migration must
    never take the drift inbox down with it - a source that raises is logged
    and skipped, because a page that 500s tells an operator far less than a
    page missing one integration's opinion.
    """
    out: list[tuple[str, object]] = []
    for name, (_label, loader) in sorted(_SOURCES.items()):
        try:
            state = loader(device, tenant)
        except Exception:
            log.exception("observation source %r failed for device %s", name, device.pk)
            continue
        # No observation is not the same as an observation of nothing: a source
        # that has never looked - or that looked and could not see the device -
        # must not make every field read as drift. Same rule the direct poll
        # gets, applied here so no source has to remember it.
        if state is None or not getattr(state, "polled_at", None):
            continue
        if getattr(state, "reachable", None) is False:
            continue
        out.append((name, state))
    return out
