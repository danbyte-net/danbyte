"""VMware Cloud Director API client for virtualization sync.

Cloud Director differs from the other two hypervisors in one way that shapes
this module: the **API version is negotiated**, not fixed. An appliance
advertises the versions it speaks at ``/api/versions``, every request carries
the chosen one in its ``Accept`` header, and the payload shape moves between
them. So the client asks first, picks the newest version it has actually been
tested against, and records what it spoke - see
:data:`MIN_API_VERSION` / :data:`TESTED_API_VERSION`.

Two endpoints do the work: ``POST /cloudapi/1.0.0/sessions`` for the bearer
token, and the legacy ``GET /api/query`` for the paginated VM list, which is
the only place a VM's vApp, org and VDC arrive in one response.

Outbound targets obey the deployment SSRF allowlist, same as the other
clients - and see :meth:`VCloudClient.get_href`, which is a guard rather than
a convenience.
"""
from __future__ import annotations

import base64
import logging
import re

import requests

from core.ssrf import SSRFError, assert_public_host

from .virt_client import VirtAPIError

logger = logging.getLogger(__name__)

#: The oldest API Danbyte will speak. ``/cloudapi/1.0.0/sessions`` exists from
#: 33.0 (VCD 10.0), but 36.0 (VCD 10.3) is the oldest line VMware still
#: supports, and every payload below it is untested here.
MIN_API_VERSION = (36, 0)

#: What this release was built and tested against. A newer appliance is fine -
#: it still serves this version - so Danbyte asks for the ceiling and says so
#: rather than refusing.
TESTED_API_VERSION = (38, 1)

#: Per-version behaviour, consulted by the client instead of scattering
#: ``if version >= (37, 0)`` through the connector. Empty today: 36.0-38.1
#: agree on everything this sync reads. It exists so the first real difference
#: is a table entry rather than a rewrite.
QUIRKS: dict[tuple[int, int], dict] = {}

_TIMEOUT = 15
#: A version document is a few kB. Anything larger is not one, and parsing it
#: would just be work done on a hostile body.
_MAX_VERSIONS_BYTES = 256 * 1024

# Read with a regex rather than an XML parser: the document is trivial, and an
# XML parser on an untrusted body is attack surface this does not need.
_VERSION_BLOCK = re.compile(
    r"<(?:\w+:)?VersionInfo\b([^>]*)>(.*?)</(?:\w+:)?VersionInfo>",
    re.S | re.I,
)
_VERSION_NUM = re.compile(
    r"<(?:\w+:)?Version>\s*(\d+(?:\.\d+)?)\s*</(?:\w+:)?Version>", re.I
)


def parse_version(text) -> tuple[int, int] | None:
    """``"38.1"`` → ``(38, 1)``. Anything unparseable is ``None``."""
    if isinstance(text, (list, tuple)):
        return None
    raw = str(text or "").strip()
    if not raw:
        return None
    m = re.match(r"^(\d+)(?:\.(\d+))?$", raw)
    if not m:
        return None
    return int(m.group(1)), int(m.group(2) or 0)


def format_version(version: tuple[int, int] | None) -> str:
    return f"{version[0]}.{version[1]}" if version else ""


def _truthy(value) -> bool:
    """Cloud Director sometimes sends a JSON boolean and sometimes the string.

    ``bool("false")`` is ``True``, which would import every vApp template as a
    running VM. This is the one-line reason that does not happen.
    """
    if isinstance(value, str):
        return value.strip().lower() in ("true", "1", "yes")
    return bool(value)


