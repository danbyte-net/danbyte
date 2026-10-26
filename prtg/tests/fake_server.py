"""A small PRTG in this process, for tests.

It answers the classic endpoints the client uses - ``table.json`` (sensors,
devices, probes and a sensor's channels), ``getstatus.htm``,
``getsensordetails.json``, ``historicdata.xml``, ``getobjectproperty.htm``,
the simple writes, ``duplicateobject.htm`` and ``discovernow.htm`` - and the
API v2 routes Danbyte writes through (``/version``, probes, schemas, device
and sensor create, patch, move, delete, metascan), from fixtures in
``fixtures/`` shaped like PRTG 26.x responses (``v2_*.json`` were recorded
from PRTG 26.3.124: a create answers 201 with an empty body and the new id in
``Location``; the interval section is refused with 501). Tests reach it over real HTTP on 127.0.0.1,
so the client, the outbound guard (with 127.0.0.1 allow-listed), headers and
query strings are exercised end to end rather than mocked.

The fixtures can be replaced by recordings from a real PRTG:
:func:`record_fixture` saves a live response with the API key and other
secrets stripped, under the same names :func:`load_fixture` reads.
"""
from __future__ import annotations

import copy
import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from prtg import status as st
from prtg.client import loads_lenient

FIXTURES = Path(__file__).resolve().parent / "fixtures"
VERSION = "26.3.124.1727"


def load_fixture(name: str, *, raw: bool = False):
    """A fixture by file name: parsed leniently, or the text as recorded."""
    text = (FIXTURES / name).read_text(encoding="utf-8")
    return text if raw else loads_lenient(text)


# ── recording ───────────────────────────────────────────────────────────────

_SECRET_KEYS = (
    r"password|passhash|apitoken|api_key|apikey|secret|community|authkey|privkey"
    r"|snmpcomm|snmpauthpass|snmpencpass"
)
_QUERY_SECRET = re.compile(rf"(?i)\b({_SECRET_KEYS})=([^&\"'\s<]+)")
_JSON_SECRET = re.compile(rf'(?i)("[^"]*(?:{_SECRET_KEYS})[^"]*"\s*:\s*)"(?:[^"\\]|\\.)*"')
_XML_SECRET = re.compile(rf"(?i)(<({_SECRET_KEYS})[^>]*>)[^<]*(</)")


def scrub(text: str, *secrets: str) -> str:
    """``text`` with every given secret, and anything that looks like one,
    replaced by ``REDACTED``."""
    for secret in secrets:
        if secret:
            text = text.replace(secret, "REDACTED")
    text = _QUERY_SECRET.sub(r"\1=REDACTED", text)
    text = _JSON_SECRET.sub(r'\1"REDACTED"', text)
    return _XML_SECRET.sub(r"\1REDACTED\3", text)


def record_fixture(client, path: str, params: dict | None, name: str,
                   directory: Path | None = None) -> Path:
    """Save one live response from a real PRTG as fixture ``name``.

    The body is kept as text, quirks and all - a recording that re-serialised
    PRTG's JSON would lose the invalid escapes the client has to survive -
    with the client's API key and anything secret-shaped redacted.
    """
    resp = client._check(client._request(path, params))
    target = (directory or FIXTURES) / name
    target.write_text(scrub(resp.text, client.api_key), encoding="utf-8")
    return target


# ── the fake server ─────────────────────────────────────────────────────────


def _xml(body: str) -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" ?>\n<prtg>\n'
        f"<version>{VERSION}+</version>\n{body}\n</prtg>"
    )


