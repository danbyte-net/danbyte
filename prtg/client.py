"""The PRTG classic HTTP API, with a probe of API v2.

No SDK, for the reason the Zabbix client gives: every call is a GET with a
header. Reads use ``/api/table.json`` and friends; the simple state writes
(acknowledge, pause, resume, properties, delete, scan now) are the documented
``*.htm`` calls. API v2 is only probed here - whether it answers is recorded
on the connection, and creation through it comes later.

Authentication is an API key. The classic API takes it only as the
``apitoken=`` query parameter - PRTG 26.3 answers a Bearer header there with
401 "Unsupported authorization scheme." - while API v2 takes it only as an
``Authorization: Bearer`` header. Because the classic key rides in the query
string, the client never lets it into an error: anything it raises has the key
redacted.

Everything goes through :func:`core.ssrf.safe_request`, so a tenant-configured
URL is never a way to reach an internal service. A PRTG on RFC1918 - most of
them - is reached by a deployment admin allow-listing it under Settings →
Security → Outbound connections. Redirects are never followed.

PRTG's JSON has quirks, handled here in one place:

* every column comes twice, ``col`` (display) and ``col_raw``; status, times
  and numbers are read from ``_raw``;
* date ``_raw`` values are fractional days since 1899-12-30 (OLE automation
  dates) in UTC;
* some ``_raw`` strings arrive wrapped in an extra pair of double quotes;
* ``lastvalue`` is a formatted string with a unit ("12 %", "1,234 kbit/s");
  the number and unit are parsed out and the string is kept for display;
* some builds emit invalid JSON escapes in messages; parsing is lenient, and a
  row that still cannot be read is skipped and counted, never fatal.
"""
from __future__ import annotations

import html
import json
import re
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from core.ssrf import SSRFError, safe_request

from . import status as st

#: Rows per ``table.json`` page. PRTG allows up to 50000, but a single huge
#: page costs the core server memory it also needs for monitoring.
PAGE_SIZE = 5000
#: Pause between pages: the classic API is served by the same web server as
#: the PRTG interface.
PAGE_GAP_SECONDS = 0.2

SENSOR_COLUMNS = (
    "objid", "name", "device", "host", "probe", "group", "type", "status",
    "message", "lastvalue", "priority", "tags", "lastcheck", "lastup", "lastdown",
    "uptime", "downtime", "interval", "parentid", "active",
)
#: ``content=channels``: the ``info`` column is a JSON document per channel
#: carrying its status, whether it is a percentage, its limits and its lookup
#: table - everything the sensor panel needs in one call per sensor.
CHANNEL_COLUMNS = ("objid", "name", "lastvalue", "info", "minimum", "maximum")
DEVICE_COLUMNS = (
    "objid", "name", "host", "probe", "group", "status", "message", "tags",
    "parentid", "active",
)
#: ``content=groups`` and ``content=probenode``: where a device can live.
GROUP_COLUMNS = ("objid", "name", "probe", "parentid", "type", "active", "tags")
#: PRTG's root group: probes hang off it, devices never do.
ROOT_GROUP = 0

#: ``content=sysinfo&category=system``, in the order rows are read back.
SYSINFO_COLUMNS = (
    "_key", "_value", "_id", "_adapter", "_receivetime", "_displayname",
)

OLE_EPOCH = datetime(1899, 12, 30, tzinfo=UTC)


class PrtgError(RuntimeError):
    """PRTG answered, and the answer was no. Keeps PRTG's own sentence."""


class PrtgUnauthorized(PrtgError):
    """PRTG refused the API key."""


class PrtgUnreachable(PrtgError):
    """PRTG did not answer at all, or the outbound guard refused the URL."""


# ── value parsing ───────────────────────────────────────────────────────────

#: A backslash and what follows it: a valid JSON escape is kept, anything else
#: has its backslash doubled. Matching the valid pair whole is what keeps an
#: escaped backslash followed by a letter intact.
_ESCAPE = re.compile(r'\\(["\\/bfnrt]|u[0-9a-fA-F]{4})?')
_TAG = re.compile(r"<[^>]+>")
_APITOKEN = re.compile(r"(?i)(apitoken=)[^&\s'\"]+")
_NUMBER = re.compile(r"^\s*([<>]?\s*-?[\d.,\s]*\d)\s*(.*?)\s*$")


