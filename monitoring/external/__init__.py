"""The shared layer for monitoring systems Danbyte reads from but does not run.

An external monitor (Zabbix today) is a server somebody already operates. What
differs per system is the client, its vocabulary and its object tree; what does
not differ lives here, so a second system plugs into the same machinery rather
than forking it:

* :mod:`.state_map` - a system's own states or severities folded onto
  Danbyte's statuses through an editable, per-connection map.
* :mod:`.matching` - which remote object a Danbyte device is: a cascade of
  levels, most reliable first, where ambiguity is no match.
* :mod:`.models` - abstract bases for the link, review-queue and adoption-rule
  rows each system keeps in its own tables.
* :mod:`.queue` - the review queue's viewset actions (apply, dismiss, restore,
  apply all) and the propose / drop-stale helpers a planning pass uses.
* :mod:`.adoption` - turning an unknown remote object into a device proposal.
* :mod:`.maintenance` - which confirmed windows want mirroring, per device.
* :mod:`.hooks` - registries for acknowledgement writers and window listeners;
  monitoring owns the one signal handler for each.
* :mod:`.beat` - the minute beat that enqueues each system's due passes, and
  the run-time re-checks every job repeats.
* :mod:`.policy` - device-shaped policy matching for rules that pick devices.

Nothing here imports a system's package: systems import this, never the other
way round.
"""
