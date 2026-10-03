"""MAC tracking, write side (#284).

A poll's forwarding table (``fdb``) and ARP table (``arp``) become
:class:`~monitoring.models.MacSighting` / :class:`~monitoring.models.ArpSighting`
rows here, and nowhere else. ``persist_snmp_result`` calls
:func:`record_mac_tables`, so a local poll, an Outpost's result and a
background refresh all write the same way.

What a poll writes, in one transaction under an advisory lock on the polled
device (two polls of one device never diff at the same time):

1. The core-side filter - the switch's own and invalid entries, group and
   all-zero MACs, the device's own interface MACs - then each row mapped to
   the stack member and Danbyte interface that own its port, through the
   same observed-name matching drift uses.
2. New ``(port, VLAN, MAC)`` keys open rows; rows still reported get
   ``last_seen = now``.
3. A **complete** read closes the rows it no longer reports (``gone_at``).
   An incomplete one - a budget or row cap hit, a walk error, an agent that
   could not say - closes nothing.
4. Rows whose member, interface or ifIndex changed are rewritten; nothing
   else is.

So writes scale with churn, not with the size of the table. An unreachable
poll writes nothing (#153).

The result shape is ``danbyte_checks.snmp_facts.fetch_snmp``'s. A result
without ``fdb_meta`` comes from an agent that predates MAC tracking: no VLAN,
the filter runs here, and the read counts as complete only when it returned
rows.
"""
from __future__ import annotations

import hashlib
import ipaddress
import logging
import re
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import timedelta

from django.db import connection, transaction
from django.db.models import CharField, Func, Value
from django.db.models.functions import Lower
from django.utils import timezone

try:  # The collector's own filter, so old agents' rows get exactly the same one.
    from danbyte_checks.snmp_facts import mac_drop_reason as _shared_drop_reason
    from danbyte_checks.snmp_facts import own_macs as _shared_own_macs
except ImportError:  # a danbyte_checks from before MAC tracking
    _shared_drop_reason = _shared_own_macs = None

log = logging.getLogger("monitoring.mac_tables")

#: A present row whose device has not completed a read for this long reads as
#: stale ("seen 3 days ago") instead of current.
STALE_AFTER = timedelta(hours=24)

#: Tenant settings and their defaults, for tenants with no settings row yet.
MAC_SETTING_DEFAULTS = {
    "mac_port_display_limit": 4,
    "mac_uplink_threshold": 4,
    "mac_uplink_lldp": True,
    "mac_retention_days": 30,
}

_BATCH = 5000
_HEX = re.compile(r"[^0-9a-f]")
_HEX_ONLY = re.compile(r"^[0-9a-f]{12}$")

# dot1dTpFdbStatus / dot1qTpFdbStatus.
_FDB_STATUS = {"1": "other", "2": "invalid", "3": "learned", "4": "self", "5": "mgmt"}
_FDB_DROP = {"invalid", "self"}

# LLDP-MIB LldpSystemCapabilitiesMap, bit order (BITS, most significant
# bit of the first octet is bit 0).
_CAP_BITS = (
    "other", "repeater", "bridge", "wlan", "router", "telephone", "docsis", "station",
)
_CAP_ALIASES = {
    "wlanaccesspoint": "wlan", "wlan-access-point": "wlan", "accesspoint": "wlan",
    "access-point": "wlan", "ap": "wlan", "w": "wlan",
    "phone": "telephone", "tel": "telephone", "t": "telephone",
    "docsiscabledevice": "docsis", "c": "docsis",
    "stationonly": "station", "station-only": "station", "s": "station",
    "switch": "bridge", "b": "bridge", "r": "router", "p": "repeater", "o": "other",
}


# ─── MAC and value helpers ───────────────────────────────────────────────────


def hexkey(value) -> str:
    """Separator-insensitive lowercase hex (``AA-BB`` == ``aa:bb`` == ``aabb``)."""
    return _HEX.sub("", str(value or "").lower())


def canon_mac(value) -> str | None:
    """``00:1b:44:11:3a:b7`` for any notation of a MAC - colons, dashes,
    Cisco dots, bare hex, pysnmp's ``0x…``, unpadded octets - or ``None``
    when it isn't one."""
    s = str(value or "").strip().lower()
    if s.startswith("0x"):
        s = s[2:]
    parts = re.split(r"[:\-]", s)
    if len(parts) == 6 and all(1 <= len(p) <= 2 for p in parts):
        key = "".join(p.zfill(2) for p in parts)
    else:
        key = _HEX.sub("", s)
    if not _HEX_ONLY.match(key):
        return None
    return ":".join(key[i:i + 2] for i in range(0, 12, 2))


