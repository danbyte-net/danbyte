"""Run a NetBox import off the RQ ``default`` queue, reporting live progress.

Mirrors ``integrations/dispatch.py``: create the DB row synchronously, enqueue
the work, and fall back to running inline if Redis is down so the import still
happens. Progress is written to the run row (polled by the UI) and to
``job.meta`` (the repo's ``/api/jobs/`` progress channel).
"""
from __future__ import annotations

import logging

from django.utils import timezone

logger = logging.getLogger(__name__)


def run_netbox_import(run_id: str) -> None:
    """RQ entry point. Loads the run, drives the importer, records the result.

    Never raises out of the worker: a failure is captured on the run row.
    The token is decrypted only for the duration of the run and cleared
    (along with the rest of ``secrets``) when it reaches a terminal state.
    """
    from django.db import transaction

    from api.status_registry import seed_builtin_statuses
    from integrations.models import NetBoxImportRun
    from integrations.management.commands.import_netbox import (
        NetBoxClient,
        _Importer,
        _Rollback,
    )

    run = NetBoxImportRun.objects.filter(pk=run_id).first()
    if run is None:
        logger.warning("netbox import run %s vanished", run_id)
        return

    token = (run.secrets or {}).get("token", "")
    run.status = "running"
    run.started_at = timezone.now()
    run.save(update_fields=["status", "started_at", "updated_at"])

    try:
        from rq import get_current_job

        job = get_current_job()
    except Exception:  # noqa: BLE001 — inline (no RQ job) or rq missing
        job = None

    def on_progress(step_i, step_total, key, stats, fetching=None):
        totals = {
            k: 0
            for k in ("fetched", "created", "existed", "updated", "failed", "skipped")
        }
        for s in stats.values():
            for k in totals:
                totals[k] += s.get(k, 0)
        pct = round(step_i / step_total * 100) if step_total else 0
        run.progress = {
            "step": step_i, "total": step_total, "key": key,
            "pct": pct, "totals": totals, "by_type": stats,
            # Live per-page fetch counter ({"key","rows"}) while a big type is
            # being pulled — proves the run is alive during a slow fetch.
            "fetching": fetching,
        }
        run.save(update_fields=["progress", "updated_at"])
        if job is not None:
            job.meta["progress"] = {"step": step_i, "total": step_total,
                                    "key": key, "pct": pct}
            try:
                job.save_meta()
            except Exception:  # noqa: BLE001 — meta is best-effort
                pass

    class _Cmd:
        # _Importer only calls cmd.stdout.write; route it to the logger.
        stdout = type("S", (), {"write": staticmethod(lambda m="": None)})()

    try:
        seed_builtin_statuses(run.tenant)
        client = NetBoxClient(run.url, token, verify=not run.insecure, guard=True)
        opts = {
            "only": set(run.only or []),
            "skip": set(run.skip or []),
            "with_images": run.with_images,
            "dry_run": run.dry_run,
            "update_existing": run.update_existing,
        }
        imp = _Importer(_Cmd(), client, run.tenant, opts, on_progress=on_progress)
        if run.dry_run:
            try:
                with transaction.atomic():
                    imp.run()
                    raise _Rollback()
            except _Rollback:
                pass
        else:
            imp.run()
        run.report = imp.report()
        # A run where NOTHING was fetched isn't a success — it means every
        # step's fetch failed (TLS, auth, wrong URL) and the failures live in
        # the notes. A green "0 fetched" banner would hide that completely.
        totals = (run.report or {}).get("totals") or {}
        fetch_failures = [
            n for n in (run.report or {}).get("notes") or []
            if "fetch failed" in n
        ]
        if not totals.get("fetched") and fetch_failures:
            run.status = "failed"
            run.error = (
                "Nothing could be fetched from NetBox — "
                + fetch_failures[0].split(": ", 1)[-1]
            )
        else:
            run.status = "success"
    except Exception as exc:  # noqa: BLE001 — record, never crash the worker
        logger.exception("netbox import %s failed", run_id)
        run.status = "failed"
        run.error = str(exc)
    finally:
        run.secrets = {}  # a migration credential must not outlive the migration
        run.finished_at = timezone.now()
        run.save()


def enqueue_netbox_import(tenant, url, token, *, dry_run, update_existing,
                          only, skip, insecure=False, with_images=False,
                          user=None):
    """Create a NetBoxImportRun and enqueue it on the low queue. Returns the
    run. Falls back to inline execution if Redis is unavailable. Never raises."""
    from integrations.models import NetBoxImportRun

    run = NetBoxImportRun.objects.create(
        tenant=tenant, url=url, status="queued",
        dry_run=dry_run, update_existing=update_existing, insecure=insecure,
        with_images=with_images,
        only=list(only or []), skip=list(skip or []),
        created_by=user, secrets={"token": token},
    )
    try:
        import django_rq

        # `default`, not `low`: an import is user-initiated and watched, so it
        # must start promptly. `low` is drained last by the worker pool (after
        # the every-minute monitoring dispatch on `default`/`high`), which left
        # imports queued for a long time. With a worker pool, one worker on the
        # import still leaves the rest for checks.
        django_rq.get_queue("default").enqueue(
            run_netbox_import, str(run.id), job_timeout=3600,
        )
    except Exception:  # noqa: BLE001 — Redis down: run inline so it still happens
        logger.warning("RQ unavailable; running netbox import inline")
        try:
            run_netbox_import(str(run.id))
        except Exception:  # noqa: BLE001
            logger.exception("inline netbox import failed")
    return run