def sensor_row(objid: int, name: str = "Ping", *, device: str = "dev", status: int = 3,
               parent: int = 2000, value: str = "1 msec") -> dict:
    """A sensor row in the shape ``table_sensors.json`` uses."""
    label = st.label(status)
    return {
        "objid": objid, "objid_raw": objid, "name": name, "name_raw": name,
        "device": device, "device_raw": device, "host": "10.0.0.9", "host_raw": "10.0.0.9",
        "probe": "Local Probe", "probe_raw": "Local Probe", "group": "Lab", "group_raw": "Lab",
        "type": "Ping", "type_raw": "ping", "status": label, "status_raw": status,
        "message": f'<div class="status">{label}</div>', "message_raw": "OK",
        "lastvalue": value, "lastvalue_raw": 1.0, "priority": "3", "priority_raw": 3,
        "tags": "pingsensor", "tags_raw": "pingsensor",
        "lastcheck": "", "lastcheck_raw": 46320.4263657407,
        "lastup": "", "lastup_raw": "", "lastdown": "", "lastdown_raw": "",
        "uptime": "100.0000%", "uptime_raw": 1000000, "downtime": "0.0000%", "downtime_raw": 0,
        "interval": "60 s", "interval_raw": 60, "parentid": parent, "parentid_raw": parent,
        "active": True, "active_raw": -1,
    }


def device_row(objid: int, name: str, *, host: str = "", parent: int = 1,
               tags=(), status: int = 3) -> dict:
    """A device row in the shape ``table_devices.json`` uses."""
    label = st.label(status)
    tags = " ".join(tags)
    return {
        "objid": objid, "objid_raw": objid, "name": name, "name_raw": name,
        "host": host, "host_raw": host, "probe": "Local Probe", "probe_raw": "Local Probe",
        "group": "Local Probe", "group_raw": "Local Probe", "status": label,
        "status_raw": status, "message": "OK", "message_raw": "OK",
        "tags": tags, "tags_raw": tags, "parentid": parent, "parentid_raw": parent,
        "active": True, "active_raw": -1,
    }


class FakePrtg:
    """One fake PRTG core server. ``start()`` it once per test class and
    ``reset()`` it per test."""

    def __init__(self, api_key: str = "fake-prtg-key"):
        self.default_key = api_key
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.httpd.fake = self
        self.port = self.httpd.server_address[1]
        self.thread = None
        self.reset()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    @property
    def v2_url(self) -> str:
        return f"{self.url}/api/v2"

    def reset(self):
        self.api_key = self.default_key
        self.status = load_fixture("getstatus.json")
        self.tables = {
            "sensors": load_fixture("table_sensors.json")["sensors"],
            "devices": load_fixture("table_devices.json")["devices"],
            "probenode": load_fixture("table_probenode.json")["probenode"],
            "groups": load_fixture("table_groups.json")["groups"],
        }
        self.details = load_fixture("getsensordetails.json")
        #: sensor objid -> channel rows (``content=channels&id=``).
        self.channels = {
            objid: load_fixture(f"table_channels_{objid}.json")["channels"]
            for objid in (2091, 2089, 1004, 1005)
        }
        #: sensor objid -> the recorded ``historicdata.xml`` body.
        self.history = {
            objid: load_fixture(f"historicdata_{objid}.xml", raw=True)
            for objid in (2089, 2091)
        }
        #: device objid -> the recorded ``content=sysinfo`` body (PRTG 26.3
        #: repeats an empty key per column, so it is served as recorded).
        self.sysinfo = {
            objid: load_fixture(f"table_sysinfo_{objid}.json", raw=True)
            for objid in (40, 2081)
        }
        #: content -> body served verbatim instead of the table, for quirks.
        self.raw_tables: dict[str, str] = {}
        self.properties: dict[tuple[int, str], str] = {}
        self.v2 = True
        #: Whether the experimental write endpoints answer (False: 404, as on
        #: a server without them).
        self.v2_writes = True
        self.next_id = 5000
        #: Sensor creates answered "could not find parent" first, as PRTG
        #: 26.3 does right after a device was created.
        self.parent_misses = 0
        #: kindid -> metascan rows (``{"headers": {...}, "rows": [...]}``).
        self.metascans: dict[str, dict] = {}
        #: kindid -> (status, body) a sensor create answers with instead.
        self.refuse_kinds: dict[str, tuple[int, dict]] = {}
        #: Every v2 call: {"method", "path", "params", "body"}.
        self.v2_calls: list[dict] = []
        #: device objid -> the sections PATCHed onto it.
        self.device_settings: dict[int, dict] = {}
        #: (status, body) every classic call answers with, to force errors.
        self.fail: tuple[int, str] | None = None
        #: Every request: {"path", "params", "auth"} - auth is how the key came.
        self.requests: list[dict] = []
        self.writes: list[tuple[str, dict]] = []

    def start(self) -> FakePrtg:
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        return self

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()

    def sensor(self, objid: int) -> dict | None:
        return next((r for r in self.tables["sensors"] if r["objid"] == objid), None)

    def device(self, objid: int) -> dict | None:
        return next((r for r in self.tables["devices"] if r["objid"] == objid), None)

    def set_status(self, objid: int, code: int, message: str | None = None):
        row = self.sensor(objid) or self.device(objid)
        row["status_raw"] = code
        row["status"] = st.label(code)
        if message is not None:
            row["message_raw"] = message

    def calls(self, path: str) -> list[dict]:
        return [r for r in self.requests if r["path"] == path]