def is_group_mac(mac: str) -> bool:
    """The I/G bit: multicast and broadcast (01:00:5e…, 33:33…, 01:80:c2…)."""
    return bool(int(mac[:2], 16) & 0x01)


def _usable_mac(mac: str | None) -> bool:
    return bool(mac) and mac != "00:00:00:00:00:00" and not is_group_mac(mac)


def own_macs(interfaces) -> set:
    """The polled device's own interface addresses (ifPhysAddress)."""
    if _shared_own_macs is not None:
        return set(_shared_own_macs(interfaces))
    own = {canon_mac(o.get("mac")) for o in interfaces or ()}
    own.discard(None)
    own.discard("00:00:00:00:00:00")
    return own


def mac_drop_reason(mac: str, own) -> str:
    """``"group"`` (I/G bit or all-zero), ``"own"`` (one of the device's own
    addresses) or ``""`` for a learned host - the collector's rule, which the
    core runs again on rows from agents that predate it."""
    if _shared_drop_reason is not None:
        return _shared_drop_reason(mac, own)
    if mac == "00:00:00:00:00:00" or is_group_mac(mac):
        return "group"
    return "own" if mac in own else ""


def fdb_status(value) -> str:
    """dot1d/dot1qTpFdbStatus as a name - ``learned``, ``mgmt``, ``other``,
    ``self``, ``invalid`` - or ``""`` when the agent gave none."""
    s = re.sub(r"\(\d+\)$", "", str(value or "").strip().lower())
    if s in _FDB_STATUS:
        return _FDB_STATUS[s]
    return s if s in _FDB_STATUS.values() else ""


def _arp_invalid(value) -> bool:
    s = re.sub(r"\(\d+\)$", "", str(value or "").strip().lower())
    return s in ("2", "invalid")


def _vid(value) -> int | None:
    try:
        vid = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    return vid if 1 <= vid <= 4094 else None


def _int_or_none(value) -> int | None:
    try:
        n = int(str(value).strip())
    except (TypeError, ValueError):
        return None
    return n if 0 <= n <= 2_147_483_647 else None


def parse_caps(value) -> list[str]:
    """LLDP system capabilities as names, whatever shape the agent sent:
    a list of names, ``"bridge, telephone"``, ``"bridge(2) router(4)"``, or
    the raw BITS octets (``"0x2400"``)."""
    if not value:
        return []
    names: list[str] = []
    if isinstance(value, (list, tuple, set)):
        raw = [str(v) for v in value]
    elif isinstance(value, (bytes, bytearray)):
        return _caps_from_bits(bytes(value))
    else:
        s = str(value).strip()
        if s.lower().startswith("0x"):
            try:
                return _caps_from_bits(bytes.fromhex(s[2:]))
            except ValueError:
                return []
        raw = re.split(r"[,;|\s]+", s)
    for item in raw:
        tok = re.sub(r"\(\d+\)$", "", item.strip().lower())
        if not tok:
            continue
        tok = _CAP_ALIASES.get(tok, tok)
        if tok in _CAP_BITS and tok not in names:
            names.append(tok)
    return names


def _caps_from_bits(octets: bytes) -> list[str]:
    out = []
    for i, name in enumerate(_CAP_BITS):
        byte = i // 8
        if byte < len(octets) and octets[byte] & (0x80 >> (i % 8)):
            out.append(name)
    return out


def caps_say_switch(caps) -> bool:
    """A bridge or router that is not a telephone - an IP phone advertises
    bridge + telephone and must stay an access port."""
    caps = set(caps or ())
    return bool(caps & {"bridge", "router"}) and "telephone" not in caps


def hex_expr(field: str):
    """SQL: the hex digits of a free-text MAC column, lowercased - so one
    ``__in`` matches every notation the column may hold."""
    return Func(
        Lower(field), Value("[^0-9a-f]"), Value(""), Value("g"),
        function="regexp_replace", output_field=CharField(),
    )


