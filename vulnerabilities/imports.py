"""Upload import (#451): vulnerability files carried in by hand.

For airgapped installs. A deployment admin uploads an NVD JSON 2.0 feed or a
saved NVD API page (``.json``, ``.json.gz``, ``.zip``), OSV records (an
ecosystem's ``all.zip`` or ``.json``), the CISA KEV catalog (``.json`` /
``.csv``) or the EPSS scores (``.csv`` / ``.csv.gz``). The request only saves
the file and opens a :class:`~vulnerabilities.models.SyncRun`; a job on the
``low`` queue parses it (a year feed is too large to parse in a request) and
the run is what the page polls.

Everything is streamed and bounded: the upload size, the unpacked size, the
zip member count and size, one record's size and the record count all have
ceilings, so a zip or gzip bomb or a huge JSON document fails the run with a
message rather than exhausting the worker. Only records that name a tracked
product are kept (:mod:`vulnerabilities.products`). Nothing here makes an
outbound request.
"""
from __future__ import annotations

import logging
import os
from datetime import timedelta
from pathlib import Path

from django.conf import settings
from django.db import IntegrityError, transaction
from django.utils import timezone

from . import products, sources, store
from .models import SyncRun, VulnerabilitySettings
from .streaming import (
    ImportFormatError,
    iter_zip_members,
    open_stream,
    sniff,
)

log = logging.getLogger(__name__)

KINDS = ("nvd", "osv", "kev", "epss")
#: Largest unpacked content of one upload (an NVD year feed is well under).
MAX_UNPACKED_BYTES = 3 * 1024 * 1024 * 1024
KEV_MAX_BYTES = 64 * 1024 * 1024
EPSS_MAX_BYTES = 512 * 1024 * 1024
ZIP_MAX_MEMBERS = 500_000
JOB_TIMEOUT = 3600
#: A browser run with no post for this long is abandoned (and resumable).
BROWSER_IDLE = timedelta(minutes=30)
ERROR_SAMPLE = 20


class ImportRefused(ValueError):
    """The upload cannot start; the message is for the user."""

    def __init__(self, message: str, status: int = 400, field: str = "file"):
        super().__init__(message)
        self.status = status
        self.field = field


class ErrorLog:
    """Counts record errors and keeps the first few messages."""

    def __init__(self):
        self.count = 0
        self.sample: list[str] = []

    def append(self, message: str) -> None:
        self.count += 1
        if len(self.sample) < ERROR_SAMPLE:
            self.sample.append(message[:300])


def max_upload_bytes() -> int:
    return int(getattr(settings, "VULN_IMPORT_MAX_BYTES", 512 * 1024 * 1024))


def import_dir() -> Path:
    return Path(settings.MEDIA_ROOT) / "vuln-imports"


def _upload_path(run_id) -> Path:
    return import_dir() / f"{run_id}.upload"


def abandon_stale() -> int:
    """Mark dead runs: a job that has said nothing for twice its timeout (a
    worker killed mid-run), a browser run idle for 30 minutes."""
    now = timezone.now()
    n = SyncRun.objects.filter(
        status="running", via__in=("upload", "server"),
        updated_at__lt=now - timedelta(seconds=JOB_TIMEOUT * 2),
    ).update(status="abandoned", finished_at=now, updated_at=now)
    n += SyncRun.objects.filter(
        status="running", via="browser", updated_at__lt=now - BROWSER_IDLE,
    ).update(status="abandoned", updated_at=now)
    return n


def start_upload(user, upload, kind: str) -> SyncRun:
    """Save ``upload`` and open its run. Raises :class:`ImportRefused`."""
    if kind not in KINDS:
        raise ImportRefused(f"Pick one of: {', '.join(KINDS)}.", field="kind")
    limit = max_upload_bytes()
    if upload.size > limit:
        raise ImportRefused(f"The file is larger than {limit // (1024 * 1024)} MB.",
                            status=413)
    if kind in ("nvd", "osv"):
        wanted = "cpe" if kind == "nvd" else "purl"
        if wanted not in products.tracked().kinds():
            raise ImportRefused(
                "No product is mapped to "
                + ("a CPE name" if kind == "nvd" else "a package URL")
                + " yet, so nothing in this file would be kept.")
    abandon_stale()
    now = timezone.now()
    try:
        with transaction.atomic():
            run = SyncRun.objects.create(
                via="upload", started_by=user if user.is_authenticated else None,
                started_at=now, status="running",
                plan={"kind": kind, "filename": os.path.basename(upload.name or "")[:200],
                      "size": upload.size})
    except IntegrityError:
        raise ImportRefused("An update is already running.", status=409) from None
    path = _upload_path(run.pk)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        written = 0
        with open(path, "wb") as fh:
            for chunk in upload.chunks():
                written += len(chunk)
                if written > limit:
                    raise ImportRefused(
                        f"The file is larger than {limit // (1024 * 1024)} MB.", status=413)
                fh.write(chunk)
    except BaseException as exc:
        path.unlink(missing_ok=True)
        _finish(run, "failed", error=str(exc) if isinstance(exc, ImportRefused)
                else "The upload could not be saved.")
        raise
    return run


