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
    _enqueue(run_devicetype_import, run, "devicetype import")
    return run


def _enqueue(task, run, label: str) -> None:
    try:
        import django_rq

        django_rq.get_queue("low").enqueue(task, str(run.id), job_timeout=3600)
    except Exception:  # noqa: BLE001 — Redis down: run inline so it still runs
        logger.warning("RQ unavailable; running %s inline", label)
        try:
            task(str(run.id))
        except Exception:  # noqa: BLE001
            logger.exception("inline %s failed", label)


def run_devicetype_image_reimport(run_id: str) -> None:
    """Re-download elevation images for the run's in-scope EXISTING device
    types (see ``reimport_images_for_type``) and record progress. Never
    raises — failures land on the run so the worker survives."""
    from django.utils import timezone

    from .devicetype_import import (
        airgap_refusal,
        reimport_images_for_type,
        summarize_reimport,
    )
    from .models import DeviceType, DeviceTypeImportRun

    run = DeviceTypeImportRun.objects.filter(
        pk=run_id, kind="image_reimport"
    ).first()
    if run is None:
        return
    run.status = "running"
    run.started_at = timezone.now()
    run.save(update_fields=["status", "started_at", "updated_at"])

    failures: list[dict] = []
    try:
        # Re-check at run time — enqueue-time state is not trusted: the
        # deployment may have been flipped to airgapped since.
        refusal = airgap_refusal()
        if refusal:
            raise ValueError(refusal)

        # Re-derive scope at run time too. Tenant bounds the queryset; the
        # creator's row-level `change` constraints are re-applied so a
        # site-scoped editor's run can't touch types outside their grant. A
        # deleted creator (SET_NULL) fails the run rather than widening it.
        qs = DeviceType.objects.filter(tenant=run.tenant).select_related(
            "manufacturer"
        ).order_by("name")
        user = run.created_by
        if user is None:
            raise ValueError("The user who started this run no longer exists.")
        if not user.is_superuser:
            from auth_api import rbac

            qs = rbac.restrict_queryset(qs, user, run.tenant, "devicetype", "change")

        opts = run.options or {}
        overwrite = bool(opts.get("overwrite"))
        apply = not bool(opts.get("dry_run"))
        types = list(qs)
        total = len(types)
        rows: list[dict] = []
        for i, dt in enumerate(types, start=1):
            row = reimport_images_for_type(
                dt, run.source_url, overwrite=overwrite, apply=apply
            )
            rows.append(row)
            # Only actionable rows go to `failures` — a big catalog's happy
            # path (matched/skipped) lives in the totals.
            if row["status"] in ("no_match", "fetch_failed") and (
                len(failures) < _MAX_FAILURES
            ):
                failures.append({
                    "name": row["name"],
                    "error": "no matching image in the repository"
                    if row["status"] == "no_match"
                    else "image fetch failed (repository unreachable?)",
                })
            if i % _PROGRESS_EVERY == 0 or i == total:
                run.progress = {
                    "done": i, "total": total, **summarize_reimport(rows),
                }
                run.save(update_fields=["progress", "updated_at"])
        run.progress = {"done": total, "total": total, **summarize_reimport(rows)}
        run.status = "success"
    except Exception as exc:  # noqa: BLE001 — scope/airgap refusal, DB trouble
        logger.exception("devicetype image reimport %s failed", run_id)
        run.status = "failed"
        run.error = str(exc)
    finally:
        run.failures = failures
        run.finished_at = timezone.now()
        run.save()


def enqueue_devicetype_image_reimport(tenant, image_base, *, overwrite,
                                      dry_run, user):
    """Create an ``image_reimport`` run and enqueue it on the ``low`` queue
    (inline fallback when Redis is down). Returns the run."""
    from .models import DeviceTypeImportRun

    run = DeviceTypeImportRun.objects.create(
        tenant=tenant, kind="image_reimport", source_url=image_base,
        options={"overwrite": bool(overwrite), "dry_run": bool(dry_run)},
        created_by=user, status="queued",
    )
    _enqueue(run_devicetype_image_reimport, run, "devicetype image reimport")
    return run
