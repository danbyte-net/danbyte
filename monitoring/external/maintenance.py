"""Which of Danbyte's maintenance windows an external monitor should mirror.

A confirmed window in Danbyte already owns a :class:`~monitoring.models.Silence`;
a system that mirrors windows writes the same window over the remote objects
it has linked, so scheduling it once quiets both. The writer is per system
(a Zabbix maintenance period, a PRTG maintenance property); deciding *what*
should exist is shared and lives here.

A window is wanted exactly when Danbyte silences for it. The silence's
existence is that decision, already made once by the status and the impacts;
its window is the one Danbyte itself honours, an open outage's rolling day
included.
"""
from __future__ import annotations


def desired_windows(tenant):
    """``(event, device ids)`` for every open window of the tenant that owns a
    silence, devices taken from the silence."""
    from monitoring.models import MaintenanceEvent

    events = (
        MaintenanceEvent.objects.filter(tenant=tenant, silence__isnull=False)
        .select_related("silence", "status")
        .prefetch_related("silence__match_devices")
    )
    for event in events:
        if event.status.is_closed:
            continue
        yield event, {d.id for d in event.silence.match_devices.all()}


def desired_for_links(tenant, links: dict) -> dict:
    """event id -> (event, sorted remote ids) for every window that covers at
    least one linked device.

    ``links`` maps a device id to the remote id the system knows it by.
    Devices the remote system does not know are simply not in the window -
    there is nothing to quiet.
    """
    out: dict = {}
    if not links:
        return out
    for event, device_ids in desired_windows(tenant):
        remote = sorted({links[d] for d in device_ids if d in links})
        if remote:
            out[event.id] = (event, remote)
    return out
