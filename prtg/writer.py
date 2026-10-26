"""Writing the plan to PRTG: applying planned changes.

The planning pass (:mod:`prtg.provision`) proposes what PRTG should have;
applying a proposal makes it so. One function per kind:

* ``create_device`` - the device under its group or probe, tagged
  ``danbyte`` and ``danbyte-<uuid>``, the credentials when the connection
  sends them, every planned sensor tagged with its ``danbyte-def-`` tag, the
  device templates run; then the link, marked as created here.
* ``add_sensor`` - one sensor on a linked device.
* ``remove_sensor`` - deletes a sensor **Danbyte created**; any other is
  refused.
* ``move_device`` - moves the device to the group its policy names.
* ``remove_device`` - deletes a device **Danbyte created**, and the link.

How objects are created depends on the server (:func:`write_mode`): API v2
on PRTG 26.2.120 and later; else copies of the connection's seed device and
its sensors (classic ``duplicateobject.htm``); else not at all - the row stays
with the reason.

Every write is retry-safe: progress is kept on the row as it happens, and an
object is looked for by its tag before it is made, so a second apply after a
failure carries on rather than creating twice. Every write leaves a journal
note and a change-log entry on the device or VM. A row that applied stays in
the queue as *Applied* until the next planning pass no longer proposes it.
"""
from __future__ import annotations

import copy
import hashlib
import hmac
import logging

from django.conf import settings
from django.utils import timezone

from monitoring.external.beat import skip_reason

from . import sensor_kinds as sk
from .client import PrtgClient, PrtgError
from .client_v2 import PrtgNotFound, PrtgV2Client, capabilities
from .models import PrtgChange, PrtgConnection, PrtgDeviceLink, PrtgSensor

log = logging.getLogger("prtg.writer")

NO_WRITES = "This PRTG cannot create objects through its API."
#: How long a write-capability answer is trusted before it is asked again.
CHECK_EVERY_SECONDS = 6 * 3600
#: The name the journal gives a write nobody pressed a button for.
SYSTEM_AUTHOR = "PRTG writer"

#: Danbyte's sensor kinds as API v2 creates them: the v2 ``kindid``, the
#: settings section a metascan value goes in (and its field), or None.
V2_KINDS: dict[str, tuple[str, tuple[str, str] | None]] = {
    "ping": ("ping", None),
    "snmp_uptime": ("snmpuptime", None),
    "snmp_cpu": ("snmpcpu", None),
    "snmp_memory": ("snmpmemory", ("memorygroup", "memory")),
    "snmp_traffic": ("snmptraffic", ("traffic", "interfacenumber")),
    "http": ("http", None),
    "ssl_certificate": ("sslcertificate", None),
    "ssl_security": ("ssl", None),
    "wmi_cpu": ("wmiprocessor", None),
    "wmi_memory": ("wmimemory", None),
    "wmi_disk": ("wmidiskspace", None),
    "windows_service": ("wmiservice", ("wmiservicemonitor", "service")),
}
#: SNMP profile protocols as PRTG names them.
AUTH_MODES = {
    "md5": "authpHMACMD596", "sha": "authpHMACSHA96", "sha224": "authpHMACSHA224",
    "sha256": "authpHMACSHA256", "sha384": "authpHMACSHA384", "sha512": "authpHMACSHA512",
}
ENC_MODES = {
    "none": "NoPrivProtocol", "des": "DESPrivProtocol", "aes": "AESPrivProtocol",
    "aes128": "AESPrivProtocol", "aes192": "AES192PrivProtocol",
    "aes256": "AES256PrivProtocol",
}


class Refused(ValueError):
    """The proposal cannot be written as it stands. The row stays."""


# ── capability ──────────────────────────────────────────────────────────────


def check_writes(conn: PrtgConnection, *, client=None, now=None) -> dict:
    """Ask the server what it can create and keep the answer on the
    connection."""
    result = capabilities(conn, client=client)
    conn.write_mode = result["mode"]
    conn.write_detail = result["detail"][:255]
    conn.write_checked_at = now or timezone.now()
    conn.save(update_fields=["write_mode", "write_detail", "write_checked_at"])
    return result


