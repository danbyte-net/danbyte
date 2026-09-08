"""The one seed this app needs: a default local target so "Back up now" and
the pre-upgrade backup work on a fresh install without setup. Required
system data - editable, never illustrative."""
from __future__ import annotations

from django.conf import settings


def default_target():
    """The default :class:`BackupTarget`, created on first use."""
    from .models import BackupTarget

    target = BackupTarget.objects.filter(is_default=True, enabled=True).first()
    if target is not None:
        return target
    target = BackupTarget.objects.filter(kind="local").order_by("created_at").first()
    if target is None:
        target = BackupTarget.objects.create(
            name="Local", kind="local", config={"path": str(settings.DANBYTE_BACKUP_DIR)},
            is_default=True,
        )
    elif not target.is_default:
        target.is_default = True
        target.save(update_fields=["is_default", "updated_at"])
    return target