def filter_hex(qs, field: str, keys):
    """``qs`` rows whose ``field`` is one of the MACs in ``keys`` (hex keys
    or any notation)."""
    wanted = sorted({hexkey(k) for k in keys} - {""})
    if not wanted:
        return qs.none()
    return qs.annotate(_mac_hex=hex_expr(field)).filter(_mac_hex__in=wanted)


def mac_settings(tenant) -> dict:
    """The tenant's MAC-tracking settings - one plain read, no get-or-create
    (the same rule as ``snmp_drift._snmp_policy``)."""
    from .models import MonitoringSettings

    tid = getattr(tenant, "pk", tenant)
    row = (
        MonitoringSettings.objects.filter(tenant_id=tid)
        .values(*MAC_SETTING_DEFAULTS)
        .first()
    )
    return {**MAC_SETTING_DEFAULTS, **(row or {})}


def legacy_state(state) -> bool:
    """True while the MAC pipeline has never processed this ``DeviceSnmp`` row
    - it was polled before 0.17, so its JSON ``fdb`` / ``arp`` are still the
    only MAC data it has. The next poll writes ``fdb_meta`` and ends that."""
    return state is not None and not (state.fdb_meta or {})


def polled_id_for(state):
    """The device whose sightings describe ``state``'s observation: the
    stack owner when ``state`` is a member's own poll (an Outpost polls every
    member), else the state's device."""
    device = state.device if state.device_id else None
    if device is None:
        return None
    if not device.virtual_chassis_id:
        return device.id
    return stack_of(device)[0].id


def is_stale(read_at, now=None) -> bool:
    if read_at is None:
        return True
    return read_at < (now or timezone.now()) - STALE_AFTER


# ─── stacks and port mapping ─────────────────────────────────────────────────


@dataclass(frozen=True)
class PortRef:
    """Where an observed ifIndex lands in Danbyte."""

    member_id: object
    interface_id: object
    key: str
    name: str


def port_key_of(row: dict) -> str:
    return str(row.get("name") or row.get("descr") or "").strip().lower()[:128]


def stack_of(device):
    """``(owner, members)`` for ``device``'s stack - only the tenant's own
    members, owner by the ``vc_stack`` rule (the master while it is a member,
    else the lowest position). A standalone device is ``(device, [device])``."""
    from api.models import Device, VirtualChassis

    if not device.virtual_chassis_id:
        return device, [device]
    members = list(
        Device.objects.filter(
            tenant_id=device.tenant_id, virtual_chassis_id=device.virtual_chassis_id
        )
        .select_related("device_type")
        .order_by("vc_position", "name")
    )
    if not members:
        return device, [device]
    master_id = (
        VirtualChassis.objects.filter(
            pk=device.virtual_chassis_id, tenant_id=device.tenant_id
        )
        .values_list("master_id", flat=True)
        .first()
    )
    owner = next((m for m in members if m.id == master_id), members[0])
    return owner, members


def port_map(owner, members, observed: list[dict]) -> dict[str, PortRef]:
    """``{ifIndex: PortRef}`` for one observation: the stack member a row
    belongs to (``vc_stack.partition_observed``), then the interface it means
    on that member (``snmp_drift._intent_by_observed_name`` +
    ``_match_observed``) - the chain drift uses, so SNMP name links hold here
    too."""
    from api.models import Interface

    from .snmp_drift import _intent_by_observed_name, _match_observed
    from .vc_stack import partition_observed

    rows = [o for o in observed or [] if str(o.get("if_index") or "").strip()]
    if not rows:
        return {}
    if len(members) > 1:
        groups = partition_observed(rows, members, owner)
    else:
        groups = {owner.id: rows}
    by_member: dict = defaultdict(list)
    for iface in Interface.objects.filter(device_id__in=list(groups)).only(
        "id", "device_id", "name", "snmp_name"
    ):
        by_member[iface.device_id].append(iface)
    out: dict[str, PortRef] = {}
    for member_id, member_rows in groups.items():
        int_by_name = _intent_by_observed_name(by_member.get(member_id, []))
        for o in member_rows:
            idx = str(o.get("if_index") or "").strip()
            key = port_key_of(o)
            if not key:
                continue
            iface = _match_observed(o, int_by_name)
            name = str(o.get("name") or o.get("descr") or "").strip()[:128]
            out[idx] = PortRef(member_id, iface.id if iface else None, key, name)
    return out