def _matches(row: dict, filters: dict[str, list[str]]) -> bool:
    for name, wanted in filters.items():
        if name == "tags":
            tags = set(re.split(r"[,\s]+", str(row.get("tags_raw", ""))))
            names = [re.sub(r"^@tag\((.*)\)$", r"\1", w) for w in wanted]
            if not tags.intersection(names):
                return False
            continue
        value = row.get(f"{name}_raw", row.get(name))
        if str(value) not in wanted:
            return False
    return True


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):  # silence
        pass

    @property
    def fake(self) -> FakePrtg:
        return self.server.fake

    def _send(self, code: int, body: str, ctype: str = "text/html", headers=None):
        data = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _json(self, obj):
        self._send(200, json.dumps(obj), "application/json")

    def _error(self, code: int, sentence: str):
        self._send(code, _xml(f"<error>{sentence}</error>"), "text/xml")

    def _auth(self, q: dict, *, v2: bool) -> str | None:
        """How the key came, when it is the right key in the right place.

        As PRTG 26.3 does it: the classic API reads only ``apitoken=`` and
        answers any Bearer header with 401; API v2 reads only the header.
        """
        header = self.headers.get("Authorization", "")
        if v2:
            if header.startswith("Bearer ") and header[7:] == self.fake.api_key:
                return "bearer"
            return None
        if header:
            return "unsupported"
        if "apitoken" in q:
            return "query" if q["apitoken"] == self.fake.api_key else None
        return None

    def do_GET(self):  # noqa: C901 - one branch per endpoint reads best
        url = urlparse(self.path)
        multi = parse_qs(url.query, keep_blank_values=True)
        q = {k: v[0] for k, v in multi.items()}
        auth = self._auth(q, v2=url.path.startswith("/api/v2/"))
        self.fake.requests.append({"path": url.path, "params": q, "auth": auth})
        if auth == "unsupported":
            return self._error(401, "Unsupported authorization scheme.")
        if url.path.startswith("/api/v2/"):
            return self._v2("GET", url.path.removeprefix("/api/v2"), q, auth)
        if auth is None:
            return self._error(401, "Unauthorized")
        if self.fake.fail:
            return self._send(*self.fake.fail)

        path = url.path
        if path == "/api/getstatus.htm":
            return self._json(self.fake.status)
        if path == "/api/table.json":
            return self._table(q, multi)
        if path == "/api/historicdata.xml":
            body = self.fake.history.get(int(q.get("id", 0) or 0))
            if body is None:
                body = ('<?xml version="1.0" encoding="UTF-8"?>\n<histdata totalcount="0" '
                        f'listend="1"><prtg-version>{VERSION}</prtg-version></histdata>')
            return self._send(200, body, "text/xml")
        if path == "/api/getsensordetails.json":
            if self.fake.sensor(int(q.get("id", 0))) is None:
                return self._json({"prtg-version": VERSION, "treesize": 0, "sensordata": {}})
            return self._json(self.fake.details)
        if path == "/api/getobjectproperty.htm":
            value = self.fake.properties.get((int(q["id"]), q["name"]), "(Property not found)")
            return self._send(200, _xml(f"<result>{value}</result>"), "text/xml")
        return self._write(path, q)

    def _table(self, q: dict, multi: dict):
        content = q.get("content", "")
        if content in self.fake.raw_tables:
            return self._send(200, self.fake.raw_tables[content], "application/json")
        if content == "sysinfo":
            body = self.fake.sysinfo.get(int(q.get("id", 0) or 0))
            if body is None:
                body = json.dumps({"prtg-version": VERSION, "treesize": 0, "sysinfo": []})
            return self._send(200, body, "application/json")
        if content == "channels":
            rows = self.fake.channels.get(int(q.get("id", 0) or 0))
            if rows is None:
                return self._error(400, "Sorry, the selected object cannot be used here.")
            return self._json({"prtg-version": VERSION, "treesize": 0,
                               "channels": copy.deepcopy(rows)})
        if content not in self.fake.tables:
            return self._error(400, f"The content type {content} is not supported.")
        filters = {k[7:]: v for k, v in multi.items() if k.startswith("filter_")}
        rows = [r for r in self.fake.tables[content] if _matches(r, filters)]
        if q.get("id"):
            rows = [r for r in rows if str(r.get("parentid")) == q["id"]]
        start = int(q.get("start", 0))
        count = int(q.get("count", 500))
        columns = [c for c in q.get("columns", "").split(",") if c]
        page = []
        for row in rows[start:start + count]:
            if columns:
                row = {k: v for k, v in row.items() if k in columns or (
                    k.endswith("_raw") and k[:-4] in columns)}
            page.append(copy.deepcopy(row))
        return self._json({"prtg-version": VERSION, "treesize": len(rows), content: page})

    # ── API v2 ───────────────────────────────────────────────────────

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        try:
            return json.loads(raw or b"{}")
        except ValueError:
            return {}

    def do_POST(self):
        self._v2_entry("POST")

    def do_PATCH(self):
        self._v2_entry("PATCH")

    def do_DELETE(self):
        self._v2_entry("DELETE")

    def _v2_entry(self, method: str):
        url = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(url.query, keep_blank_values=True).items()}
        auth = self._auth(q, v2=True)
        self.fake.requests.append({"path": url.path, "params": q, "auth": auth})
        if not url.path.startswith("/api/v2/"):
            return self._send(405, "")
        return self._v2(method, url.path.removeprefix("/api/v2"), q, auth)

    def _v2_error(self, code: int, kind: str, message: str):
        self._send(code, json.dumps({"code": kind, "message": message,
                                     "request_id": "fake"}), "application/json")

    def _new_id(self) -> int:
        self.fake.next_id += 1
        return self.fake.next_id

    def _v2(self, method: str, path: str, q: dict, auth):  # noqa: C901
        fake = self.fake
        if not fake.v2:
            return self._send(404, "<h1>Not Found</h1>")
        if auth is None:
            return self._send(401, json.dumps({"code": "Unauthorized"}), "application/json")
        body = self._body() if method in ("POST", "PATCH") else None
        fake.v2_calls.append({"method": method, "path": path, "params": q, "body": body})
        missing = ("NOT_FOUND",
                   "The resource could not be found in this endpoint. Check the ID of the object.")
        if path == "/version":
            return self._json({"application_server_version": "0.362.0",
                               "prtg_version": f"{fake.status.get('Version', VERSION)}",
                               "prtg_release_channel": "Stable"})
        if path.startswith("/experimental/") and not fake.v2_writes:
            return self._send(404, "<h1>Not Found</h1>")
        if method == "GET" and path == "/experimental/sensors":
            limit = int(q.get("limit", 100) or 100) or 3000
            rows = [{"id": str(r["objid"]), "name": r["name"]}
                    for r in fake.tables["sensors"]][:limit]
            return self._json(rows)
        if method == "GET" and path == "/experimental/probes":
            return self._json([{"id": str(r["objid"]), "name": r["name"], "kind": "probenode"}
                               for r in fake.tables["probenode"]
                               if str(r.get("type_raw", "probenode")) == "probenode"
                               and r["objid"] != 0])
        m = re.fullmatch(r"/experimental/schemas/(\d+)", path)
        if method == "GET" and m:
            parent = int(m.group(1))
            if fake.device(parent) is not None:
                return self._json(load_fixture("v2_schemas_device.json"))
            return self._json([{"creatable": True, "kind": "device[1]", "name": "Device"},
                               {"creatable": True, "kind": "group[1]", "name": "Group"}])
        m = re.fullmatch(r"/experimental/(groups|probes)/(\d+)/device", path)
        if method == "POST" and m:
            parent = int(m.group(2))
            known = {r["objid"] for r in fake.tables["groups"]} | {
                r["objid"] for r in fake.tables["probenode"]}
            if parent not in known:
                return self._v2_error(404, "NOT_FOUND", f"{missing[1]} Cause: could not find "
                                      f"parent with ID: {parent}")
            basic = (body or {}).get("basic") or {}
            objid = self._new_id()
            fake.tables["devices"].append(device_row(
                objid, basic.get("name", "Device"), host=basic.get("host", ""),
                parent=parent, tags=basic.get("tags") or [],
            ))
            return self._send(201, "", "application/json",
                              {"Location": f"/api/v2/devices/{objid}"})
        m = re.fullmatch(r"/experimental/devices/(\d+)/sensor", path)
        if method == "POST" and m:
            objid = int(m.group(1))
            device = fake.device(objid)
            if device is None:
                return self._v2_error(404, *missing)
            kind = q.get("kindid", "")
            if fake.parent_misses > 0:
                fake.parent_misses -= 1
                return self._v2_error(404, "NOT_FOUND", f"{missing[1]} Cause: could not find "
                                      f"parent with ID: {objid}")
            if kind in fake.refuse_kinds:
                code, err = fake.refuse_kinds[kind]
                return self._send(code, json.dumps(err), "application/json")
            if "intervalgroup" in (body or {}):
                return self._v2_error(400, "BAD_REQUEST", '"intervalgroup.interval" is invalid: '
                                      "no lookup validation possible for lookup intervalid")
            basic = (body or {}).get("basic") or {}
            sid = self._new_id()
            row = sensor_row(sid, basic.get("name") or kind, device=device["name"],
                             parent=objid, status=st.UNKNOWN)
            row["type_raw"] = kind
            row["type"] = kind
            tags = " ".join(basic.get("tags") or [])
            row["tags"] = row["tags_raw"] = tags
            row["_settings"] = body
            fake.tables["sensors"].append(row)
            return self._send(201, "", "application/json",
                              {"Location": f"/api/v2/sensors/{sid}"})
        m = re.fullmatch(r"/experimental/devices/(\d+)/metascan", path)
        if m:
            kind = q.get("kind", "")
            if method == "POST":
                return self._send(201, "", "application/json", {
                    "Location": f"/api/v2/experimental/devices/{m.group(1)}/metascan?kind={kind}"})
            if kind not in fake.metascans:
                return self._v2_error(400, "BAD_GATEWAY", "error during meta-scan: 106: The "
                                      "sensor does not get a response from the device.")
            return self._json(fake.metascans[kind])
        m = re.fullmatch(r"/devices/(\d+)", path)
        if m:
            device = fake.device(int(m.group(1)))
            if device is None:
                return self._v2_error(404, *missing)
            if method == "GET":
                return self._json({"id": m.group(1), "name": device["name"],
                                   "basic": {"host": device.get("host_raw", "")}})
            if method == "PATCH":
                sections = fake.device_settings.setdefault(int(m.group(1)), {})
                for name, values in (body or {}).items():
                    sections.setdefault(name, {}).update(values)
                basic = (body or {}).get("basic") or {}
                if "host" in basic:
                    device["host"] = device["host_raw"] = basic["host"]
                if "tags" in basic:
                    device["tags"] = device["tags_raw"] = " ".join(basic["tags"])
                return self._send(204, "")
        m = re.fullmatch(r"/experimental/sensors/(\d+)", path)
        if m:
            row = fake.sensor(int(m.group(1)))
            if row is None:
                return self._v2_error(404, *missing)
            if method == "DELETE":
                fake.tables["sensors"].remove(row)
                return self._send(204, "")
            if method == "PATCH":
                if set(body or {}) - {"basic", "channelgroup"}:
                    return self._v2_error(501, "METHOD_NOT_IMPLEMENTED",
                                          "The requested action is not implemented yet. Cause: "
                                          "section intervalgroup is not yet supported")
                basic = (body or {}).get("basic") or {}
                if "name" in basic:
                    row["name"] = row["name_raw"] = basic["name"]
                if "tags" in basic:
                    row["tags"] = row["tags_raw"] = " ".join(basic["tags"])
                return self._send(204, "")
        m = re.fullmatch(r"/experimental/devices/(\d+)", path)
        if m and method == "DELETE":
            objid = int(m.group(1))
            device = fake.device(objid)
            if device is None:
                return self._v2_error(404, *missing)
            fake.tables["devices"].remove(device)
            fake.tables["sensors"] = [r for r in fake.tables["sensors"]
                                      if r.get("parentid") != objid]
            return self._send(204, "")
        m = re.fullmatch(r"/objects/(\d+)/move", path)
        if m and method == "POST":
            device = fake.device(int(m.group(1)))
            parent = str((body or {}).get("parent") or "")
            if device is None or not parent.isdigit():
                return self._v2_error(404, *missing)
            device["parentid"] = device["parentid_raw"] = int(parent)
            return self._send(204, "", "application/json",
                              {"Location": f"/api/v2/devices/{m.group(1)}"})
        if method == "GET":
            # The probe of API v2 and anything else read-only.
            limit = int(q.get("limit", 100) or 100)
            rows = [{"id": str(r["objid"]), "name": r["name"]}
                    for r in fake.tables["sensors"]][:limit]
            return self._json(rows)
        return self._v2_error(404, *missing)

    # ── classic writes ───────────────────────────────────────────────

    def _write(self, path: str, q: dict):  # noqa: C901
        name = path.removeprefix("/api/")
        if name not in {"acknowledgealarm.htm", "pause.htm", "pauseobjectfor.htm",
                        "setobjectproperty.htm", "deleteobject.htm", "scannow.htm",
                        "duplicateobject.htm", "discovernow.htm"}:
            return self._send(404, "<HTML><BODY>Not Found</BODY></HTML>")
        try:
            objid = int(q.get("id", ""))
        except ValueError:
            return self._error(400, "The id parameter is missing or invalid.")
        self.fake.writes.append((name, q))
        row = self.fake.sensor(objid)
        if name == "setobjectproperty.htm":
            self.fake.properties[(objid, q.get("name", ""))] = q.get("value", "")
            target = row or self.fake.device(objid)
            if target is not None and q.get("name") == "tags":
                target["tags"] = target["tags_raw"] = q.get("value", "")
            return self._send(200, "<html><body>OK</body></html>")
        if name == "duplicateobject.htm":
            return self._duplicate(objid, q)
        if name == "discovernow.htm":
            if self.fake.device(objid) is None:
                return self._error(400, "Sorry, the selected object cannot be used here.")
            return self._send(200, "<HTML><BODY>OK</BODY></HTML>")
        device = self.fake.device(objid) if row is None else None
        if row is None and device is None:
            return self._error(400, "Sorry, the selected object cannot be used here.")
        if device is not None:
            return self._device_write(name, objid, q)
        if name == "acknowledgealarm.htm":
            # As PRTG 26.3: a redirect to the alarms list either way; only a
            # sensor in a Down state changes.
            if row["status_raw"] in (st.DOWN, st.DOWN_PARTIAL):
                msg = q.get("ackmsg", "")
                self.fake.set_status(
                    objid, st.DOWN_ACKNOWLEDGED,
                    f"{msg} (Acknowledged by PRTG System Administrator on 10/26/2026 "
                    f"at 9:51:27 AM [GMT+0100]): {row.get('message_raw', '')}",
                )
            return self._send(302, "", headers={
                "Location": "/alarms.htm?filter_status=5&filter_status=13"
            })
        elif name == "pause.htm":
            self.fake.set_status(
                objid, st.UP if q.get("action") == "1" else st.PAUSED_USER
            )
        elif name == "pauseobjectfor.htm":
            self.fake.set_status(objid, st.PAUSED_UNTIL)
        elif name == "deleteobject.htm":
            if q.get("approve") != "1":
                return self._error(400, "Deleting needs approve=1.")
            self.fake.tables["sensors"].remove(row)
        return self._send(200, "<html><body>OK</body></html>")

    def _duplicate(self, objid: int, q: dict):
        """As PRTG 26.3: a 302 to the copy, which arrives paused; a device's
        sensors are copied with it."""
        fake = self.fake
        target = int(q.get("targetid", 0) or 0)
        source = fake.sensor(objid)
        if source is not None:
            device = fake.device(target)
            if device is None:
                return self._error(400, "Sorry, the selected object cannot be used here.")
            new = copy.deepcopy(source)
            sid = self._new_id()
            new.update(objid=sid, objid_raw=sid, parentid=target, parentid_raw=target,
                       name=q.get("name", source["name"]), name_raw=q.get("name", ""))
            fake.tables["sensors"].append(new)
            fake.set_status(sid, st.PAUSED_USER)
            return self._send(302, "", headers={"Location": f"/sensor.htm?id={sid}"})
        source = fake.device(objid)
        if source is None:
            return self._error(400, "Sorry, the selected object cannot be used here.")
        did = self._new_id()
        new = copy.deepcopy(source)
        new.update(objid=did, objid_raw=did, parentid=target, parentid_raw=target,
                   name=q.get("name", source["name"]), name_raw=q.get("name", ""))
        if q.get("host"):
            new["host"] = new["host_raw"] = q["host"]
        fake.tables["devices"].append(new)
        fake.set_status(did, st.PAUSED_USER)
        for s in [r for r in fake.tables["sensors"] if r.get("parentid") == objid]:
            c = copy.deepcopy(s)
            sid = self._new_id()
            c.update(objid=sid, objid_raw=sid, parentid=did, parentid_raw=did)
            fake.tables["sensors"].append(c)
        return self._send(302, "", headers={"Location": f"/device.htm?id={did}"})

    def _device_write(self, name: str, objid: int, q: dict):
        """Pausing a device pauses its sensors ("paused by parent"), and the
        pause message leads the device's message, as PRTG 26.3 does it."""
        sensors = [r for r in self.fake.tables["sensors"] if r.get("parentid") == objid]
        if name in ("pause.htm", "pauseobjectfor.htm") and q.get("action") != "1":
            code = st.PAUSED_UNTIL if name == "pauseobjectfor.htm" else st.PAUSED_USER
            msg = q.get("pausemsg", "")
            self.fake.set_status(objid, code, f"{msg} (Paused by PRTG System Administrator)")
            for s in sensors:
                s.setdefault("_before", s["status_raw"])
                self.fake.set_status(s["objid"], st.PAUSED_USER, "Paused by parent")
        elif name == "pause.htm":
            self.fake.set_status(objid, st.UP, "OK")
            for s in sensors:
                self.fake.set_status(s["objid"], s.pop("_before", st.UP), "OK")
        elif name == "acknowledgealarm.htm":
            return self._send(302, "", headers={"Location": "/alarms.htm"})
        elif name == "deleteobject.htm":
            device = self.fake.device(objid)
            self.fake.tables["devices"].remove(device)
            self.fake.tables["sensors"] = [r for r in self.fake.tables["sensors"]
                                           if r.get("parentid") != objid]
            return self._send(302, "", headers={"Location": "/probenode.htm?id=1"})
        return self._send(200, "<html><body>OK</body></html>")
