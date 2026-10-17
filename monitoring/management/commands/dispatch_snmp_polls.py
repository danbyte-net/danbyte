"""Enqueue the scheduled SNMP polls that are due (#284 P4b).

Run every five minutes by danbyte-snmp-poll.timer, or by ``run_scheduler`` in
a container. Tenants opt in with **Poll devices every**; with it off
everywhere the run is a skip. See ``monitoring.snmp_schedule``.

    manage.py dispatch_snmp_polls
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from core.scheduled_runs import record_run
from monitoring.snmp_schedule import dispatch


class Command(BaseCommand):
    help = "Enqueue scheduled SNMP polls for devices that are due."

    def handle(self, *args, **opts):
        with record_run("snmp-poll", "Scheduled SNMP polls") as run:
            r = dispatch()
            if r.get("enabled") is False:
                self.stdout.write("scheduled SNMP polling is off")
                run.skip("off for every tenant")
                return
            summary = (
                f"enqueued {r['enqueued']} of {r['due']} due device(s) "
                f"across {r['tenants']} tenant(s)"
            )
            self.stdout.write(self.style.SUCCESS(summary))
            run.note(summary, **r)
