"""Adding sensors to a linked PRTG device by hand, from its Sensors tab.

Profiles and policies decide what a device *should* carry and the review
queue writes it; this is the other way in: an operator picks one of the
sensor kinds PRTG offers, fills in its settings and Danbyte creates it now.

* :func:`catalog` - the kinds PRTG offers (API v2's schema list under a
  device), cached on the connection for a day. A kind Danbyte knows
  (:data:`prtg.writer.V2_KINDS`) has Danbyte's own parameter form; every
  other kind gets a form built from PRTG's create schema
  (:func:`schema_fields`). Without API v2 writes the list is Danbyte's own
  kinds, created as copies of the seed device's sensors.
* :func:`scan` - PRTG's metascan for a kind that needs one (SNMP traffic):
  the rows the operator picks from.
* :func:`add_sensor` - one sensor (or one per picked scan row) through the
  writer's own create path: tagged ``danbyte``, ``danbyte-manual`` and a
  ``danbyte-man-`` key, so a retry finds what an earlier attempt made;
  recorded on the link's ``created_sensors`` so Danbyte may delete it later;
  journalled and change-logged on the device or VM; the device's sensors
  re-read at once.
* :func:`discover` - PRTG's auto-discovery on the device, with an optional
  device template; what it finds arrives with the next status read.

A manual sensor's key tag is not a ``danbyte-def-`` tag, so the planning
pass never proposes removing it.
"""
from __future__ import annotations

import hashlib
import json
import re
from datetime import datetime

from django.utils import timezone

from monitoring.external.beat import skip_reason

from . import sensor_kinds as sk
from .actions import ActionError
from .client import PrtgClient, PrtgError
from .client_v2 import PrtgV2Client
from .models import PrtgChange, PrtgConnection, PrtgDeviceLink, PrtgSensor
from .writer import NO_WRITES, V2_KINDS, Refused, Writer, _lock, _unlock, record, write_mode

MANUAL_TAG = "danbyte-manual"
KEY_PREFIX = "danbyte-man-"
#: How long PRTG's list of kinds and templates is trusted.
CATALOG_SECONDS = 24 * 3600
#: The most scan rows one request turns into sensors.
MAX_ROWS = 50
#: Device templates every PRTG ships, offered when the list cannot be read.
DEFAULT_TEMPLATES = (
    ("Device Generic Ping.odt", "Generic Device (Ping Only)"),
    ("Device Generic SNMP.odt", "Generic Device (SNMP Enabled)"),
    ("Device Generic SNMP Detailed.odt", "Generic Device (SNMP Enabled, Detailed)"),
)
#: PRTG kind id -> Danbyte kind, for the kinds with Danbyte's own form.
BY_KINDID = {kindid: value for value, (kindid, _) in V2_KINDS.items()}
#: Danbyte kinds the scan step is for: one sensor per picked row.
SCANNED = {k.value for k in sk.KINDS if k.per == sk.PER_INTERFACE}

#: A sensor's name's first word -> the dialog's group.
_GROUPS = {
    "snmp": "SNMP", "wmi": "Windows", "windows": "Windows", "perfcounter": "Windows",
    "event": "Windows", "hyper-v": "Windows", "exchange": "Windows",
    "http": "Web", "rest": "Web", "ssl": "Web", "ssl/tls": "Web",
    "ssh": "SSH", "ping": "Ping", "traceroute": "Ping",
    "netflow": "Flow", "jflow": "Flow", "sflow": "Flow", "ipfix": "Flow",
    "packet": "Flow",
    "dns": "Network services", "dhcp": "Network services", "ftp": "Network services",
    "imap": "Network services", "pop3": "Network services", "smtp": "Network services",
    "sntp": "Network services", "ldap": "Network services", "rdp": "Network services",
    "port": "Network services", "tftp": "Network services", "radius": "Network services",
    "aws": "Cloud", "microsoft": "Cloud", "cloud": "Cloud",
}
#: Settings sections the generic form leaves to PRTG (inherited, or set by
#: Danbyte apart: the interval through the classic API).
_SKIP_SECTIONS = {"accessgroup", "commentgroup", "intervalgroup", "scheduledependency"}


def _clients(conn, classic=None, v2=None):
    return (classic or PrtgClient.for_connection(conn),
            v2 or PrtgV2Client.for_connection(conn))


