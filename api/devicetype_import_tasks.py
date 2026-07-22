"""Background bulk import from the NetBox devicetype-library.

A folder (a manufacturer, or the whole ``device-types`` dir — thousands of
files) is too much for the synchronous import-yaml endpoint, so it runs here
off the RQ ``low`` queue with pollable progress. Mirrors the NetBox import
run's shape (``integrations/netbox_tasks.py``)."""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

#: Keep at most this many per-file failures on the run (avoid unbounded JSON).
_MAX_FAILURES = 100
#: Write progress to the DB every N files (not every one — one UPDATE per file
#: on a 1000-file run is a lot of needless writes).
_PROGRESS_EVERY = 5


def run_devicetype_import(run_id: str) -> None:
    """Expand the run's folder URL, fetch each YAML, import it, and record
    progress. Never raises — failures land on the run so the worker survives."""
    from django.utils import timezone

    from core.ssrf import safe_get

    from .devicetype_import import expand_github_dir, import_yaml_auto
    from .models import DeviceTypeImportRun

    run = DeviceTypeImportRun.objects.filter(pk=run_id).first()
    if run is None:
        return
    run.status = "running"
    run.started_at = timezone.now()
    run.save(update_fields=["status", "started_at", "updated_at"])

    created = failed = done = 0
    failures: list[dict] = []
    try:
        files = expand_github_dir(run.source_url, safe_get)
        total = len(files)
        run.progress = {"done": 0, "total": total, "created": 0, "failed": 0}
        run.save(update_fields=["progress", "updated_at"])

        for url in files:
            try:
                resp = safe_get(url, timeout=15)
                resp.raise_for_status()
                report = import_yaml_auto(
                    run.tenant, resp.text,
                    stack_positions=run.stack_positions,
                    owning_site=run.owning_site,
                )
                if report.get("ok"):
                    created += 1
                else:
                    failed += 1
                    if len(failures) < _MAX_FAILURES:
                        failures.append({
                            "name": report.get("name") or url,
                            "error": report.get("error") or "import failed",
                        })
            except Exception as exc:  # noqa: BLE001 — record, keep going
                failed += 1
                if len(failures) < _MAX_FAILURES:
                    failures.append({"name": url, "error": str(exc)})
            done += 1
            if done % _PROGRESS_EVERY == 0 or done == total:
                run.progress = {
                    "done": done, "total": total,
                    "created": created, "failed": failed,
                }
                run.save(update_fields=["progress", "updated_at"])
        run.status = "success"
    except Exception as exc:  # noqa: BLE001 — the expand/list step blew up
        logger.exception("devicetype import %s failed", run_id)
        run.status = "failed"
        run.error = str(exc)
    finally:
        run.failures = failures
        run.finished_at = timezone.now()
        run.save()


def enqueue_devicetype_import(tenant, url, *, stack, owning_site, user):
    """Create a run and enqueue it on the ``low`` queue. Falls back to inline
    execution when Redis is unavailable. Returns the run."""
    from .models import DeviceTypeImportRun

    run = DeviceTypeImportRun.objects.create(
        tenant=tenant, source_url=url, stack_positions=stack,
        owning_site=owning_site, created_by=user, status="queued",
    )
    try:
        import django_rq

        django_rq.get_queue("low").enqueue(
            run_devicetype_import, str(run.id), job_timeout=3600,
        )
    except Exception:  # noqa: BLE001 — Redis down: run inline so it still runs
        logger.warning("RQ unavailable; running devicetype import inline")
        try:
            run_devicetype_import(str(run.id))
        except Exception:  # noqa: BLE001
            logger.exception("inline devicetype import failed")
    return run
