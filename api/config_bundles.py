"""Rendering a device's config as a set of files, and remembering what was
last pushed.

A router is more than one file: ``frr.conf``, ``/etc/network/interfaces``,
a systemd ``.link`` unit, ``nft.conf``, a WireGuard config. A
:class:`~api.models.ConfigBundle` names the templates that produce them,
and this module renders them together, keyed by the path each file lands
at, with a hash per file - so a push tool can fetch everything in one call
and skip what has not changed.

The push tool tells Danbyte what it put on the box
(:class:`~integrations.models.ConfigPush`); a later render is compared
against that, so the device page can say "changed since the last push"
before anyone reads the running config.
"""
from __future__ import annotations

import difflib
import hashlib
import io
import tarfile
import time
import uuid

from .export_templates import render_device_config
from .models import ConfigBundle, ExportTemplate

#: A pushed file the API will keep the text of, for diffs. Larger pushes
#: keep only their hash.
MAX_PUSH_OUTPUT = 1024 * 1024
#: Devices one bulk render will do. Past this, filter tighter.
MAX_BULK_DEVICES = 500


def sha256_of(text: str) -> str:
    return hashlib.sha256((text or "").encode()).hexdigest()


class BundleLookupError(ValueError):
    """``?bundle=`` named nothing usable; the message is for the caller."""


def resolve_bundle(tenant, device, param: str):
    """The bundle ``?bundle=<param>`` means for this device.

    An id, a name, or the word ``role`` - the one bundle bound to the
    device's role. Ambiguity is an error rather than a guess: two bundles
    on one role is a modelling mistake the caller should hear about.
    """
    if not param or tenant is None:
        raise BundleLookupError("Say which bundle: an id, a name, or 'role'.")
    qs = ConfigBundle.objects.filter(tenant=tenant).prefetch_related("templates")
    if param == "role":
        if not device.role_id:
            raise BundleLookupError(f"{device.name} has no role, so no bundle.")
        bound = list(qs.filter(roles=device.role_id))
        if not bound:
            raise BundleLookupError(
                f"No bundle is bound to the {device.role.name} role."
            )
        if len(bound) > 1:
            names = ", ".join(sorted(b.name for b in bound))
            raise BundleLookupError(
                f"{device.role.name} has more than one bundle ({names}); name one."
            )
        return bound[0]
    found = qs.filter(name=param).first()
    if found is None:
        try:
            found = qs.filter(id=uuid.UUID(str(param))).first()
        except ValueError:
            found = None
    if found is None:
        raise BundleLookupError(f"No bundle called {param!r}.")
    return found


def render_file(template: ExportTemplate, device) -> dict:
    """One template on one device: ``{path, template, template_id, output,
    sha256}``. Template errors propagate, as they do for a single render."""
    output = render_device_config(template, device, template.tenant)
    return {
        "path": template.bundle_path,
        "template": template.name,
        "template_id": str(template.id),
        "output": output,
        "sha256": sha256_of(output),
    }


def render_bundle(bundle: ConfigBundle, device) -> dict:
    """Every file in the bundle, keyed by path, in path order."""
    files = {}
    for tmpl in sorted(bundle.templates.all(), key=lambda t: (t.bundle_path, t.name)):
        if tmpl.object_type != "device":
            continue
        row = render_file(tmpl, device)
        files[row["path"]] = row
    return files


def tar_of(files: dict, device_name: str) -> bytes:
    """A tarball of the rendered files, paths kept relative - a tool untars
    it where it likes, and an absolute path in an archive is a foot-gun."""
    buf = io.BytesIO()
    now = int(time.time())
    with tarfile.open(fileobj=buf, mode="w") as tar:
        for path, row in files.items():
            data = (row["output"] or "").encode()
            info = tarfile.TarInfo(name=f"{device_name}/{path.lstrip('/')}")
            info.size = len(data)
            info.mtime = now
            info.mode = 0o644
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


def attach_push_state(device, files: dict) -> dict:
    """Add ``pushed``, ``drift`` and ``diff`` to each rendered file.

    ``pushed`` is the latest push for that path (``None`` when nothing was
    ever pushed); ``drift`` is whether the current render differs from it;
    ``diff`` is the unified diff against the pushed text when the tool kept
    it, else ``""``. A file never pushed has ``drift`` ``None``: "unknown" is
    a different answer from "no".
    """
    from integrations.models import ConfigPush

    latest: dict[str, ConfigPush] = {}
    for push in (
        ConfigPush.objects.filter(device=device, path__in=list(files))
        .select_related("pushed_by").order_by("path", "-pushed_at")
    ):
        latest.setdefault(push.path, push)
    for path, row in files.items():
        push = latest.get(path)
        if push is None:
            row.update({"pushed": None, "drift": None, "diff": ""})
            continue
        drift = push.sha256 != row["sha256"]
        diff = ""
        if drift and push.output:
            diff = "\n".join(difflib.unified_diff(
                push.output.splitlines(), (row["output"] or "").splitlines(),
                fromfile=f"pushed {push.pushed_at:%Y-%m-%d %H:%M}",
                tofile="rendered now", lineterm="",
            ))
        row.update({
            "pushed": {
                "sha256": push.sha256,
                "at": push.pushed_at.isoformat(),
                "by": push.pushed_by.username if push.pushed_by_id else "",
                "source": push.source,
                "note": push.note,
                "has_output": bool(push.output),
            },
            "drift": drift,
            "diff": diff,
        })
    return files
