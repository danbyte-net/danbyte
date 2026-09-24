"""Operator steps a release needs after the upgrade itself.

Some changes cannot ride a migration: an nginx location, a new volume, a
system package. Each such step is an :class:`UpgradeNote` here, shipped
with the code on every path (git, bundle, image). After an upgrade the
notes for the running version are *pending* until a deployment admin marks
them done; ``DeploymentSettings.upgrade_notes_done`` holds the ids. A
fresh install seeds that list with everything up to its own version, so it
never sees steps for what it started on.

Add a note in the same change as the feature that needs it.
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from .version import deployment_method, is_newer, system_version

PLATFORMS = ("systemd", "docker")


@dataclass(frozen=True)
class UpgradeNote:
    id: str
    version: str
    title: str
    body: str
    snippet: str = ""
    docs: str = ""
    platforms: tuple[str, ...] = PLATFORMS
    # Returns True when the step is already done; such a note is never shown.
    check: Callable[[], bool] | None = None

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "version": self.version,
            "title": self.title,
            "body": self.body,
            "snippet": self.snippet,
            "docs": self.docs,
            "platforms": list(self.platforms),
        }


_NGINX_BACKUPS = """\
location ^~ /api/backups/ {
    proxy_pass http://127.0.0.1:8000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_request_buffering off;
    proxy_read_timeout 600s;
    client_max_body_size 8g;
}
# then: sudo nginx -t && sudo systemctl reload nginx"""

_NGINX_BACKUPS_BUFFER = """\
# in the /api/backups/ block, replace "proxy_request_buffering off;" with:
    proxy_request_buffering on;
    proxy_max_temp_file_size 10240m;
# then: sudo nginx -t && sudo systemctl reload nginx"""

_LOGROTATE = """\
# as root, from the app directory (adjust the user and log dir to yours):
sudo sed -e 's#@@LOG_DIR@@#/var/log/danbyte#g' -e 's#@@USER@@#danbyte#g' \\
    deploy/logrotate/danbyte | sudo tee /etc/logrotate.d/danbyte >/dev/null
# then, as the service user:
systemctl --user restart danbyte-web danbyte-workers danbyte-ws danbyte-fastlane"""

_NGINX_ACME = """\
# in the :80 server, before the redirect:
location /.well-known/acme-challenge/ {
    proxy_pass http://127.0.0.1:8000;
    proxy_set_header Host $host;
}
# then: sudo nginx -t && sudo systemctl reload nginx"""


_NGINX_MEDIA = """\
# in /etc/nginx/sites-available/danbyte.conf, replace the /media/ block:
location /media/ {
    proxy_pass http://127.0.0.1:8000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    access_log off;
}
# then: sudo nginx -t && sudo systemctl reload nginx"""


def _media_proxied() -> bool:
    """True when the site's nginx config already hands /media/ to Danbyte.

    Reads the config if it can; a config it cannot find or read says
    nothing, so the note stays up rather than being hidden on a guess.
    """
    import re
    from pathlib import Path

    for path in (Path("/etc/nginx/sites-enabled/danbyte.conf"),
                 Path("/etc/nginx/sites-available/danbyte.conf")):
        try:
            text = path.read_text()
        except OSError:
            continue
        block = re.search(r"location\s+/media/\s*\{([^}]*)\}", text)
        return bool(block and "proxy_pass" in block.group(1))
    return False


def _backups_buffered() -> bool:
    """True when the site's nginx no longer streams backup uploads through."""
    from pathlib import Path

    for path in (Path("/etc/nginx/sites-enabled/danbyte.conf"),
                 Path("/etc/nginx/sites-available/danbyte.conf")):
        try:
            text = path.read_text()
        except OSError:
            continue
        return "proxy_request_buffering off" not in text
    return False


def _logrotate_installed() -> bool:
    """Done when the config exists, or when nothing writes log files at all."""
    import os
    from pathlib import Path

    if not os.getenv("DANBYTE_LOG_DIR", "").strip():
        return True
    return Path("/etc/logrotate.d/danbyte").exists()


def _tls_unit_installed() -> bool:
    from .site_tls import UNIT_FILE

    return UNIT_FILE.exists()


_NGINX_TEMP_SIZE = """\
# nginx takes k or m for this size, never g:
sudo sed -i 's/proxy_max_temp_file_size 10g;/proxy_max_temp_file_size 10240m;/' \\
    /etc/nginx/sites-available/danbyte.conf
sudo nginx -t && sudo systemctl reload nginx"""