def write_mode(conn: PrtgConnection, *, v2=None) -> str:
    """The stored answer, asked again once it is old or was never asked."""
    now = timezone.now()
    stale = conn.write_checked_at is None or (
        (now - conn.write_checked_at).total_seconds() > CHECK_EVERY_SECONDS
    )
    if stale or not conn.write_mode:
        check_writes(conn, client=v2, now=now)
    elif conn.write_mode == PrtgConnection.WRITE_NONE and conn.seed_device_objid:
        # A seed device named since the last check is a way in.
        check_writes(conn, client=v2, now=now)
    return conn.write_mode


# ── logging ─────────────────────────────────────────────────────────────────


def _actor(user):
    if user is not None and getattr(user, "pk", None):
        return user, user.get_username()
    return None, SYSTEM_AUTHOR


def record(obj, text: str, user=None, *, field: str = "prtg") -> None:
    """A journal note and a change-log entry on the device or VM, so its
    Journal and Change log tabs say what Danbyte did in PRTG."""
    from audit.context import current_request_id
    from audit.models import ChangeAction, ChangeLogEntry, JournalEntry, JournalKind
    from audit.site_capture import entry_site_id

    author, name = _actor(user)
    site = entry_site_id(obj)
    JournalEntry.objects.create(
        tenant_id=obj.tenant_id, created_by=author, author_name=name,
        object_type=obj._meta.label_lower, object_id=str(obj.pk),
        object_site_id=site, kind=JournalKind.INFO, comments=text,
    )
    ChangeLogEntry.objects.create(
        tenant_id=obj.tenant_id, user=author, user_name=name,
        action=ChangeAction.UPDATE, object_type=obj._meta.label_lower,
        object_label=obj._meta.verbose_name.title(), object_id=str(obj.pk),
        object_repr=str(obj)[:255], object_site_id=site,
        changes={field: {"old": None, "new": text[:500]}},
        request_id=current_request_id(),
    )


# ── the clients ─────────────────────────────────────────────────────────────