def loads_lenient(text: str):
    """``json.loads`` that survives PRTG's stray backslashes and raw control
    characters in messages."""
    try:
        return json.loads(text, strict=False)
    except ValueError:
        fixed = _ESCAPE.sub(lambda m: m.group(0) if m.group(1) else "\\\\", text)
        return json.loads(fixed, strict=False)


def _loads_pairs(text: str):
    """:func:`loads_lenient`, keeping every object as its list of pairs -
    the only way to read a JSON object whose keys repeat."""
    hook = {"object_pairs_hook": list}
    try:
        return json.loads(text, strict=False, **hook)
    except ValueError:
        fixed = _ESCAPE.sub(lambda m: m.group(0) if m.group(1) else "\\\\", text)
        return json.loads(fixed, strict=False, **hook)


def unquote_raw(value):
    """Strip the extra quotes some ``_raw`` strings carry."""
    if isinstance(value, str) and len(value) >= 2 and value[0] == value[-1] == '"':
        return value[1:-1]
    return value


def clean_text(value) -> str:
    """A message as an operator should read it: entities decoded, markup gone."""
    if value is None:
        return ""
    # Twice: getsensordetails escapes entities a second time ("&amp;#39;").
    text = html.unescape(html.unescape(str(unquote_raw(value))))
    return re.sub(r" {2,}", " ", _TAG.sub(" ", text)).strip()


def ole_to_datetime(value) -> datetime | None:
    """A PRTG ``_raw`` date (days since 1899-12-30, UTC) as an aware datetime.
    Empty, zero and garbage are None: PRTG writes "" for never."""
    value = unquote_raw(value)
    if value in (None, "", 0, "0"):
        return None
    try:
        days = float(value)
    except (TypeError, ValueError):
        return None
    if days <= 0:
        return None
    # Rounded to the millisecond: the float carries noise below that.
    return OLE_EPOCH + timedelta(milliseconds=round(days * 86_400_000))


def parse_value(display) -> tuple[float | None, str]:
    """``"1,234.5 kbit/s"`` -> ``(1234.5, "kbit/s")``; ``"No data"`` -> ``(None, "")``.

    PRTG formats with the server's locale. A comma followed by exactly three
    digits is read as a thousands separator, any other comma as a decimal
    point - the two forms PRTG writes.
    """
    text = clean_text(display)
    m = _NUMBER.match(text)
    if not m:
        return None, ""
    number = m.group(1).replace(" ", "").lstrip("<>")
    unit = m.group(2)
    if "," in number and "." not in number and not re.search(r",\d{3}(?!\d)", number):
        number = number.replace(",", ".")
    number = number.replace(",", "")
    try:
        return float(number), unit
    except ValueError:
        return None, ""


def parse_percent(display, raw=None) -> float | None:
    value, unit = parse_value(display)
    if value is not None and unit.startswith("%"):
        return value
    try:
        # uptime_raw / downtime_raw are ten-thousandths of a percent.
        return float(unquote_raw(raw)) / 10000 if raw not in (None, "") else None
    except (TypeError, ValueError):
        return None


def _int(value, default=None):
    try:
        return int(float(unquote_raw(value)))
    except (TypeError, ValueError):
        return default


def _raw(row: dict, col: str):
    """The ``_raw`` value of a column, falling back to its display value."""
    if f"{col}_raw" in row:
        return unquote_raw(row[f"{col}_raw"])
    return unquote_raw(row.get(col))


