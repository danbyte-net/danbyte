"""Installing 3D model packs in the app: Settings → Device library → 3D model
packs (docs/dcim/model-packs.md#installing-in-the-app).

A pack arrives as an uploaded ``.zip`` or a download from an allowed URL and
gets a :class:`~api.models.ModelPack` row. Two jobs on the RQ ``low`` queue
then work on it:

1. **Check** (``run_check``): download it when it came by URL, refuse an
   unsafe archive (api.model_pack.zip_refusals), run the pack checker
   (api.model_pack_check) and a dry-run import (api.model_pack.import_pack)
   and store both as the row's ``report``.
2. **Install** (``run_install``), only when asked and only for a checked
   pack without check errors: the import for real, with the pack's name and
   version as the change log's cause and the installer as the actor. An
   older installed copy of the same pack becomes ``replaced``.

Both jobs re-check the user's rights when they run; nothing is trusted from
enqueue time. The archive is read in memory, never extracted, and nothing
in it is executed. It is kept under ``MEDIA_ROOT/model-packs/`` (private:
api.media_views serves no such path) until the install, and deleted then.
"""
from __future__ import annotations

import hashlib
import logging
import posixpath
from datetime import timedelta
from pathlib import Path
from urllib.parse import urljoin, urlsplit

from django.conf import settings
from django.utils import timezone

from core.errors import NETWORK_ERRORS, public_error

logger = logging.getLogger(__name__)

#: A check or install no job has touched for this long is dead (a killed
#: worker); a checked pack nobody installs is dropped after a day.
STALE_RUN = timedelta(hours=2)
STALE_DRAFT = timedelta(days=1)
#: Checked-but-not-installed packs a tenant may hold at once.
MAX_DRAFTS = 10
MAX_REDIRECTS = 3
JOB_TIMEOUT = 3600
DEFAULT_MAX_BYTES = 200 * 1024 * 1024
ACTIVE = ("checking", "installing")
DRAFT = ("checking", "checked", "refused", "failed")


class InstallRefused(ValueError):
    """The request can't start; the message is for the user."""

    def __init__(self, message: str, status: int = 400, field: str = "detail"):
        super().__init__(message)
        self.status = status
        self.field = field


# ── settings and rights ─────────────────────────────────────────────────────

def max_bytes() -> int:
    return int(getattr(settings, "MODEL_PACK_MAX_BYTES", DEFAULT_MAX_BYTES))


def source_url() -> str:
    return str(getattr(settings, "MODEL_PACK_SOURCE_URL", "") or "")


def allowed_hosts() -> list[str]:
    return [str(h).lower() for h in getattr(settings, "MODEL_PACK_ALLOWED_HOSTS", []) or []]


def redirect_hosts() -> list[str]:
    return [str(h).lower() for h in getattr(settings, "MODEL_PACK_REDIRECT_HOSTS", []) or []]


def archive_path(pack) -> Path:
    return Path(settings.MEDIA_ROOT) / "model-packs" / f"{pack.pk}.zip"


def may_view(user, tenant) -> bool:
    from auth_api import rbac

    return tenant is not None and rbac.has_action(user, tenant, "devicetype", "view")


def may_install(user, tenant) -> bool:
    """A pack creates and changes device and module types for the whole
    tenant, so installing one takes what the library import takes - add,
    and change for the types it replaces models on - unconstrained and on
    every site, and tenant admin rights, as the settings page does."""
    from auth_api import rbac
    from auth_api.permissions import can_manage_admin

    if tenant is None or not getattr(user, "is_authenticated", False):
        return False
    if user.is_superuser:
        return True
    if not can_manage_admin(user, tenant):
        return False
    for slug in ("devicetype", "moduletype"):
        for action in ("add", "change"):
            # One grant without row constraints or sites must cover it.
            if not any(not p.constraints and not p.sites.exists()
                       for p in rbac._granting_perms(user, tenant, slug, action)):
                return False
    return True


def url_refusal(url: str, *, redirect: bool = False) -> str | None:
    """Why ``url`` may not be downloaded from, or None. https only, no
    credentials in it, and under the configured pack source URL or on an
    allowed host - or, for a redirect, on a redirect host. The address
    itself is checked again by core.ssrf when it is fetched."""
    from .devicetype_import import airgap_refusal

    refusal = airgap_refusal()
    if refusal:
        return "Downloads are off on this airgapped install - upload the .zip instead."
    try:
        parts = urlsplit(url)
    except ValueError:
        return "Not a URL."
    if parts.scheme != "https":
        return "Only https URLs."
    if parts.username or parts.password or not parts.hostname:
        return "Not a URL Danbyte downloads from."
    host = parts.hostname.lower()
    base = source_url()
    if base:
        b = urlsplit(base)
        if (b.scheme == "https" and b.hostname and host == b.hostname.lower()
                and (parts.port or 443) == (b.port or 443)
                and parts.path.startswith(b.path or "/")):
            return None
    if host in allowed_hosts():
        return None
    if redirect and host in redirect_hosts():
        return None
    where = [x for x in ([base] if base else []) + allowed_hosts()]
    if not where:
        return "No download source is configured (MODEL_PACK_SOURCE_URL)."
    return f"Packs download only from {', '.join(where)}."