class Writer:
    """One apply: the connection, both clients and the progress log."""

    def __init__(self, change: PrtgChange, *, user=None, classic=None, v2=None):
        self.change = change
        self.conn = change.connection
        self.user = user
        self.classic = classic or PrtgClient.for_connection(self.conn)
        self.v2 = v2 or PrtgV2Client.for_connection(self.conn)
        self.detail = dict(change.detail or {})
        self.result = dict(self.detail.get("result") or {})
        self.steps: list[str] = []
        self.obj = change.device if change.device_id else change.virtual_machine

    # progress is saved as it happens, so a retry resumes
    def keep(self, **values) -> None:
        self.result.update(values)
        self.detail["result"] = self.result
        self.change.detail = self.detail
        if not self.change._state.adding:
            # A sensor added by hand (prtg.manual) has no queue row: a retry
            # resumes by the sensor's tag instead.
            self.change.save(update_fields=["detail", "updated_at"])

    def step(self, text: str) -> None:
        self.steps.append(text)

    @property
    def mode(self) -> str:
        return write_mode(self.conn, v2=self.v2)

    # ── shared pieces ─────────────────────────────────────────────

    def device_sensors(self, objid) -> list[dict]:
        return self.classic.sensors({"parentid": str(objid)}).rows

    def tagged_device(self, tag: str) -> dict | None:
        rows = self.classic.devices({"tags": f"@tag({tag})"}).rows
        return rows[0] if len(rows) == 1 else None

    def create_sensor(self, device_objid, inst: dict, link: PrtgDeviceLink) -> str:
        """One planned sensor on a device, unless one already carries its
        tag. Returns the sensor id."""
        key = inst["key"]
        for row in self.device_sensors(device_objid):
            if key in (row.get("tags") or []):
                self._remember(link, key, str(row["objid"]), row.get("name", ""))
                return str(row["objid"])
        tags = _sensor_tags(inst)
        kind = inst["kind"]
        if self.mode == PrtgConnection.WRITE_V2:
            objid = self._create_v2(device_objid, inst, tags)
        else:
            objid = self._create_seed(device_objid, inst, tags)
        if inst.get("interval_seconds"):
            self.classic.set_interval(objid, inst["interval_seconds"])
        self._remember(link, key, objid, inst.get("name", ""))
        label = inst.get("name") or inst.get("kind_label") or sk.label(kind)
        self.step(f"Created sensor {label} ({objid}).")
        return objid

    def _create_v2(self, device_objid, inst: dict, tags: list) -> str:
        kind = inst["kind"]
        spec = V2_KINDS.get(kind)
        if spec is None and inst.get("kindid"):
            return self._create_v2_generic(device_objid, inst, tags)
        if spec is None:
            raise Refused(f"Danbyte cannot create a {sk.label(kind)} sensor.")
        kindid, scan = spec
        params = inst.get("params") or {}
        body: dict = {"basic": {"tags": tags}}
        if scan is None:
            body["basic"]["name"] = inst.get("name") or sk.label(kind)
        if kind == "http" and params.get("url"):
            body["httpspecific"] = {"httpurl": params["url"]}
        if kind == "ssl_certificate" and params.get("port"):
            body["exespecific"] = {"port": int(params["port"])}
        if scan is not None:
            section, field = scan
            # A sensor added by hand carries the scan rows the operator picked.
            values = inst.get("scan_values") or self._scan_values(device_objid, kindid, inst)
            body[section] = {field: list(values)}
        objid = self.v2.create_sensor(device_objid, kindid, body)
        if scan is not None and inst.get("name"):
            # A scanned kind takes its name from what it found; Danbyte's
            # name is set after.
            self.v2.update_sensor(objid, {"name": inst["name"], "tags": tags})
        return objid

    def _create_v2_generic(self, device_objid, inst: dict, tags: list) -> str:
        """A PRTG sensor kind Danbyte has no form of its own for: the
        settings sections from PRTG's schema as the operator filled them in
        (:func:`prtg.manual.clean_generic`), plus Danbyte's tags."""
        kindid = inst["kindid"]
        body = copy.deepcopy(inst.get("sections") or {})
        basic = body.setdefault("basic", {})
        basic["tags"] = tags
        scan = inst.get("metascan")
        scanned = bool(scan and inst.get("scan_values"))
        if scanned:
            body.setdefault(scan["section"], {})[scan["field"]] = list(inst["scan_values"])
        elif inst.get("name"):
            basic["name"] = inst["name"]
        objid = self.v2.create_sensor(device_objid, kindid, body)
        if scanned and inst.get("name"):
            self.v2.update_sensor(objid, {"name": inst["name"], "tags": tags})
        return objid

    def _scan_values(self, device_objid, kindid: str, inst: dict) -> list:
        rows = self.v2.metascan(device_objid, kindid)
        if not rows:
            raise Refused("PRTG's scan of the device found nothing to monitor.")
        if inst["kind"] == "snmp_memory":
            return [_scan_value(r) for r in rows]
        want = set()
        iface = inst.get("interface") or {}
        params = inst.get("params") or {}
        if iface.get("name"):
            want.add(iface["name"].lower())
        if params.get("interface_name"):
            want.add(str(params["interface_name"]).lower())
        if inst["kind"] == "windows_service" and params.get("service"):
            want.add(str(params["service"]).lower())
        for row in rows:
            values = {str(v).strip().lower() for v in row.values() if v not in (None, "")}
            if want & values or any(
                any(v.endswith(f" {w}") or v.startswith(f"{w} ") for w in want) for v in values
            ):
                return [_scan_value(row)]
        raise Refused(
            f"PRTG's scan of the device has no {', '.join(sorted(want)) or 'match'}."
        )

    def _create_seed(self, device_objid, inst: dict, tags: list) -> str:
        kind = sk.BY_VALUE.get(inst["kind"])
        if kind is None or kind.per == sk.PER_INTERFACE or V2_KINDS.get(
            inst["kind"], ("", None)
        )[1]:
            raise Refused(
                f"{sk.label(inst['kind'])} needs PRTG 26.2.120 or later: a copied "
                "sensor keeps the original's interface or item."
            )
        seed = self.conn.seed_device_objid
        if not seed:
            raise Refused(NO_WRITES)
        source = next(
            (r for r in self.device_sensors(seed) if kind.matches_type(r.get("kind", ""))),
            None,
        )
        if source is None:
            raise Refused(f"The seed device has no {kind.label} sensor to copy.")
        name = inst.get("name") or kind.label
        objid = self.classic.duplicate(source["objid"], name, device_objid)
        self.classic.set_property(objid, "tags", " ".join(tags))
        params = inst.get("params") or {}
        if inst["kind"] == "http" and params.get("url"):
            self.classic.set_property(objid, "httpurl", params["url"])
        if inst["kind"] in ("ssl_certificate", "ssl_security") and params.get("port"):
            self.classic.set_property(objid, "port", int(params["port"]))
        self.classic.resume(objid)
        return objid

    def _remember(self, link, key: str, objid: str, name: str) -> None:
        created = dict(link.created_sensors or {})
        created[key] = {"objid": str(objid), "name": name,
                        "created_at": timezone.now().isoformat()}
        link.created_sensors = created
        link.save(update_fields=["created_sensors"])
        sensors = dict(self.result.get("sensors") or {})
        sensors[key] = str(objid)
        self.keep(sensors=sensors)

    def refresh(self, link) -> None:
        """Read the device's sensors now, so the next plan sees them."""
        from .reader import write_sensors

        try:
            rows = self.device_sensors(link.objid)
        except PrtgError:
            return
        write_sensors(self.conn, [link], rows, timezone.now())

    def delete_object(self, objid, *, device: bool) -> bool:
        """Delete through API v2 where it writes, else the classic call."""
        if self.mode == PrtgConnection.WRITE_V2:
            return (self.v2.delete_device if device else self.v2.delete_sensor)(objid)
        try:
            self.classic.delete(int(objid))
        except PrtgError as exc:
            if "cannot be used" in str(exc) or "not found" in str(exc).lower():
                return False
            raise
        return True