def _int(value, default=0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def parse_versions(body: str) -> list[tuple[int, int]]:
    """Every non-deprecated version the appliance advertises, ascending.

    Three shapes are accepted because three have been seen in the wild: the
    JSON object with a ``versionInfo`` list, a bare JSON list, and the XML
    document the endpoint returns when it ignores the JSON Accept header.
    Deprecated entries are dropped - an appliance that still answers on 33.0
    is not an invitation to speak it.
    """
    import json

    text = (body or "").strip()
    found: list[tuple[int, int]] = []
    if text.startswith(("{", "[")):
        try:
            data = json.loads(text)
        except ValueError:
            data = None
        entries = None
        if isinstance(data, dict):
            entries = data.get("versionInfo") or data.get("VersionInfo")
        elif isinstance(data, list):
            entries = data
        for entry in entries or []:
            if isinstance(entry, dict):
                if _truthy(entry.get("deprecated")):
                    continue
                v = parse_version(entry.get("version") or entry.get("Version"))
            else:
                v = parse_version(entry)
            if v:
                found.append(v)
    if not found:
        for attrs, block in _VERSION_BLOCK.findall(text):
            if re.search(r'deprecated\s*=\s*"?true', attrs, re.I):
                continue
            m = _VERSION_NUM.search(block)
            v = parse_version(m.group(1)) if m else None
            if v:
                found.append(v)
    if not found:
        # No VersionInfo wrappers at all - take every bare <Version>.
        found = [
            v for v in (parse_version(x) for x in _VERSION_NUM.findall(text)) if v
        ]
    return sorted(set(found))


def choose_version(offered: list[tuple[int, int]]) -> tuple:
    """Pick the version to speak, and say what is worth telling the operator.

    Returns ``(version, note)``. The rule is *the newest offered version that
    is no newer than the one this release was tested against* - so a Cloud
    Director ahead of Danbyte still syncs, on a version both sides know, and
    the note says so rather than the sync failing on an untested payload.
    """
    if not offered:
        return None, (
            "Cloud Director did not advertise any API versions, so Danbyte "
            f"asked for {format_version(TESTED_API_VERSION)}."
        )
    usable = [v for v in offered if MIN_API_VERSION <= v <= TESTED_API_VERSION]
    if usable:
        best = max(usable)
        newest = max(offered)
        if newest > TESTED_API_VERSION:
            return best, (
                f"This Cloud Director offers API {format_version(newest)}; "
                f"Danbyte is tested to {format_version(TESTED_API_VERSION)} "
                f"and will speak {format_version(best)}."
            )
        return best, ""
    newest = max(offered)
    if newest < MIN_API_VERSION:
        raise VirtAPIError(
            f"This Cloud Director's newest API is {format_version(newest)}; "
            f"Danbyte needs {format_version(MIN_API_VERSION)} or later."
        )
    # Everything offered is above the tested ceiling. Speak the lowest of
    # them: it is the closest to what was tested.
    best = min(offered)
    return best, (
        f"This Cloud Director's oldest API is {format_version(best)}, newer "
        f"than the {format_version(TESTED_API_VERSION)} Danbyte is tested "
        f"against. Syncing anyway - report anything that looks wrong."
    )


class VCloudClient:
    """One Cloud Director session, reused across a sync pass.

    ``login()`` negotiates the API version unless the source pins one, then
    exchanges Basic credentials for a bearer token. The token is dropped again
    in :meth:`close`.
    """

    def __init__(self, source):
        self.source = source
        self.base = f"https://{source.host}:{source.port}"
        self.version: tuple[int, int] | None = None
        #: Set by :meth:`login` when the negotiation is worth reporting.
        self.version_note = ""
        self._token: str | None = None
        self._http = requests.Session()
        self._http.verify = source.verify_ssl

    # ── plumbing ────────────────────────────────────────────────────────
    def _guard(self) -> None:
        try:
            assert_public_host(self.source.host, self.source.port)
        except SSRFError as exc:
            raise VirtAPIError(str(exc)) from exc

    def _fail(self, exc) -> VirtAPIError:
        return VirtAPIError(
            f"Cloud Director at {self.source.host}:{self.source.port} "
            f"unreachable: {exc}"
        )

    def _accept(self) -> str:
        return f"application/*+json;version={format_version(self.version)}"

    def quirks(self) -> dict:
        return QUIRKS.get(self.version or (), {})

    # ── version negotiation ─────────────────────────────────────────────
    def versions(self) -> list[tuple[int, int]]:
        """What the appliance says it speaks. Unauthenticated by design."""
        self._guard()
        try:
            r = self._http.get(
                f"{self.base}/api/versions",
                headers={"Accept": "application/*+json"},
                timeout=_TIMEOUT,
                allow_redirects=False,
            )
        except requests.RequestException as exc:
            raise self._fail(exc) from exc
        if not r.ok:
            raise VirtAPIError(
                f"Cloud Director returned {r.status_code} for /api/versions."
            )
        return parse_versions(r.text[:_MAX_VERSIONS_BYTES])

    def _negotiate(self) -> None:
        pinned = parse_version(getattr(self.source, "api_version", ""))
        if pinned:
            self.version = pinned
            if pinned > TESTED_API_VERSION:
                self.version_note = (
                    f"API {format_version(pinned)} is pinned on this source "
                    f"and is newer than the "
                    f"{format_version(TESTED_API_VERSION)} Danbyte is tested "
                    f"against."
                )
            return
        self.version, self.version_note = choose_version(self.versions())
        if self.version is None:
            self.version = TESTED_API_VERSION

    # ── session ─────────────────────────────────────────────────────────
    def login(self) -> VCloudClient:
        self._guard()
        self._negotiate()
        creds = self.source.credentials or {}
        username = creds.get("username", "")
        password = creds.get("password", "")
        basic = base64.b64encode(f"{username}:{password}".encode()).decode()
        try:
            r = self._http.post(
                f"{self.base}/cloudapi/1.0.0/sessions",
                headers={
                    "Authorization": f"Basic {basic}",
                    "Accept": f"application/*;version={format_version(self.version)}",
                },
                timeout=_TIMEOUT,
                allow_redirects=False,
            )
        except requests.RequestException as exc:
            raise self._fail(exc) from exc
        if r.status_code in (401, 403):
            raise VirtAPIError("Cloud Director rejected the credentials (401/403).")
        if not r.ok:
            raise VirtAPIError(f"Cloud Director login returned {r.status_code}.")
        token = r.headers.get("X-VMWARE-VCLOUD-ACCESS-TOKEN")
        if not token:
            raise VirtAPIError(
                "Cloud Director accepted the login but returned no access token."
            )
        self._token = token
        self._http.headers.update(
            {"Authorization": f"Bearer {token}", "Accept": self._accept()}
        )
        logger.info(
            "Cloud Director %s: speaking API %s",
            self.source.host, format_version(self.version),
        )
        return self

    def close(self) -> None:
        if self._token is not None:
            try:
                self._http.delete(
                    f"{self.base}/cloudapi/1.0.0/sessions",
                    timeout=10,
                    allow_redirects=False,
                )
            except requests.RequestException:
                pass  # best-effort logout; the session expires on its own
            finally:
                self._token = None
        self._http.close()

    # ── reads ───────────────────────────────────────────────────────────
    def _get(self, url: str, params=None):
        if self._token is None:
            self.login()
        self._guard()
        try:
            r = self._http.get(
                url, params=params, timeout=30, allow_redirects=False
            )
        except requests.RequestException as exc:
            raise self._fail(exc) from exc
        if r.status_code in (401, 403):
            raise VirtAPIError(
                "Cloud Director session expired or unauthorized (401/403)."
            )
        return r

    def get_href(self, href: str):
        """GET a Cloud Director href, on **this** appliance.

        A record's href is absolute and names whatever address the appliance
        was configured to publish - which is a URL the remote side chooses.
        Following it verbatim is a server-side request forgery primitive, so
        the scheme and host are discarded and only the ``/api/...`` path is
        re-attached to the base Danbyte already validated.
        """
        from urllib.parse import urlsplit

        path = urlsplit(href or "").path
        if not path.startswith("/api/"):
            raise VirtAPIError(
                f"Cloud Director returned an unexpected object link ({href!r})."
            )
        r = self._get(f"{self.base}{path}")
        if not r.ok:
            raise VirtAPIError(
                f"Cloud Director returned {r.status_code} for {path}."
            )
        try:
            return r.json()
        except ValueError as exc:
            raise VirtAPIError(
                "Cloud Director returned non-JSON output."
            ) from exc

    def query(self, type_: str, page_size: int = 128, max_pages: int = 200,
              **params) -> list:
        """Every record of ``type_``, walking Cloud Director's pagination.

        Past the last page some versions answer 400 rather than an empty
        list, so that is treated as the end rather than an error.
        """
        out: list = []
        page = 1
        while page <= max_pages:
            r = self._get(
                f"{self.base}/api/query",
                params={"type": type_, "page": page, "pageSize": page_size,
                        "format": "records", **params},
            )
            if r.status_code == 400 and page > 1:
                break
            if not r.ok:
                raise VirtAPIError(
                    f"Cloud Director {type_} query page {page} returned "
                    f"{r.status_code}."
                )
            try:
                data = r.json()
            except ValueError as exc:
                raise VirtAPIError(
                    "Cloud Director returned non-JSON output."
                ) from exc
            records = data.get("record") or []
            if not records:
                break
            out.extend(records)
            if len(records) < page_size:
                break
            page += 1
        else:
            logger.warning(
                "Cloud Director %s query stopped at %d pages", type_, max_pages
            )
        return out