def _lldp_by_port(neighbors, observed, pm) -> dict[str, dict]:
    """``{port_key: {name, caps, switch}}`` - the LLDP neighbour on each port.

    The local port is ``local_if_index`` when the agent resolved one, else the
    ``local_port`` text matched against the observed ifName/ifDescr. Where a
    port has several neighbours the switch-like one is kept."""
    by_idx = {str(o.get("if_index") or "").strip(): o for o in observed or []}
    name_to_key: dict[str, str] = {}
    for o in observed or []:
        for n in (o.get("name"), o.get("descr")):
            if n:
                name_to_key.setdefault(str(n).strip().lower(), port_key_of(o))
    out: dict[str, dict] = {}
    for n in neighbors or []:
        remote = str(n.get("remote_device") or "").strip()
        if not remote:
            continue
        key = None
        li = str(n.get("local_if_index") or "").strip()
        if li:
            if li in pm:
                key = pm[li].key
            elif li in by_idx:
                key = port_key_of(by_idx[li])
        if not key:
            key = name_to_key.get(str(n.get("local_port") or "").strip().lower())
        if not key:
            continue
        caps = parse_caps(n.get("remote_caps"))
        entry = {"name": remote[:255], "caps": caps, "switch": caps_say_switch(caps)}
        cur = out.get(key)
        if cur is None or (entry["switch"] and not cur["switch"]):
            out[key] = entry
    return out


def _lag_by_port(observed) -> dict[str, str]:
    out: dict[str, str] = {}
    for o in observed or []:
        key = port_key_of(o)
        if not key:
            continue
        if str(o.get("type_name") or "") == "lag":
            out[key] = "aggregate"
        elif str(o.get("lag_if_index") or "").strip():
            out[key] = "member"
    return out


def build_mac_ports(port_macs: dict, port_meta: dict, lldp: dict, lag: dict) -> dict:
    """The per-port summary stored on ``DeviceSnmp.mac_ports`` (§4.3).

    ``port_macs`` is ``{port_key: set(mac)}``, ``port_meta``
    ``{port_key: (if_index, name)}``. A port is listed when it learned a MAC,
    has an LLDP neighbour or is in a LAG - the inputs of the uplink rules,
    which combine it with the live interface flags and settings on read."""
    out: dict[str, dict] = {}
    for key in set(port_macs) | set(lldp) | set(lag):
        if_index, name = port_meta.get(key, ("", ""))
        out[key] = {
            "if_index": if_index,
            "name": name,
            "count": len(port_macs.get(key, ())),
            "lldp": lldp.get(key),
            "lag": lag.get(key),
        }
    return out


def legacy_mac_ports(state) -> dict:
    """:func:`build_mac_ports` from a pre-0.17 row's JSON tables, keyed the
    same way - so a device not re-polled since the upgrade is classified by
    the same uplink rules as one that has been."""
    observed = state.interfaces or []
    by_idx = {str(o.get("if_index") or "").strip(): o for o in observed}
    port_macs: dict[str, set] = defaultdict(set)
    port_meta: dict[str, tuple] = {}
    for row in state.fdb or []:
        idx = str(row.get("if_index") or "").strip()
        mac = canon_mac(row.get("mac"))
        o = by_idx.get(idx)
        if mac is None or o is None or not port_key_of(o):
            continue
        port_macs[port_key_of(o)].add(mac)
        port_meta[port_key_of(o)] = (idx, str(o.get("name") or o.get("descr") or ""))
    pm = {
        idx: PortRef(None, None, port_key_of(o), str(o.get("name") or ""))
        for idx, o in by_idx.items() if idx and port_key_of(o)
    }
    return build_mac_ports(
        port_macs, port_meta, _lldp_by_port(state.neighbors or [], observed, pm),
        _lag_by_port(observed),
    )


# ─── writing ─────────────────────────────────────────────────────────────────


def _lock_key(kind: str, pk) -> int:
    digest = hashlib.blake2b(f"mac-tables:{kind}:{pk}".encode(), digest_size=8).digest()
    return int.from_bytes(digest, "big", signed=True)


def _advisory_lock(key: int) -> None:
    with connection.cursor() as cur:
        cur.execute("SELECT pg_advisory_xact_lock(%s)", [key])


def _update_ids(model, ids, **values) -> int:
    n = 0
    ids = list(ids)
    for i in range(0, len(ids), _BATCH):
        n += model.objects.filter(pk__in=ids[i:i + _BATCH]).update(**values)
    return n