_NGINX_PROTO = """\
# in /etc/nginx/sites-available/danbyte.conf, add to the /media/ and the
# /static/ block (the https server):
    proxy_set_header X-Forwarded-Proto $scheme;
# then: sudo nginx -t && sudo systemctl reload nginx"""


def _site_config() -> str | None:
    """The site's nginx config, or None when it cannot be read."""
    from pathlib import Path

    for path in (Path("/etc/nginx/sites-enabled/danbyte.conf"),
                 Path("/etc/nginx/sites-available/danbyte.conf")):
        try:
            return path.read_text()
        except OSError:
            continue
    return None


def _temp_size_valid() -> bool:
    """Done when no size in the config carries a g suffix nginx refuses."""
    import re

    text = _site_config()
    if text is None:
        return False
    return not re.search(r"proxy_max_temp_file_size\s+\d+[gG]\s*;", text)


def _proxied_blocks_forward_proto() -> bool:
    """Done when every /media/ and /static/ block that proxies to Danbyte
    says which scheme the request came in on."""
    import re

    text = _site_config()
    if text is None:
        return False
    for block in re.findall(r"location\s+/(?:media|static)/\s*\{([^}]*)\}", text):
        if "proxy_pass" in block and "X-Forwarded-Proto" not in block:
            return False
    return True


def _histograms_filled() -> bool:
    """Done once the last four weeks of daily rollups carry a latency
    histogram wherever they have latency at all."""
    from datetime import timedelta

    from django.utils import timezone

    from monitoring.models import CheckRollupDaily

    since = timezone.now() - timedelta(days=28)
    return not CheckRollupDaily.objects.filter(
        bucket__gte=since, lat_p50__isnull=False, lat_hist_n=0
    ).exists()