def _usable(conn: PrtgConnection) -> None:
    reason = skip_reason(conn, "prtg")
    if reason:
        raise ActionError(f"PRTG is off for this tenant ({reason}).")
    if not (conn.enabled and conn.api_key_set):
        raise ActionError("The PRTG connection is off or has no API key.")


def _stale(entry: dict | None, now) -> bool:
    if not entry or not entry.get("read_at"):
        return True
    try:
        at = datetime.fromisoformat(entry["read_at"])
    except (TypeError, ValueError):
        return True
    return (now - at).total_seconds() > CATALOG_SECONDS


def _keep(conn, key: str, entry: dict) -> None:
    data = dict(conn.sensor_catalog or {})
    data[key] = entry
    conn.sensor_catalog = data
    conn.save(update_fields=["sensor_catalog"])


# ── the kinds ───────────────────────────────────────────────────────────────


def _group(name: str, counts: dict) -> str:
    first = (name or "").split(" ")[0]
    found = _GROUPS.get(first.lower())
    if found:
        return found
    return first if first and counts.get(first, 0) >= 3 else "Other"


def _from_prtg(rows: list) -> list[dict]:
    counts: dict = {}
    for r in rows:
        first = str(r.get("name") or "").split(" ")[0]
        counts[first] = counts.get(first, 0) + 1
    out = []
    for r in rows:
        kindid = str(r.get("kind") or "")
        if not kindid:
            continue
        value = BY_KINDID.get(kindid)
        flags = list(r.get("flags") or [])
        out.append({
            "id": kindid,
            "name": str(r.get("name") or kindid),
            "description": str(r.get("description") or ""),
            "help": str(r.get("help") or ""),
            "category": _group(str(r.get("name") or ""), counts),
            "form": "danbyte" if value else "generic",
            "danbyte_kind": value,
            "scan": (value in SCANNED) if value else "HasMetaScan" in flags,
            "credentials": str(r.get("credential_group") or ""),
            "manual": str(r.get("manual") or ""),
            "copy_from_seed": False,
        })
    return sorted(out, key=lambda k: (k["category"], k["name"].lower()))


def _danbyte_kinds() -> list[dict]:
    """Danbyte's own kinds as a seed copy can make them: no scanned kinds,
    no templates."""
    out = []
    for k in sk.KINDS:
        if k.value == sk.TEMPLATE or k.per == sk.PER_INTERFACE:
            continue
        if V2_KINDS.get(k.value, ("", None))[1]:
            continue
        group = {"snmp": "SNMP", "windows": "Windows"}.get(k.needs or "", "")
        if not group:
            group = "Web" if k.value in ("http", "ssl_certificate", "ssl_security") else "Ping"
        out.append({
            "id": k.value, "name": k.label, "description": "", "help": "",
            "category": group, "form": "danbyte", "danbyte_kind": k.value,
            "scan": False, "credentials": k.needs or "", "manual": "",
            "copy_from_seed": True,
        })
    return out


def catalog(conn: PrtgConnection, *, link: PrtgDeviceLink | None = None,
            refresh: bool = False, v2=None) -> dict:
    """The kinds an operator can add: ``{mode, source, read_at, kinds,
    danbyte_forms}``. Read from PRTG at most once a day, or now with
    ``refresh``."""
    _usable(conn)
    mode = write_mode(conn, v2=v2)
    if mode != PrtgConnection.WRITE_V2:
        kinds = [_shape(k) for k in _danbyte_kinds()]
        return {"mode": mode, "source": "danbyte", "read_at": None, "kinds": kinds,
                "danbyte_forms": len(kinds), "detail": conn.write_detail or ""}
    now = timezone.now()
    entry = (conn.sensor_catalog or {}).get("kinds")
    if refresh or _stale(entry, now):
        if link is None:
            link = conn.links.order_by("name").first()
        if link is None:
            raise ActionError("No device is linked yet: PRTG lists sensor kinds per device.")
        _, v2 = _clients(conn, v2=v2)
        try:
            rows = _from_prtg(v2.kinds(link.objid))
        except PrtgError as exc:
            if entry and entry.get("rows"):
                rows, now = entry["rows"], None
            else:
                raise ActionError(f"PRTG did not list its sensor kinds: {exc}"[:300], 502) from None
        if now is not None:
            entry = {"read_at": now.isoformat(), "rows": rows}
            _keep(conn, "kinds", entry)
    rows = [_shape(r) for r in entry.get("rows") or []]
    return {"mode": mode, "source": "prtg", "read_at": entry.get("read_at"), "kinds": rows,
            "danbyte_forms": sum(1 for k in rows if k["form"] == "danbyte"),
            "detail": conn.write_detail or ""}