def _sensor_tags(inst: dict) -> list:
    tags = ["danbyte", *(inst.get("tags") or []), inst["key"]]
    out: list = []
    for t in tags:
        t = str(t).strip().replace(" ", "-")
        if t and t not in out:
            out.append(t)
    return out


def _scan_value(row: dict) -> str:
    for name in ("interfacenumber", "value", "id"):
        for k, v in row.items():
            if k.lower() == name:
                return str(v)
    return str(next(iter(row.values())))


# ── credentials ─────────────────────────────────────────────────────────────


def credential_sections(obj, tenant) -> tuple[dict, list[str]]:
    """The device settings sections that carry the credentials Danbyte
    holds for ``obj``, and their names for the log (never the secrets)."""
    from .provision import _is_vm

    sections: dict = {}
    names: list[str] = []
    from monitoring.snmp_resolve import resolve_device_profile, resolve_vm_profile

    profile, _ = (resolve_vm_profile if _is_vm(obj) else resolve_device_profile)(obj, tenant)
    if profile is not None:
        params = profile.params or {}
        secret = profile.secret_params or {}
        snmp: dict = {"_inherited": False}
        if params.get("port"):
            snmp["snmpport"] = int(params["port"])
        if profile.version == "v3":
            snmp.update({
                "snmpversion": "V3",
                "snmpuser": secret.get("username") or params.get("username") or "",
                "snmpauthmode": AUTH_MODES.get(str(params.get("auth_proto", "sha")).lower(),
                                               "authpHMACSHA96"),
                "snmpauthpass": secret.get("auth_key", ""),
                "snmpencmode": ENC_MODES.get(
                    str(params.get("priv_proto", "aes" if secret.get("priv_key") else "none"))
                    .lower(), "AESPrivProtocol"),
                "snmpencpass": secret.get("priv_key", ""),
                "snmpcontext": params.get("context", "") or "",
            })
        else:
            field = "snmpcommv1" if profile.version == "v1" else "snmpcommv2"
            snmp.update({
                "snmpversion": "V1" if profile.version == "v1" else "V2",
                field: secret.get("community") or params.get("community") or "public",
            })
        sections["snmpversiongroup"] = snmp
        names.append(f"SNMP {profile.name}")
    from monitoring.models import DeviceCredential

    kind = getattr(DeviceCredential.Kind, "WINDOWS_LOGIN", None)
    if kind is not None and not _is_vm(obj):
        cred = DeviceCredential.objects.filter(device=obj, kind=kind).order_by("name").first()
        if cred is not None:
            secret = cred.resolve_secret()
            user = cred.username or ""
            domain, _, login = user.rpartition("\\")
            sections["windowsconnection"] = {
                "_inherited": False, "windowslogindomain": domain,
                "windowsloginusername": login or user,
                "windowsloginpassword": secret.get("password", ""),
            }
            names.append(f"Windows {cred.name}")
    return sections, names


