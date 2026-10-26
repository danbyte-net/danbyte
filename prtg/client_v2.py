"""PRTG API v2: what Danbyte uses to create, change and delete objects.

API v2 is PRTG's newer REST API, served by the application server on its own
port (1616 for HTTPS, 1615 for HTTP) under ``/api/v2``, with the API key as an
``Authorization: Bearer`` header and JSON both ways. Its reference is the
OpenAPI document the server itself serves under ``/api/v2/oas/``.

Every endpoint that creates or deletes is under ``/experimental`` and may
change between PRTG releases. Danbyte uses them only after a capability check
(:func:`capabilities`): PRTG 26.2.120 or later, where sensor creation accepts
every sensor kind, and the experimental schema endpoint answering. What PRTG
26.3.124 does, as recorded against a real server:

* ``POST /experimental/groups/{id}/device`` and ``/experimental/probes/{id}/
  device`` answer 201 with an **empty body** and the new device in
  ``Location`` (``/api/v2/devices/2101``). The device is created active.
* ``POST /experimental/devices/{id}/sensor?kindid=<kind>`` answers the same
  way (``Location: /api/v2/sensors/2102``). The sensor starts active. Right
  after the device was created it answers 404 "could not find parent with
  ID" for a few seconds; that is waited out.
* ``PATCH /devices/{id}`` (stable) takes ``basic`` (name, host, tags) and the
  credential sections ``snmpversiongroup`` and ``windowsconnection`` with
  ``_inherited: false``. Passwords read back as ``*********``; an SNMP
  community reads back in clear, so it is never logged.
* ``PATCH /experimental/sensors/{id}`` takes ``basic`` (name, priority,
  tags) only; the interval section answers 501, so intervals are set
  through the classic API (:meth:`prtg.client.PrtgClient.set_interval`).
* ``POST /objects/{id}/move`` (stable) with ``{"parent": id}`` answers 204.
  The classic API has no move call (``moveobjectnow.htm`` is 404 on 26.3).
* ``DELETE /experimental/devices/{id}`` and ``/experimental/sensors/{id}``
  answer 204, and 404 once the object is gone.
* ``POST /experimental/devices/{id}/metascan?kind=`` answers 201; its result
  is read with ``GET`` on the same path, 202 with ``progress`` until done.

Requests time out at 25 seconds on PRTG's side and bodies are capped at 15 KB,
so one object goes per request. Writes are spaced by :data:`WRITE_GAP` and a
429 or 503 waits for ``Retry-After`` once.

Everything goes through :func:`core.ssrf.safe_request`.
"""
from __future__ import annotations

import json
import re
import time

from core.ssrf import SSRFError, safe_request

from .client import PrtgError, PrtgUnauthorized, PrtgUnreachable

#: Sensor creation accepts every kind from this release on.
MIN_WRITE_VERSION = (26, 2, 120)
#: Rows per page on a list endpoint (PRTG's maximum).
PAGE_LIMIT = 3000
#: PRTG refuses request bodies above 15 KB.
BODY_LIMIT = 15_000
#: Seconds between two writes: the application server shares the core.
WRITE_GAP = 0.25
#: How long a metascan may take before Danbyte gives up on it.
METASCAN_SECONDS = 60


class PrtgNotFound(PrtgError):
    """PRTG has no such object (any more)."""


def version_tuple(text: str) -> tuple[int, ...]:
    out = []
    for part in re.split(r"[.\s+]", str(text or "").strip()):
        if not part.isdigit():
            break
        out.append(int(part))
    return tuple(out)


def id_from_location(location: str) -> str:
    """``/api/v2/devices/2101`` -> ``2101``."""
    m = re.search(r"/(\d+)/?(?:\?.*)?$", location or "")
    if not m:
        raise PrtgError("PRTG did not say which object it created.")
    return m.group(1)


