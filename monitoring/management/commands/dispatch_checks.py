"""Enqueue all due checks. Run every minute by a systemd timer (the
minute-resolution beat) — see services/danbyte-dispatch.timer.

    manage.py dispatch_checks            # enqueue onto RQ
    manage.py dispatch_checks --sync     # run inline (no worker needed)
"""
from __future__ import annotations

from django.core.management.base import BaseCommand

from core.scheduled_runs import record_run
from monitoring.scheduler import dispatch


class Command(BaseCommand):
    help = "Enqueue worker jobs for every check that is due."

    def add_arguments(self, parser):
        parser.add_argument(
            "--sync",
            action="store_true",
            help="Run due checks inline instead of enqueuing onto RQ.",
        )

    def handle(self, *args, **opts):
        with record_run("dispatch", "Check engine (dispatch)") as run:
            result = dispatch(sync=opts["sync"])
            # Watched-endpoint TLS polling piggybacks the minute beat — isolated
            # from the IP check engine and guarded so it can never block dispatch.
            try:
                from monitoring.watched_endpoints import run_due_watched_endpoints

                run_due_watched_endpoints()
            except Exception:  # noqa: BLE001
                import logging

                logging.getLogger("monitoring.watched_endpoints").exception(
                    "watched-endpoint poll pass failed"
                )
            run.note(
                f"dispatched {result['due']} due check(s) in {result['jobs']} job(s)",
                due=result["due"],
                jobs=result["jobs"],
            )
            self.stdout.write(
                self.style.SUCCESS(
                    f"dispatched {result['due']} due check(s) in {result['jobs']} job(s)"
                )
            )
