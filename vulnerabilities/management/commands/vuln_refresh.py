"""Fetch vulnerability data from NVD, OSV, CISA KEV and FIRST EPSS (#451).
Daily (danbyte-vuln-refresh.timer / run_scheduler); does nothing unless a
deployment admin turned the feature on with update source ``server``.

    manage.py vuln_refresh
"""
from __future__ import annotations

from django.core.management.base import BaseCommand, CommandError

from core.scheduled_runs import record_run
from vulnerabilities import fetch
from vulnerabilities.models import VulnerabilitySettings


def _summary(run) -> str:
    counts = run.counts or {}
    nvd, osv = counts.get("nvd", {}), counts.get("osv", {})
    return "; ".join([
        f"NVD {nvd.get('created', 0)} new, {nvd.get('updated', 0)} updated",
        f"OSV {osv.get('created', 0)} new, {osv.get('updated', 0)} updated",
        f"KEV {counts.get('kev', {}).get('updated', 0)} updated",
        f"EPSS {counts.get('epss', {}).get('updated', 0)} updated",
        f"{counts.get('requests', 0)} requests",
    ])


class Command(BaseCommand):
    help = "Fetch vulnerability data (server mode only) and store it."

    def handle(self, *args, **opts):
        with record_run("vuln-refresh", "Vulnerability data") as rec:
            row = VulnerabilitySettings.load()
            if not row.enabled:
                rec.skip("vulnerability data is off")
                self.stdout.write("vulnerability data is off")
                return
            if row.update_source != "server":
                msg = f"update source is {row.update_source}; nothing fetched"
                rec.skip(msg)
                self.stdout.write(msg)
                return
            try:
                run = fetch.start_run(None)
            except fetch.Busy:
                rec.skip("an update is already running")
                self.stdout.write("an update is already running")
                return
            except (fetch.Off, fetch.FetchError) as exc:
                raise CommandError(str(exc)) from None
            run = fetch.execute(run.pk)
            summary = _summary(run)
            rec.note(summary, run=str(run.pk), status=run.status)
            if run.status != "ok":
                raise CommandError(run.error or f"run {run.status}")
            self.stdout.write(self.style.SUCCESS(summary))