class PrtgV2Client:
    def __init__(self, base: str, api_key: str = "", *, verify_tls: bool = True,
                 timeout: float = 30, write_gap: float = WRITE_GAP,
                 poll_seconds: float = 3, metascan_seconds: float = METASCAN_SECONDS,
                 parent_wait_seconds: float = 30):
        self.base = (base or "").rstrip("/")
        self.api_key = api_key or ""
        self.verify_tls = verify_tls
        self.timeout = timeout
        self.write_gap = write_gap
        self.poll_seconds = poll_seconds
        self.metascan_seconds = metascan_seconds
        self.parent_wait_seconds = parent_wait_seconds
        self._last_write = 0.0

    @classmethod
    def for_connection(cls, conn, **kwargs) -> PrtgV2Client:
        return cls(conn.v2_base, conn.api_key, verify_tls=conn.verify_tls, **kwargs)

    # ── transport ────────────────────────────────────────────────────

    def redact(self, text) -> str:
        text = str(text or "")
        return text.replace(self.api_key, "REDACTED") if self.api_key else text

    def _raw(self, method: str, path: str, *, params=None, body=None):
        headers = {"Accept": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        kwargs: dict = {"params": params or None, "headers": headers,
                        "timeout": self.timeout, "verify": self.verify_tls}
        if body is not None:
            data = json.dumps(body)
            if len(data.encode()) > BODY_LIMIT:
                raise PrtgError("The request is larger than PRTG accepts (15 KB).")
            headers["Content-Type"] = "application/json"
            kwargs["data"] = data
        try:
            return safe_request(method, f"{self.base}{path}", **kwargs)
        except SSRFError as exc:
            raise PrtgUnreachable(self.redact(exc)) from None
        except Exception as exc:  # noqa: BLE001 - every transport failure is one kind
            raise PrtgUnreachable(self.redact(exc) or type(exc).__name__) from None

    def _call(self, method: str, path: str, *, params=None, body=None, ok=(200,)):
        write = method != "GET"
        if write and self.write_gap:
            wait = self._last_write + self.write_gap - time.monotonic()
            if wait > 0:
                time.sleep(wait)
        retried = 0
        while True:
            resp = self._raw(method, path, params=params, body=body)
            if write:
                self._last_write = time.monotonic()
            code = resp.status_code
            # Rate limited, or an object made a moment ago that PRTG has not
            # finished: wait as told, a few times at most.
            if code in (429, 503) or (code == 202 and 202 not in ok):
                if retried >= 3:
                    break
                retried += 1
                hint = resp.headers.get("Retry-After") or resp.headers.get("Wait-For") or "1"
                try:
                    delay = float(re.sub(r"[^\d.]", "", hint) or 1)
                except ValueError:
                    delay = 1.0
                time.sleep(min(max(delay, 0.2), 10))
                continue
            break
        if code in ok:
            return resp
        message = _message(resp)
        if code in (401, 403):
            raise PrtgUnauthorized(f"PRTG refused the API key ({message or code})")
        if code == 404:
            raise PrtgNotFound(message or "PRTG has no such object.")
        raise PrtgError(f"PRTG API v2 answered {code}: {message}"[:400])

    def _json(self, resp):
        try:
            return resp.json()
        except ValueError as exc:
            raise PrtgError("PRTG API v2 answered with something that is not JSON.") from exc

    def get(self, path: str, params=None):
        return self._json(self._call("GET", path, params=params))

    def list_all(self, path: str, params=None) -> list:
        out: list = []
        offset = 0
        while True:
            page = self.get(path, {**(params or {}), "limit": PAGE_LIMIT, "offset": offset})
            if not isinstance(page, list):
                raise PrtgError("PRTG API v2 returned a list in an unexpected shape.")
            out.extend(page)
            if len(page) < PAGE_LIMIT:
                return out
            offset += len(page)

    # ── reads ────────────────────────────────────────────────────────

    def version(self) -> str:
        data = self.get("/version")
        return str((data or {}).get("prtg_version") or "").rstrip("+").strip()

    def probes(self) -> list:
        return self.list_all("/experimental/probes")

    def groups(self) -> list:
        return self.list_all("/experimental/groups")

    def devices(self, filter: str | None = None) -> list:
        return self.list_all("/experimental/devices", {"filter": filter} if filter else None)

    def sensors(self, filter: str | None = None) -> list:
        return self.list_all("/experimental/sensors", {"filter": filter} if filter else None)

    def device(self, objid) -> dict:
        return self.get(f"/devices/{objid}")

    def kinds(self, parent) -> list:
        """What can be created under ``parent``: ``[{kind, name, creatable,
        hints, flags, metascan_field, ...}]``."""
        data = self.get(f"/experimental/schemas/{parent}", {"limit": 0})
        return data if isinstance(data, list) else []

    # ── writes ───────────────────────────────────────────────────────

    def create_device(self, parent_id, name: str, host: str, tags=(), *,
                      parent_kind: str = "group") -> str:
        """A device under a group or probe. Returns its id."""
        where = "probes" if parent_kind == "probe" else "groups"
        resp = self._call(
            "POST", f"/experimental/{where}/{parent_id}/device",
            body={"basic": {"name": name, "host": host, "tags": list(tags)}}, ok=(200, 201),
        )
        return id_from_location(resp.headers.get("Location", ""))

    def update_device(self, objid, sections: dict) -> None:
        """``PATCH /devices/{id}`` with whole settings sections."""
        self._call("PATCH", f"/devices/{objid}", body=sections, ok=(200, 204))

    def move(self, objid, parent_id) -> None:
        self._call("POST", f"/objects/{objid}/move", body={"parent": str(parent_id)},
                   ok=(200, 204))

    def delete_device(self, objid) -> bool:
        """Delete a device and its sensors. False when it was already gone."""
        try:
            self._call("DELETE", f"/experimental/devices/{objid}", ok=(200, 204))
        except PrtgNotFound:
            return False
        return True

    def create_sensor(self, device_id, kind: str, sections: dict) -> str:
        # A device created a moment ago is not yet a parent the sensor
        # endpoint knows (PRTG 26.3: 404 "could not find parent with ID"),
        # so that answer is waited out for a while.
        deadline = time.monotonic() + self.parent_wait_seconds
        while True:
            try:
                resp = self._call(
                    "POST", f"/experimental/devices/{device_id}/sensor",
                    params={"kindid": kind}, body=sections, ok=(200, 201),
                )
                return id_from_location(resp.headers.get("Location", ""))
            except PrtgNotFound as exc:
                if "parent" not in str(exc) or time.monotonic() >= deadline:
                    raise
                time.sleep(self.poll_seconds)

    def update_sensor(self, objid, basic: dict) -> None:
        self._call("PATCH", f"/experimental/sensors/{objid}", body={"basic": basic},
                   ok=(200, 204))

    def delete_sensor(self, objid) -> bool:
        try:
            self._call("DELETE", f"/experimental/sensors/{objid}", ok=(200, 204))
        except PrtgNotFound:
            return False
        return True

    def metascan(self, device_id, kind: str) -> list[dict]:
        """Start a metascan and wait for its table: ``[{column: value}]``.
        Raises :class:`PrtgError` when it fails or does not finish in time."""
        self._call("POST", f"/experimental/devices/{device_id}/metascan",
                   params={"kind": kind}, body={}, ok=(200, 201, 307))
        deadline = time.monotonic() + self.metascan_seconds
        while True:
            resp = self._call("GET", f"/experimental/devices/{device_id}/metascan",
                              params={"kind": kind}, ok=(200, 202))
            if resp.status_code == 200:
                return _table(self._json(resp))
            if time.monotonic() >= deadline:
                raise PrtgError(
                    "PRTG's scan of the device did not finish in time; try again later."
                )
            time.sleep(self.poll_seconds)


def _message(resp) -> str:
    try:
        data = resp.json()
    except ValueError:
        return re.sub(r"<[^>]+>", " ", resp.text or "").strip()[:300]
    if isinstance(data, dict):
        return str(data.get("message") or data.get("code") or "")[:300]
    return ""


def _table(data) -> list[dict]:
    """A metascan result (``{headers: {values: [...]}, rows: [{values}]}``)
    as one dict per row, keyed by the header names."""
    if not isinstance(data, dict):
        return []
    headers = data.get("headers") or {}
    if isinstance(headers, list):
        names = [h.get("name") if isinstance(h, dict) else str(h) for h in headers]
    else:
        names = list(headers.get("values") or [])
    out = []
    for row in data.get("rows") or []:
        values = row.get("values") if isinstance(row, dict) else row
        values = list(values or [])
        keys = names if len(names) >= len(values) else [*names, *range(len(names), len(values))]
        out.append({str(k): v for k, v in zip(keys, values, strict=False)})
    return out


def capabilities(conn, *, client=None) -> dict:
    """Whether this PRTG can create objects through API v2:
    ``{"mode": "v2" | "seed" | "none", "detail", "version"}``.

    v2 when the server is 26.2.120 or later and its experimental schema
    endpoint answers for a probe; otherwise a copy of the connection's seed
    device when one is named; otherwise none."""
    client = client or PrtgV2Client.for_connection(conn)
    floor = ".".join(str(p) for p in MIN_WRITE_VERSION)
    version, reason = conn.version or "", ""
    try:
        version = client.version() or version
        if version_tuple(version) < MIN_WRITE_VERSION:
            reason = f"PRTG {version or '(unknown)'} is older than {floor}."
        else:
            probes = client.probes()
            if not probes:
                reason = "API v2 lists no probe to ask."
            else:
                kinds = client.kinds(probes[0].get("id"))
                if not any(str(k.get("kind", "")).startswith("device") for k in kinds):
                    reason = "API v2 offers no device to create."
    except PrtgUnauthorized as exc:
        reason = str(exc)
    except PrtgError as exc:
        reason = f"API v2 did not answer: {exc}"[:200]
    if not reason:
        return {"mode": "v2", "version": version,
                "detail": f"PRTG {version} creates devices and sensors through API v2."}
    if conn.seed_device_objid:
        return {"mode": "seed", "version": version,
                "detail": f"{reason} New devices are copies of seed device "
                          f"{conn.seed_device_objid}."[:255]}
    return {"mode": "none", "version": version,
            "detail": f"{reason} This PRTG cannot create objects through its API."[:255]}