def credentials_hash(sections: dict) -> str:
    """A keyed hash of what was written: compares, never reveals."""
    import json

    data = json.dumps(sections, sort_keys=True, default=str).encode()
    return hmac.new(settings.SECRET_KEY.encode(), data, hashlib.sha256).hexdigest()


def send_credentials(w: Writer, objid: str, link) -> list[str]:
    sections, names = credential_sections(w.obj, w.conn.tenant)
    if not sections:
        return []
    if w.mode == PrtgConnection.WRITE_V2:
        w.v2.update_device(objid, sections)
    else:
        # The classic API takes the same names as properties; each
        # section's inheritance switch is the section name with "_".
        for section, values in sections.items():
            for name, value in values.items():
                if not name.startswith("_"):
                    w.classic.set_property(objid, name, value)
            w.classic.set_property(objid, f"{section}_", 0)
    link.credentials_hash = credentials_hash(sections)
    link.save(update_fields=["credentials_hash"])
    w.step(f"Set credentials: {', '.join(names)}.")
    return names


# ── one function per kind ───────────────────────────────────────────────────


def _owner(w: Writer):
    if w.obj is None:
        raise Refused("This proposal names no device or VM.")
    if w.obj.tenant_id != w.conn.tenant_id:
        raise Refused("The device is not in this connection's tenant.")
    if w.change.virtual_machine_id:
        w.obj._prtg_vm = True
    return w.obj


def _link(w: Writer) -> PrtgDeviceLink:
    from .provision import _parent

    link = PrtgDeviceLink.objects.filter(connection=w.conn, **_parent(w.obj)).first()
    if link is None:
        raise Refused("The object is not linked to a PRTG device any more.")
    return link


def _need_create(w: Writer) -> None:
    if w.mode == PrtgConnection.WRITE_NONE:
        raise Refused(NO_WRITES)


