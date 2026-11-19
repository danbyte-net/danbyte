"""Repair the links between Danbyte's windows and Zabbix's maintenance periods.

A dry run by default: it reads both sides and prints what a pass would do -
adopt a period whose id Danbyte lost, create, update, delete - without
writing anything. ``--apply`` runs that pass, under the same lock as the
timer and the button.

    manage.py zabbix_maintenance_repair [--connection <id or name>] [--apply]
"""
from __future__ import annotations

import uuid

from django.core.management.base import BaseCommand, CommandError

from zabbix.maintenance import LOCK_WAIT, reconcile, reconcile_locked
from zabbix.models import ZabbixConnection

VERBS = ("adopted", "created", "updated", "deleted", "failed")


class Command(BaseCommand):
    help = "Adopt, create, update or delete Zabbix maintenance periods to match Danbyte."

    def add_arguments(self, parser):
        parser.add_argument("--connection", help="Connection id or name (default: all).")
        parser.add_argument(
            "--apply", action="store_true", help="Write the changes (default: dry run)."
        )

    def handle(self, *args, connection=None, apply=False, **opts):
        qs = ZabbixConnection.objects.filter(
            enabled=True, sync_maintenance=True
        ).select_related("tenant").order_by("name")
        if connection:
            try:
                qs = qs.filter(pk=uuid.UUID(connection))
            except ValueError:
                qs = qs.filter(name=connection)
            if not qs.exists():
                raise CommandError(f"No connection {connection!r} with maintenance sync on.")

        for conn in qs:
            report: list = []
            if apply:
                counts = reconcile_locked(conn, wait=LOCK_WAIT, report=report)
                if counts is None:
                    self.stdout.write(self.style.WARNING(
                        f"{conn.name}: a pass is still running - try again."
                    ))
                    continue
            else:
                counts = reconcile(conn, dry_run=True, report=report)
            for verb, name, detail in report:
                self.stdout.write(f"  {verb:<8} {name}" + (f"  {detail}" if detail else ""))
            summary = ", ".join(f"{counts.get(v, 0)} {v}" for v in VERBS)
            if counts.get("error"):
                summary += f" - {counts['error']}"
            prefix = "" if apply else "dry run: "
            style = self.style.ERROR if counts.get("failed") or counts.get("error") else (
                self.style.SUCCESS
            )
            self.stdout.write(style(f"{prefix}{conn.name} ({conn.tenant.name}): {summary}"))
        if not apply:
            self.stdout.write("Nothing written. Run with --apply to make these changes.")