def normalise_row(row: dict) -> dict:
    """One ``table.json`` row as typed values. Unrequested columns stay out."""
    out: dict = {}
    if "objid" in row or "objid_raw" in row:
        objid = _int(_raw(row, "objid"))
        if objid is None:
            raise ValueError("row has no object id")
        out["objid"] = objid
    for col in ("name", "device", "host", "probe", "group"):
        if col in row or f"{col}_raw" in row:
            out[col] = clean_text(_raw(row, col))
    if "type" in row or "type_raw" in row:
        out["type"] = clean_text(row.get("type"))
        out["kind"] = clean_text(_raw(row, "type"))
    if "status" in row or "status_raw" in row:
        code = _int(row.get("status_raw"), st.UNKNOWN)
        out["status_raw"] = code
        out["status"] = clean_text(row.get("status")) or st.label(code)
    if "message" in row or "message_raw" in row:
        out["message"] = clean_text(
            row["message_raw"] if "message_raw" in row else row.get("message")
        )
    if "lastvalue" in row or "lastvalue_raw" in row:
        display = clean_text(row.get("lastvalue"))
        number, unit = parse_value(display)
        raw = row.get("lastvalue_raw")
        try:
            raw_number = float(unquote_raw(raw)) if raw not in (None, "") else None
        except (TypeError, ValueError):
            raw_number = None
        out["last_value"] = display
        out["last_value_raw"] = raw_number if raw_number is not None else number
        out["unit"] = unit
    if "priority" in row or "priority_raw" in row:
        out["priority"] = _int(_raw(row, "priority"))
    if "interval" in row or "interval_raw" in row:
        out["interval_seconds"] = _int(_raw(row, "interval"))
    if "parentid" in row or "parentid_raw" in row:
        out["parent_id"] = _int(_raw(row, "parentid"))
    if "active" in row or "active_raw" in row:
        out["active"] = str(_raw(row, "active")).lower() in ("true", "1", "-1")
    if "tags" in row or "tags_raw" in row:
        # Space-separated for classic sensors, comma-separated for the v2
        # kinds (PRTG 26.3: "icmp,ping,pingsensor").
        out["tags"] = [t for t in re.split(r"[,\s]+", clean_text(_raw(row, "tags"))) if t]
    for col, key in (("lastcheck", "last_check_at"), ("lastup", "last_up_at"),
                     ("lastdown", "last_down_at")):
        if col in row or f"{col}_raw" in row:
            out[key] = ole_to_datetime(row.get(f"{col}_raw"))
    for col, key in (("uptime", "uptime_pct"), ("downtime", "downtime_pct")):
        if col in row or f"{col}_raw" in row:
            out[key] = parse_percent(row.get(col), row.get(f"{col}_raw"))
    return out


_CLOCK_FORMATS = (
    "%m/%d/%Y %I:%M:%S %p", "%d.%m.%Y %H:%M:%S", "%Y-%m-%d %H:%M:%S",
    "%d/%m/%Y %H:%M:%S", "%m/%d/%Y %H:%M:%S", "%d-%m-%Y %H:%M:%S",
)


def parse_clock(value) -> datetime | None:
    """``getstatus``'s ``Clock`` ("10/26/2026 12:08:06 AM", in the user's
    date format) as a naive datetime, or None."""
    text = clean_text(value)
    for fmt in _CLOCK_FORMATS:
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


@dataclass
class Table:
    version: str = ""
    total: int = 0
    rows: list = field(default_factory=list)
    #: Rows that could not be read, and were left out.
    skipped: int = 0
    pages: int = 0


def _clean_version(value) -> str:
    return str(value or "").strip().rstrip("+").strip()


def _error_sentence(body: str) -> str:
    """PRTG's own words from an XML or HTML error body."""
    text = (body or "").strip()
    if text.startswith("<?xml") or text.startswith("<prtg"):
        try:
            node = ET.fromstring(text).find("error")
            if node is not None and node.text:
                return node.text.strip()
        except ET.ParseError:
            pass
    m = re.search(r'<div class="errormsg">(.*?)</div>', text, re.S | re.I)
    if m:
        text = m.group(1)
    return clean_text(text)[:300]


# ── the client ──────────────────────────────────────────────────────────────


