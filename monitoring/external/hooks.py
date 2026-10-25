"""Where monitoring's workflow moments reach external monitors.

Two moments travel outwards: an operator acknowledging an alert, and a
maintenance window settling (or its event being deleted). Monitoring owns one
signal handler for each (connected in :mod:`monitoring.apps`); systems
register what they want called, so adding a system adds a registration, not
another receiver on monitoring's signals.

* **Acknowledgement writers** are keyed by the check kind whose alerts they
  answer for. Each is registered with the system it writes to, and is not
  called for an acknowledgement that *came from* that system (``source``) -
  a mark read from a remote system must never be echoed back to it.
* **Window listeners** receive a tenant id whenever one of its windows
  changes. They should only queue work, after commit; talking to the remote
  system is a job with its own re-checks.
"""
from __future__ import annotations

from collections.abc import Callable

#: check kind -> {system: writer(alert, acknowledged, actor=..., source=...)}
_ACK_WRITERS: dict[str, dict[str, Callable]] = {}
#: name -> listener(tenant_id)
_WINDOW_LISTENERS: dict[str, Callable] = {}


def register_ack_writer(check_kind: str, fn: Callable, *, system: str | None = None) -> None:
    """Call ``fn`` when an alert of ``check_kind`` is acknowledged or cleared.

    ``system`` names where ``fn`` writes (defaults to the check kind); an
    acknowledgement whose ``source`` is that system is not passed back to it.
    Registering again under the same system replaces the earlier writer.
    """
    _ACK_WRITERS.setdefault(check_kind, {})[system or check_kind] = fn


def register_window_listener(name: str, fn: Callable) -> None:
    """Call ``fn(tenant_id)`` whenever a window of that tenant changes or its
    event is deleted. Registering again under the same name replaces it."""
    _WINDOW_LISTENERS[name] = fn


def ack_writers(check_kind: str) -> dict[str, Callable]:
    return dict(_ACK_WRITERS.get(check_kind, {}))


def window_listeners() -> dict[str, Callable]:
    return dict(_WINDOW_LISTENERS)


# ── the handlers monitoring connects ─────────────────────────────────────
def on_alert_acknowledged(
    sender, alert, acknowledged, actor=None, source=None, **kwargs
) -> None:
    for system, fn in ack_writers(alert.kind).items():
        if source is not None and source == system:
            continue
        fn(alert, acknowledged, actor=actor, source=source)


def _tenant_changed(tenant_id) -> None:
    for fn in window_listeners().values():
        fn(tenant_id)


def on_window_changed(sender, event, **kwargs) -> None:
    _tenant_changed(event.tenant_id)


def on_event_deleted(sender, instance, **kwargs) -> None:
    _tenant_changed(instance.tenant_id)


def connect() -> None:
    """Connect the handlers once. Called from ``MonitoringConfig.ready``."""
    from django.db.models.signals import post_delete

    from monitoring.signals import alert_acknowledged, maintenance_window_changed

    maintenance_window_changed.connect(
        on_window_changed, dispatch_uid="monitoring.external.window_changed"
    )
    post_delete.connect(
        on_event_deleted,
        sender="monitoring.MaintenanceEvent",
        dispatch_uid="monitoring.external.event_deleted",
    )
    alert_acknowledged.connect(
        on_alert_acknowledged, dispatch_uid="monitoring.external.alert_acknowledged"
    )