def _scrub(text: str, state) -> str:
    """Never let a credential ride an error message into the API."""
    text = str(text or "")[:500]
    profile = getattr(state, "profile", None)
    secrets = (getattr(profile, "secret_params", None) or {}) if profile else {}
    for value in secrets.values():
        value = str(value or "")
        if len(value) >= 3 and value in text:
            text = text.replace(value, "•••")
    return text


def _agent_meta(meta_in: dict) -> dict:
    """The collector's ``fdb_meta``, cut to the documented keys and sizes."""
    vlans = meta_in.get("vlans") if isinstance(meta_in.get("vlans"), dict) else {}

    def _vids(value) -> list:
        return [v for v in (_vid(x) for x in (value or [])) if v is not None][:512]

    dropped = meta_in.get("dropped") if isinstance(meta_in.get("dropped"), dict) else {}
    return {
        "source": str(meta_in.get("source") or "none")[:16],
        "truncated": bool(meta_in.get("truncated")),
        "vlan_map": str(meta_in.get("vlan_map") or "")[:16],
        "port_map": str(meta_in.get("port_map") or "")[:16],
        "vlans": {k: _vids(vlans.get(k)) for k in ("read", "skipped", "failed")},
        "dropped": {
            str(k)[:16]: _int_or_none(v) or 0 for k, v in list(dropped.items())[:16]
        },
        "rows": _int_or_none(meta_in.get("rows")) or 0,
        "elapsed_ms": _int_or_none(meta_in.get("elapsed_ms")) or 0,
        "mode": str(meta_in.get("mode") or "")[:8],
    }


def record_mac_tables(state, result: dict) -> dict | None:
    """Turn one persisted poll's MAC and ARP tables into sightings (§5.2).

    ``state`` is the ``DeviceSnmp`` row ``persist_snmp_result`` just saved;
    ``result`` the fetch result it saved. Returns a small summary, or ``None``
    when nothing was written (unreachable, or a stack member whose owner
    records the stack)."""
    from .models import DeviceSnmp

    if state is None or state.pk is None or not state.reachable:
        return None
    now = state.polled_at or timezone.now()
    observed = [o for o in (result.get("interfaces") or []) if isinstance(o, dict)]
    owner = members = None
    if state.device_id:
        device = state.device
        if device.tenant_id != state.tenant_id:  # never write across tenants
            log.warning("MAC tables: %s is not in its state's tenant", device.pk)
            return None
        owner, members = stack_of(device)
        if owner.id != device.id:
            # A member's poll repeats its owner's read (an Outpost polls every
            # member); the stack's table is recorded once, under the owner.
            # Marking the row tells its readers to look there, not at its JSON.
            meta = {"source": "stack", "complete": False, "legacy": False,
                    "error": "", "owner": str(owner.id), "core": {"present": 0}}
            DeviceSnmp.objects.filter(pk=state.pk).update(fdb_meta=meta, mac_ports={})
            state.fdb_meta, state.mac_ports = meta, {}
            return None
        pm = port_map(owner, members, observed)
        lock = _lock_key("device", device.pk)
    else:
        pm = {}
        lock = _lock_key("vm", state.vm_id)

    with transaction.atomic():
        _advisory_lock(lock)
        if owner is not None:
            fdb = _record_fdb(state, owner, members, result, observed, pm, now)
        else:
            fdb = {
                "meta": {"source": "none", "complete": False, "legacy": False,
                         "error": "", "core": {"present": 0}},
                "ports": {}, "complete": False,
            }
        arp = _record_arp(state, members or [], result, pm, now)
        fdb["meta"]["arp"] = arp
        updates = {"fdb_meta": fdb["meta"], "mac_ports": fdb["ports"]}
        if fdb["complete"]:
            updates["fdb_polled_at"] = now
        DeviceSnmp.objects.filter(pk=state.pk).update(**updates)
        for field, value in updates.items():
            setattr(state, field, value)
    return {"fdb": fdb["meta"].get("core", {}), "arp": arp}


