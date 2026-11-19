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

A **bundle** (api.model_pack_bundle) is one row of ``kind`` bundle: the
check runs the checker and a dry run per pack, in the bundle's order; the
install applies the picked packs one by one, each in its own transaction,
skipping (and reporting) a pack with check errors. Each installed pack gets
its own pack row with the bundle it came from.

A pack's ``requires`` is listed as installed, in the bundle, or missing
(a warning, never a refusal). A missing pack the pack catalog
(``MODEL_PACK_CATALOG_URL``) lists can be fetched, checked and installed
first ("Install with it"), under the same URL guards as any pack download.

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


def catalog_url() -> str:
    return str(getattr(settings, "MODEL_PACK_CATALOG_URL", "") or "")


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


def set_progress(pack, phase: str, done: int = 0, total: int = 0, *, current: str = "",
                 index: int = 0, count: int = 0) -> None:
    """Progress the pollers read. Kept in the cache too: the import runs in
    one transaction, so a row write from inside it isn't seen until the end.
    A bundle adds the pack at work: ``pack`` (its name), ``index`` and
    ``count``."""
    from django.core.cache import cache

    value = {"phase": phase, "done": done, "total": total}
    if current:
        value.update(pack=current, index=index, count=count)
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


def _sections(pack) -> list[dict]:
    return [r for r in (pack.report or {}).get("packs") or [] if isinstance(r, dict)]


def installable(pack) -> bool:
    """A checked pack without check errors, or a checked bundle with at
    least one such pack."""
    if pack.status != "checked":
        return False
    if pack.kind == "bundle":
        return any(r.get("installable") for r in _sections(pack))
    return bool(((pack.report or {}).get("check") or {}).get("ok"))


def _offered(pack) -> dict[str, dict]:
    """The missing required packs the catalog offers, by id."""
    rows = [*((pack.report or {}).get("needs") or [])]
    for sec in _sections(pack):
        rows += sec.get("needs") or []
    return {r["id"]: r for r in rows
            if isinstance(r, dict) and r.get("state") == "missing" and r.get("available")}


