"""auto_upgrade — scheduled check + (windowed) self-upgrade to the latest release.

Run on a timer (see services/danbyte-auto-upgrade.*). No-op unless auto-update is
enabled in Deployment settings; respects the maintenance window (blank = anytime).
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from core.auto_upgrade import check_and_upgrade


class Command(BaseCommand):
    help = "Auto-upgrade Danbyte to the latest release when enabled + in window."

    def handle(self, *args, **opts):
        result = check_and_upgrade()
        self.stdout.write(str(result))
