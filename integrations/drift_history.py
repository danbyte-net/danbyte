"""Drift history — append a DeviceConfigSnapshot when a device's drift changes.

Connected as a post_save on DeviceConfigState (see apps.ready). A snapshot is
written only when status or diff differs from the device's most recent snapshot,
so the history is a transition log, not one row per heartbeat. Best-effort: a
failure here never breaks the config-state save.
"""
from __future__ import annotations

import logging

logger = logging.getLogger("danbyte.drift")


def _on_state_save(sender, instance, **kwargs):
    try:
        from .models import DeviceConfigSnapshot

        last = (
            DeviceConfigSnapshot.objects.filter(device_id=instance.device_id)
            .order_by("-created_at")
            .first()
        )
        if last and last.status == instance.status and last.diff == instance.diff:
            return  # nothing meaningful changed
        DeviceConfigSnapshot.objects.create(
            tenant_id=instance.tenant_id,
            device_id=instance.device_id,
            status=instance.status,
            diff=instance.diff,
            source=instance.source,
        )
    except Exception:  # noqa: BLE001 — never break the originating save
        logger.exception("drift snapshot failed")


def connect() -> None:
    from django.db.models.signals import post_save

    from .models import DeviceConfigState

    post_save.connect(
        _on_state_save, sender=DeviceConfigState, dispatch_uid="drift_snapshot"
    )