def _shape(row: dict) -> dict:
    """A catalog row with the picker's names beside the dialog's own:
    ``danbyte_form``, ``needs_scan`` and ``credential_group``."""
    return {**row, "danbyte_form": row.get("form") == "danbyte",
            "needs_scan": bool(row.get("scan")),
            "credential_group": row.get("credentials") or ""}


def cached_kind(conn: PrtgConnection, kindid: str) -> dict | None:
    """The row PRTG's cached list holds for ``kindid``, or None."""
    for row in ((conn.sensor_catalog or {}).get("kinds") or {}).get("rows") or []:
        if row.get("id") == kindid:
            return row
    return None


def has_catalog(conn: PrtgConnection) -> bool:
    return bool(((conn.sensor_catalog or {}).get("kinds") or {}).get("rows"))


def needs_of(row: dict | None) -> str | None:
    """The Danbyte credential a PRTG kind's credential group stands for."""
    group = str((row or {}).get("credentials") or "").lower()
    if "snmp" in group:
        return sk.SNMP
    if "windows" in group or "wmi" in group:
        return sk.WINDOWS
    return None


# ── PRTG's form for a kind ──────────────────────────────────────────────────


def _sort_index(node) -> int:
    meta = node.get("x-prtg-meta") if isinstance(node, dict) else None
    try:
        return int((meta or {}).get("sortIndex", 999))
    except (TypeError, ValueError):
        return 999


def _scan_target(schema: dict) -> dict | None:
    """Where a metascan's picked rows go: ``{section, field}``."""
    extra = ((schema.get("additionalProperties") or {}).get("properties") or {})
    for node in extra.values():
        path = ((node or {}).get("x-prtg-meta") or {}).get("metascan_field") or ""
        m = re.search(r"/properties/([^/]+)/([^/]+)$", path)
        if m:
            return {"section": m.group(1), "field": m.group(2)}
    return None


def _field(section: str, sec_title: str, name: str, node: dict) -> dict | None:
    meta = node.get("x-prtg-meta") or {}
    kind = node.get("type")
    options = meta.get("options") or {}
    out = {
        "key": f"{section}.{name}", "section": section, "section_title": sec_title,
        "name": name, "label": str(node.get("title") or name),
        "default": node.get("default"), "required": bool(meta.get("required")),
        "options": [], "minimum": node.get("minimum"), "maximum": node.get("maximum"),
        "help": str(node.get("description") or ""),
    }
    if kind == "boolean":
        out["type"] = "checkbox"
    elif kind in ("integer", "number"):
        out["type"] = "number"
    elif kind == "string" and node.get("enum"):
        out["type"] = "select"
        out["options"] = [{"value": str(v), "label": str(options.get(str(v), v))}
                          for v in node["enum"]]
    elif kind == "array" and ((node.get("items") or {}).get("enum")):
        out["type"] = "multi"
        out["options"] = [{"value": str(v), "label": str(options.get(str(v), v))}
                          for v in node["items"]["enum"]]
    elif kind == "string" and meta.get("class") in ("edit", "textarea", "password", None):
        secret = meta.get("class") == "password" or meta.get("security") not in (None, "none")
        out["type"] = "password" if secret else "text"
    else:
        return None
    return out


def parse_schema(schema: dict) -> dict:
    """PRTG's create schema as the generic form's fields: ``{fields: [...],
    scan: {section, field} | None}``. Inherited sections, read-only and
    internal fields, and Danbyte's own (name, tags, interval) are left out."""
    scan = _scan_target(schema)
    fields: list = []
    sections = sorted((schema.get("properties") or {}).items(), key=lambda kv: _sort_index(kv[1]))
    for section, sec in sections:
        if not isinstance(sec, dict) or section in _SKIP_SECTIONS:
            continue
        if (sec.get("x-prtg-meta") or {}).get("inheritable"):
            continue
        props = sorted((sec.get("properties") or {}).items(), key=lambda kv: _sort_index(kv[1]))
        for name, node in props:
            if name.startswith("_") or not isinstance(node, dict) or node.get("readOnly"):
                continue
            if section == "basic" and name in ("name", "tags", "parenttags"):
                continue
            meta = node.get("x-prtg-meta") or {}
            if meta.get("class") in ("lookupchecklistbox",) or "metascan" in str(meta.get("$ref", "")):
                scan = scan or {"section": section, "field": name}
                continue
            f = _field(section, str(sec.get("title") or section), name, node)
            if f is not None:
                fields.append(f)
    return {"fields": fields, "scan": scan}


