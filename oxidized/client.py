"""The oxidized-web REST API, as plain GETs.

The routes are oxidized-web's ``lib/oxidized/web/webapp.rb``:

* ``GET /nodes.json`` - every node: ``name``, ``full_name`` (``group/name``
  when the node has a group), ``ip``, ``group`` (``"default"`` when it has
  none), ``model``, ``status``, ``time``, ``last``.
* ``GET /node/fetch/<group>/<name>`` - the current configuration as text.
  The group segment is optional. An unknown node answers 200 with
  ``unable to find '<name>'``; the git output answers ``node not found``.
* ``GET /node/version.json?node_full=<group/name>`` - the git history, newest
  first: ``[{oid, date, time, author: {name, email, time}, message}]``. A node
  the git output does not know answers ``["node not found"]``; an output with
  no history (the file output) errors.
* ``GET /node/version/view?node=&group=&oid=&epoch=&num=&format=text`` - one
  version's text. Without ``format=text`` the body is HTML-escaped for the
  web page; with it, it is the raw blob. ``version not found`` when the oid
  is not in the history.
* ``PUT /node/next/<group>/<name>.json`` - move the node to the head of the
  queue, so it is backed up next. The JSON body may carry ``user``/``msg``,
  which the git output writes into the commit.

``/node/version/diffs`` exists too, but only diffs a version against its
parent or one other oid and wraps the patch for its own page, so Danbyte diffs
two version texts itself.

Outbound goes through :class:`core.ssrf.SafeSession`: a tenant-configured URL
is never a way to reach an internal service, and an Oxidized on RFC1918 is
reached by a deployment admin allow-listing it.
"""
from __future__ import annotations

import json
from urllib.parse import quote, urlencode

from core.ssrf import SafeSession, SSRFError

#: The most a single response may carry. Network configs are kilobytes, a
#: large chassis a few megabytes; past this something is wrong, and holding
#: it in a worker's memory would be the problem.
MAX_BYTES = 10 * 1024 * 1024

#: Bodies Oxidized answers with 200 when there is no such node or version.
NOT_FOUND = ("node not found", "version not found")


class OxidizedError(RuntimeError):
    """The server answered, and the answer was no."""


class OxidizedUnreachable(OxidizedError):
    """The server did not answer at all, or the SSRF guard refused it."""


class OxidizedNotFound(OxidizedError):
    """Oxidized does not know that node or version."""


class OxidizedTooLarge(OxidizedError):
    """The response is larger than :data:`MAX_BYTES`."""


def _seg(value: str) -> str:
    return quote(value or "", safe="")


def _group_path(group: str) -> str:
    # A group may itself contain "/", and oxidized-web matches it with a splat.
    return "/".join(_seg(part) for part in (group or "").split("/") if part)


class OxidizedClient:
    def __init__(self, url: str, auth=None, *, verify_tls=True, timeout=20):
        self.base = (url or "").rstrip("/")
        self.auth = auth
        self.verify_tls = verify_tls
        self.timeout = timeout

    @classmethod
    def for_connection(cls, conn) -> OxidizedClient:
        return cls(conn.url, conn.auth, verify_tls=conn.verify_tls)

    # ── transport ────────────────────────────────────────────────────

    def _request(self, method: str, path: str, *, body=None) -> bytes:
        url = f"{self.base}{path}"
        headers = {"Accept": "application/json, text/plain;q=0.9"}
        data = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body)
        try:
            with SafeSession() as sess:
                resp = sess.request(
                    method, url, headers=headers, data=data, auth=self.auth,
                    timeout=self.timeout, verify=self.verify_tls, stream=True,
                )
                try:
                    status = resp.status_code
                    chunks, size = [], 0
                    for chunk in resp.iter_content(64 * 1024):
                        size += len(chunk)
                        if size > MAX_BYTES:
                            raise OxidizedTooLarge(
                                f"The response is larger than "
                                f"{MAX_BYTES // (1024 * 1024)} MB."
                            )
                        chunks.append(chunk)
                finally:
                    resp.close()
        except OxidizedError:
            raise
        except SSRFError as exc:
            raise OxidizedUnreachable(str(exc)) from exc
        except Exception as exc:  # noqa: BLE001 - any transport failure
            raise OxidizedUnreachable(str(exc)) from exc
        raw = b"".join(chunks)
        if status in (401, 403):
            raise OxidizedError(f"HTTP {status}: Oxidized refused the credentials.")
        if status == 404:
            raise OxidizedNotFound("Oxidized has no such node.")
        if 300 <= status < 400:
            raise OxidizedError(
                f"HTTP {status}: redirects are not followed - check the URL."
            )
        if status != 200:
            raise OxidizedError(f"HTTP {status}: {raw[:200].decode('utf-8', 'replace')}")
        return raw

    def _json(self, path: str):
        raw = self._request("GET", path)
        try:
            return json.loads(raw)
        except ValueError as exc:
            raise OxidizedError(
                "The URL did not return JSON - check it points at oxidized-web."
            ) from exc

    @staticmethod
    def _text(raw: bytes) -> str:
        return raw.decode("utf-8", "replace")

    # ── API ──────────────────────────────────────────────────────────

    def nodes(self) -> list[dict]:
        data = self._json("/nodes.json")
        if not isinstance(data, list):
            raise OxidizedError("/nodes.json did not return a list.")
        return [n for n in data if isinstance(n, dict)]

    def fetch(self, name: str, group: str = "") -> str:
        prefix = _group_path(group)
        path = f"/node/fetch/{prefix + '/' if prefix else ''}{_seg(name)}"
        text = self._text(self._request("GET", path))
        if text.strip() in NOT_FOUND or text.strip() == f"unable to find '{name}'":
            raise OxidizedNotFound(text.strip())
        return text

    def versions(self, name: str, group: str = "") -> list[dict]:
        full = f"{group}/{name}" if group else name
        data = self._json(f"/node/version.json?{urlencode({'node_full': full})}")
        if not isinstance(data, list):
            raise OxidizedError("/node/version.json did not return a list.")
        # ["node not found"] is the git output not knowing the node: no
        # history, not an error worth a red banner.
        return [v for v in data if isinstance(v, dict) and v.get("oid")]

    def version(self, name: str, group: str, oid: str) -> str:
        query = urlencode({
            "node": name, "group": group or "", "oid": oid,
            "epoch": 0, "num": 0, "format": "text",
        })
        text = self._text(self._request("GET", f"/node/version/view?{query}"))
        if text.strip() in NOT_FOUND:
            raise OxidizedNotFound(text.strip())
        return text

    def next(self, name: str, group: str = "", *, user: str = "", msg: str = "") -> None:
        prefix = _group_path(group)
        path = f"/node/next/{prefix + '/' if prefix else ''}{_seg(name)}.json"
        self._request("PUT", path, body={"user": user, "msg": msg})