def apply_create_device(w: Writer) -> str:
    from .reader import make_link

    obj = _owner(w)
    _need_create(w)
    d = w.detail
    group = d.get("group") or {}
    if not group.get("objid"):
        raise Refused("No PRTG group to create it in.")
    tag = f"danbyte-{obj.id}"
    tags = ["danbyte", tag]
    objid = w.result.get("device")
    created_here = bool(objid)
    if objid:
        try:
            rows = w.classic.devices({"objid": str(objid)}).rows
        except PrtgError:
            rows = []
        if not rows:
            objid, created_here = None, False
    if not objid:
        found = w.tagged_device(tag)
        if found is not None:
            # Made by an earlier attempt whose answer was lost, or tagged by
            # hand: linked, but only removable when Danbyte recorded it.
            objid = str(found["objid"])
            w.step(f"Found PRTG device {objid} already tagged {tag}.")
        elif w.mode == PrtgConnection.WRITE_V2:
            objid = w.v2.create_device(group["objid"], d.get("name") or obj.name,
                                       d.get("host", ""), tags,
                                       parent_kind=group.get("kind") or "group")
            created_here = True
            w.step(f"Created PRTG device {objid} under {group.get('path') or group['objid']}.")
        else:
            objid = w.classic.duplicate(int(w.conn.seed_device_objid),
                                        d.get("name") or obj.name, int(group["objid"]),
                                        host=d.get("host") or None)
            # The copy brings the seed's sensors along; they are the seed's
            # patterns, not what this device wants.
            for row in w.device_sensors(objid):
                w.classic.delete(int(row["objid"]))
            w.classic.set_property(objid, "tags", " ".join(tags))
            w.classic.resume(objid)
            created_here = True
            w.step(f"Copied seed device {w.conn.seed_device_objid} as {objid}.")
        w.keep(device=str(objid), created_here=created_here)
    created_here = created_here or bool(w.result.get("created_here"))
    remote = {"objid": str(objid), "name": d.get("name") or obj.name,
              "host": d.get("host", ""), "group": group.get("path", ""), "tags": tags}
    link = make_link(w.conn, obj, remote, "created" if created_here else "tag",
                     timezone.now())
    link.created_here = created_here
    link.tagged = True
    link.save(update_fields=["created_here", "tagged"])
    if w.conn.send_credentials and not w.result.get("credentials"):
        names = send_credentials(w, objid, link)
        w.keep(credentials=names or ["none"])
    failures = []
    for inst in d.get("sensors") or []:
        try:
            w.create_sensor(objid, inst, link)
        except (Refused, PrtgError) as exc:
            failures.append(f"{inst.get('name') or inst.get('kind')}: {exc}")
    templates = [t for t in d.get("templates") or [] if t]
    if templates and not w.result.get("templates"):
        w.classic.discover_now(int(objid), templates)
        w.keep(templates=templates)
        w.step(f"Ran device templates {', '.join(templates)}.")
    w.refresh(link)
    if failures:
        raise PrtgError("Created the device; some sensors failed: " + "; ".join(failures))
    return f"Created {obj.name} in PRTG as device {objid}."


def apply_add_sensor(w: Writer) -> str:
    _owner(w)
    _need_create(w)
    link = _link(w)
    if str(w.detail.get("objid") or link.objid) != link.objid:
        raise Refused("The object is linked to another PRTG device now.")
    inst = dict(w.detail.get("sensor") or {})
    if not inst.get("key"):
        inst["key"] = w.change.key
    objid = w.create_sensor(link.objid, inst, link)
    w.refresh(link)
    return f"Added {inst.get('name') or sk.label(inst.get('kind', ''))} ({objid}) in PRTG."


def apply_remove_sensor(w: Writer) -> str:
    _owner(w)
    link = _link(w)
    objid = str((w.detail.get("sensor") or {}).get("objid") or w.change.key)
    created = {v.get("objid"): k for k, v in (link.created_sensors or {}).items()}
    if objid not in created:
        raise Refused(
            f"Danbyte did not create sensor {objid}; it is left alone."
        )
    gone = not w.delete_object(objid, device=False)
    entries = dict(link.created_sensors)
    entries.pop(created[objid], None)
    link.created_sensors = entries
    link.save(update_fields=["created_sensors"])
    PrtgSensor.objects.filter(connection=w.conn, objid=objid).delete()
    w.step(f"Deleted sensor {objid}." if not gone else f"Sensor {objid} was already gone.")
    return f"Removed sensor {objid} from PRTG."


def apply_move_device(w: Writer) -> str:
    _owner(w)
    link = _link(w)
    to = w.detail.get("to") or {}
    if not to.get("objid"):
        raise Refused("No PRTG group to move it to.")
    if w.mode != PrtgConnection.WRITE_V2 and not w.conn.v2_available:
        raise Refused("Moving needs API v2: the classic API has no move call.")
    w.v2.move(link.objid, to["objid"])
    link.group_path = (to.get("path") or "")[:255]
    link.save(update_fields=["group_path"])
    w.step(f"Moved device {link.objid} to {to.get('path') or to['objid']}.")
    return f"Moved {link.name or link.objid} to {to.get('path') or to['objid']} in PRTG."