def _record_fdb(state, owner, members, result, observed, pm, now) -> dict:
    from .models import MacSighting

    meta_in = result.get("fdb_meta")
    legacy = not isinstance(meta_in, dict)
    raw = [r for r in (result.get("fdb") or []) if isinstance(r, dict)]
    own = own_macs(observed)
    dropped: Counter = Counter()
    reported: dict[tuple, tuple] = {}
    for r in raw:
        mac = canon_mac(r.get("mac"))
        if mac is None:
            dropped["bad"] += 1
            continue
        status = fdb_status(r.get("status"))
        reason = mac_drop_reason(mac, own)
        if reason == "group":
            dropped["group"] += 1
            continue
        if status in _FDB_DROP:
            dropped["self"] += 1
            continue
        if reason:
            dropped[reason] += 1
            continue
        idx = str(r.get("if_index") or "").strip()
        port = pm.get(idx)
        if port is None:
            dropped["unmapped"] += 1
            continue
        vlan = None if legacy else _vid(r.get("vlan"))
        key = (port.key, vlan, mac)
        if key not in reported:
            fdb_id = None if legacy else _int_or_none(r.get("fdb_id"))
            reported[key] = (port, idx, fdb_id, status)

    if legacy:
        meta = {"source": "legacy", "truncated": False, "vlan_map": "none",
                "port_map": "", "vlans": {"read": [], "skipped": [], "failed": []},
                "dropped": {}, "rows": len(raw), "elapsed_ms": 0, "mode": ""}
        complete = bool(raw)
        error = ""
    else:
        meta = _agent_meta(meta_in)
        # Only a literal true closes rows: anything else is no evidence.
        complete = (
            meta_in.get("complete") is True
            and not meta["truncated"]
            and meta["source"] != "none"
        )
        error = _scrub(meta_in.get("error") or "", state)
    if raw and not observed:
        # Without the interface table no row can be placed - a failed
        # ifTable walk is no evidence that every MAC left.
        complete = False
        error = error or "The interface table was not read; nothing was closed."
    meta.update({"complete": complete, "legacy": legacy, "error": error})
    # VLANs the agent left out of this read - over the VLAN cap, or a context
    # that failed. The read can still be complete for everything else, so
    # their rows are neither closed nor refreshed: nobody looked.
    unread = set()
    if not legacy:
        unread = set(meta["vlans"]["skipped"]) | set(meta["vlans"]["failed"])

    present = {
        (pk_, vlan, mac): (sid, device_id, iface_id, if_index, port_name, fdb_id, status)
        for sid, pk_, vlan, mac, device_id, iface_id, if_index, port_name, fdb_id, status
        in MacSighting.objects.filter(
            polled_device=owner, gone_at__isnull=True
        ).values_list(
            "id", "port_key", "vlan_vid", "mac", "device_id", "interface_id",
            "if_index", "port_name", "fdb_id", "status",
        )
    }

    new_rows, seen_ids, changed = [], [], []
    for key, (port, idx, fdb_id, status) in reported.items():
        cur = present.get(key)
        if cur is None:
            new_rows.append(MacSighting(
                tenant_id=state.tenant_id, polled_device=owner,
                device_id=port.member_id, interface_id=port.interface_id,
                port_key=port.key, port_name=port.name, if_index=idx[:16],
                vlan_vid=key[1], fdb_id=fdb_id, mac=key[2], status=status,
                first_seen=now, last_seen=now,
            ))
            continue
        seen_ids.append(cur[0])
        want = (port.member_id, port.interface_id, idx[:16], port.name, fdb_id, status)
        if tuple(cur[1:]) != want:
            changed.append(MacSighting(
                id=cur[0], device_id=want[0], interface_id=want[1], if_index=want[2],
                port_name=want[3], fdb_id=want[4], status=want[5],
            ))
    if new_rows:
        MacSighting.objects.bulk_create(new_rows, batch_size=1000)
    if changed:
        MacSighting.objects.bulk_update(
            changed,
            ["device", "interface", "if_index", "port_name", "fdb_id", "status"],
            batch_size=1000,
        )
    closed = 0
    if complete:
        gone = [v[0] for k, v in present.items() if k not in reported and k[1] not in unread]
        closed = _update_ids(MacSighting, gone, gone_at=now)
        bump = MacSighting.objects.filter(polled_device=owner, gone_at__isnull=True)
        if unread:
            bump = bump.exclude(vlan_vid__in=unread)
            _update_ids(
                MacSighting,
                [present[k][0] for k in reported if k in present and k[1] in unread],
                last_seen=now,
            )
        bump.update(last_seen=now)
        # Rows a previous owner of this stack recorded: this read speaks for
        # the whole stack now.
        others = [m.id for m in members if m.id != owner.id]
        if others:
            stale_owner = MacSighting.objects.filter(
                tenant_id=state.tenant_id, polled_device_id__in=others,
                gone_at__isnull=True,
            )
            if unread:
                stale_owner = stale_owner.exclude(vlan_vid__in=unread)
            closed += stale_owner.update(gone_at=now)
        final = set(reported) | {k for k in present if k[1] in unread}
    else:
        _update_ids(MacSighting, seen_ids, last_seen=now)
        final = set(present) | set(reported)

    port_macs: dict[str, set] = defaultdict(set)
    port_meta: dict[str, tuple] = {}
    for key in final:
        port_macs[key[0]].add(key[2])
        if key[0] not in port_meta and key in present:
            port_meta[key[0]] = (present[key][3], present[key][4])
    for idx, port in pm.items():  # this read's ifIndex and name win
        port_meta[port.key] = (idx, port.name)
    ports = build_mac_ports(
        port_macs, port_meta,
        _lldp_by_port(result.get("neighbors") or [], observed, pm),
        _lag_by_port(observed),
    )
    meta["core"] = {
        "present": len(final), "opened": len(new_rows), "closed": closed,
        "ports": sum(1 for v in ports.values() if v["count"]),
        "dropped": dict(dropped),
    }
    return {"meta": meta, "ports": ports, "complete": complete}


