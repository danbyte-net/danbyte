"""The HTTP client a script uses to read and write Danbyte data.

Standard library only (``urllib``), so a sandboxed run needs nothing
installed. Every call carries the run token, which is minted as the run-as
user with the script's scope and dies with the run - so tenant scoping,
RBAC and the audit trail are the API's, not a second implementation here.
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

DEFAULT_TIMEOUT = 60
MAX_PAGE = 1000


class ApiError(RuntimeError):
    """A non-2xx answer. ``status`` and ``detail`` say what went wrong."""

    def __init__(self, status: int, detail: Any, url: str = ""):
        self.status = status
        self.detail = detail
        self.url = url
        super().__init__(f"HTTP {status} from {url}: {detail}")


def _endpoint(kind: str) -> str:
    """``"devices"`` and ``"device"`` both reach ``/api/devices/``."""
    kind = str(kind).strip().strip("/")
    if not kind:
        raise ValueError("Pass an object type, e.g. 'devices'.")
    return kind if kind.endswith("s") else kind + "s"


class Client:
    """Reads ``DANBYTE_URL`` and ``DANBYTE_TOKEN`` from the environment.
    Construct your own only to reach a second install."""

    def __init__(self, url: str = "", token: str = "", *, timeout: int = DEFAULT_TIMEOUT,
                 retries: int = 2):
        self.url = (url or os.environ.get("DANBYTE_URL", "")).rstrip("/")
        self.token = token or os.environ.get("DANBYTE_TOKEN", "")
        self.timeout = timeout
        self.retries = retries

    # ─── plumbing ───────────────────────────────────────────────────────

    def request(self, method: str, path: str, *, params: dict | None = None,
                data: Any = None) -> Any:
        if not self.url:
            raise ApiError(0, "No Danbyte URL - DANBYTE_URL is not set.")
        path = path if path.startswith("/") else f"/api/{path}"
        if params:
            clean = {k: v for k, v in params.items() if v is not None}
            if clean:
                path += ("&" if "?" in path else "?") + urllib.parse.urlencode(clean, doseq=True)
        body = None if data is None else json.dumps(data).encode()
        req = urllib.request.Request(self.url + path, method=method.upper(), data=body)
        req.add_header("Accept", "application/json")
        if body is not None:
            req.add_header("Content-Type", "application/json")
        if self.token:
            req.add_header("Authorization", f"Token {self.token}")

        last: Exception | None = None
        for attempt in range(self.retries + 1):
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                    raw = resp.read()
                    if not raw:
                        return None
                    return json.loads(raw)
            except urllib.error.HTTPError as exc:
                raw = exc.read()
                try:
                    detail = json.loads(raw)
                except ValueError:
                    detail = raw[:500].decode(errors="replace")
                # 4xx is the caller's problem; only retry server/transport errors.
                if exc.code < 500 or attempt == self.retries:
                    raise ApiError(exc.code, detail, path) from None
                last = exc
            except urllib.error.URLError as exc:
                if attempt == self.retries:
                    raise ApiError(0, f"could not reach Danbyte: {exc.reason}", path) from None
                last = exc
            time.sleep(0.5 * (attempt + 1))
        raise ApiError(0, str(last), path)

    # ─── CRUD ───────────────────────────────────────────────────────────

    def list(self, kind: str, *, limit: int | None = None, **filters) -> list[dict]:
        """Every matching object, following pagination. Filters are the same
        query parameters the UI uses: ``db.list("devices", site="aarhus")``."""
        out: list[dict] = []
        params = {**filters, "limit": min(limit or MAX_PAGE, MAX_PAGE)}
        path = _endpoint(kind) + "/"
        while True:
            page = self.request("GET", path, params=params)
            params = None  # the `next` link carries them
            if isinstance(page, list):
                out.extend(page)
                break
            out.extend(page.get("results") or [])
            nxt = page.get("next")
            if not nxt or (limit and len(out) >= limit):
                break
            path = nxt[len(self.url):] if nxt.startswith(self.url) else nxt
        return out[:limit] if limit else out

    def get(self, kind: str, id_: str) -> dict:
        return self.request("GET", f"{_endpoint(kind)}/{id_}/")

    def create(self, kind: str, data: dict) -> dict:
        return self.request("POST", f"{_endpoint(kind)}/", data=data)

    def update(self, kind: str, id_: str, data: dict) -> dict:
        return self.request("PATCH", f"{_endpoint(kind)}/{id_}/", data=data)

    def delete(self, kind: str, id_: str) -> None:
        self.request("DELETE", f"{_endpoint(kind)}/{id_}/")

    def search(self, q: str, *, kind: str = "", limit: int = 50) -> list[dict]:
        """The global search, same ranking as the palette."""
        page = self.request("GET", "search/", params={"q": q, "type": kind or None, "limit": limit})
        return (page or {}).get("results") or []


db = Client()