def apply_remove_device(w: Writer) -> str:
    _owner(w)
    link = _link(w)
    if not link.created_here:
        raise Refused(
            f"Danbyte did not create PRTG device {link.objid}; it is left alone."
        )
    objid, name = link.objid, link.name
    gone = not w.delete_object(objid, device=True)
    link.delete()
    w.step(f"Deleted device {objid}." if not gone else f"Device {objid} was already gone.")
    return f"Removed {name or objid} from PRTG."


APPLY = {
    PrtgChange.CREATE_DEVICE: apply_create_device,
    PrtgChange.ADD_SENSOR: apply_add_sensor,
    PrtgChange.REMOVE_SENSOR: apply_remove_sensor,
    PrtgChange.MOVE_DEVICE: apply_move_device,
    PrtgChange.REMOVE_DEVICE: apply_remove_device,
}


def apply(change: PrtgChange, *, user=None, classic=None, v2=None) -> dict:
    """Write one planned change to PRTG. Returns ``{"detail", "result"}``.

    Raises :class:`Refused` (a ``ValueError``) when it cannot be written as
    it stands - the row stays, with the reason - and
    :class:`~prtg.client.PrtgError` when PRTG refused or could not be
    reached; the row is marked failed and a retry resumes where it stopped.
    """
    conn = change.connection
    reason = skip_reason(conn, "prtg")
    if reason:
        raise Refused(f"PRTG is off for this tenant ({reason}).")
    if not (conn.enabled and conn.api_key_set):
        raise Refused("The PRTG connection is off or has no API key.")
    if change.tenant_id != conn.tenant_id:
        raise Refused("The proposal is not in this connection's tenant.")
    fn = APPLY.get(change.kind)
    if fn is None:
        raise Refused("This proposal is not a write to PRTG.")
    detail = change.detail or {}
    if detail.get("applied"):
        raise Refused("Already applied.")
    if detail.get("applicable") is False:
        raise Refused(detail.get("reason") or "This change cannot be written as it stands.")
    w = Writer(change, user=user, classic=classic, v2=v2)
    now = timezone.now()
    _, by = _actor(user)
    try:
        sentence = fn(w)
    except (Refused, PrtgError, PrtgNotFound) as exc:
        _finish(w, now, by, ok=False, sentence=str(exc)[:400])
        raise
    _finish(w, now, by, ok=True, sentence=sentence)
    return {"detail": sentence, "result": w.result}


def _finish(w: Writer, now, by: str, *, ok: bool, sentence: str) -> None:
    entry = {"at": now.isoformat(), "by": by, "ok": ok, "detail": sentence,
             "steps": w.steps}
    w.detail = dict(w.change.detail or {}) | {"result": w.result}
    history = list(w.detail.get("log") or [])[-9:]
    history.append(entry)
    w.detail["log"] = history
    if ok:
        w.detail["applied"] = {"at": entry["at"], "by": by, "detail": sentence}
        w.detail.pop("last_error", None)
    else:
        w.detail["last_error"] = {"at": entry["at"], "detail": sentence}
    w.change.detail = w.detail
    w.change.save(update_fields=["detail", "updated_at"])
    if w.obj is not None and (ok or w.steps):
        text = sentence if ok else f"PRTG write failed: {sentence}"
        if w.steps:
            text += " " + " ".join(w.steps)
        record(w.obj, text[:2000], w.user)
    from .provision import _parent

    if w.obj is not None:
        link = PrtgDeviceLink.objects.filter(connection=w.conn, **_parent(w.obj)).first()
        if link is not None:
            link.last_apply = {"at": entry["at"], "kind": w.change.kind, "ok": ok,
                               "detail": sentence, "result": w.result, "by": by}
            link.save(update_fields=["last_apply"])
    conn = w.conn
    summary = dict(conn.last_apply_summary or {})
    if conn.last_apply_at is None or (now - conn.last_apply_at).total_seconds() > 60:
        summary = {"applied": 0, "failed": 0}
    summary["applied" if ok else "failed"] = summary.get("applied" if ok else "failed", 0) + 1
    summary["last"] = {"kind": w.change.kind, "ok": ok, "detail": sentence[:300]}
    conn.last_apply_at = now
    conn.last_apply_summary = summary
    conn.save(update_fields=["last_apply_at", "last_apply_summary"])