def schema_fields(link: PrtgDeviceLink, kindid: str, *, v2=None) -> dict:
    conn = link.connection
    _usable(conn)
    _, v2 = _clients(conn, v2=v2)
    try:
        schema = v2.post_schema(link.objid, kindid)
    except PrtgError as exc:
        raise ActionError(f"PRTG has no form for '{kindid}': {exc}"[:300], 502) from None
    out = {"kind": kindid, **parse_schema(schema)}
    _keep_schema(conn, kindid, out)
    return out


def _keep_schema(conn, kindid: str, form: dict) -> None:
    conn.refresh_from_db(fields=["sensor_catalog"])
    schemas = dict((conn.sensor_catalog or {}).get("schemas") or {})
    schemas[kindid] = {"read_at": timezone.now().isoformat(), "fields": form["fields"],
                       "scan": form["scan"]}
    _keep(conn, "schemas", schemas)


def cached_schema(conn: PrtgConnection, kindid: str) -> dict | None:
    """The form last read for ``kindid``: ``{fields, scan}``, or None."""
    entry = ((conn.sensor_catalog or {}).get("schemas") or {}).get(kindid)
    return entry if entry and isinstance(entry.get("fields"), list) else None


def connection_schema(conn: PrtgConnection, kindid: str, *, link: PrtgDeviceLink | None = None,
                      refresh: bool = False, v2=None) -> dict:
    """PRTG's create form for ``kindid`` at connection level, for the
    profile editor: kept beside the kind list for a day. PRTG answers per
    device, so ``link`` (or the first linked device) is asked."""
    _usable(conn)
    entry = cached_schema(conn, kindid)
    if entry and not refresh and not _stale(entry, timezone.now()):
        return {"kind": kindid, "fields": entry["fields"], "scan": entry.get("scan")}
    if link is None:
        link = conn.links.order_by("name").first()
    if link is None:
        if entry:
            return {"kind": kindid, "fields": entry["fields"], "scan": entry.get("scan")}
        raise ActionError("No device is linked yet: PRTG gives a sensor's form per device.")
    try:
        return schema_fields(link, kindid, v2=v2)
    except ActionError:
        if entry:
            return {"kind": kindid, "fields": entry["fields"], "scan": entry.get("scan")}
        raise


def flat_params(sections: dict) -> dict:
    """Settings sections as the generic form's ``section.field`` keys."""
    return {f"{section}.{name}": value
            for section, values in (sections or {}).items()
            for name, value in (values or {}).items()}


def sections_of(params: dict) -> dict:
    """A profile's generic ``section.field`` params as settings sections."""
    out: dict = {}
    for key, value in (params or {}).items():
        section, _, name = str(key).partition(".")
        if section and name:
            out.setdefault(section, {})[name] = value
    return out


def clean_generic(fields: list, values) -> dict:
    """The operator's values for PRTG's form as settings sections, typed by
    the schema. Raises :class:`ActionError` with a field -> message dict."""
    if values in (None, ""):
        values = {}
    if not isinstance(values, dict):
        raise ActionError("params: expected an object.")
    known = {f["key"]: f for f in fields}
    unknown = sorted(set(values) - set(known))
    if unknown:
        raise ActionError(f"This sensor takes no {', '.join(unknown)}.")
    sections: dict = {}
    errors: dict = {}
    for key, f in known.items():
        if key not in values or values[key] in (None, ""):
            # PRTG marks fields required that only count with another
            # setting on (a command only when "send command"); it checks.
            continue
        value = values[key]
        if f["type"] == "checkbox":
            value = value in (True, 1, "1", "true", "on", "yes")
        elif f["type"] == "number":
            try:
                value = int(value) if float(value).is_integer() else float(value)
            except (TypeError, ValueError):
                errors[key] = f"{f['label']} must be a number."
                continue
            lo, hi = f.get("minimum"), f.get("maximum")
            if (lo is not None and value < lo) or (hi is not None and value > hi):
                errors[key] = f"{f['label']} is out of range."
                continue
        elif f["type"] == "select":
            value = str(value)
            if value not in {o["value"] for o in f["options"]}:
                errors[key] = f"{f['label']} is not one of PRTG's choices."
                continue
        elif f["type"] == "multi":
            allowed = {o["value"] for o in f["options"]}
            if not isinstance(value, list) or not {str(v) for v in value} <= allowed:
                errors[key] = f"{f['label']} is not one of PRTG's choices."
                continue
            value = [str(v) for v in value]
        else:
            value = str(value)[:1024]
        sections.setdefault(f["section"], {})[f["name"]] = value
    if errors:
        exc = ActionError(" ".join(errors.values()))
        exc.fields = errors
        raise exc
    return sections