def enqueue(run: SyncRun) -> None:
    """Queue the parse job; on a queue that is down, fail the run cleanly."""
    try:
        import django_rq

        django_rq.get_queue("low").enqueue(run_import_job, str(run.pk),
                                           job_timeout=JOB_TIMEOUT)
    except Exception:  # noqa: BLE001 - Redis down: say so, do not parse inline
        _upload_path(run.pk).unlink(missing_ok=True)
        _finish(run, "failed", error="The job queue is not reachable.")
        raise ImportRefused("The job queue is not reachable.", status=503) from None


def _finish(run: SyncRun, status: str, *, error: str = "", counts: dict | None = None) -> None:
    now = timezone.now()
    fields = {"status": status, "finished_at": now, "updated_at": now, "error": error[:2000]}
    if counts is not None:
        fields["counts"] = counts
    SyncRun.objects.filter(pk=run.pk).update(**fields)
    VulnerabilitySettings.load()
    # An UPDATE, not save(): run bookkeeping is not a settings change, so it
    # stays out of the change log.
    VulnerabilitySettings.objects.filter(pk=1).update(
        last_sync_at=now, last_sync_status=status, last_sync_error=error[:2000],
        last_sync_via=run.via, updated_at=now)


def _heartbeat(run_id):
    def beat(counts: dict) -> None:
        SyncRun.objects.filter(pk=run_id, status="running").update(
            counts=dict(counts), updated_at=timezone.now())
    return beat


def _nvd_records(fh, errors: ErrorLog):
    if sniff(fh) == "zip":
        for _name, reader in iter_zip_members(
                fh, suffixes=(".json",), max_members=ZIP_MAX_MEMBERS,
                max_member_bytes=MAX_UNPACKED_BYTES, max_total_bytes=MAX_UNPACKED_BYTES):
            yield from sources.iter_nvd(reader, errors=errors)
        return
    yield from sources.iter_nvd(open_stream(fh, max_bytes=MAX_UNPACKED_BYTES), errors=errors)


def _osv_records(fh, errors: ErrorLog):
    if sniff(fh) == "zip":
        for _name, reader in iter_zip_members(
                fh, suffixes=(".json",), max_members=ZIP_MAX_MEMBERS,
                max_member_bytes=sources.RECORD_MAX, max_total_bytes=MAX_UNPACKED_BYTES):
            try:
                yield from sources.iter_osv_json(reader, errors=errors)
            except ImportFormatError as exc:
                # One bad file in an ecosystem zip does not sink the rest.
                errors.append(f"{_name}: {exc}")
        return
    yield from sources.iter_osv_json(open_stream(fh, max_bytes=MAX_UNPACKED_BYTES),
                                     errors=errors)


def process(kind: str, fh, *, tracked=None, progress=None) -> dict:
    """Parse and store one opened file. Raises ``ImportFormatError`` for a
    file that is not what ``kind`` expects."""
    errors = ErrorLog()
    if tracked is None and kind in ("nvd", "osv"):
        tracked = products.tracked()
    if kind == "nvd":
        counts = store.store_records(_nvd_records(fh, errors), source="nvd_feed",
                                     tracked=tracked, progress=progress)
    elif kind == "osv":
        counts = store.store_records(_osv_records(fh, errors), source="osv",
                                     tracked=tracked, progress=progress)
    elif kind == "kev":
        counts = store.store_kev(sources.iter_kev(
            open_stream(fh, max_bytes=KEV_MAX_BYTES), errors=errors))
    elif kind == "epss":
        counts = store.store_epss(sources.iter_epss_csv(
            open_stream(fh, max_bytes=EPSS_MAX_BYTES), errors=errors))
    else:
        raise ImportFormatError(f"Unknown kind {kind!r}.")
    counts["invalid"] = errors.count
    counts["errors"] = errors.sample
    return counts


def run_import_job(run_id: str) -> None:
    """RQ entry point. Re-reads the run and the settings, so a run that was
    abandoned or a feature switched off since the upload does nothing.
    Never raises; the outcome lands on the run."""
    run = SyncRun.objects.filter(pk=run_id).first()
    if run is None or run.status != "running" or run.via != "upload":
        return
    path = _upload_path(run.pk)
    try:
        if not VulnerabilitySettings.load().enabled:
            _finish(run, "failed", error="Vulnerability data was turned off.")
            return
        if not path.exists():
            _finish(run, "failed", error="The uploaded file is gone.")
            return
        with open(path, "rb") as fh:
            counts = process(run.plan.get("kind", ""), fh, progress=_heartbeat(run.pk))
        _finish(run, "ok", counts=counts)
    except ImportFormatError as exc:
        _finish(run, "failed", error=str(exc))
    except Exception as exc:  # noqa: BLE001 - the run must end, whatever broke
        log.exception("vulnerability import %s failed", run_id)
        _finish(run, "failed", error=f"Import failed: {exc.__class__.__name__}.")
    finally:
        path.unlink(missing_ok=True)