# Newest first.
NOTES: tuple[UpgradeNote, ...] = (
    UpgradeNote(
        id="0.17.0-latency-histogram",
        version="0.17.0",
        title="Fill in latency histograms for SLA latency objectives",
        body=(
            "Latency objectives count probes answered within a time from a "
            "histogram the rollups now keep. Rows written before the upgrade "
            "have none, so an objective starts empty. Rebuilding the last 29 "
            "days from the raw results, which are kept 30 days, fills them in."
        ),
        snippet="manage.py rollup_checks --backfill 29",
        docs="features/sla/#latency-objectives",
        check=_histograms_filled,
    ),
    UpgradeNote(
        id="0.16.13-nginx-temp-size",
        version="0.16.13",
        title="Fix the backup temp-file size in nginx",
        body=(
            "0.16.12 wrote the backup block's temp-file size as 10g, which "
            "nginx does not accept, so nginx -t failed after the change. The "
            "same size in megabytes works."
        ),
        snippet=_NGINX_TEMP_SIZE,
        docs="getting-started/backup-restore/",
        platforms=("systemd",),
        check=_temp_size_valid,
    ),
    UpgradeNote(
        id="0.16.13-nginx-media-proto",
        version="0.16.13",
        title="Pass the HTTPS scheme on /media/ and /static/",
        body=(
            "A config from make proxy-install sent /media/ to Danbyte without "
            "saying the request came in over HTTPS, so Danbyte redirected it "
            "to itself and no document or image loaded."
        ),
        snippet=_NGINX_PROTO,
        docs="getting-started/upgrading/",
        platforms=("systemd",),
        check=_proxied_blocks_forward_proto,
    ),
    UpgradeNote(
        id="0.16.12-logrotate",
        version="0.16.12",
        title="Install the logrotate config for /var/log/danbyte",
        body=(
            "danbyte.log is written by every web and background process, and "
            "the handler that rotated it was not safe across processes: lines "
            "were lost to rotated files. With the shipped logrotate config the "
            "processes just append, rotation happens outside them, and the "
            "gunicorn access and error logs appear next to danbyte.log."
        ),
        snippet=_LOGROTATE,
        docs="getting-started/upgrading/",
        platforms=("systemd",),
        check=_logrotate_installed,
    ),
    UpgradeNote(
        id="0.16.12-nginx-backups-buffer",
        version="0.16.12",
        title="Let nginx buffer backup uploads and downloads",
        body=(
            "A backup upload streamed to Danbyte at the browser's speed, and "
            "the web worker was stopped after a minute, so any archive that "
            "took longer to upload failed with a 500. nginx now takes the "
            "whole file first. It needs free space for one archive in its "
            "temporary directory."
        ),
        snippet=_NGINX_BACKUPS_BUFFER,
        docs="getting-started/backup-restore/",
        platforms=("systemd",),
        check=_backups_buffered,
    ),
    UpgradeNote(
        id="0.16.12-nginx-media",
        version="0.16.12",
        title="Send /media/ through Danbyte instead of serving it from disk",
        body=(
            "Uploaded documents, image attachments and floor plans are now "
            "served only to users who can view their object. An nginx config "
            "rendered before this release serves the folder straight from disk; "
            "the upgrade already closed the private folders to it, so until you "
            "change the block those files answer 403 rather than leaking - and "
            "images on object pages stay broken."
        ),
        snippet=_NGINX_MEDIA,
        docs="getting-started/upgrading/",
        platforms=("systemd",),
        check=_media_proxied,
    ),
    UpgradeNote(
        id="0.16.0-tls-unit",
        version="0.16.0",
        title="Install the site-certificate apply unit",
        body=(
            "Settings → Updates → Site certificate drops a certificate pair "
            "in a folder Danbyte owns; a root systemd path unit puts it in "
            "front of nginx. Fresh installs get the unit from the installer; "
            "an upgraded host installs it once, as a user with sudo, from the "
            "Danbyte directory."
        ),
        snippet="sudo make install-tls-unit",
        docs="monitoring/certificates/#the-sites-own-certificate",
        platforms=("systemd",),
        check=_tls_unit_installed,
    ),
    UpgradeNote(
        id="0.16.0-nginx-acme",
        version="0.16.0",
        title="Hand ACME challenges to Danbyte in nginx",
        body=(
            "Getting the site's own certificate from Let's Encrypt over HTTP-01 "
            "needs /.well-known/acme-challenge/ proxied to Danbyte on port 80. "
            "The installer's templates carry it; a hand-managed config does not. "
            "Skip this if you will not use HTTP-01."
        ),
        snippet=_NGINX_ACME,
        docs="monitoring/certificates/#the-sites-own-certificate",
        platforms=("systemd",),
    ),
    UpgradeNote(
        id="0.16.0-nginx-backups",
        version="0.16.0",
        title="Add the backup upload location to nginx",
        body=(
            "Backup archives stream through /api/backups/ and can be several "
            "gigabytes. The installer's nginx templates carry the location; a "
            "hand-managed config does not, and uploads over the default body "
            "limit fail. Add this block before the existing /api/ location."
        ),
        snippet=_NGINX_BACKUPS,
        docs="getting-started/backup-restore/#reverse-proxy",
        platforms=("systemd",),
    ),
)


def _done(note: UpgradeNote) -> bool:
    if note.check is None:
        return False
    try:
        return bool(note.check())
    except Exception:  # noqa: BLE001 - a broken check must not hide the note
        return False


def applicable(version: str | None = None, platform: str | None = None) -> list[UpgradeNote]:
    """Notes that apply to this install: not newer than the running
    version, for this platform, and not already satisfied."""
    version = version or system_version()["version"]
    platform = platform or deployment_method()
    return [
        n for n in NOTES
        if not is_newer(n.version, version) and platform in n.platforms and not _done(n)
    ]


def ids_up_to(version: str) -> list[str]:
    """Every note id a fresh install at ``version`` starts with as done."""
    return [n.id for n in NOTES if not is_newer(n.version, version)]


def pending(dep, version: str | None = None, platform: str | None = None) -> list[UpgradeNote]:
    done = set(dep.upgrade_notes_done or [])
    return [n for n in applicable(version, platform) if n.id not in done]


def acknowledge(dep, ids: list[str] | None = None) -> list[str]:
    """Mark notes done; ``None`` means every pending one. Unknown ids are
    ignored. Returns the ids that were added."""
    known = {n.id for n in NOTES}
    wanted = [n.id for n in pending(dep)] if ids is None else [i for i in ids if i in known]
    current = list(dep.upgrade_notes_done or [])
    added = [i for i in wanted if i not in current]
    if added:
        dep.upgrade_notes_done = current + added
        dep.save(update_fields=["upgrade_notes_done", "updated_at"])
    return added


def payload(dep) -> dict:
    return {
        "version": system_version()["version"],
        "deployment": deployment_method(),
        "pending": [n.as_dict() for n in pending(dep)],
        "done": list(dep.upgrade_notes_done or []),
    }
