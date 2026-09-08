"""Background OUI registry import - the 50k-row CSV runs off the RQ ``low``
queue with pollable progress, same shape as the devicetype-library import."""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

_MAX_BYTES = 64 * 1024 * 1024
_PROGRESS_EVERY = 4000


def enqueue_oui_import(run) -> None:
    from .devicetype_import_tasks import _enqueue

    _enqueue(run_oui_import, run, "oui import")


def run_oui_import(run_id: str) -> None:
    from django.utils import timezone

    from .models import OuiImport
    from .oui import OuiError, parse_registry_csv, sync_registry

    run = OuiImport.objects.filter(pk=run_id).first()
    if run is None:
        logger.warning("oui import run %s not found in this database", run_id)
        return
    run.status = "running"
    run.started_at = timezone.now()
    run.save(update_fields=["status", "started_at", "updated_at"])

    last = {"n": 0}

    def progress(done, total):
        if done - last["n"] >= _PROGRESS_EVERY or done == total:
            last["n"] = done
            run.progress = {**run.progress, "done": done, "total": total}
            run.save(update_fields=["progress", "updated_at"])

    try:
        if run.source == "url":
            from core.ssrf import safe_get

            resp = safe_get(run.source_url, timeout=120, stream=True)
            resp.raise_for_status()
            chunks, size = [], 0
            for chunk in resp.iter_content(1024 * 256):
                size += len(chunk)
                if size > _MAX_BYTES:
                    raise OuiError("The file is larger than 64 MB.")
                chunks.append(chunk)
            text = b"".join(chunks).decode("utf-8-sig", errors="replace")
        else:
            with run.file.open("rb") as fh:
                text = fh.read(_MAX_BYTES + 1).decode("utf-8-sig", errors="replace")
        entries = parse_registry_csv(text)
        run.progress = {"done": 0, "total": len(entries)}
        run.save(update_fields=["progress", "updated_at"])
        result = sync_registry(entries, on_progress=progress)
        run.progress = {**result, "done": result["total"]}
        run.status = "success"
    except Exception as exc:  # noqa: BLE001 - land it on the run, keep the worker
        logger.exception("oui import failed")
        run.status = "failed"
        run.error = str(exc)[:2000]
    finally:
        run.finished_at = timezone.now()
        if run.file:
            try:
                run.file.delete(save=False)
            except Exception:  # noqa: BLE001
                pass
            run.file = ""
        run.save()