# ── many at once ────────────────────────────────────────────────────────────


def ready(change: PrtgChange) -> bool:
    """Whether a planned row can be applied without a person deciding."""
    d = change.detail or {}
    return (
        change.planned and not change.ignored and change.kind not in PrtgChange.DESTRUCTIVE
        and d.get("applicable", True) is not False and not d.get("applied")
    )


def apply_ready(conn: PrtgConnection, *, user=None, ids=None) -> dict:
    """Apply every ready planned row of a connection (or those of ``ids``),
    one at a time. Returns per-row results."""
    rows = PrtgChange.pending(conn).filter(kind__in=PrtgChange.PLANNED).select_related(
        "device", "virtual_machine", "connection", "connection__tenant"
    ).order_by("kind", "created_at")
    if ids is not None:
        rows = rows.filter(id__in=ids)
    out = []
    for change in rows:
        if not ready(change):
            continue
        try:
            r = apply(change, user=user)
            out.append({"id": str(change.id), "ok": True, "detail": r["detail"]})
        except (ValueError, PrtgError) as exc:
            out.append({"id": str(change.id), "ok": False, "detail": str(exc)[:400]})
    return {"applied": sum(1 for r in out if r["ok"]),
            "failed": [r for r in out if not r["ok"]], "results": out}


def _lock(conn) -> bool:
    """One writer per connection: a beat that queues twice before the first
    job ran must not create twice. Without Redis it runs unlocked."""
    try:
        import django_rq

        return bool(django_rq.get_connection("low").set(
            f"danbyte-prtg-write:{conn.id}", "1", nx=True, ex=900
        ))
    except Exception:  # noqa: BLE001
        return True


def _unlock(conn) -> None:
    try:
        import django_rq

        django_rq.get_connection("low").delete(f"danbyte-prtg-write:{conn.id}")
    except Exception:  # noqa: BLE001
        pass


def run_auto_apply(connection_id: str) -> dict:
    """The beat's apply: ready planned rows, when the connection allows it.
    Every switch is checked again here."""
    conn = PrtgConnection.objects.filter(pk=connection_id).select_related("tenant").first()
    reason = skip_reason(conn, "prtg")
    if reason:
        return {"skipped": reason}
    if not (conn.enabled and conn.api_key_set and conn.auto_apply_registration):
        return {"skipped": "auto apply off"}
    if not _lock(conn):
        return {"skipped": "already applying"}
    try:
        out = apply_ready(conn)
        conn.last_apply_at = timezone.now()
        conn.save(update_fields=["last_apply_at"])
    finally:
        _unlock(conn)
    log.info("prtg auto apply %s: %s applied, %s failed", conn.name, out["applied"],
             len(out["failed"]))
    return {"applied": out["applied"], "failed": len(out["failed"])}


def change_status(change: PrtgChange) -> str:
    """The queue's status pill: ``ready``, ``attention``, ``applied``,
    ``failed`` or ``decision``."""
    d = change.detail or {}
    if change.kind == PrtgChange.AMBIGUOUS:
        return "decision"
    if d.get("applied"):
        return "applied"
    if d.get("last_error"):
        return "failed"
    if change.kind == PrtgChange.ADOPT:
        from monitoring.external.adoption import applicable

        return "ready" if applicable(d) else "attention"
    if d.get("applicable", True) is False:
        return "attention"
    return "ready"