# ── progress ────────────────────────────────────────────────────────────────

def _progress_key(pack_id) -> str:
    return f"model-pack:{pack_id}:progress"


def set_progress(pack, phase: str, done: int = 0, total: int = 0) -> None:
    """Progress the pollers read. Kept in the cache too: the import runs in
    one transaction, so a row write from inside it isn't seen until the end."""
    from django.core.cache import cache

    value = {"phase": phase, "done": done, "total": total}
    try:
        cache.set(_progress_key(pack.pk), value, timeout=JOB_TIMEOUT * 2)
    except Exception:  # noqa: BLE001 - the cache is a nicety
        pass
    pack.progress = value


def live_progress(pack) -> dict:
    if pack.status not in ACTIVE:
        return pack.progress or {}
    from django.core.cache import cache

    try:
        return cache.get(_progress_key(pack.pk)) or pack.progress or {}
    except Exception:  # noqa: BLE001
        return pack.progress or {}


# ── starting ────────────────────────────────────────────────────────────────

def purge_stale(tenant) -> None:
    """Drop dead runs and old drafts of ``tenant``, with their archives."""
    from .models import ModelPack

    now = timezone.now()
    ModelPack.objects.filter(
        tenant=tenant, status__in=ACTIVE, updated_at__lt=now - STALE_RUN,
    ).update(status="failed", error="The run stopped - the worker may have been "
                                    "restarted. Try again.", updated_at=now)
    for pack in ModelPack.objects.filter(
            tenant=tenant, status__in=("checked", "refused", "failed"),
            installed_at__isnull=True, updated_at__lt=now - STALE_DRAFT):
        discard(pack)


def discard(pack) -> None:
    """Delete a pack row and its archive."""
    archive_path(pack).unlink(missing_ok=True)
    pack.delete()


def _new_row(tenant, user, **fields):
    from .models import ModelPack

    purge_stale(tenant)
    drafts = ModelPack.objects.filter(tenant=tenant, status__in=DRAFT).count()
    if drafts >= MAX_DRAFTS:
        raise InstallRefused("Too many packs are waiting to be installed - install or "
                             "discard one first.", status=409)
    return ModelPack.objects.create(tenant=tenant, created_by=user, status="checking",
                                    progress={"phase": "queued"}, **fields)


def start_upload(tenant, user, upload):
    """Save an uploaded ``.zip`` and queue its check."""
    limit = max_bytes()
    name = posixpath.basename(str(getattr(upload, "name", "") or "").replace("\\", "/"))[:255]
    if not name.lower().endswith(".zip"):
        raise InstallRefused("Upload the pack as a .zip.", field="file")
    if upload.size > limit:
        raise InstallRefused(f"The file is larger than {limit // (1024 * 1024)} MB.",
                             status=413, field="file")
    pack = _new_row(tenant, user, source="upload", filename=name)
    path = archive_path(pack)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        digest, written = hashlib.sha256(), 0
        with open(path, "wb") as fh:
            for chunk in upload.chunks():
                written += len(chunk)
                if written > limit:
                    raise InstallRefused(f"The file is larger than {limit // (1024 * 1024)} "
                                         "MB.", status=413, field="file")
                digest.update(chunk)
                fh.write(chunk)
    except BaseException:
        discard(pack)
        raise
    pack.sha256, pack.size = digest.hexdigest(), written
    pack.save(update_fields=["sha256", "size", "updated_at"])
    _enqueue(run_check, pack)
    pack.refresh_from_db()
    return pack


def start_url(tenant, user, url: str):
    """Queue a download and check of the pack at ``url``."""
    url = (url or "").strip()
    refusal = url_refusal(url)
    if refusal:
        raise InstallRefused(refusal, field="url")
    name = posixpath.basename(urlsplit(url).path)[:255]
    pack = _new_row(tenant, user, source="url", source_url=url[:1024], filename=name)
    _enqueue(run_check, pack)
    pack.refresh_from_db()
    return pack


