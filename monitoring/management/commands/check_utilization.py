"""Evaluate prefix utilization and fire alerts on threshold crossings.

Run periodically by danbyte-utilization.timer.

    manage.py check_utilization
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from core.scheduled_runs import record_run
from monitoring.port_utilization import evaluate_port_rules
from monitoring.utilization import evaluate_utilization


class Command(BaseCommand):
    help = (
        "Fire prefix-utilization alerts for prefixes over the threshold, "
        "and port-utilization alerts for matching rules."
    )

    def handle(self, *args, **opts):
        with record_run("utilization", "Interface utilization") as run:
            r = evaluate_utilization()
            p = evaluate_port_rules()
            self.stdout.write(
                self.style.SUCCESS(
                    f"utilization: {r['fired']} alert(s) fired, "
                    f"{r['rearmed']} re-armed (threshold {r['threshold']}%); "
                    f"ports: {p['fired']} fired, {p['rearmed']} re-armed "
                    f"({p['rules']} rule(s))"
                )
            )
            run.note(
                f"{r['fired']} prefix alert(s) fired, {r['rearmed']} re-armed "
                f"(threshold {r['threshold']}%); {p['fired']} port alert(s) "
                f"fired, {p['rearmed']} re-armed ({p['rules']} rule(s))",
                fired=r["fired"],
                rearmed=r["rearmed"],
                threshold=r["threshold"],
                port_fired=p["fired"],
                port_rearmed=p["rearmed"],
                port_rules=p["rules"],
            )