# ── the scan ────────────────────────────────────────────────────────────────


def _kindid(kind: str) -> tuple[str | None, str]:
    """``(danbyte kind or None, PRTG kind id)`` for what the caller sent."""
    if kind in V2_KINDS:
        return kind, V2_KINDS[kind][0]
    if kind in BY_KINDID:
        return BY_KINDID[kind], kind
    return None, kind


def _row_value(row: dict) -> str:
    for name in ("interfacenumber", "value", "id"):
        for k, v in row.items():
            if k.lower() == name and v not in (None, ""):
                return str(v)
    return str(next(iter(row.values()), ""))


def scan_rows(rows: list[dict]) -> list[dict]:
    out = []
    for row in rows:
        value = _row_value(row)
        if not value:
            continue
        lower = {str(k).lower(): v for k, v in row.items()}
        name = next((str(lower[k]) for k in ("name", "interface", "description", "service")
                     if lower.get(k) not in (None, "")), value)
        status = str(lower.get("status") or lower.get("connection status") or "")
        connected = None
        if status:
            s = status.lower()
            connected = "connected" in s and "disconnected" not in s or s == "up"
        out.append({"value": value, "name": name, "status": status, "connected": connected,
                    "info": {str(k): v for k, v in row.items()}})
    return out


def scan(link: PrtgDeviceLink, kind: str, *, v2=None) -> dict:
    """PRTG's metascan of the linked device for ``kind``."""
    conn = link.connection
    _usable(conn)
    if write_mode(conn, v2=v2) != PrtgConnection.WRITE_V2:
        raise ActionError("Scanning a device needs API v2 writes (PRTG 26.2.120 or later).")
    _, kindid = _kindid(kind)
    _, v2 = _clients(conn, v2=v2)
    try:
        rows = v2.metascan(link.objid, kindid)
    except PrtgError as exc:
        raise ActionError(f"PRTG's scan failed: {exc}"[:400], 502) from None
    return {"kind": kindid, "rows": scan_rows(rows)}


# ── adding ──────────────────────────────────────────────────────────────────


def _tags(raw) -> list[str]:
    from rest_framework.exceptions import ValidationError

    from .registration_serializers import PrtgSensorDefinitionSerializer

    if raw in (None, ""):
        return []
    if isinstance(raw, str):
        raw = raw.split()
    try:
        return PrtgSensorDefinitionSerializer().validate_tags(raw)
    except ValidationError as exc:
        raise ActionError(f"Tags: {' '.join(str(d) for d in exc.detail)}") from None


def _interval(raw) -> int | None:
    if raw in (None, "", 0, "0"):
        return None
    try:
        value = int(raw)
    except (TypeError, ValueError):
        value = -1
    if value not in sk.INTERVALS:
        raise ActionError(
            "Interval: one of PRTG's intervals: "
            + ", ".join(str(v) for v in sk.INTERVALS) + " seconds."
        )
    return value


def _picked(raw) -> list[dict]:
    rows = []
    for item in raw or []:
        if isinstance(item, dict):
            value, name = str(item.get("value") or ""), str(item.get("name") or "")
        else:
            value, name = str(item), ""
        if value:
            rows.append({"value": value[:255], "name": (name or value)[:255]})
    if len(rows) > MAX_ROWS:
        raise ActionError(f"At most {MAX_ROWS} rows at a time.")
    return rows