def start_install(pack, user, *, replace_photos: bool = False, overwrite: bool = False):
    """Queue the install of a checked pack."""
    from django.db import transaction

    from .models import ModelPack

    if pack.status != "checked":
        raise InstallRefused("Only a checked pack can be installed.", status=409)
    if not (pack.report.get("check") or {}).get("ok"):
        raise InstallRefused("The pack has check errors; it can't be installed.", status=409)
    with transaction.atomic():
        busy = ModelPack.objects.select_for_update().filter(
            tenant=pack.tenant, status="installing").exclude(pk=pack.pk).exists()
        if busy:
            raise InstallRefused("Another pack is being installed.", status=409)
        updated = ModelPack.objects.filter(pk=pack.pk, status="checked").update(
            status="installing", installed_by=user, replace_photos=bool(replace_photos),
            overwrite=bool(overwrite),
            progress={"phase": "queued"}, updated_at=timezone.now())
    if not updated:
        raise InstallRefused("Only a checked pack can be installed.", status=409)
    pack.refresh_from_db()
    _enqueue(run_install, pack)
    pack.refresh_from_db()
    return pack


def _enqueue(task, pack) -> None:
    from .devicetype_import_tasks import _enqueue as enqueue

    enqueue(task, pack, "model pack")


# ── the jobs ────────────────────────────────────────────────────────────────

class _Failed(Exception):
    """Ends a job with ``status`` and the message."""

    def __init__(self, message: str, status: str = "failed"):
        super().__init__(message)
        self.status = status


def _download(pack, path: Path) -> None:
    from core.ssrf import safe_get

    url, limit = pack.source_url, max_bytes()
    for hop in range(MAX_REDIRECTS + 1):
        refusal = url_refusal(url, redirect=hop > 0)
        if refusal:
            raise _Failed(refusal, "refused")
        resp = safe_get(url, stream=True, timeout=(10, 120),
                        headers={"Accept": "application/zip, application/octet-stream"})
        try:
            if resp.status_code in (301, 302, 303, 307, 308):
                loc = resp.headers.get("Location") or ""
                if not loc:
                    raise _Failed("The server redirected without a location.")
                url = urljoin(url, loc)
                continue
            if resp.status_code != 200:
                raise _Failed(f"The server answered {resp.status_code}.")
            declared = resp.headers.get("Content-Length")
            if declared and declared.isdigit() and int(declared) > limit:
                raise _Failed(f"The pack is larger than {limit // (1024 * 1024)} MB.", "refused")
            path.parent.mkdir(parents=True, exist_ok=True)
            digest, written = hashlib.sha256(), 0
            with open(path, "wb") as fh:
                for chunk in resp.iter_content(1024 * 1024):
                    written += len(chunk)
                    if written > limit:
                        raise _Failed(f"The pack is larger than {limit // (1024 * 1024)} MB.",
                                      "refused")
                    digest.update(chunk)
                    fh.write(chunk)
            pack.sha256, pack.size = digest.hexdigest(), written
            return
        finally:
            resp.close()
    raise _Failed("Too many redirects.")


def _type_rows(result) -> list[dict]:
    return [{"kind": t.kind, "path": t.path, "name": t.name, "action": t.action,
             "id": t.id, "notes": t.notes, "changes": t.changes} for t in result.types]


def _summary(result) -> dict:
    return {
        "created": sum(1 for t in result.types if t.action == "created"),
        "matched": sum(1 for t in result.types if t.action == "matched"),
        "errors": result.errors,
        "types": _type_rows(result),
        "unused_models": result.unused_models,
    }


def _load(pack_id, status: str):
    from .models import ModelPack

    pack = ModelPack.objects.filter(pk=pack_id).select_related("tenant").first()
    if pack is None:
        logger.warning("model pack %s not found in this database - is another instance's "
                       "worker sharing this Redis queue (RQ_REDIS_DB)?", pack_id)
        return None
    if pack.status != status:
        return None
    return pack


def _finish(pack, exc: Exception, fallback: str) -> None:
    from .model_pack import PackRefused

    if isinstance(exc, _Failed):
        pack.status, pack.error = exc.status, str(exc)
    elif isinstance(exc, PackRefused):
        pack.status, pack.error = "refused", "The archive is refused."
        pack.report = {"refusals": exc.messages}
    else:
        logger.exception("model pack %s failed", pack.pk)
        pack.status = "failed"
        pack.error = public_error(exc, fallback, expected=NETWORK_ERRORS, log=False)
    if pack.status == "refused":
        archive_path(pack).unlink(missing_ok=True)