def _record_arp(state, members, result, pm, now) -> dict:
    from .models import ArpSighting

    owner_q = (
        {"device_id": state.device_id} if state.device_id else {"vm_id": state.vm_id}
    )
    rows = [r for r in (result.get("arp") or []) if isinstance(r, dict)]
    reported: dict[tuple, tuple] = {}
    for r in rows:
        if _arp_invalid(r.get("type")):
            continue
        mac = canon_mac(r.get("mac"))
        if not _usable_mac(mac):
            continue
        try:
            ip = str(ipaddress.ip_address(str(r.get("ip") or "").strip()))
        except ValueError:
            continue
        idx = str(r.get("if_index") or "").strip()[:16]
        port = pm.get(idx)
        reported.setdefault((ip, mac), (idx, port.interface_id if port else None))
    arp_meta = result.get("arp_meta")
    if isinstance(arp_meta, dict):
        complete = arp_meta.get("complete") is True
        error = _scrub(arp_meta.get("error") or "", state)
    else:
        # An agent that predates arp_meta: a reachable poll that returned
        # rows counts as a complete read.
        complete = bool(rows)
        error = ""

    present = {
        (ip, mac): (sid, if_index, iface_id)
        for sid, ip, mac, if_index, iface_id in ArpSighting.objects.filter(
            tenant_id=state.tenant_id, gone_at__isnull=True, **owner_q
        ).values_list("id", "ip", "mac", "if_index", "interface_id")
    }
    new_rows, seen_ids, changed = [], [], []
    for key, (idx, iface_id) in reported.items():
        cur = present.get(key)
        if cur is None:
            new_rows.append(ArpSighting(
                tenant_id=state.tenant_id, interface_id=iface_id, if_index=idx,
                ip=key[0], mac=key[1], first_seen=now, last_seen=now, **owner_q,
            ))
            continue
        seen_ids.append(cur[0])
        if (cur[1], cur[2]) != (idx, iface_id):
            changed.append(ArpSighting(id=cur[0], if_index=idx, interface_id=iface_id))
    if new_rows:
        ArpSighting.objects.bulk_create(new_rows, batch_size=1000)
    if changed:
        ArpSighting.objects.bulk_update(changed, ["if_index", "interface"], batch_size=1000)
    closed = 0
    if complete:
        gone = [v[0] for k, v in present.items() if k not in reported]
        closed = _update_ids(ArpSighting, gone, gone_at=now)
        ArpSighting.objects.filter(
            tenant_id=state.tenant_id, gone_at__isnull=True, **owner_q
        ).update(last_seen=now)
        others = [m.id for m in members if m.id != state.device_id]
        if others:
            closed += ArpSighting.objects.filter(
                tenant_id=state.tenant_id, device_id__in=others, gone_at__isnull=True
            ).update(gone_at=now)
        count = len(reported)
    else:
        _update_ids(ArpSighting, seen_ids, last_seen=now)
        count = len(set(present) | set(reported))
    return {"complete": complete, "present": count, "opened": len(new_rows),
            "closed": closed, "error": error}