def start_install(pack, user, *, replace_photos: bool = False, overwrite: bool = False,
                  packs: list[str] | None = None, with_packs: list[str] | None = None):
    """Queue the install of a checked pack or bundle. ``packs``: a bundle's
    packs to install (default: all; one with check errors is skipped and
    reported); ``with_packs``:
    the missing required packs to fetch from the catalog and install first."""
    from django.db import transaction

    from .models import ModelPack

    if pack.status != "checked":
        raise InstallRefused("Only a checked pack can be installed.", status=409)
    picked: list[str] = []
    if pack.kind == "bundle":
        ids = [r.get("id") for r in _sections(pack)]
        if packs is None:
            picked = list(ids)
        else:
            bad = [p for p in packs if p not in ids]
            if bad:
                raise InstallRefused(f"Not in the bundle: {', '.join(map(str, bad[:5]))}.",
                                     field="packs")
            picked = [i for i in ids if i in packs]
        if not any(r.get("installable") for r in _sections(pack) if r.get("id") in picked):
            raise InstallRefused("None of the picked packs can be installed.", status=409)
    elif packs is not None:
        raise InstallRefused("Only a bundle has packs to pick.", field="packs")
    elif not installable(pack):
        raise InstallRefused("The pack has check errors; it can't be installed.", status=409)
    offered = _offered(pack)
    with_packs = list(dict.fromkeys(with_packs or []))
    bad = [p for p in with_packs if p not in offered]
    if bad:
        raise InstallRefused(f"Not offered by the pack catalog: {', '.join(map(str, bad[:5]))}.",
                             field="with")
    with transaction.atomic():
        busy = ModelPack.objects.select_for_update().filter(
            tenant=pack.tenant, status="installing").exclude(pk=pack.pk).exists()
        if busy:
            raise InstallRefused("Another pack is being installed.", status=409)
        updated = ModelPack.objects.filter(pk=pack.pk, status="checked").update(
            status="installing", installed_by=user, replace_photos=bool(replace_photos),
            overwrite=bool(overwrite), result={"request": {"packs": picked, "with": with_packs}},
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


def _get(url: str, accept: str):
    """GET ``url`` under the pack URL guards, following allowed redirects;
    the open 200 response (the caller closes it)."""
    from core.ssrf import safe_get

    for hop in range(MAX_REDIRECTS + 1):
        refusal = url_refusal(url, redirect=hop > 0)
        if refusal:
            raise _Failed(refusal, "refused")
        resp = safe_get(url, stream=True, timeout=(10, 120), headers={"Accept": accept})
        if resp.status_code in (301, 302, 303, 307, 308):
            loc = resp.headers.get("Location") or ""
            resp.close()
            if not loc:
                raise _Failed("The server redirected without a location.")
            url = urljoin(url, loc)
            continue
        if resp.status_code != 200:
            resp.close()
            raise _Failed(f"The server answered {resp.status_code}.")
        return resp
    raise _Failed("Too many redirects.")


def _fetch(url: str, path: Path) -> tuple[str, int]:
    """Download a pack zip from ``url`` to ``path``: its SHA-256 and size."""
    limit = max_bytes()
    resp = _get(url, "application/zip, application/octet-stream")
    try:
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
        return digest.hexdigest(), written
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    finally:
        resp.close()


def _download(pack, path: Path) -> None:
    pack.sha256, pack.size = _fetch(pack.source_url, path)


# ── the pack catalog and what a pack requires ───────────────────────────────

#: The largest packs.json read, and the format it must declare.
MAX_CATALOG_BYTES = 4 * 1024 * 1024
CATALOG_FORMAT = "danbyte-library/catalog/v1"


class Catalog:
    """The pack catalog (``packs.json`` at ``MODEL_PACK_CATALOG_URL``),
    fetched once per job and only when a pack needs one it lists. Each
    pack's zip URL is resolved against the catalog's and must pass the same
    URL guards as any pack download."""

    def __init__(self):
        self._rows: dict[str, dict] | None = None
        self.error = ""

    def rows(self) -> dict[str, dict]:
        if self._rows is None:
            self._rows = {}
            try:
                self._rows = self._load()
            except _Failed as exc:
                self.error = str(exc)
            except NETWORK_ERRORS as exc:
                self.error = public_error(exc, "The pack catalog can't be reached.",
                                          expected=NETWORK_ERRORS, log=False)
            except ValueError:
                self.error = "The pack catalog isn't readable."
        return self._rows

    def _load(self) -> dict[str, dict]:
        import json

        from .devicetype_import import airgap_refusal
        from .model_pack_check import PACK_ID_RE

        url = catalog_url()
        if not url or airgap_refusal():
            return {}
        resp = _get(url, "application/json")
        try:
            body = b""
            for chunk in resp.iter_content(256 * 1024):
                body += chunk
                if len(body) > MAX_CATALOG_BYTES:
                    raise _Failed("The pack catalog is too large.")
        finally:
            resp.close()
        doc = json.loads(body.decode("utf-8"))
        if not isinstance(doc, dict) or doc.get("format") != CATALOG_FORMAT:
            raise ValueError("not a catalog")
        out: dict[str, dict] = {}
        for row in doc.get("packs") or []:
            if not isinstance(row, dict) or (row.get("kind") or "pack") != "pack":
                continue
            pid, file = str(row.get("id") or ""), row.get("file")
            if not PACK_ID_RE.match(pid) or not isinstance(file, str) or not file:
                continue
            zip_url = urljoin(url, file)
            if url_refusal(zip_url):
                continue
            sha = str(row.get("sha256") or "").lower()
            out[pid] = {"url": zip_url, "name": str(row.get("name") or pid)[:200],
                        "version": str(row.get("version") or "")[:50],
                        "sha256": sha if len(sha) == 64 else "",
                        "size": row.get("size") if isinstance(row.get("size"), int) else None}
        return out


def _installed_row(tenant, slug, exclude=None):
    from .models import ModelPack

    qs = ModelPack.objects.filter(tenant=tenant, kind="pack", slug=slug, status="installed")
    if exclude is not None:
        qs = qs.exclude(pk=exclude)
    return qs.order_by("-installed_at").first() if slug else None


def _installed_info(tenant, slug, exclude=None) -> dict | None:
    prev = _installed_row(tenant, slug, exclude)
    if prev is None:
        return None
    return {"id": str(prev.pk), "version": prev.version, "sha256": prev.sha256,
            "installed_at": prev.installed_at.isoformat() if prev.installed_at else None}


def needs(tenant, requires, *, in_bundle=(), version: str = "", catalog: Catalog | None = None
          ) -> list[dict]:
    """Each required pack's state: ``bundle`` (in the same bundle),
    ``installed`` (with its version) or ``missing`` - with ``available``
    when the catalog offers it, and ``zip``, the file to get."""
    out = []
    for rid in requires or []:
        prev = _installed_row(tenant, rid)
        row = {"id": rid, "state": "missing", "installed": prev.version if prev else None}
        if rid in in_bundle:
            row["state"] = "bundle"
        elif prev is not None:
            row["state"] = "installed"
        else:
            offer = (catalog.rows() if catalog is not None else {}).get(rid)
            if offer:
                row["available"] = offer
            ver = (offer or {}).get("version") or version
            row["zip"] = f"{rid}-{ver}.zip" if ver else f"{rid}.zip"
        out.append(row)
    return out


def _warn_missing(check: dict, rows: list[dict]) -> None:
    """A missing required pack is a warning in the check, never an error."""
    for r in rows:
        if r["state"] != "missing":
            continue
        how = ("the pack catalog offers it" if r.get("available")
               else f"get {r['zip']}")
        check.setdefault("findings", []).append({
            "level": "warning", "path": "pack.yaml",
            "message": f"Needs {r['id']}, which isn't installed - {how}."})
        check["warnings"] = int(check.get("warnings") or 0) + 1


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


# ── the check ───────────────────────────────────────────────────────────────

def _check_pack(pack, files, catalog: Catalog) -> None:
    from .model_pack import import_pack
    from .model_pack_check import check_pack

    check = check_pack(files, tenant=pack.tenant)
    meta = check.pack
    pack.kind = "pack"
    pack.slug = meta.get("id", "")[:100]
    pack.name = meta.get("name", "")[:200]
    pack.version = meta.get("version", "")[:50]
    pack.license = meta.get("license", "")[:100]
    pack.author = meta.get("author", "")[:200]
    pack.requires = list(meta.get("requires") or [])

    def tick(done, total):
        set_progress(pack, "dry run", done, total)

    dry = import_pack(pack.tenant, files, dry_run=True, progress=tick,
                      label=f"Pack import: {pack.name or pack.filename} {pack.version}")
    report = check.to_dict()
    rows = needs(pack.tenant, pack.requires, version=pack.version, catalog=catalog)
    _warn_missing(report, rows)
    pack.report = {"check": report, "import": _summary(dry),
                   "installed": _installed_info(pack.tenant, pack.slug, exclude=pack.pk),
                   "needs": rows}
    if catalog.error:
        pack.report["catalog_error"] = catalog.error


def _section_status(sec: dict) -> str:
    """``errors``, ``installed`` (this version is), ``update`` (another
    version is) or ``ready``."""
    if not sec.get("installable"):
        return "errors"
    prev = sec.get("installed")
    if prev:
        return "installed" if prev.get("version") == sec.get("version") else "update"
    return "ready"


def _check_bundle(pack, files, catalog: Catalog) -> None:
    from .model_pack import import_pack
    from .model_pack_bundle import check_sections, read_bundle

    bundle = read_bundle(files)
    pack.kind = "bundle"
    pack.slug = bundle.meta.get("id", "")[:100]
    pack.name = bundle.meta.get("name", "")[:200]
    pack.version = bundle.meta.get("version", "")[:50]
    pack.license = pack.author = ""
    pack.requires = []
    secs = check_sections(files, bundle, tenant=pack.tenant)
    in_bundle = {s.id for s in secs if s.files is not None}
    rows = []
    for i, sec in enumerate(secs):
        meta = sec.report.pack
        row = {"id": sec.id, "name": sec.name[:200], "version": sec.version[:50],
               "license": meta.get("license", ""), "author": meta.get("author", ""),
               "description": "", "requires": list(meta.get("requires") or []),
               "files": [], "import": None, "installed": None, "needs": []}
        if sec.files is not None:
            sizes = sec.files.sizes()
            row["files"] = [{"path": p, "size": sizes[p]} for p in sorted(sizes)]
            row["description"] = _description(sec.files)
            label = f"Pack import: {row['name']} {row['version']}".strip()

            def tick(done, total, i=i, name=row["name"]):
                set_progress(pack, "dry run", done, total, current=name, index=i + 1,
                             count=len(secs))

            try:
                dry = import_pack(pack.tenant, sec.files, dry_run=True, progress=tick,
                                  label=label)
                row["import"] = _summary(dry)
            except Exception as exc:  # noqa: BLE001 - one pack's dry run, not the bundle's
                logger.exception("model pack %s: dry run of %s failed", pack.pk, sec.id)
                from .model_pack_check import Finding

                sec.report.findings.append(Finding("error", "pack.yaml", public_error(
                    exc, "The dry run failed. The details are in the server log.",
                    log=False)))
            row["installed"] = _installed_info(pack.tenant, sec.id)
            row["needs"] = needs(pack.tenant, row["requires"], in_bundle=in_bundle - {sec.id},
                                 version=row["version"], catalog=catalog)
        report = sec.report.to_dict()
        _warn_missing(report, row["needs"])
        row["check"] = report
        row["installable"] = bool(report["ok"] and row["import"] is not None)
        row["status"] = _section_status(row)
        rows.append(row)
    pack.report = {"bundle": {**bundle.meta,
                              "packs": [{"id": e.id, "name": e.name, "version": e.version}
                                        for e in bundle.entries]},
                   "problems": bundle.problems, "packs": rows,
                   "installed": _installed_bundle(pack)}
    if catalog.error:
        pack.report["catalog_error"] = catalog.error


def _description(files) -> str:
    import yaml

    from .model_pack import MAX_YAML_BYTES

    try:
        meta = yaml.safe_load(files.read("pack.yaml", MAX_YAML_BYTES) or b"")
    except Exception:  # noqa: BLE001 - the checker reports it
        return ""
    return str(meta.get("description") or "")[:500] if isinstance(meta, dict) else ""


def _installed_bundle(pack) -> dict | None:
    from .models import ModelPack

    prev = (ModelPack.objects.filter(tenant=pack.tenant, kind="bundle", slug=pack.slug,
                                     status="installed")
            .exclude(pk=pack.pk).order_by("-installed_at").first()) if pack.slug else None
    if prev is None:
        return None
    return {"id": str(prev.pk), "version": prev.version,
            "installed_at": prev.installed_at.isoformat() if prev.installed_at else None}


def run_check(pack_id: str) -> None:
    """Download (for a URL), refuse an unsafe archive, check and dry-run the
    pack - or each pack of a bundle. Never raises: the outcome lands on the
    row."""
    import zipfile

    from audit.context import clear_context, set_context

    from .model_pack import PackFiles
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
        catalog = Catalog()
        if files.is_bundle:
            _check_bundle(pack, files, catalog)
        else:
            _check_pack(pack, files, catalog)
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


# ── the install ─────────────────────────────────────────────────────────────

#: The kinds whose ``pack_state`` names the pack that last imported them.
_CARRIED = {"device-type": "DeviceType", "module-type": "ModuleType", "rack-type": "RackType"}


def _carries(state, pack) -> bool:
    """Does a type's ``pack_state`` name ``pack`` as the pack it came from
    (by id; by name for a type imported before packs had ids there)."""
    link = state.get("pack") if isinstance(state, dict) else None
    if not isinstance(link, dict):
        return False
    if link.get("id"):
        return link["id"] == pack.slug
    return bool(pack.name) and link.get("name") == pack.name


def _supersede(tenant, rec) -> list[str]:
    """Other installed packs none of whose types names them any more - a
    pack from before the library was split, whose types the split packs now
    carry - become ``replaced``; their names."""
    from . import models

    out = []
    for old in models.ModelPack.objects.filter(tenant=tenant, kind="pack", status="installed"
                                               ).exclude(pk=rec.pk).exclude(slug=rec.slug):
        ids: dict[str, list[str]] = {}
        for t in (old.result or {}).get("types") or []:
            if isinstance(t, dict) and t.get("id") and t.get("kind") in _CARRIED:
                ids.setdefault(t["kind"], []).append(t["id"])
        states = []
        for kind, pks in ids.items():
            model = getattr(models, _CARRIED[kind])
            states += list(model.objects.filter(tenant=tenant, pk__in=pks)
                           .values_list("pack_state", flat=True))
        if states and not any(_carries(st, old) for st in states):
            old.status = "replaced"
            old.save(update_fields=["status", "updated_at"])
            out.append(str(old))
    return out


def _record(run, *, slug, name, version, result, user, report, files_list, requires,
            license="", author="", bundle=None, source=None, source_url=None, filename=None,
            sha256=None, size=None):
    """The installed pack's row: the run's own for a lone pack, else one per
    pack (a bundle's, or a required pack's), matched by id. The same version
    installed again updates its row; another version gets a new row and the
    older becomes ``replaced``."""
    from .models import ModelPack

    now = timezone.now()
    fields = {
        "name": name[:200], "version": version[:50], "license": license[:100],
        "author": author[:200], "result": _summary(result), "status": "installed",
        "installed_at": now, "installed_by": user, "error": "",
        "replace_photos": run.replace_photos, "overwrite": run.overwrite,
        "requires": list(requires or []), "report": report, "files": files_list,
        "source": source or run.source, "source_url": run.source_url if source_url is None
        else source_url, "filename": run.filename if filename is None else filename,
        "sha256": run.sha256 if sha256 is None else sha256,
        "size": run.size if size is None else size,
    }
    if bundle is not None:
        fields.update(bundle=bundle, bundle_slug=bundle.slug, bundle_name=bundle.name,
                      bundle_version=bundle.version)
    if run.kind == "pack" and bundle is None and run.slug == slug and source is None:
        rec = run
        for k, v in fields.items():
            setattr(rec, k, v)
        rec.save()
    else:
        same = (ModelPack.objects.filter(tenant=run.tenant, kind="pack", slug=slug,
                                         status="installed", version=version)
                .order_by("-installed_at").first()) if slug else None
        if same is not None:
            for k, v in fields.items():
                setattr(same, k, v)
            same.save()
            rec = same
        else:
            rec = ModelPack.objects.create(tenant=run.tenant, kind="pack", slug=slug[:100],
                                           created_by=run.created_by, **fields)
    if slug:
        for old in ModelPack.objects.filter(tenant=run.tenant, kind="pack", slug=slug,
                                            status="installed").exclude(pk=rec.pk):
            old.status = "replaced"
            old.save(update_fields=["status", "updated_at"])
    rec.superseded = _supersede(run.tenant, rec)
    return rec


def _apply(run, files, *, name, version, user, tick):
    """Import one pack for real, in its own transaction."""
    from .model_pack import import_pack

    label = f"Pack import: {name} {version}".strip()
    return label, import_pack(run.tenant, files, dry_run=False,
                              replace_photos=run.replace_photos, overwrite=run.overwrite,
                              label=label, progress=tick)


def _outcome(id_, name, version, status, reason="", rec=None, result=None, via="") -> dict:
    out = {"id": id_, "name": name, "version": version, "status": status, "reason": reason}
    if via:
        out["via"] = via
    if rec is not None:
        out["record"] = str(rec.pk)
        if getattr(rec, "superseded", None):
            out["superseded"] = rec.superseded
    if result is not None:
        s = _summary(result)
        out.update(created=s["created"], matched=s["matched"], errors=s["errors"])
    return out


def _install_required(run, user, rid: str, offer: dict) -> dict:
    """Fetch, check and install a required pack the catalog offers."""
    from audit.context import cause

    from .model_pack import PackFiles, PackRefused
    from .model_pack_check import check_pack

    name, version = offer.get("name") or rid, offer.get("version") or ""
    if _installed_row(run.tenant, rid) is not None:
        return _outcome(rid, name, version, "skipped", "Already installed.", via="requires")
    tmp = archive_path(run).with_name(f"{run.pk}-{rid}.zip")
    files = None
    try:
        set_progress(run, "downloading", current=name)
        sha, size = _fetch(offer["url"], tmp)
        if offer.get("sha256") and sha != offer["sha256"]:
            return _outcome(rid, name, version, "refused",
                            "The download's SHA-256 isn't the one the pack catalog gives.",
                            via="requires")
        try:
            files = PackFiles(tmp)
        except PackRefused as exc:
            return _outcome(rid, name, version, "refused",
                            "The archive is refused: " + " ".join(exc.messages[:3]),
                            via="requires")
        if files.is_bundle:
            return _outcome(rid, name, version, "refused", "A bundle, not a pack.",
                            via="requires")
        check = check_pack(files, tenant=run.tenant)
        if check.pack.get("id") != rid:
            return _outcome(rid, name, version, "refused",
                            f"Its pack.yaml id is {check.pack.get('id') or 'missing'}.",
                            via="requires")
        name = check.pack.get("name") or name
        version = check.pack.get("version") or version
        if not check.ok:
            return _outcome(rid, name, version, "skipped",
                            f"{check.errors} check error{'s' if check.errors != 1 else ''}.",
                            via="requires")

        def tick(done, total):
            set_progress(run, "installing", done, total, current=name)

        label, result = _apply(run, files, name=name, version=version, user=user, tick=tick)
        sizes = files.sizes()
        with cause(label):
            rec = _record(run, slug=rid, name=name, version=version, result=result, user=user,
                          report={"check": check.to_dict()},
                          files_list=[{"path": p, "size": sizes[p]} for p in sorted(sizes)],
                          requires=check.pack.get("requires"),
                          license=check.pack.get("license", ""),
                          author=check.pack.get("author", ""), source="url",
                          source_url=offer["url"][:1024],
                          filename=posixpath.basename(urlsplit(offer["url"]).path)[:255],
                          sha256=sha, size=size)
        return _outcome(rid, name, version, "installed", rec=rec, result=result, via="requires")
    except _Failed as exc:
        return _outcome(rid, name, version, exc.status, str(exc), via="requires")
    except Exception as exc:  # noqa: BLE001 - one required pack, not the run
        logger.exception("model pack %s: required pack %s failed", run.pk, rid)
        return _outcome(rid, name, version, "failed", public_error(
            exc, "The install failed. The details are in the server log.",
            expected=NETWORK_ERRORS, log=False), via="requires")
    finally:
        if files is not None:
            files.close()
        tmp.unlink(missing_ok=True)


def _install_bundle(run, files, user, picked: list[str]) -> list[dict]:
    from audit.context import cause

    from .model_pack import PackFiles
    from .model_pack_bundle import read_bundle

    bundle = read_bundle(files)
    secs = {r.get("id"): r for r in _sections(run)}
    order = [e.id for e in bundle.entries if e.id in secs]
    out = []
    for i, pid in enumerate(order):
        sec = secs[pid]
        name, version = sec.get("name") or pid, sec.get("version") or ""
        if pid not in picked:
            out.append(_outcome(pid, name, version, "skipped", "Not picked."))
            continue
        if not sec.get("installable"):
            n = int((sec.get("check") or {}).get("errors") or 0)
            out.append(_outcome(pid, name, version, "skipped",
                                f"{n} check error{'s' if n != 1 else ''}."))
            continue
        if not may_install(user, run.tenant):
            out.append(_outcome(pid, name, version, "failed",
                                "You can no longer install model packs."))
            continue
        try:
            view = PackFiles.nested(files, f"packs/{pid}")

            def tick(done, total, i=i, name=name):
                set_progress(run, "installing", done, total, current=name, index=i + 1,
                             count=len(order))

            label, result = _apply(run, view, name=name, version=version, user=user,
                                   tick=tick)
            with cause(label):
                rec = _record(run, slug=pid, name=name, version=version, result=result,
                              user=user,
                              report={k: sec.get(k) for k in ("check", "import", "installed",
                                                              "needs")},
                              files_list=sec.get("files") or [], requires=sec.get("requires"),
                              license=sec.get("license", ""), author=sec.get("author", ""),
                              bundle=run, size=sum(int(f.get("size") or 0)
                                                   for f in sec.get("files") or []))
            out.append(_outcome(pid, name, version, "installed", rec=rec, result=result))
        except Exception as exc:  # noqa: BLE001 - one pack, not the bundle
            logger.exception("model pack %s: pack %s failed", run.pk, pid)
            out.append(_outcome(pid, name, version, "failed", public_error(
                exc, "The install failed. The details are in the server log.", log=False)))
    return out


def run_install(pack_id: str) -> None:
    """Install a checked pack, or the picked packs of a checked bundle, with
    the required packs asked for first. Never raises: the outcome lands on
    the row."""
    from django.db import transaction

    from audit.context import cause, clear_context, set_context

    from .model_pack import PackFiles
    from .models import ModelPack

    pack = _load(pack_id, "installing")
    if pack is None:
        return
    user = pack.installed_by
    set_context(user, str(pack.pk), "")
    files = None
    request = dict((pack.result or {}).get("request") or {})
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
        offered = _offered(pack)
        required = [_install_required(pack, user, rid, offered[rid]["available"])
                    for rid in request.get("with") or [] if rid in offered]
        files = PackFiles(path)
        if pack.kind == "bundle":
            outcomes = _install_bundle(pack, files, user, list(request.get("packs") or []))
            done = [o for o in outcomes if o["status"] == "installed"]
            pack.result = {
                "request": request, "requires": required, "packs": outcomes,
                "created": sum(o.get("created", 0) for o in done),
                "matched": sum(o.get("matched", 0) for o in done),
                "errors": sum(o.get("errors", 0) for o in done),
            }
            if not done:
                raise _Failed("No pack was installed.")
            with cause(f"Pack import: {pack.name} {pack.version}".strip()), \
                    transaction.atomic():
                for old in ModelPack.objects.filter(
                        tenant=pack.tenant, kind="bundle", slug=pack.slug, status="installed",
                ).exclude(pk=pack.pk):
                    old.status = "replaced"
                    old.save(update_fields=["status", "updated_at"])
                pack.status = "installed"
                pack.installed_at = timezone.now()
                pack.error = ""
        else:
            def tick(done, total):
                set_progress(pack, "installing", done, total)

            label, result = _apply(pack, files, name=pack.name or pack.slug or pack.filename,
                                   version=pack.version, user=user, tick=tick)
            with cause(label), transaction.atomic():
                _record(pack, slug=pack.slug, name=pack.name, version=pack.version,
                        result=result, user=user, report=pack.report,
                        files_list=pack.files, requires=pack.requires, license=pack.license,
                        author=pack.author)
                pack.result = {**_summary(result), "request": request, "requires": required}
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