def run_check(pack_id: str) -> None:
    """Download (for a URL), refuse an unsafe archive, check and dry-run the
    pack. Never raises: the outcome lands on the row."""
    import zipfile

    from audit.context import clear_context, set_context

    from .model_pack import PackFiles, import_pack
    from .model_pack_check import check_pack
    from .models import ModelPack

    pack = _load(pack_id, "checking")
    if pack is None:
        return
    set_context(pack.created_by, str(pack.pk), "")
    files = None
    try:
        if not may_install(pack.created_by, pack.tenant):
            raise _Failed("You can no longer install model packs.")
        path = archive_path(pack)
        if pack.source == "url":
            set_progress(pack, "downloading")
            _download(pack, path)
        if not path.is_file():
            raise _Failed("The uploaded file is gone.")
        set_progress(pack, "checking")
        try:
            files = PackFiles(path)
        except zipfile.BadZipFile as exc:
            raise _Failed("Not a zip file.", "refused") from exc
        sizes = files.sizes()
        pack.files = [{"path": p, "size": sizes[p]} for p in sorted(sizes)]
        check = check_pack(files, tenant=pack.tenant)
        meta = check.pack
        pack.slug = meta.get("id", "")[:100]
        pack.name = meta.get("name", "")[:200]
        pack.version = meta.get("version", "")[:50]
        pack.license = meta.get("license", "")[:100]
        pack.author = meta.get("author", "")[:200]

        def tick(done, total):
            set_progress(pack, "dry run", done, total)

        dry = import_pack(pack.tenant, files, dry_run=True, progress=tick,
                          label=f"Pack import: {pack.name or pack.filename} {pack.version}")
        installed = None
        if pack.slug:
            prev = ModelPack.objects.filter(
                tenant=pack.tenant, slug=pack.slug, status="installed",
            ).exclude(pk=pack.pk).order_by("-installed_at").first()
            if prev is not None:
                installed = {"id": str(prev.pk), "version": prev.version,
                             "sha256": prev.sha256,
                             "installed_at": prev.installed_at.isoformat()
                             if prev.installed_at else None}
        pack.report = {"check": check.to_dict(), "import": _summary(dry),
                       "installed": installed}
        pack.status = "checked"
        pack.error = ""
    except Exception as exc:  # noqa: BLE001 - record, keep the worker alive
        _finish(pack, exc, "The check failed. The details are in the server log.")
    finally:
        if files is not None:
            files.close()
        set_progress(pack, "done")
        # Forgotten while the job ran: don't write the row back.
        if ModelPack.objects.filter(pk=pack.pk).exists():
            pack.save()
        clear_context()


def run_install(pack_id: str) -> None:
    """Install a checked pack. Never raises: the outcome lands on the row."""
    from django.db import transaction

    from audit.context import clear_context, set_context

    from .model_pack import PackFiles, import_pack
    from .models import ModelPack

    pack = _load(pack_id, "installing")
    if pack is None:
        return
    user = pack.installed_by
    set_context(user, str(pack.pk), "")
    files = None
    try:
        if not may_install(user, pack.tenant):
            raise _Failed("You can no longer install model packs.")
        path = archive_path(pack)
        if not path.is_file():
            raise _Failed("The pack's archive is gone - add it again.")
        digest = hashlib.sha256()
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != pack.sha256:
            raise _Failed("The archive changed since it was checked - add it again.")
        set_progress(pack, "installing")
        files = PackFiles(path)

        def tick(done, total):
            set_progress(pack, "installing", done, total)

        label = f"Pack import: {pack.name or pack.slug or pack.filename} {pack.version}"
        result = import_pack(pack.tenant, files, dry_run=False,
                             replace_photos=pack.replace_photos, overwrite=pack.overwrite,
                             label=label.strip(),
                             progress=tick)
        with transaction.atomic():
            if pack.slug:
                for old in ModelPack.objects.filter(
                        tenant=pack.tenant, slug=pack.slug, status="installed",
                ).exclude(pk=pack.pk):
                    old.status = "replaced"
                    old.save(update_fields=["status", "updated_at"])
            pack.result = _summary(result)
            pack.status = "installed"
            pack.installed_at = timezone.now()
            pack.error = ""
        files.close()
        files = None
        path.unlink(missing_ok=True)
    except Exception as exc:  # noqa: BLE001 - record, keep the worker alive
        _finish(pack, exc, "The install failed. The details are in the server log.")
    finally:
        if files is not None:
            files.close()
        set_progress(pack, "done")
        # Forgotten while the job ran: don't write the row back.
        if ModelPack.objects.filter(pk=pack.pk).exists():
            pack.save()
        clear_context()