def _key(link, seed: str, row: str = "") -> str:
    digest = hashlib.sha1(f"{link.id}:{seed}:{row}".encode()).hexdigest()[:12]
    return f"{KEY_PREFIX}{digest}"


def plan_instances(link: PrtgDeviceLink, data: dict, *, mode: str, v2=None) -> list[dict]:
    """What the request asks for, validated, as the writer's sensor
    instances (one per picked scan row for a scanned kind)."""
    raw_kind = str(data.get("kind") or "").strip()
    if not raw_kind:
        raise ActionError("Pick a sensor kind.")
    value, kindid = _kindid(raw_kind)
    if value is None and raw_kind in sk.BY_VALUE:
        raise ActionError(f"A {sk.label(raw_kind)} is added through a device template.")
    name = str(data.get("name") or "").strip()[:255]
    interval = _interval(data.get("interval_seconds"))
    tags = [MANUAL_TAG, *_tags(data.get("tags"))]
    picked = _picked(data.get("interfaces") or data.get("rows"))
    seed = str(data.get("request_id") or "").strip()[:64] or json.dumps(
        [raw_kind, data.get("params"), name, interval, tags, picked],
        sort_keys=True, default=str,
    )
    base = {"interval_seconds": interval, "required": False, "definition": None,
            "profile": "", "interface": None}

    if value is not None:
        spec = sk.BY_VALUE[value]
        try:
            params = sk.clean_params(value, data.get("params"))
        except ValueError as exc:
            detail = exc.args[0] if exc.args else {}
            err = ActionError(" ".join(
                str(v) if not isinstance(v, dict) else " ".join(map(str, v.values()))
                for v in (detail.values() if isinstance(detail, dict) else [detail])
            ))
            err.fields = detail
            raise err from None
        if value == "http":
            scheme = params.get("scheme") or "http"
            port = sk.port_of(value, params)
            suffix = f":{port}" if port and port != (443 if scheme == "https" else 80) else ""
            params["url"] = f"{scheme}://{link.host}{suffix}{params.get('path') or '/'}"
        base.update(kind=value, kind_label=spec.label, params=params)
        if value in SCANNED:
            if mode != PrtgConnection.WRITE_V2:
                raise ActionError(f"{spec.label} needs API v2 writes (PRTG 26.2.120 or later).")
            if not picked:
                raise ActionError("Pick at least one interface from the scan.")
            return [{
                **base, "key": _key(link, seed, row["value"]),
                "name": (name or spec.default_name).replace("{interface}", row["name"]),
                "tags": tags, "scan_values": [row["value"]],
                "interface": {"id": None, "name": row["name"]},
            } for row in picked]
        default = spec.default_name.format_map(_Blank(params))
        return [{**base, "key": _key(link, seed), "name": name or default.strip() or spec.label,
                 "tags": tags}]

    # A kind only PRTG knows: its own form.
    if mode != PrtgConnection.WRITE_V2:
        raise ActionError(
            "Only Danbyte's own kinds can be added here: this PRTG creates sensors as "
            "copies of the seed device's."
        )
    form = schema_fields(link, kindid, v2=v2)
    sections = clean_generic(form["fields"], data.get("params"))
    base.update(kind=kindid, kindid=kindid, kind_label=str(data.get("kind_label") or kindid),
                params={}, sections=sections, metascan=form["scan"])
    if form["scan"]:
        if not picked:
            raise ActionError("Pick at least one row from the scan.")
        return [{**base, "key": _key(link, seed, row["value"]), "name": name,
                 "tags": tags, "scan_values": [row["value"]]} for row in picked]
    return [{**base, "key": _key(link, seed), "name": name, "tags": tags}]


class _Blank(dict):
    def __missing__(self, key):
        return ""