class PrtgClient:
    def __init__(
        self,
        url: str,
        api_key: str = "",
        *,
        v2_url: str = "",
        verify_tls: bool = True,
        timeout: float = 20,
        page_size: int = PAGE_SIZE,
        page_gap: float = PAGE_GAP_SECONDS,
    ):
        self.base = (url or "").rstrip("/")
        self.v2_base = (v2_url or "").rstrip("/")
        self.api_key = api_key or ""
        self.verify_tls = verify_tls
        self.timeout = timeout
        self.page_size = max(1, min(int(page_size), 50000))
        self.page_gap = page_gap

    @classmethod
    def for_connection(cls, conn, **kwargs) -> PrtgClient:
        return cls(
            conn.url, conn.api_key, v2_url=conn.v2_base,
            verify_tls=conn.verify_tls, **kwargs,
        )

    # ── transport ────────────────────────────────────────────────────

    def _auth(self, params: dict, *, v2: bool) -> dict:
        """The key where each API wants it: a query parameter for the classic
        API, a Bearer header for API v2. Never both."""
        headers = {"Accept": "application/json, text/xml;q=0.9, */*;q=0.5"}
        if self.api_key:
            if v2:
                headers["Authorization"] = f"Bearer {self.api_key}"
            else:
                params["apitoken"] = self.api_key
        return headers

    def redact(self, text) -> str:
        """``text`` with the API key replaced. Transport errors quote the URL,
        and the classic key is in its query string."""
        text = str(text or "")
        if self.api_key:
            text = text.replace(self.api_key, "REDACTED")
        return _APITOKEN.sub(r"\1REDACTED", text)

    def _request(self, path: str, params: dict | None = None, *,
                 base: str | None = None, v2: bool = False):
        params = {k: v for k, v in (params or {}).items() if v is not None}
        headers = self._auth(params, v2=v2)
        url = f"{base if base is not None else self.base}{path}"
        try:
            return safe_request(
                "GET", url, params=params, headers=headers,
                timeout=self.timeout, verify=self.verify_tls,
            )
        # ``from None``: the original exception's text carries the URL, and
        # with it the key - a chained traceback would log it.
        except SSRFError as exc:
            raise PrtgUnreachable(self.redact(exc)) from None
        except Exception as exc:  # noqa: BLE001 - every transport failure is one kind
            raise PrtgUnreachable(self.redact(exc) or type(exc).__name__) from None

    def _check(self, resp, *, write: bool = False):
        code = resp.status_code
        if code in (401, 403):
            raise PrtgUnauthorized(
                f"PRTG refused the API key ({_error_sentence(resp.text) or code})"
            )
        if code in (301, 302, 303, 307, 308):
            location = resp.headers.get("Location", "")
            # A refused key on an .htm call redirects to the login page.
            if "login" in location.lower() or "/index.htm" in location.lower():
                raise PrtgUnauthorized("PRTG refused the API key (redirected to sign-in)")
            if "error" in location.lower():
                raise PrtgError(f"PRTG refused the call ({self.redact(location[:200])})")
            if write:
                return resp
            raise PrtgError(f"PRTG answered with a redirect to {self.redact(location[:200])}")
        if code != 200:
            raise PrtgError(f"HTTP {code}: {_error_sentence(resp.text)}")
        return resp

    def get_json(self, path: str, params: dict | None = None, *, base: str | None = None):
        resp = self._check(self._request(path, params, base=base))
        try:
            return loads_lenient(resp.text)
        except ValueError as exc:
            raise PrtgError(
                "The URL did not return PRTG JSON - check it points at the "
                "PRTG web interface."
            ) from exc

    def _write(self, path: str, params: dict) -> str:
        resp = self._check(self._request(path, params), write=True)
        return resp.text or ""

    # ── reads ────────────────────────────────────────────────────────

    def table(self, content: str, columns=SENSOR_COLUMNS, filters: dict | None = None,
              id: int | None = None, *, limit: int | None = None) -> Table:
        """Every row of ``content``, paged with ``start``/``count`` until a
        short page. ``filters`` are ``filter_<name>`` values (a list repeats
        the filter, which PRTG ORs)."""
        out = Table()
        start = 0
        while True:
            count = self.page_size if limit is None else min(self.page_size, limit - start)
            if count <= 0:
                break
            params: dict = {
                "content": content,
                "columns": ",".join(columns),
                "start": start,
                "count": count,
                "id": id,
            }
            for name, value in (filters or {}).items():
                params[f"filter_{name}"] = value
            if out.pages and self.page_gap:
                time.sleep(self.page_gap)
            payload = self.get_json("/api/table.json", params)
            if not isinstance(payload, dict):
                raise PrtgError("PRTG returned a table in an unexpected shape.")
            out.pages += 1
            out.version = _clean_version(payload.get("prtg-version")) or out.version
            out.total = _int(payload.get("treesize"), 0) or 0
            rows = payload.get(content)
            if rows is None:
                rows = next(
                    (v for k, v in payload.items() if isinstance(v, list)), []
                )
            for row in rows:
                try:
                    out.rows.append(normalise_row(row))
                except (ValueError, TypeError, AttributeError):
                    out.skipped += 1
            start += len(rows)
            if len(rows) < count or (out.total and start >= out.total):
                break
        return out

    def sensors(self, filters: dict | None = None, columns=SENSOR_COLUMNS) -> Table:
        return self.table("sensors", columns, filters)

    def devices(self, filters: dict | None = None, columns=DEVICE_COLUMNS) -> Table:
        return self.table("devices", columns, filters)

    def count(self, content: str, filters: dict | None = None) -> int:
        """How many objects of a kind PRTG has: one row asked for, the total
        read from ``treesize``."""
        table = self.table(content, ("objid",), filters, limit=1)
        return table.total or len(table.rows)

    def status(self) -> dict:
        """``getstatus.htm``: version, alarm counts, cluster and licence state.

        JSON despite the name; PRTG 26.3 has no ``getstatus.json`` (404)."""
        payload = self.get_json("/api/getstatus.htm", {"id": 0})
        if not isinstance(payload, dict):
            raise PrtgError("PRTG returned its status in an unexpected shape.")
        return payload

    def version(self) -> str:
        return _clean_version(self.status().get("Version"))

    def groups_tree(self) -> list[dict]:
        """Every probe and group a device could be put under, as
        ``{objid, name, kind, path, probe, parent_id, tags}``, in path order.

        Two calls: probes (``content=probenode`` filtered to probes - the
        unfiltered content lists other objects too) and groups. The root
        group is left out; devices never live directly under it.
        """
        probes = self.table("probenode", GROUP_COLUMNS, {"type": "probenode"}).rows
        groups = self.table("groups", GROUP_COLUMNS).rows
        nodes: dict[int, dict] = {}
        for kind, rows in (("probe", probes), ("group", groups)):
            for row in rows:
                if row["objid"] == ROOT_GROUP:
                    continue
                nodes[row["objid"]] = {
                    "objid": str(row["objid"]), "name": row.get("name", ""),
                    "kind": kind, "probe": row.get("probe", "") or row.get("name", ""),
                    "parent_id": row.get("parent_id"),
                    "tags": list(row.get("tags") or []),
                }

        def path(objid, seen=()) -> str:
            node = nodes.get(objid)
            if node is None or objid in seen or len(seen) > 32:
                return ""
            parent = path(node["parent_id"], (*seen, objid))
            return f"{parent} / {node['name']}" if parent else node["name"]

        out = [{**n, "path": path(objid)} for objid, n in nodes.items()]
        for n in out:
            n["parent_id"] = str(n["parent_id"]) if n["parent_id"] is not None else ""
        return sorted(out, key=lambda n: n["path"].lower())

    def sensor_details(self, objid: int) -> dict:
        """``getsensordetails.json``: one sensor's summary, as PRTG words it."""
        payload = self.get_json("/api/getsensordetails.json", {"id": int(objid)})
        data = (payload or {}).get("sensordata") if isinstance(payload, dict) else None
        if not isinstance(data, dict) or not data:
            raise PrtgError(f"PRTG has no sensor {objid}.")
        out = {k: clean_text(v) for k, v in data.items()}
        out["status_raw"] = _int(data.get("statusid"), st.UNKNOWN)
        return out

    def channels(self, objid: int) -> list[dict]:
        """``table.json?content=channels&id=<sensor>``: the sensor's channels
        as PRTG returns them (mapped by :mod:`prtg.channels`). A sensor has
        tens of channels at most, so one page."""
        payload = self.get_json("/api/table.json", {
            "content": "channels", "id": int(objid),
            "columns": ",".join(CHANNEL_COLUMNS), "count": 500,
        })
        rows = payload.get("channels") if isinstance(payload, dict) else None
        if not isinstance(rows, list):
            raise PrtgError("PRTG returned channels in an unexpected shape.")
        return rows

    def historic(self, objid: int, start, end, avg: int) -> list[dict]:
        """``historicdata.xml``: averaged history of every channel of a
        sensor between ``start`` and ``end`` (naive datetimes in the PRTG
        server's local time, as the API wants them), one row per ``avg``
        seconds.

        The XML form, not ``historicdata.json``: the JSON repeats one
        ``value`` key per channel without saying which channel it is (or,
        with ``usecaption``, drops the raw timestamp), while the XML names
        each value's channel id and carries the UTC timestamp.

        Returns ``[{"end": aware UTC datetime, "values": {channel id:
        {"name", "display", "raw"}}}]``; an empty value is ``raw: None``.
        """
        fmt = "%Y-%m-%d-%H-%M-%S"
        resp = self._check(self._request("/api/historicdata.xml", {
            "id": int(objid), "avg": int(avg),
            "sdate": start.strftime(fmt), "edate": end.strftime(fmt),
        }))
        try:
            root = ET.fromstring(resp.text.strip())
        except ET.ParseError as exc:
            raise PrtgError("PRTG returned history in an unexpected shape.") from exc
        if root.tag == "prtg" and root.find("error") is not None:
            raise PrtgError(_error_sentence(resp.text))
        out = []
        for item in root.iter("item"):
            end_at = ole_to_datetime((item.findtext("datetime_raw") or "").strip())
            if end_at is None:
                continue
            values: dict = {}
            for node in item.findall("value"):
                cid = node.get("channelid")
                if cid is None:
                    continue
                values[cid] = {"name": clean_text(node.get("channel")),
                               "display": clean_text(node.text), "raw": None}
            for node in item.findall("value_raw"):
                cid = node.get("channelid")
                if cid not in values:
                    continue
                try:
                    values[cid]["raw"] = float((node.text or "").strip())
                except ValueError:
                    values[cid]["raw"] = None
            out.append({"end": end_at, "values": values})
        return out

    def server_clock(self) -> datetime | None:
        """The PRTG server's clock in the API user's time zone, naive, from
        ``getstatus.htm`` - what ``historicdata`` windows are written in.
        None when the format is not one PRTG uses."""
        return parse_clock(self.status().get("Clock"))

    def sysinfo(self, objid: int, category: str = "system") -> list[dict]:
        """``table.json?content=sysinfo``: the system information PRTG holds
        for a device - ``[{"key", "value", "id", "adapter", "displayname",
        "receivetime"}]``, empty when PRTG has none (PRTG reads it over WMI or
        SNMP, about once a day, and only where it can).

        PRTG 26.3 names every ``_``-prefixed sysinfo column ``""`` in its
        JSON - each row is the same empty key repeated, display then
        ``_raw`` per column - so the row is read by position, in the order
        the columns were asked for.
        """
        resp = self._check(self._request("/api/table.json", {
            "content": "sysinfo", "id": int(objid), "category": category,
            "columns": ",".join(SYSINFO_COLUMNS),
        }))
        try:
            payload = _loads_pairs(resp.text)
        except ValueError as exc:
            raise PrtgError("PRTG returned system information in an unexpected shape.") from exc
        rows = dict(payload).get("sysinfo") if isinstance(payload, list) else None
        if not isinstance(rows, list):
            raise PrtgError("PRTG returned system information in an unexpected shape.")
        names = [c.lstrip("_") for c in SYSINFO_COLUMNS]
        out = []
        for row in rows:
            if not isinstance(row, list):
                continue
            named = {k.lstrip("_").removesuffix("_raw"): v for k, v in row if k.strip("_")}
            if named and set(names) & set(named):
                values = [named.get(n) for n in names]
            else:
                # Display then raw, per column: the raw value is the second.
                values = [v for i, (_k, v) in enumerate(row) if i % 2 == 1]
            # A short row leaves the missing columns blank.
            values = (values + [None] * len(names))[: len(names)]
            entry = {
                n: clean_text(v) if v is not None else ""
                for n, v in zip(names, values, strict=True)
            }
            if entry.get("key"):
                out.append(entry)
        return out

    def get_property(self, objid: int, name: str) -> str:
        """``getobjectproperty.htm`` - one property's value, as text."""
        resp = self._check(self._request(
            "/api/getobjectproperty.htm", {"id": int(objid), "name": name, "show": "nohtmlencode"}
        ))
        try:
            node = ET.fromstring(resp.text.strip()).find("result")
        except ET.ParseError as exc:
            raise PrtgError("PRTG returned a property in an unexpected shape.") from exc
        if node is None:
            raise PrtgError(f"PRTG has no property {name} on {objid}.")
        value = node.text or ""
        if value == "(Property not found)":
            raise PrtgError(f"PRTG has no property {name} on {objid}.")
        return value

    # ── writes ───────────────────────────────────────────────────────

    def acknowledge(self, objid: int, message: str = "") -> None:
        """Acknowledge a sensor in a Down state. PRTG has no un-acknowledge."""
        self._write("/api/acknowledgealarm.htm", {"id": int(objid), "ackmsg": message})

    def pause(self, objid: int, message: str = "", minutes: int | None = None) -> None:
        """Pause an object, indefinitely or for ``minutes``."""
        if minutes:
            self._write("/api/pauseobjectfor.htm", {
                "id": int(objid), "pausemsg": message, "duration": int(minutes),
            })
        else:
            self._write("/api/pause.htm", {
                "id": int(objid), "pausemsg": message, "action": 0,
            })

    def resume(self, objid: int) -> None:
        self._write("/api/pause.htm", {"id": int(objid), "action": 1})

    def set_property(self, objid: int, name: str, value) -> None:
        self._write("/api/setobjectproperty.htm", {
            "id": int(objid), "name": name, "value": value,
        })

    def delete(self, objid: int) -> None:
        self._write("/api/deleteobject.htm", {"id": int(objid), "approve": 1})

    def scan_now(self, objid: int) -> None:
        self._write("/api/scannow.htm", {"id": int(objid)})

    def duplicate(self, objid: int, name: str, target_id: int, host: str | None = None) -> str:
        """``duplicateobject.htm``: copy a device or sensor under
        ``target_id``. The copy arrives **paused**; its id is read from the
        redirect's ``Location`` (``/device.htm?id=2107``), which only works
        because the outbound guard never follows redirects. Returns the id."""
        params = {"id": int(objid), "name": name, "targetid": int(target_id)}
        if host:
            params["host"] = host
        resp = self._check(self._request("/api/duplicateobject.htm", params), write=True)
        m = re.search(r"[?&]id=(\d+)", resp.headers.get("Location", ""))
        if not m:
            raise PrtgError("PRTG did not say which object the copy is.")
        return m.group(1)

    def discover_now(self, objid: int, templates=()) -> None:
        """``discovernow.htm``: run auto-discovery on a device, with the
        named device templates (file names, e.g. ``Device Generic Ping.odt``)."""
        params: dict = {"id": int(objid)}
        if templates:
            params["template"] = ",".join(f'"{t}"' for t in templates)
        self._write("/api/discovernow.htm", params)

    def set_interval(self, objid: int, seconds: int) -> None:
        """A sensor's scanning interval, with inheritance switched off.

        API v2 refuses the interval section on create and on PATCH (PRTG
        26.3: "section intervalgroup is not yet supported"), so it is the
        classic properties: ``interval`` and the inheritance switch, whose
        classic name is ``intervalgroup_`` (``intervalgroup`` is accepted
        and does nothing)."""
        self.set_property(objid, "interval", int(seconds))
        self.set_property(objid, "intervalgroup_", 0)

    # ── API v2 ───────────────────────────────────────────────────────

    def probe_v2(self) -> tuple[bool, str]:
        """Whether API v2 answers at ``v2_base``, and what it said.

        A refused key still counts as answering: v2 is there, the key is the
        problem, and that is worth saying separately.
        """
        if not self.v2_base:
            return False, "No API v2 address."
        try:
            resp = self._request(
                "/experimental/sensors", {"limit": 1}, base=self.v2_base, v2=True
            )
        except PrtgUnreachable as exc:
            return False, f"API v2 did not answer: {exc}"
        if resp.status_code == 200:
            return True, "API v2 answers."
        if resp.status_code in (401, 403):
            return True, "API v2 answers but refused the API key."
        return False, f"API v2 answered HTTP {resp.status_code}."
