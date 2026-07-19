"""Dispatch a scheduled config-drift run to every enabled automation target.

Run every minute by a systemd timer (see services/danbyte-drift-dispatch.timer);
the command self-throttles to the interval configured in DeploymentSettings.

    manage.py drift_dispatch
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from integrations.dispatch_drift import run_scheduled_drift_dispatch


class Command(BaseCommand):
    help = "Dispatch a scheduled config-drift run (throttled to the configured interval)."

    def handle(self, *args, **opts):
        result = run_scheduled_drift_dispatch()
        if result.get("enabled") is False:
            self.stdout.write("config-drift dispatch disabled")
        elif result.get("skipped"):
            self.stdout.write(f"skipped ({result['skipped']})")
        else:
            self.stdout.write(
                self.style.SUCCESS(
                    f"dispatched drift to {result['runs']} target(s) "
                    f"across {result['tenants']} tenant(s)"
                )
            )