def add_sensor(link: PrtgDeviceLink, data: dict, user, *, classic=None, v2=None) -> dict:
    """Create what ``data`` asks for on the linked device now. Returns
    ``{detail, objids, sensors}`` - the new rows as the re-read imported
    them."""
    conn = link.connection
    _usable(conn)
    classic, v2 = _clients(conn, classic, v2)
    mode = write_mode(conn, v2=v2)
    if mode == PrtgConnection.WRITE_NONE:
        raise ActionError(conn.write_detail or NO_WRITES)
    obj = link.device or link.virtual_machine
    if obj is None or obj.tenant_id != conn.tenant_id:
        raise ActionError("The link names no device or VM in this tenant.")
    insts = plan_instances(link, data, mode=mode, v2=v2)
    if link.virtual_machine_id:
        obj._prtg_vm = True
    change = PrtgChange(tenant=conn.tenant, connection=conn, kind=PrtgChange.ADD_SENSOR,
                        device=link.device, virtual_machine=link.virtual_machine,
                        key=insts[0]["key"], detail={"manual": True})
    w = Writer(change, user=user, classic=classic, v2=v2)
    if not _lock(conn):
        raise ActionError("Danbyte is writing to this PRTG right now; try again in a moment.",
                          409)
    objids, failures = [], []
    try:
        for inst in insts:
            try:
                objids.append(w.create_sensor(link.objid, inst, link))
            except (Refused, PrtgError) as exc:
                failures.append(f"{inst.get('name') or inst['kind_label']}: {exc}")
        if objids:
            w.refresh(link)
    finally:
        _unlock(conn)
    label = insts[0].get("name") or insts[0]["kind_label"]
    if objids:
        what = label if len(objids) == 1 else f"{len(objids)} {insts[0]['kind_label']} sensors"
        sentence = f"Added {what} in PRTG by hand."
    else:
        sentence = f"Adding {label} in PRTG failed."
    if failures:
        sentence += " Failed: " + "; ".join(failures)
    if objids or w.steps or failures:
        record(obj, (sentence + (" " + " ".join(w.steps) if w.steps else ""))[:2000], user)
        link.last_apply = {"at": timezone.now().isoformat(), "kind": PrtgChange.ADD_SENSOR,
                           "ok": not failures, "detail": sentence[:400],
                           "result": {"sensors": objids, "manual": True},
                           "by": getattr(user, "get_username", lambda: "")()}
        link.save(update_fields=["last_apply"])
    if not objids:
        raise ActionError(sentence[:400], 502 if failures else 400)
    sensors = PrtgSensor.objects.filter(connection=conn, objid__in=objids)
    return {"detail": sentence, "objids": objids, "sensors": list(sensors),
            "failed": failures}


# ── discovery ───────────────────────────────────────────────────────────────


def templates(conn: PrtgConnection, *, refresh: bool = False, v2=None) -> dict:
    """PRTG's device templates (API v2), cached for a day; Danbyte's short
    list of PRTG's stock ones when they cannot be read."""
    _usable(conn)
    now = timezone.now()
    entry = (conn.sensor_catalog or {}).get("templates")
    if refresh or _stale(entry, now):
        _, v2 = _clients(conn, v2=v2)
        try:
            rows = [
                {"file_name": str(t.get("file_name") or ""), "name": str(t.get("name") or ""),
                 "id": str(t.get("id") or "")}
                for t in v2.device_templates() if t.get("file_name")
            ]
            entry = {"read_at": now.isoformat(), "rows": sorted(rows, key=lambda t: t["name"])}
            _keep(conn, "templates", entry)
        except PrtgError:
            if not (entry and entry.get("rows")):
                return {"source": "defaults", "read_at": None, "templates": [
                    {"file_name": f, "name": n, "id": ""} for f, n in DEFAULT_TEMPLATES
                ]}
    return {"source": "prtg", "read_at": entry.get("read_at"), "templates": entry["rows"]}


_TEMPLATE = re.compile(r"^[^\"',\\/]{1,120}$")


def discover(link: PrtgDeviceLink, template: str, user, *, classic=None) -> dict:
    """Run PRTG's auto-discovery on the device now, with ``template`` (a
    device template file name) or the device's own templates."""
    conn = link.connection
    _usable(conn)
    template = (template or "").strip()
    if template and not _TEMPLATE.match(template):
        raise ActionError("A template is a file name such as Device Generic SNMP.odt.")
    classic = classic or PrtgClient.for_connection(conn)
    try:
        classic.discover_now(int(link.objid), [template] if template else [])
    except PrtgError as exc:
        raise ActionError(f"PRTG did not start the discovery: {exc}"[:400], 502) from None
    obj = link.device or link.virtual_machine
    sentence = (f"Ran PRTG auto-discovery on {link.name or link.objid}"
                + (f" with template {template}." if template else "."))
    record(obj, sentence, user)
    return {"detail": sentence + " What PRTG finds arrives with the next status read."}
