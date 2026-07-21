"""Offline plugin install — extract an uploaded plugin archive into the import
path and record it in the manifest.

For airgapped deployments that can't ``pip install`` from PyPI: a superuser
uploads a ``.tar.gz`` / ``.zip`` of the plugin source; it is safely extracted
into ``settings.PLUGIN_UPLOAD_DIR`` (a writable dir on ``sys.path``) and its
module name written to ``installed.json``. The plugin is discovered on the next
restart (Apply changes), exactly like a ``PLUGINS`` entry.

SECURITY: this installs code that runs in-process — it is remote code execution
by design and is gated to superusers at the API layer. Extraction is hardened
against path traversal, oversized archives, and too many members.
"""
from __future__ import annotations

import json
import shutil
import tarfile
import tempfile
import zipfile
from pathlib import Path

from django.conf import settings

MAX_ARCHIVE_BYTES = 25 * 1024 * 1024        # compressed upload cap
MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024  # zip/tar bomb guard
MAX_MEMBERS = 5000


class PluginInstallError(Exception):
    """A bad or unsafe plugin archive (surfaced as a 400)."""


def _dir() -> Path:
    return Path(settings.PLUGIN_UPLOAD_DIR)


def _manifest_path() -> Path:
    return _dir() / "installed.json"


def uploaded_names() -> list[str]:
    """Module names installed via upload (from the manifest)."""
    p = _manifest_path()
    if not p.is_file():
        return []
    try:
        return list(json.loads(p.read_text() or "{}").get("plugins", []))
    except Exception:  # noqa: BLE001 — a corrupt manifest is not fatal
        return []


def _write_manifest(names) -> None:
    _dir().mkdir(parents=True, exist_ok=True)
    _manifest_path().write_text(
        json.dumps({"plugins": sorted(set(names))}, indent=2)
    )


def _safe_extract(archive: Path, dest: Path) -> None:
    name = archive.name.lower()
    try:
        if name.endswith((".tar.gz", ".tgz", ".tar")):
            with tarfile.open(archive) as tf:
                members = tf.getmembers()
                if len(members) > MAX_MEMBERS:
                    raise PluginInstallError("archive has too many files")
                if sum(m.size for m in members) > MAX_UNCOMPRESSED_BYTES:
                    raise PluginInstallError("archive too large when uncompressed")
                # filter="data" (Python 3.12+) blocks path traversal, absolute
                # paths, and special files — raises on anything unsafe.
                tf.extractall(dest, filter="data")
        elif name.endswith(".zip"):
            with zipfile.ZipFile(archive) as zf:
                infos = zf.infolist()
                if len(infos) > MAX_MEMBERS:
                    raise PluginInstallError("archive has too many files")
                if sum(i.file_size for i in infos) > MAX_UNCOMPRESSED_BYTES:
                    raise PluginInstallError("archive too large when uncompressed")
                for i in infos:
                    parts = Path(i.filename).parts
                    if i.filename.startswith("/") or ".." in parts:
                        raise PluginInstallError(
                            f"unsafe path in archive: {i.filename}"
                        )
                zf.extractall(dest)
        else:
            raise PluginInstallError(
                "unsupported archive type — use .tar.gz, .tgz, .tar or .zip"
            )
    except PluginInstallError:
        raise
    except (tarfile.TarError, zipfile.BadZipFile, OSError, ValueError) as exc:
        # Includes the tar filter's traversal/absolute-path rejections.
        raise PluginInstallError(f"could not extract archive: {exc}") from exc


def _find_package(root: Path) -> Path:
    """The Danbyte plugin package inside an extracted archive.

    A package = a directory with ``__init__.py`` that ships either a
    ``danbyte_plugin.py`` or an ``apps.py`` referencing ``DanbytePluginConfig``.
    Handles both a root-level package and one nested under a wrapper dir (e.g. a
    GitHub source tarball's ``repo-sha/`` prefix). Shallowest match wins.
    """
    candidates: list[Path] = []
    for init in root.rglob("__init__.py"):
        d = init.parent
        if d.name.startswith((".", "__")):
            continue
        has_entry = (d / "danbyte_plugin.py").is_file()
        apps_py = d / "apps.py"
        has_cfg = (
            apps_py.is_file()
            and "DanbytePluginConfig" in apps_py.read_text(errors="ignore")
        )
        if has_entry or has_cfg:
            candidates.append(d)
    if not candidates:
        raise PluginInstallError(
            "no Danbyte plugin package found in the archive (expected a package "
            "with apps.py using DanbytePluginConfig)"
        )
    candidates.sort(key=lambda p: len(p.relative_to(root).parts))
    return candidates[0]


def install_archive(django_file) -> dict:
    """Install an uploaded plugin archive. Returns ``{"name": <module>}``.

    Replaces an existing upload of the same name (upgrade). The plugin is not
    active until the next restart (Apply changes).
    """
    if django_file.size > MAX_ARCHIVE_BYTES:
        raise PluginInstallError(
            f"archive too large (max {MAX_ARCHIVE_BYTES // 1024 // 1024} MB)"
        )
    _dir().mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        arch = tmp / (Path(django_file.name or "upload").name)
        with open(arch, "wb") as fh:
            for chunk in django_file.chunks():
                fh.write(chunk)
        extract_dir = tmp / "x"
        extract_dir.mkdir()
        _safe_extract(arch, extract_dir)
        pkg = _find_package(extract_dir)
        name = pkg.name
        if not name.isidentifier():
            raise PluginInstallError(f"invalid plugin package name: {name!r}")
        target = _dir() / name
        if target.exists():
            shutil.rmtree(target)  # replace = upgrade
        shutil.copytree(pkg, target)

    names = uploaded_names()
    if name not in names:
        names.append(name)
    _write_manifest(names)
    return {"name": name}


def uninstall(name: str) -> bool:
    """Remove an uploaded plugin (manifest entry + extracted files). Takes
    effect on the next restart. Returns False if it wasn't an uploaded plugin."""
    names = uploaded_names()
    if name not in names:
        return False
    names.remove(name)
    _write_manifest(names)
    target = _dir() / name
    if target.is_dir():
        shutil.rmtree(target, ignore_errors=True)
    return True
