"""SNMP system-facts fetch - the read-only *observed* layer for Phase 1 of the
discovery feature (issue #84).

A single SNMP GET of the system MIB (sysDescr/sysObjectID/sysUpTime/sysContact/
sysName/sysLocation), returned as a named dict - never raw OIDs to the caller.
Reuses the v2c/v3 credential shape used by ``monitoring.checkers.snmp`` so an
``SnmpProfile``'s ``params`` + ``secret_params`` work unchanged here.

This is *observed* data: it is stored alongside the device's source-of-truth
fields and never overwrites them (reconciliation is a later phase).
"""
from __future__ import annotations

import asyncio
import re
import time


def _load_pysnmp():
    """The pysnmp asyncio API. One seam, so tests can put an agent behind it."""
    import pysnmp.hlapi.v3arch.asyncio as mod

    return mod


def _monotonic() -> float:
    """The clock MAC-table budgets run on (a seam for tests)."""
    return time.monotonic()


# OID → friendly key. The system group (RFC 1213) is universally implemented.
SYSTEM_OIDS = {
    "1.3.6.1.2.1.1.1.0": "sys_descr",
    "1.3.6.1.2.1.1.2.0": "sys_object_id",
    "1.3.6.1.2.1.1.3.0": "sys_uptime",
    "1.3.6.1.2.1.1.4.0": "sys_contact",
    "1.3.6.1.2.1.1.5.0": "sys_name",
    "1.3.6.1.2.1.1.6.0": "sys_location",
}

_AUTH_PROTOS = {
    "md5": "usmHMACMD5AuthProtocol",
    "sha": "usmHMACSHAAuthProtocol",
    "sha224": "usmHMAC128SHA224AuthProtocol",
    "sha256": "usmHMAC192SHA256AuthProtocol",
    "sha384": "usmHMAC256SHA384AuthProtocol",
    "sha512": "usmHMAC384SHA512AuthProtocol",
}
_PRIV_PROTOS = {
    "des": "usmDESPrivProtocol",
    "aes": "usmAesCfb128Protocol",
    "aes128": "usmAesCfb128Protocol",
    "aes192": "usmAesCfb192Protocol",
    "aes256": "usmAesCfb256Protocol",
}


class SnmpFactsError(Exception):
    """SNMP fetch failed (config error, unreachable, or PDU error)."""


def _auth_data(version, params, secret_params, mod):
    """Mirror of ``SnmpChecker._auth_data`` - build pysnmp auth from the same
    ``params`` / ``secret_params`` shape an ``SnmpProfile`` stores."""
    if version == "v3":
        user = secret_params.get("username") or params.get("username")
        kwargs = {}
        if secret_params.get("auth_key"):
            kwargs["authKey"] = secret_params["auth_key"]
            kwargs["authProtocol"] = getattr(
                mod, _AUTH_PROTOS.get(params.get("auth_proto", "sha"), "usmHMACSHAAuthProtocol")
            )
        if secret_params.get("priv_key"):
            kwargs["privKey"] = secret_params["priv_key"]
            kwargs["privProtocol"] = getattr(
                mod, _PRIV_PROTOS.get(params.get("priv_proto", "aes"), "usmAesCfb128Protocol")
            )
        return mod.UsmUserData(user, **kwargs)
    community = secret_params.get("community") or params.get("community", "public")
    mp_model = 0 if version == "v1" else 1
    return mod.CommunityData(community, mpModel=mp_model)


async def fetch_system_facts(
    target: str, version: str, params: dict, secret_params: dict, timeout_ms: int = 2000
) -> dict:
    """GET the system group from ``target`` → ``{friendly_key: value, ...}``.

    Raises ``SnmpFactsError`` on a config/engine error, no response, or PDU
    error so the caller can record ``reachable=False`` with the message.
    """
    try:
        mod = _load_pysnmp()
    except Exception as e:  # noqa: BLE001
        raise SnmpFactsError(f"pysnmp unavailable: {e}")

    port = int(params.get("port", 161))
    timeout_s = max(timeout_ms / 1000, 0.2)
    try:
        auth = _auth_data(version, params, secret_params, mod)
        transport = await mod.UdpTransportTarget.create(
            (target, port), timeout=timeout_s, retries=0
        )
        object_types = [mod.ObjectType(mod.ObjectIdentity(oid)) for oid in SYSTEM_OIDS]
        error_indication, error_status, _, var_binds = await mod.get_cmd(
            mod.SnmpEngine(), auth, transport, mod.ContextData(), *object_types
        )
    except Exception as e:  # noqa: BLE001
        raise SnmpFactsError(f"snmp error: {e}")

    if error_indication:
        raise SnmpFactsError(str(error_indication))
    if error_status:
        raise SnmpFactsError(error_status.prettyPrint())

    facts: dict = {}
    for name, value in var_binds:
        key = SYSTEM_OIDS.get(str(name))
        if key:
            facts[key] = value.prettyPrint()
    return facts


def fetch_system_facts_sync(
    target: str, version: str, params: dict, secret_params: dict, timeout_ms: int = 2000
) -> dict:
    """Synchronous wrapper for on-demand polling from a DRF view."""
    return asyncio.run(
        fetch_system_facts(target, version, params, secret_params, timeout_ms)
    )


# ─── Interface enrichment (IF-MIB ifTable + ifXTable) - Phase 2 ─────────────
#
# Per LibreNMS/Observium practice we read ifXTable (ifName/ifAlias/ifHighSpeed)
# alongside the base ifTable; ifXTable's HC counters don't wrap on fast links.
# Each column is a separate sub-tree keyed by ifIndex (the trailing OID part).

# friendly key → IF-MIB column base OID
_IF_COLUMNS = {
    "descr": "1.3.6.1.2.1.2.2.1.2",          # ifDescr
    "type": "1.3.6.1.2.1.2.2.1.3",           # ifType
    "mtu": "1.3.6.1.2.1.2.2.1.4",            # ifMtu
    "mac": "1.3.6.1.2.1.2.2.1.6",            # ifPhysAddress
    "admin_status": "1.3.6.1.2.1.2.2.1.7",   # ifAdminStatus
    "oper_status": "1.3.6.1.2.1.2.2.1.8",    # ifOperStatus
    "name": "1.3.6.1.2.1.31.1.1.1.1",        # ifName        (ifXTable)
    "alias": "1.3.6.1.2.1.31.1.1.1.18",      # ifAlias       (ifXTable)
    "speed_mbps": "1.3.6.1.2.1.31.1.1.1.15",  # ifHighSpeed   (ifXTable, Mbps)
    "in_octets": "1.3.6.1.2.1.31.1.1.1.6",   # ifHCInOctets  (64-bit, no wrap)
    "out_octets": "1.3.6.1.2.1.31.1.1.1.10",  # ifHCOutOctets (64-bit, no wrap)
}

_IF_STATUS = {"1": "up", "2": "down", "3": "testing", "4": "unknown",
              "5": "dormant", "6": "notPresent", "7": "lowerLayerDown"}

# ipAddrTable column: ipAdEntIfIndex (IP → owning ifIndex). IPv4 only, but
# universally supported (vs the newer ipAddressTable).
_IP_AD_ENT_IFINDEX = "1.3.6.1.2.1.4.20.1.2"

# IANAifType → friendly name for the common interface kinds we surface.
_IANA_IFTYPE = {
    "1": "other", "6": "ethernet", "24": "loopback", "53": "virtual",
    "131": "tunnel", "135": "l2vlan", "136": "l3vlan", "161": "lag",
    "117": "ethernet", "142": "ipForward",
}

# Link aggregation membership. IEEE8023-LAG-MIB names the aggregate a port is
# attached to (authoritative on LACP gear); IF-MIB ifStackTable is the
# fallback - a member port stacks under its aggregate (higher.lower index).
_DOT3AD_AGG_PORT_ATTACHED_AGG_ID = "1.2.840.10006.300.43.1.2.1.1.13"
_IF_STACK_STATUS = "1.3.6.1.2.1.31.1.2.1.3"
_IFTYPE_LAG = "161"


def parse_lag_membership(
    agg_attached: dict, if_stack: dict, if_types: dict
) -> dict[str, str]:
    """Member ifIndex → aggregate ifIndex.

    ``agg_attached`` is dot3adAggPortAttachedAggID keyed by port ifIndex (0 or
    the port itself = not attached). ``if_stack`` is ifStackStatus keyed
    ``"higher.lower"``; only an active row whose higher layer is an
    ieee8023adLag interface counts, so VLAN-over-port and tunnel stacking stay
    out. The LAG MIB wins where both answer.
    """
    out: dict[str, str] = {}
    for idx, agg in agg_attached.items():
        agg = str(agg or "")
        idx = str(idx)
        if agg not in ("", "0") and agg != idx:
            out[idx] = agg
    for key, status in if_stack.items():
        higher, _, lower = str(key).partition(".")
        if str(status) not in ("1", "active"):
            continue
        if higher in ("", "0") or lower in ("", "0") or lower in out:
            continue
        if str(if_types.get(higher, "")) == _IFTYPE_LAG:
            out[lower] = higher
    return out


# Q-BRIDGE-MIB (802.1Q) - for per-interface access VLAN (PVID). VLAN membership
# is keyed by *bridge port*, not ifIndex, so we also read the bridge-port→ifIndex
# map. (Tagged-VLAN egress bitmaps are a later add; the access/untagged VLAN is
# what an IPAM cares about most.)
_DOT1D_BASE_PORT_IFINDEX = "1.3.6.1.2.1.17.1.4.1.2"   # bridge port → ifIndex
_DOT1Q_PVID = "1.3.6.1.2.1.17.7.1.4.5.1.1"           # bridge port → PVID
_DOT1Q_VLAN_STATIC_NAME = "1.3.6.1.2.1.17.7.1.4.3.1.1"  # VLAN id → name


def parse_vlans(base_port_ifindex: dict, pvid_by_port: dict,
                vlan_names: dict) -> dict:
    """Pure Q-BRIDGE join → ``{ifIndex: {vlan_id, vlan_name}}`` for the access
    (PVID) VLAN of each bridge port. ``base_port_ifindex`` maps bridge-port→
    ifIndex; ``pvid_by_port`` maps bridge-port→PVID; ``vlan_names`` maps
    VLAN-id→name."""
    out: dict = {}
    for port, pvid in pvid_by_port.items():
        if_index = base_port_ifindex.get(port)
        if not if_index or not pvid:
            continue
        vid = str(pvid)
        out[str(if_index)] = {
            "vlan_id": vid,
            "vlan_name": vlan_names.get(vid, ""),
        }
    return out


def _fmt_mac(raw: str) -> str:
    """Best-effort MAC formatting from pysnmp's prettyPrint of ifPhysAddress.

    pyasn1 prints an OCTET STRING as text when every byte is printable, so a
    six-character value is the address's six raw octets (``<RZABC``)."""
    if len(raw) == 6 and not raw.startswith("0x"):
        octets = raw.encode("latin-1", "ignore")
        if len(octets) == 6:
            return ":".join(f"{b:02x}" for b in octets)
    hexs = raw[2:] if raw.startswith("0x") else raw
    hexs = hexs.replace(":", "").replace(" ", "")
    if len(hexs) == 12:
        try:
            int(hexs, 16)
            return ":".join(hexs[i:i + 2] for i in range(0, 12, 2)).lower()
        except ValueError:
            pass
    return raw


async def fetch_interfaces(
    target: str, version: str, params: dict, secret_params: dict, timeout_ms: int = 4000
) -> list[dict]:
    """Walk ifTable/ifXTable → a list of per-interface dicts (one per ifIndex)."""
    try:
        mod = _load_pysnmp()
    except Exception as e:  # noqa: BLE001
        raise SnmpFactsError(f"pysnmp unavailable: {e}")

    port = int(params.get("port", 161))
    timeout_s = max(timeout_ms / 1000, 0.2)
    try:
        auth = _auth_data(version, params, secret_params, mod)
        transport = await mod.UdpTransportTarget.create(
            (target, port), timeout=timeout_s, retries=0
        )
    except Exception as e:  # noqa: BLE001
        raise SnmpFactsError(f"snmp error: {e}")

    engine = mod.SnmpEngine()
    rows: dict[str, dict] = {}
    for key, base in _IF_COLUMNS.items():
        try:
            walk = mod.bulk_walk_cmd(
                engine, auth, transport, mod.ContextData(), 0, 25,
                mod.ObjectType(mod.ObjectIdentity(base)),
                lexicographicMode=False,
            )
            async for error_indication, error_status, _, var_binds in walk:
                if error_indication or error_status:
                    break
                for oid, value in var_binds:
                    if_index = str(oid).split(".")[-1]
                    rows.setdefault(if_index, {})[key] = value.prettyPrint()
        except Exception:  # noqa: BLE001 - a missing column shouldn't fail the rest
            continue

    # ipAddrTable (IPv4 ipAdEntIfIndex): map ifIndex → its configured addresses,
    # so we can show whether an interface operates at L3 (has an IP) vs L2.
    ip_by_ifindex: dict[str, list] = {}
    try:
        walk = mod.bulk_walk_cmd(
            engine, auth, transport, mod.ContextData(), 0, 25,
            mod.ObjectType(mod.ObjectIdentity(_IP_AD_ENT_IFINDEX)),
            lexicographicMode=False,
        )
        async for error_indication, error_status, _, var_binds in walk:
            if error_indication or error_status:
                break
            for oid, value in var_binds:
                ip = str(oid)[len(_IP_AD_ENT_IFINDEX) + 1:]
                ip_by_ifindex.setdefault(value.prettyPrint(), []).append(ip)
    except Exception:  # noqa: BLE001 - ipAddrTable is optional
        pass

    # Q-BRIDGE-MIB: per-interface access VLAN (PVID). Optional - L3-only devices
    # and non-switches simply won't answer, which is fine.
    vlan_cols: dict[str, dict] = {}
    for ckey, base in (
        ("base", _DOT1D_BASE_PORT_IFINDEX),
        ("pvid", _DOT1Q_PVID),
        ("names", _DOT1Q_VLAN_STATIC_NAME),
    ):
        col: dict[str, str] = {}
        try:
            walk = mod.bulk_walk_cmd(
                engine, auth, transport, mod.ContextData(), 0, 25,
                mod.ObjectType(mod.ObjectIdentity(base)), lexicographicMode=False,
            )
            async for error_indication, error_status, _, var_binds in walk:
                if error_indication or error_status:
                    break
                for oid, value in var_binds:
                    col[str(oid)[len(base) + 1:]] = value.prettyPrint()
        except Exception:  # noqa: BLE001
            pass
        vlan_cols[ckey] = col
    vlan_by_ifindex = parse_vlans(
        vlan_cols["base"], vlan_cols["pvid"], vlan_cols["names"]
    )

    # Link aggregation: which aggregate each port belongs to. Optional tables
    # again; `lag_if_index` is always emitted (blank = not a member) so the
    # core can tell "not a member" from "this agent never looked".
    lag_cols: dict[str, dict] = {}
    for ckey, base in (
        ("agg", _DOT3AD_AGG_PORT_ATTACHED_AGG_ID),
        ("stack", _IF_STACK_STATUS),
    ):
        lag_cols[ckey] = await _walk_column(mod, engine, auth, transport, base)
    lag_of = parse_lag_membership(
        lag_cols["agg"], lag_cols["stack"],
        {i: r.get("type", "") for i, r in rows.items()},
    )
    aggregate_ids = set(lag_of.values())

    out = []
    for if_index, r in rows.items():
        ips = ip_by_ifindex.get(if_index, [])
        vlan = vlan_by_ifindex.get(if_index) or {}
        out.append({
            "if_index": if_index,
            "name": r.get("name") or r.get("descr") or f"if{if_index}",
            "descr": r.get("descr", ""),
            "alias": r.get("alias", ""),
            "type": r.get("type", ""),
            # An aggregate is "lag" even where the box reports it as
            # propVirtual (Cisco IOS) - being a membership target decides.
            "type_name": (
                "lag" if if_index in aggregate_ids
                else _IANA_IFTYPE.get(r.get("type", ""), "")
            ),
            "lag_if_index": lag_of.get(if_index, ""),
            "mtu": r.get("mtu", ""),
            "mac": _fmt_mac(r["mac"]) if r.get("mac") else "",
            "admin_status": _IF_STATUS.get(r.get("admin_status", ""), r.get("admin_status", "")),
            "oper_status": _IF_STATUS.get(r.get("oper_status", ""), r.get("oper_status", "")),
            "speed_mbps": r.get("speed_mbps", ""),
            "in_octets": r.get("in_octets", ""),
            "out_octets": r.get("out_octets", ""),
            # L3 if the device has an IP on it, else L2. (IP presence is the
            # reliable signal; ifType only tells you the medium.)
            "ip_addresses": ips,
            "layer": "L3" if ips else "L2",
            # Access (PVID) VLAN from Q-BRIDGE-MIB, when the device is a switch.
            "vlan": vlan.get("vlan_id", ""),
            "vlan_name": vlan.get("vlan_name", ""),
        })
    out.sort(key=lambda x: int(x["if_index"]) if x["if_index"].isdigit() else 0)
    return out


def fetch_interfaces_sync(
    target: str, version: str, params: dict, secret_params: dict, timeout_ms: int = 4000
) -> list[dict]:
    return asyncio.run(
        fetch_interfaces(target, version, params, secret_params, timeout_ms)
    )


# ─── Topology: LLDP neighbours + ARP (#84, Phase 4) ─────────────────────────

# LLDP-MIB columns. The remote-table rows are indexed by
# timeMark.localPortNum.remIndex; the local-port table maps localPortNum → name.
_LLDP_LOC_PORT_ID_SUBTYPE = "1.0.8802.1.1.2.1.3.7.1.2"
_LLDP_LOC_PORT_ID = "1.0.8802.1.1.2.1.3.7.1.3"
_LLDP_LOC_PORT_DESC = "1.0.8802.1.1.2.1.3.7.1.4"
_LLDP_REM_SYSNAME = "1.0.8802.1.1.2.1.4.1.1.9"
_LLDP_REM_PORT_DESC = "1.0.8802.1.1.2.1.4.1.1.8"
_LLDP_REM_PORT_ID = "1.0.8802.1.1.2.1.4.1.1.7"
_LLDP_REM_SYS_CAP_ENABLED = "1.0.8802.1.1.2.1.4.1.1.12"
# ipNetToMediaPhysAddress / ipNetToMediaType, indexed by ifIndex.a.b.c.d
_ARP_PHYS = "1.3.6.1.2.1.4.22.1.2"
_ARP_TYPE = "1.3.6.1.2.1.4.22.1.4"
# BRIDGE-MIB forwarding table: dot1dTpFdbPort (index = the 6 MAC octets) →
# bridge port number; dot1dBasePortIfIndex maps that bridge port → ifIndex.
_DOT1D_TP_FDB_PORT = "1.3.6.1.2.1.17.4.3.1.2"

# Rows per GETBULK for the topology tables. Several string columns ride in one
# request, so each asks for fewer rows than a single-column walk would.
_LLDP_REPETITIONS = 10
_ARP_REPETITIONS = 25

# lldpLocPortIdSubtype values whose lldpLocPortId names an interface:
# interfaceAlias(1), interfaceName(5) and local(7).
_LLDP_NAMED_SUBTYPES = {"1", "5", "7", "interfacealias", "interfacename", "local"}
# LldpSystemCapabilitiesMap bits, bit 0 first (8-10 come from LLDP-V2-MIB).
_LLDP_CAPS = (
    "other", "repeater", "bridge", "wlanAccessPoint", "router", "telephone",
    "docsisCableDevice", "stationOnly", "cVlanComponent", "sVlanComponent",
    "twoPortMacRelay",
)
# ipNetToMediaType. invalid(2) entries are dropped.
_ARP_TYPES = {"1": "other", "2": "invalid", "3": "dynamic", "4": "static"}


def _int(value) -> int | None:
    """An int from a walked value (``"3"``, a pyasn1 Integer), else None."""
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _octets(value) -> bytes:
    """The raw bytes of an OCTET STRING's prettyPrint: ``0x…`` hex, or the text
    pyasn1 prints when every byte is printable."""
    text = str(value or "")
    if text.startswith("0x"):
        try:
            return bytes.fromhex(text[2:])
        except ValueError:
            pass
    return text.encode("latin-1", "ignore")


def _text(value) -> str:
    """An OCTET STRING meant as text (an interface name), hex form decoded."""
    text = str(value or "")
    if text.startswith("0x") and len(text) > 2:
        try:
            text = bytes.fromhex(text[2:]).decode("utf-8", "replace")
        except ValueError:
            pass
    return text.replace("\x00", "").strip()


def _column(rows: dict, key: str) -> dict:
    """One column of a lockstep walk → ``{index: value}``."""
    return {index: row[key] for index, row in rows.items() if key in row}


def parse_lldp(loc_ports: dict, rem_sysname: dict, rem_port_desc: dict,
               rem_port_id: dict, rem_caps: dict | None = None,
               local_if_index: dict | None = None) -> list[dict]:
    """Pure LLDP join: rem-table rows (keyed timeMark.localPort.remIndex) +
    local-port names → ``[{local_port, remote_device, remote_port}]``.

    Given ``local_if_index`` (local port number → ifIndex, from
    :func:`resolve_lldp_local_ports`) every row also carries ``local_if_index``,
    ``""`` when unresolved. Given ``rem_caps`` (lldpRemSysCapEnabled on the rem
    index) every row carries ``remote_caps``, the capability names it enables.
    """
    out = []
    for index, sysname in rem_sysname.items():
        if not sysname:
            continue
        parts = index.split(".")
        local_port_num = parts[1] if len(parts) >= 2 else ""
        row = {
            "local_port": loc_ports.get(local_port_num) or f"port {local_port_num}",
            "remote_device": sysname,
            "remote_port": rem_port_desc.get(index) or rem_port_id.get(index) or "",
        }
        if local_if_index is not None:
            row["local_if_index"] = local_if_index.get(local_port_num, "")
        if rem_caps is not None:
            row["remote_caps"] = parse_lldp_caps(rem_caps.get(index, ""))
        out.append(row)
    return out


def parse_lldp_caps(value) -> list[str]:
    """lldpRemSysCapEnabled (a BITS octet string) → capability names in bit
    order. ``0x2400`` is bridge + telephone: an IP phone, not a switch."""
    octets = _octets(value)
    return [
        name for bit, name in enumerate(_LLDP_CAPS)
        if bit // 8 < len(octets) and octets[bit // 8] & (0x80 >> (bit % 8))
    ]


def _interface_names(interfaces) -> tuple[dict, ...]:
    """ifName, ifDescr and ifAlias (casefolded) → the ifIndexes carrying them."""
    tables: tuple[dict, ...] = ({}, {}, {})
    for row in interfaces or ():
        index = str(row.get("if_index") or "").strip()
        if not index:
            continue
        for table, key in zip(tables, ("name", "descr", "alias"), strict=True):
            text = str(row.get(key) or "").strip().casefold()
            if text:
                table.setdefault(text, set()).add(index)
    return tables


def _match_interface(tables: tuple[dict, ...], text: str) -> str:
    """The one ifIndex whose name, else descr, else alias is ``text``."""
    text = text.strip().casefold()
    if text:
        for table in tables:
            found = table.get(text) or ()
            if len(found) == 1:
                return next(iter(found))
    return ""


def resolve_lldp_local_ports(ports, loc_subtype: dict, loc_id: dict, loc_desc: dict,
                             interfaces=None, base_port_ifindex=None) -> dict:
    """LLDP local port number → ifIndex (``""`` when nothing fits), trying:

    1. lldpLocPortId, when its subtype names an interface (interfaceAlias,
       interfaceName, local) and it matches exactly one ifName/ifDescr/ifAlias;
    2. the port number as a bridge port through dot1dBasePortIfIndex - LLDP-MIB
       says the two are equal on a bridge;
    3. lldpLocPortDesc as a name, which is what ``local_port`` has always shown.
    """
    tables = _interface_names(interfaces)
    known = {str(r.get("if_index")) for r in interfaces or () if r.get("if_index")}
    base = {str(k): v for k, v in (base_port_ifindex or {}).items()}
    out: dict[str, str] = {}
    for num in {str(p) for p in ports}:
        index = ""
        if str(loc_subtype.get(num, "")).strip().lower() in _LLDP_NAMED_SUBTYPES:
            index = _match_interface(tables, _text(loc_id.get(num)))
        if not index:
            via = _int(base.get(num))
            if via and (not known or str(via) in known):
                index = str(via)
        if not index:
            index = _match_interface(tables, _text(loc_desc.get(num)))
        out[num] = index
    return out


def parse_arp(phys: dict, types: dict | None = None) -> list[dict]:
    """Pure ARP parse: ipNetToMediaPhysAddress (index ifIndex.a.b.c.d) →
    ``[{ip, mac, if_index, type}]``. ``types`` is ipNetToMediaType on the same
    index: invalid(2) entries are dropped, the rest say other, dynamic or
    static (``""`` when the agent reports no type)."""
    out = []
    for index, mac in phys.items():
        parts = index.split(".")
        if len(parts) < 5:
            continue
        raw = str((types or {}).get(index, "")).strip()
        kind = _ARP_TYPES.get(raw, raw.lower())
        if kind == "invalid":
            continue
        out.append({
            "if_index": parts[0],
            "ip": ".".join(parts[1:5]),
            "mac": _fmt_mac(mac),
            "type": kind,
        })
    return out


def parse_fdb(fdb_port: dict, base_port_ifindex: dict) -> list[dict]:
    """Pure MAC-address-table parse: dot1dTpFdbPort (index = the 6 decimal MAC
    octets → bridge port) joined with dot1dBasePortIfIndex (bridge port →
    ifIndex) → ``[{mac, if_index}]``. The bridge port is resolved to an ifIndex
    so it joins to interfaces exactly like ARP/ifTable entries.

    The legacy, unfiltered join; polls read the table with :func:`fetch_mac_table`.
    """
    out = []
    for index, port in fdb_port.items():
        octets = index.split(".")
        if len(octets) != 6:
            continue
        try:
            mac = ":".join(f"{int(o):02x}" for o in octets)
        except ValueError:
            continue
        if_index = base_port_ifindex.get(str(port).strip(), "")
        if not if_index:
            continue  # a bridge port with no ifIndex isn't a usable switch port
        out.append({"mac": mac, "if_index": if_index})
    return out


async def _walk_column(
    mod, engine, auth, transport, base: str, limit: int | None = None
) -> dict:
    """Walk one column → ``{oid_tail_after_base: prettyValue}``. Tolerant: a
    missing/blocked column yields ``{}`` rather than failing the whole fetch.

    ``limit`` stops after that many bindings - for exploring a whole table base
    interactively, where the subtree can be far larger than any one column.
    """
    result: dict = {}
    try:
        walk = mod.bulk_walk_cmd(
            engine, auth, transport, mod.ContextData(), 0, 25,
            mod.ObjectType(mod.ObjectIdentity(base)), lexicographicMode=False,
        )
        async for error_indication, error_status, _, var_binds in walk:
            if error_indication or error_status:
                break
            for oid, value in var_binds:
                tail = str(oid)[len(base) + 1:]
                if tail:
                    result[tail] = value.prettyPrint()
            if limit is not None and len(result) >= limit:
                break
    except Exception:  # noqa: BLE001
        return result
    return result


# ─── Multi-column walks ──────────────────────────────────────────────────────

MAC_MAX_REPETITIONS = 50   # rows per GETBULK on MAC tables
MAC_RETRIES = 1            # a timed-out request is sent once more


class _WalkBudget:
    """Wall clock and row allowance shared by every walk of one MAC-table read.
    ``truncated`` turns true when either runs out; ``reason`` says which."""

    def __init__(self, seconds: float, rows: int):
        self.seconds = seconds
        self.rows = rows
        self.deadline = _monotonic() + seconds
        self.rows_left = rows
        self.truncated = False
        self.reason = ""

    def remaining(self) -> float:
        return self.deadline - _monotonic()

    def stop(self, reason: str) -> None:
        self.truncated = True
        self.reason = self.reason or reason


def _oid_key(oid: str) -> tuple:
    try:
        return tuple(int(part) for part in oid.split("."))
    except ValueError:
        return ()


def _is_end(value) -> bool:
    """endOfMibView, noSuchObject or noSuchInstance: a column's end, not a row."""
    return any(
        cls.__name__ in ("EndOfMibView", "NoSuchObject", "NoSuchInstance", "Null")
        for cls in type(value).__mro__
    )


def _is_timeout(error_indication) -> bool:
    return (
        type(error_indication).__name__ == "RequestTimedOut"
        or "timeout" in str(error_indication).lower()
    )


def _pretty(value) -> str:
    pretty = getattr(value, "prettyPrint", None)
    return str(pretty() if callable(pretty) else value)


async def _walk_columns(
    mod, engine, auth, transport, columns: dict, *, context=None,
    max_rep: int = MAC_MAX_REPETITIONS, retries: int = MAC_RETRIES,
    budget: _WalkBudget | None = None, cap_rows: bool = False,
    stats: dict | None = None,
) -> tuple[dict, bool]:
    """Walk several columns of one table in lockstep → ``(rows, complete)``.

    ``columns`` maps a key to a column OID and ``rows`` is ``{index: {key:
    prettyValue}}``: each GETBULK carries the next rows of every column still
    open. ``complete`` is true only when every column reached its end. A walk
    that stops on an error, a timeout, the budget or the row cap is
    incomplete - never "empty" - and keeps the rows it got.

    ``context`` is a ContextData (default context when None). A timed-out
    request is retried ``retries`` times. ``budget`` bounds the wall clock and,
    with ``cap_rows``, the rows. ``stats`` receives ``error`` (text),
    ``timeout`` and ``truncated`` (the budget or the row cap stopped it).
    """
    stats = {} if stats is None else stats
    stats.update(error="", timeout=False, truncated=False)
    ctx = mod.ContextData() if context is None else context
    bases = {key: str(oid).strip(".") for key, oid in columns.items()}
    cursor = dict(bases)
    last = {key: _oid_key(oid) for key, oid in bases.items()}
    active = list(bases)
    rows: dict[str, dict] = {}
    complete = True

    def cut(reason: str) -> tuple[dict, bool]:
        budget.stop(reason)
        stats["truncated"] = True
        return rows, False

    while active:
        response = None
        for attempt in range(max(retries, 0) + 1):
            if budget is not None and budget.remaining() <= 0:
                return cut("time")
            var_binds = [mod.ObjectType(mod.ObjectIdentity(cursor[k])) for k in active]
            try:
                call = mod.bulk_cmd(
                    engine, auth, transport, ctx, 0, max_rep, *var_binds,
                    lookupMib=False,
                )
                if budget is None:
                    response = await call
                else:
                    response = await asyncio.wait_for(call, max(budget.remaining(), 0.01))
            except TimeoutError:
                if budget is not None:
                    return cut("time")  # wait_for ran out of budget
                stats.update(error="timeout", timeout=True)
                return rows, False
            except Exception as e:  # noqa: BLE001 - engine/config issue
                stats["error"] = f"snmp error: {e}"
                return rows, False
            if response[0] and _is_timeout(response[0]) and attempt < retries:
                continue
            break
        error_indication, error_status, error_index, var_table = response
        if error_indication:
            stats["error"] = str(error_indication)
            stats["timeout"] = _is_timeout(error_indication)
            return rows, False
        status = _int(error_status) or 0
        if status:
            position = _int(error_index) or 0
            if status == 2 and 1 <= position <= len(active):
                # SNMPv1 noSuchName: that column walked off the end of the MIB.
                active.pop(position - 1)
                continue
            if status == 1 and max_rep > 1:
                max_rep = max(1, max_rep // 2)  # tooBig: ask for fewer rows
                continue
            stats["error"] = _pretty(error_status)
            return rows, False
        if not var_table:
            stats["error"] = "empty response"
            return rows, False
        width = len(active)
        done: set[str] = set()
        for i, var_bind in enumerate(var_table):
            key = active[i % width]
            if key in done:
                continue
            name, value = var_bind[0], var_bind[1]
            oid = str(name)
            base = bases[key]
            if _is_end(value) or not oid.startswith(base + "."):
                done.add(key)
                continue
            at = _oid_key(oid)
            if at <= last[key]:
                # An agent that hands back an OID it already gave loops forever.
                stats["error"] = f"OID not increasing after {cursor[key]}"
                complete = False
                done.add(key)
                continue
            last[key] = at
            cursor[key] = oid
            index = oid[len(base) + 1:]
            row = rows.get(index)
            if row is None:
                if cap_rows and budget is not None:
                    if budget.rows_left <= 0:
                        return cut("rows")
                    budget.rows_left -= 1
                row = rows[index] = {}
            row[key] = value.prettyPrint()
        active = [key for key in active if key not in done]
    return rows, complete


def _close_engine(engine) -> None:
    close = getattr(engine, "close_dispatcher", None)
    if callable(close):
        try:
            close()
        except Exception:  # noqa: BLE001 - best-effort socket cleanup
            pass


async def fetch_topology(
    target: str, version: str, params: dict, secret_params: dict, timeout_ms: int = 4000,
    interfaces: list | None = None,
) -> dict:
    """Discover LLDP neighbours + the ARP table → ``{neighbors, arp, arp_meta}``.

    Each neighbour also names its local port as an ifIndex (``local_if_index``,
    ``""`` when unresolved) and lists the capabilities it advertises
    (``remote_caps``); each ARP row carries its ``type``. ``interfaces`` - the
    same poll's interface rows - lets the local port resolve by name. The MAC
    table is read by :func:`fetch_mac_table`.

    ``arp_meta`` is ``{complete, rows, error}``: ``complete`` only when the ARP
    walk ran to its end, so a table cut short by an error or a timeout never
    reads as one whose entries went away.
    """
    try:
        mod = _load_pysnmp()
    except Exception as e:  # noqa: BLE001
        raise SnmpFactsError(f"pysnmp unavailable: {e}") from e

    port = int(params.get("port", 161))
    timeout_s = max(timeout_ms / 1000, 0.2)
    try:
        auth = _auth_data(version, params, secret_params, mod)
        transport = await mod.UdpTransportTarget.create(
            (target, port), timeout=timeout_s, retries=0
        )
    except Exception as e:  # noqa: BLE001
        raise SnmpFactsError(f"snmp error: {e}") from e

    engine = mod.SnmpEngine()

    async def walk(columns: dict, max_rep: int) -> dict:
        rows, _complete = await _walk_columns(
            mod, engine, auth, transport, columns, max_rep=max_rep, retries=0
        )
        return rows

    try:
        loc = await walk({
            "subtype": _LLDP_LOC_PORT_ID_SUBTYPE, "id": _LLDP_LOC_PORT_ID,
            "desc": _LLDP_LOC_PORT_DESC,
        }, _LLDP_REPETITIONS)
        rem = await walk({
            "sysname": _LLDP_REM_SYSNAME, "port_desc": _LLDP_REM_PORT_DESC,
            "port_id": _LLDP_REM_PORT_ID, "caps": _LLDP_REM_SYS_CAP_ENABLED,
        }, _LLDP_REPETITIONS)
        base = {}
        if rem:
            base = _column(
                await walk({"if_index": _DOT1D_BASE_PORT_IFINDEX}, MAC_MAX_REPETITIONS),
                "if_index",
            )
        arp_stats: dict = {}
        arp, arp_complete = await _walk_columns(
            mod, engine, auth, transport, {"mac": _ARP_PHYS, "type": _ARP_TYPE},
            max_rep=_ARP_REPETITIONS, retries=0, stats=arp_stats,
        )
    finally:
        _close_engine(engine)

    ports = {index.split(".")[1] for index in rem if index.count(".") >= 2}
    local = resolve_lldp_local_ports(
        ports, _column(loc, "subtype"), _column(loc, "id"), _column(loc, "desc"),
        interfaces, base,
    )
    arp_rows = parse_arp(_column(arp, "mac"), _column(arp, "type"))
    return {
        "neighbors": parse_lldp(
            _column(loc, "desc"), _column(rem, "sysname"), _column(rem, "port_desc"),
            _column(rem, "port_id"), rem_caps=_column(rem, "caps"),
            local_if_index=local,
        ),
        "arp": arp_rows,
        "arp_meta": _arp_meta(
            complete=arp_complete, rows=len(arp_rows),
            error="" if arp_complete else _why(arp_stats)[:300],
        ),
    }


def _arp_meta(**overrides) -> dict:
    """A fresh ``arp_meta``: nothing read yet."""
    meta = {"complete": False, "rows": 0, "error": ""}
    meta.update(overrides)
    return meta


def fetch_topology_sync(
    target: str, version: str, params: dict, secret_params: dict, timeout_ms: int = 4000,
    interfaces: list | None = None,
) -> dict:
    return asyncio.run(
        fetch_topology(target, version, params, secret_params, timeout_ms, interfaces)
    )


# ─── MAC address tables (#284) ──────────────────────────────────────────────
#
# Which MAC sits behind which port, read without leaning on one vendor:
#
# 1. dot1dBasePortIfIndex: bridge port → ifIndex. Every FDB port maps through it.
# 2. Q-BRIDGE dot1qTpFdbPort/Status (index fdbId.m1…m6): one table for every
#    VLAN. dot1qVlanFdbId (index timeMark.vlan) says which VLAN an FDB id is.
# 3. Only when Q-BRIDGE has no rows: BRIDGE-MIB dot1dTpFdbPort/Status in the
#    default context, then per-VLAN contexts on agents that keep one table per
#    VLAN (Cisco-style: community@vid, or the SNMPv3 context "vlan-<vid>").
#
# Only learned host entries survive (learned_rows), and ``fdb_meta`` says how
# far the read got: only a complete read may close MACs that went away.

MAC_BUDGET_S = 120          # wall clock for the MAC part of a full read
MAC_QUICK_BUDGET_S = 15     # ... of a quick read (Poll now runs inside a request)
MAC_ROW_CAP = 100_000       # forwarding entries per device
MAC_MAX_VLANS = 128         # per-VLAN contexts per device
MAC_VLAN_CONTEXTS = "auto"  # auto | always | off
MAC_CONTEXT_CONCURRENCY = 2  # contexts read at once, to spare the switch CPU
MAC_CONTEXT_ABORT_AFTER = 3  # failed contexts in a row that end the per-VLAN read

_DOT1D_TP_FDB_STATUS = "1.3.6.1.2.1.17.4.3.1.3"
_DOT1Q_TP_FDB_PORT = "1.3.6.1.2.1.17.7.1.2.2.1.2"
_DOT1Q_TP_FDB_STATUS = "1.3.6.1.2.1.17.7.1.2.2.1.3"
_DOT1Q_VLAN_FDB_ID = "1.3.6.1.2.1.17.7.1.4.2.1.3"
_DOT1D_BRIDGE = "1.3.6.1.2.1.17"
# ENTITY-MIB entLogicalTable: how an agent advertises its per-VLAN contexts.
_ENT_LOGICAL_COLUMNS = {
    "descr": "1.3.6.1.2.1.47.1.2.1.1.2",
    "type": "1.3.6.1.2.1.47.1.2.1.1.3",
    "community": "1.3.6.1.2.1.47.1.2.1.1.4",
    "context": "1.3.6.1.2.1.47.1.2.1.1.8",
}
# CISCO-VTP-MIB vtpVlanState (index domain.vlan): the one vendor OID, used only
# when ENTITY-MIB lists no bridge contexts.
_VTP_VLAN_STATE = "1.3.6.1.4.1.9.9.46.1.3.1.1.2"
_RESERVED_VLANS = range(1002, 1006)  # fddi/token-ring defaults: no MAC table
_FDB_STATUS = {"1": "other", "2": "invalid", "3": "learned", "4": "self", "5": "mgmt"}
# Bridge ports are ethernet ports or aggregates: ethernetCsmacd, iso88023,
# ethernet3Mbit, fastEther, fastEtherFX, gigabitEthernet, ieee8023adLag.
_PORT_IFTYPES = {
    "6", "7", "26", "62", "69", "117", "161",
    "ethernetCsmacd", "gigabitEthernet", "fastEther", "ieee8023adLag",
}
_MAC_SEPARATORS = re.compile(r"[\s:.\-]")
_PORT_MAP_RANK = {"base-port": 0, "assumed": 1, "none": 2}


def _mac_meta(**overrides) -> dict:
    """A fresh ``fdb_meta``: nothing read yet."""
    meta = {
        "source": "none", "complete": False, "truncated": False,
        "vlan_map": "none", "port_map": "none",
        "vlans": {"read": [], "skipped": [], "failed": []},
        "dropped": {"self": 0, "port0": 0, "group": 0, "own": 0, "unmapped": 0},
        "rows": 0, "elapsed_ms": 0, "error": "",
    }
    meta.update(overrides)
    return meta


def _norm_mac(value) -> str:
    """Any MAC notation, or a pysnmp prettyPrint of one → ``aa:bb:cc:dd:ee:ff``
    (``""`` when it is not six octets)."""
    text = _fmt_mac(str(value or "").strip())
    hexs = _MAC_SEPARATORS.sub("", text)
    if hexs[:2].lower() == "0x":
        hexs = hexs[2:]
    if len(hexs) != 12:
        return ""
    try:
        int(hexs, 16)
    except ValueError:
        return ""
    return ":".join(hexs[i:i + 2] for i in range(0, 12, 2)).lower()


class _Ifaces:
    """What the MAC filter needs from the same poll's interface rows."""

    def __init__(self, interfaces):
        self.types: dict[str, tuple[str, str]] = {}
        self.own: set[str] = set()
        self.pvids: set[int] = set()
        for row in interfaces or ():
            index = str(row.get("if_index") or "").strip()
            if not index:
                continue
            self.types[index] = (
                str(row.get("type") or "").strip(), str(row.get("type_name") or "").strip()
            )
            mac = _norm_mac(row.get("mac"))
            if mac and mac != "00:00:00:00:00:00":
                self.own.add(mac)
            vid = _int(row.get("vlan"))
            if vid and 1 <= vid <= 4094:
                self.pvids.add(vid)

    def known(self, index: str) -> bool:
        return str(index) in self.types

    def is_port(self, index: str) -> bool:
        """An ethernet port or an aggregate - something a bridge port can be."""
        if_type, type_name = self.types.get(str(index), ("", ""))
        return type_name in ("ethernet", "lag") or if_type in _PORT_IFTYPES


def own_macs(interfaces) -> set[str]:
    """The polled device's own addresses (ifPhysAddress), normalised."""
    return _Ifaces(interfaces).own


def mac_drop_reason(mac: str, own: set | frozenset = frozenset()) -> str:
    """Why a forwarding entry's address is not a learned host: ``"group"`` for
    a group (I/G bit set) or all-zero address, ``"own"`` for one of ``own``
    (the polled device's normalised ifPhysAddress values, see
    :func:`own_macs`); ``""`` for a host. The core reuses it on results from
    agents that predate ``fdb_meta``."""
    norm = _norm_mac(mac)
    if not norm or int(norm[:2], 16) & 0x01 or norm == "00:00:00:00:00:00":
        return "group"
    if norm in own:
        return "own"
    return ""


def _fdb_status(raw) -> str:
    """dot1d/dot1q TpFdbStatus → other/invalid/learned/self/mgmt; ``""`` when the
    agent has no status column."""
    if raw is None:
        return ""
    text = str(raw).strip()
    if not text:
        return ""
    if text in _FDB_STATUS:
        return _FDB_STATUS[text]
    return text.lower() if text.lower() in _FDB_STATUS.values() else "other"


def _mac_from_index(parts) -> str:
    """Six decimal OID parts → ``aa:bb:cc:dd:ee:ff`` (``""`` when not a MAC)."""
    if len(parts) != 6:
        return ""
    octets = [_int(p) for p in parts]
    if any(o is None or not 0 <= o <= 255 for o in octets):
        return ""
    return ":".join(f"{o:02x}" for o in octets)


def parse_fdb_table(rows: dict, *, qbridge: bool) -> list[dict]:
    """Rows of a lockstep forwarding-table walk → entries.

    ``rows`` is ``{index: {"port": …, "status": …}}`` from dot1qTpFdbPort/Status
    (index ``fdbId.m1…m6``) or, with ``qbridge=False``, dot1dTpFdbPort/Status
    (index ``m1…m6``). Each entry is ``{mac, fdb_id, bridge_port, status}``:
    ``fdb_id`` is None on BRIDGE-MIB, ``bridge_port`` None when the row has no
    port, and ``status`` ``""`` when the agent has no status column.
    """
    out = []
    for index, row in rows.items():
        parts = index.split(".")
        fdb_id = None
        if qbridge:
            if len(parts) != 7:
                continue
            fdb_id = _int(parts[0])
            parts = parts[1:]
            if fdb_id is None:
                continue
        mac = _mac_from_index(parts)
        if not mac:
            continue
        out.append({
            "mac": mac,
            "fdb_id": fdb_id,
            "bridge_port": _int(row.get("port")),
            "status": _fdb_status(row.get("status")),
        })
    return out


def map_fdb_vlans(fdb_ids, vlan_fdb_ids: dict, named_vlans=None) -> tuple[dict, str]:
    """FDB id → VLAN (None when it can't be told) and how that was decided.

    ``vlan_fdb_ids`` is dot1qVlanFdbId (index ``timeMark.vlan`` → FDB id). An FDB
    id used by exactly one VLAN is that VLAN; one shared by several (shared
    learning) stays None - ``"fdb-id"``. Without that table an FDB id is taken
    as the VLAN only when every FDB id is a VLAN the agent names
    (``named_vlans``: dot1qVlanStaticName and PVIDs) - ``"assumed"`` - and
    otherwise stays None - ``"none"``. Never a silent guess.
    """
    ids = {f for f in fdb_ids if f is not None}
    users: dict[int, set[int]] = {}
    for index, fdb in (vlan_fdb_ids or {}).items():
        vid, fid = _int(str(index).split(".")[-1]), _int(fdb)
        if vid and 1 <= vid <= 4094 and fid is not None:
            users.setdefault(fid, set()).add(vid)
    if users:
        return {
            f: next(iter(users[f])) if len(users.get(f, ())) == 1 else None for f in ids
        }, "fdb-id"
    named = {v for v in (_int(x) for x in named_vlans or ()) if v}
    if ids and ids <= named:
        return {f: f for f in ids}, "assumed"
    return dict.fromkeys(ids), "none"


def map_bridge_ports(ports, base_port_ifindex: dict, interfaces=None, *,
                     ifaces: _Ifaces | None = None) -> tuple[dict, str]:
    """Bridge port → ifIndex, and how: ``"base-port"`` through
    dot1dBasePortIfIndex; ``"assumed"`` (port = ifIndex) when that table is
    empty but every port is the ifIndex of an ethernet or LAG interface;
    ``"none"`` otherwise, which leaves the rows unmapped."""
    ifaces = ifaces or _Ifaces(interfaces)
    base: dict[int, str] = {}
    for port, index in (base_port_ifindex or {}).items():
        p, i = _int(port), _int(index)
        if p and i:
            base[p] = str(i)
    ports = {p for p in ports if p}
    if base:
        return {p: base[p] for p in ports if p in base}, "base-port"
    if ports and all(ifaces.is_port(str(p)) for p in ports):
        return {p: str(p) for p in ports}, "assumed"
    return {}, "none"


def learned_rows(entries, base_port_ifindex: dict, interfaces=None, dropped=None, *,
                 ifaces: _Ifaces | None = None) -> tuple[list[dict], str]:
    """The learned-only filter and the port mapping → ``(rows, port_map)``.

    Drops, counted into ``dropped`` by reason: status self(4) and invalid(2)
    (``self``); group and all-zero addresses (``group``); the device's own
    ifPhysAddress values (``own``); bridge port 0 or none (``port0``); ports
    that map to no ifIndex (``unmapped``). Keeps learned(3), other(1), mgmt(5)
    and rows with no status column. ``port_map`` is ``""`` when nothing was left
    to map, else as :func:`map_bridge_ports`.
    """
    ifaces = ifaces or _Ifaces(interfaces)
    dropped = _mac_meta()["dropped"] if dropped is None else dropped
    keep = []
    for entry in entries:
        if entry.get("status") in ("self", "invalid"):
            dropped["self"] += 1
            continue
        reason = mac_drop_reason(entry.get("mac", ""), ifaces.own)
        if reason:
            dropped[reason] += 1
            continue
        if not entry.get("bridge_port"):
            dropped["port0"] += 1
            continue
        keep.append(entry)
    if not keep:
        return [], ""
    mapping, how = map_bridge_ports(
        {e["bridge_port"] for e in keep}, base_port_ifindex, ifaces=ifaces
    )
    rows = []
    for entry in keep:
        index = mapping.get(entry["bridge_port"], "")
        if not index:
            dropped["unmapped"] += 1
            continue
        rows.append({
            "mac": entry["mac"],
            "if_index": index,
            "vlan": entry.get("vlan"),
            "fdb_id": entry.get("fdb_id"),
            "bridge_port": entry["bridge_port"],
            "status": entry.get("status", ""),
        })
    return rows, how


def unit_ports(if_stack: dict, interfaces=None, *, ifaces: _Ifaces | None = None) -> dict:
    """Logical unit ifIndex → its physical port, for a unit that ifStackTable
    (``higher.lower`` → status) stacks on exactly one ethernet or LAG interface
    - the way Junos bridges ``ge-0/0/1.0`` over ``ge-0/0/1``."""
    ifaces = ifaces or _Ifaces(interfaces)
    lowers: dict[str, set[str]] = {}
    for key, status in (if_stack or {}).items():
        higher, _, lower = str(key).partition(".")
        if str(status).strip() not in ("1", "active"):
            continue
        if higher in ("", "0") or lower in ("", "0"):
            continue
        lowers.setdefault(higher, set()).add(lower)
    out = {}
    for higher, below in lowers.items():
        if not ifaces.known(higher) or ifaces.is_port(higher):
            continue
        physical = [lower for lower in below if ifaces.is_port(lower)]
        if len(physical) == 1:
            out[higher] = physical[0]
    return out


def _vlan_in(text, pattern: str) -> int | None:
    found = re.search(pattern, _text(text), re.IGNORECASE)
    vid = _int(found.group(1)) if found else None
    return vid if vid and 1 <= vid <= 4094 else None


def parse_entity_vlans(rows: dict) -> list[int]:
    """entLogicalTable rows (``{index: {descr, type, community, context}}``) →
    the VLANs of its dot1dBridge entries, from entLogicalContextName
    (``vlan-20``), else entLogicalDescr (``vlan20``), else the ``@20`` of
    entLogicalCommunity. The community itself is never kept."""
    out = set()
    for row in rows.values():
        kind = str(row.get("type") or "").strip().lstrip(".")
        if kind != _DOT1D_BRIDGE and "dot1dbridge" not in kind.lower():
            continue
        vid = (
            _vlan_in(row.get("context"), r"^vlan-?0*(\d+)$")
            or _vlan_in(row.get("descr"), r"vlan\s*-?\s*0*(\d+)")
            or _vlan_in(row.get("community"), r"@0*(\d+)$")
        )
        if vid:
            out.add(vid)
    return sorted(out)


def parse_vtp_vlans(states: dict) -> list[int]:
    """CISCO-VTP-MIB vtpVlanState (index ``domain.vlan``) → the operational(1)
    VLANs."""
    out = set()
    for index, state in states.items():
        if str(state).strip().lower() not in ("1", "operational"):
            continue
        vid = _int(str(index).split(".")[-1])
        if vid and 1 <= vid <= 4094:
            out.add(vid)
    return sorted(out)


def plan_context_vlans(vlans, max_vlans: int = MAC_MAX_VLANS) -> tuple[list, list]:
    """VLANs → ``(to_read, over_cap)``: valid ids, ascending, without the
    reserved 1002-1005, the first ``max_vlans`` read and the rest skipped."""
    clean = sorted({
        v for v in (_int(x) for x in vlans)
        if v and 1 <= v <= 4094 and v not in _RESERVED_VLANS
    })
    return clean[:max_vlans], clean[max_vlans:]


def _clamp(value, default: int, low: int, high: int) -> int:
    number = _int(value)
    return default if number is None else min(max(number, low), high)


def _mac_options(params: dict, mode: str) -> dict:
    """The MAC-read options a profile's ``params`` carry, with the defaults."""
    contexts = str(params.get("mac_vlan_contexts") or MAC_VLAN_CONTEXTS).strip().lower()
    if contexts not in ("auto", "always", "off"):
        contexts = MAC_VLAN_CONTEXTS
    quick = str(mode or "").strip().lower() == "quick"
    budget = _clamp(params.get("mac_budget_s"), MAC_BUDGET_S, 5, 600)
    hint = params.get("mac_vlan_hint") or []
    if isinstance(hint, str):
        hint = hint.replace(",", " ").split()
    if not isinstance(hint, (list, tuple, set)):
        hint = []
    return {
        "contexts": contexts,
        "quick": quick,
        "budget_s": min(budget, MAC_QUICK_BUDGET_S) if quick else budget,
        "max_vlans": _clamp(params.get("mac_max_vlans"), MAC_MAX_VLANS, 1, 1024),
        "hint": list(hint),
    }


def _why(stats: dict) -> str:
    return "timeout" if stats.get("timeout") else (stats.get("error") or "error")


class _MacTableRead:
    """One read of a device's MAC table; :meth:`run` → ``(rows, meta)``."""

    def __init__(self, mod, engine, auth, transport, version, params, secret_params,
                 interfaces, mode):
        self.mod, self.engine, self.auth, self.transport = mod, engine, auth, transport
        self.version = version
        self.params = params
        self.secret_params = secret_params
        self.opts = _mac_options(params, mode)
        self.budget = _WalkBudget(self.opts["budget_s"], MAC_ROW_CAP)
        self.ifaces = _Ifaces(interfaces)
        self.meta = _mac_meta()
        self.problems: list[str] = []  # why the read is incomplete
        self.port_maps: list[str] = []
        self.default_base = False
        self.stack: dict | None = None
        self.halted = False  # the agent stopped answering in the default context

    @property
    def stopped(self) -> bool:
        return self.halted or self.budget.truncated

    @property
    def can_walk(self) -> bool:
        """Time is left and the agent still answers (the row cap may be spent:
        small lookup tables don't count against it)."""
        return not self.halted and self.budget.remaining() > 0

    async def walk(self, columns: dict, *, auth=None, context=None, cap_rows=False,
                   max_rep: int = MAC_MAX_REPETITIONS) -> tuple[dict, bool, dict]:
        stats: dict = {}
        rows, complete = await _walk_columns(
            self.mod, self.engine, auth or self.auth, self.transport, columns,
            context=context, max_rep=max_rep, retries=MAC_RETRIES,
            budget=self.budget, cap_rows=cap_rows, stats=stats,
        )
        return rows, complete, stats

    def note(self, what: str, stats: dict) -> None:
        """A default-context walk ended early: say why. A timeout means the
        agent stopped answering, so nothing more is asked."""
        if stats.get("truncated"):
            return  # the budget says so once, at the end
        self.problems.append(f"{what}: {_why(stats)}")
        if stats.get("timeout"):
            self.halted = True

    async def run(self) -> tuple[list[dict], dict]:
        started = _monotonic()
        try:
            rows = await self._read()
        except Exception as e:  # noqa: BLE001 - a surprise here must not cost the poll
            rows = []
            self.problems.append(f"MAC table read failed: {e}")
        return self._finish(rows, started)

    async def _read(self) -> list[dict]:
        base_rows, ok, stats = await self.walk({"if_index": _DOT1D_BASE_PORT_IFINDEX})
        if not ok:
            self.note("dot1dBasePortIfIndex", stats)
        if self.stopped:
            return []
        base = _column(base_rows, "if_index")
        self.default_base = bool(base)

        # dot1qVlanFdbId before the forwarding table: it is small, and a read
        # the budget cuts short still knows the VLAN of every row it got.
        vlan_rows, vlan_ok, stats = await self.walk({"fdb": _DOT1Q_VLAN_FDB_ID})
        if not vlan_ok:
            self.note("dot1qVlanFdbId", stats)
        if self.stopped:
            return []

        q_rows, ok, stats = await self.walk(
            {"port": _DOT1Q_TP_FDB_PORT, "status": _DOT1Q_TP_FDB_STATUS}, cap_rows=True
        )
        if not ok:
            self.note("dot1qTpFdbTable", stats)
        if q_rows:
            self.meta["source"] = "qbridge"
            entries = parse_fdb_table(q_rows, qbridge=True)
            await self._qbridge_vlans(entries, _column(vlan_rows, "fdb"), vlan_ok)
            return await self._learned(entries, base)
        if self.stopped:
            return []

        d_rows, ok, stats = await self.walk(
            {"port": _DOT1D_TP_FDB_PORT, "status": _DOT1D_TP_FDB_STATUS}, cap_rows=True
        )
        if not ok:
            self.note("dot1dTpFdbTable", stats)
        if d_rows:
            self.meta["source"] = "bridge"
        rows = await self._learned(parse_fdb_table(d_rows, qbridge=False), base)
        if self.stopped or self.opts["contexts"] == "off":
            return rows
        return await self._per_vlan(rows)

    async def _qbridge_vlans(self, entries: list[dict], vlan_fdb: dict,
                             vlan_fdb_complete: bool) -> None:
        """Give each Q-BRIDGE entry its VLAN - never a guess (map_fdb_vlans).
        Only an agent whose dot1qVlanFdbId walk ended empty, rather than
        failed, may have its FDB ids taken as the VLANs it names."""
        named = None
        if not vlan_fdb and vlan_fdb_complete:
            named = set(self.ifaces.pvids)
            if self.can_walk:
                names, ok, stats = await self.walk({"name": _DOT1Q_VLAN_STATIC_NAME})
                if not ok:
                    self.note("dot1qVlanStaticName", stats)
                named |= {v for v in (_int(i) for i in names) if v}
        vlan_of, how = map_fdb_vlans((e["fdb_id"] for e in entries), vlan_fdb, named)
        self.meta["vlan_map"] = how
        for entry in entries:
            entry["vlan"] = vlan_of.get(entry["fdb_id"])

    async def _learned(self, entries: list[dict], base: dict) -> list[dict]:
        rows, how = learned_rows(
            entries, base, dropped=self.meta["dropped"], ifaces=self.ifaces
        )
        if how:
            self.port_maps.append(how)
        logical = {
            r["if_index"] for r in rows
            if self.ifaces.known(r["if_index"]) and not self.ifaces.is_port(r["if_index"])
        }
        if logical and self.stack is None and self.can_walk:
            stack, ok, stats = await self.walk({"status": _IF_STACK_STATUS})
            if not ok:
                self.note("ifStackTable", stats)
            self.stack = unit_ports(_column(stack, "status"), ifaces=self.ifaces)
        if logical and self.stack:
            for row in rows:
                row["if_index"] = self.stack.get(row["if_index"], row["if_index"])
        return rows

    async def _context_vlans(self) -> tuple[list, bool]:
        """The VLANs with a context of their own → ``(vlans, advertised)``.
        ``advertised`` is true when the agent itself listed them."""
        rows, ok, stats = await self.walk(_ENT_LOGICAL_COLUMNS, max_rep=25)
        if not ok:
            self.note("entLogicalTable", stats)
        vlans = parse_entity_vlans(rows)
        if vlans or self.stopped:
            return vlans, bool(vlans)
        rows, ok, stats = await self.walk({"state": _VTP_VLAN_STATE})
        if not ok:
            self.note("vtpVlanState", stats)
        vlans = parse_vtp_vlans(_column(rows, "state"))
        if vlans or self.stopped:
            return vlans, bool(vlans)
        if self.opts["contexts"] == "always":
            return list(self.opts["hint"]), False
        return [], False

    async def _per_vlan(self, rows: list[dict]) -> list[dict]:
        vlans, advertised = await self._context_vlans()
        to_read, over_cap = plan_context_vlans(vlans, self.opts["max_vlans"])
        if self.stopped or not to_read:
            return rows
        listed = self.meta["vlans"]
        listed["skipped"].extend(over_cap)
        if self.opts["quick"]:
            listed["skipped"].extend(to_read)
            self.problems.append("quick read: per-VLAN MAC tables not read")
            context_rows = []
        else:
            context_rows = await self._read_contexts(to_read)
        if listed["read"]:
            self.meta["source"] = "bridge-vlan"
        if advertised or listed["read"]:
            self.meta["vlan_map"] = "context"
            if 1 in listed["read"]:
                # VLAN 1's own context supersedes the default one, which some
                # agents fill with every VLAN's entries.
                rows = []
            # Otherwise the default context is VLAN 1, as on Cisco agents.
            for row in rows:
                if row["vlan"] is None:
                    row["vlan"] = 1
        return rows + context_rows

    def _context_auth(self, vid: int):
        """Credentials for one VLAN's context: ``community@vid`` on v1/v2c, the
        v3 context ``vlan-<vid>``. Built here, never logged or returned."""
        if self.version == "v3":
            return self.auth, self.mod.ContextData(contextName=f"vlan-{vid}")
        community = self.secret_params.get("community") or self.params.get(
            "community", "public"
        )
        mp_model = 0 if self.version == "v1" else 1
        return self.mod.CommunityData(f"{community}@{vid}", mpModel=mp_model), None

    async def _read_context(self, vid: int) -> tuple[bool, list[dict], str]:
        """Read one VLAN's context → ``(ok, rows, failure)``; ``failure`` is ``""``
        when the budget or the row cap cut it short rather than the agent."""
        auth, context = self._context_auth(vid)
        base, ok, stats = await self.walk(
            {"if_index": _DOT1D_BASE_PORT_IFINDEX}, auth=auth, context=context
        )
        if not ok:
            return False, [], "" if stats["truncated"] else _why(stats)
        fdb, ok, stats = await self.walk(
            {"port": _DOT1D_TP_FDB_PORT, "status": _DOT1D_TP_FDB_STATUS},
            auth=auth, context=context, cap_rows=True,
        )
        entries = parse_fdb_table(fdb, qbridge=False)
        for entry in entries:
            entry["vlan"] = vid
        rows = await self._learned(entries, _column(base, "if_index"))
        if not ok:
            return False, rows, "" if stats["truncated"] else _why(stats)
        return True, rows, ""

    async def _read_contexts(self, vlans: list[int]) -> list[dict]:
        """Read per-VLAN contexts, ``MAC_CONTEXT_CONCURRENCY`` at a time. After
        ``MAC_CONTEXT_ABORT_AFTER`` failures in a row - a wrong community, or a
        v3 group without ``context vlan- match prefix`` - the rest is skipped."""
        listed = self.meta["vlans"]
        gate = asyncio.Semaphore(max(1, MAC_CONTEXT_CONCURRENCY))
        results: dict[int, list[dict]] = {}
        failures: dict[int, str] = {}
        streak: list[int] = []
        aborted: list[int] = []

        async def one(vid: int) -> None:
            async with gate:
                if aborted or self.budget.truncated or self.budget.remaining() <= 0:
                    listed["skipped"].append(vid)
                    return
                ok, rows, failure = await self._read_context(vid)
                results[vid] = rows
                if ok:
                    listed["read"].append(vid)
                    streak.clear()
                elif not failure:
                    listed["skipped"].append(vid)
                else:
                    listed["failed"].append(vid)
                    failures[vid] = failure
                    streak.append(vid)
                    if aborted:
                        aborted.append(vid)  # was already in flight
                    elif len(streak) >= MAC_CONTEXT_ABORT_AFTER:
                        aborted.extend(streak)

        await asyncio.gather(*(one(vid) for vid in vlans))
        if aborted:
            hint = (
                "the v3 group may lack 'context vlan- match prefix'"
                if self.version == "v3" else "the agent may not take community@vlan"
            )
            shown = ", ".join(str(v) for v in aborted)
            self.problems.append(
                f"per-VLAN read stopped after {len(aborted)} failed contexts in a row "
                f"(VLAN {shown}); {hint}"
            )
        others = sorted(v for v in failures if v not in aborted)
        if others:
            self.problems.append(
                "per-VLAN contexts failed: "
                + ", ".join(f"VLAN {v} ({failures[v]})" for v in others)
            )
        return [row for vid in sorted(results) for row in results[vid]]

    def _finish(self, rows: list[dict], started: float) -> tuple[list[dict], dict]:
        # One row per (vlan, mac, port): shared FDBs leave several VLAN-less
        # copies, and a logical unit can fold onto a port that has its own.
        unique, seen = [], set()
        for row in rows:
            key = (row["vlan"], row["mac"], row["if_index"])
            if key not in seen:
                seen.add(key)
                unique.append(row)
        meta = self.meta
        if self.budget.truncated:
            self.problems.append(
                f"time budget ({self.budget.seconds} s) reached"
                if self.budget.reason == "time"
                else f"row cap ({self.budget.rows}) reached"
            )
        meta["truncated"] = self.budget.truncated
        meta["complete"] = not self.problems
        meta["error"] = "; ".join(dict.fromkeys(self.problems))[:300]
        if self.port_maps:
            meta["port_map"] = max(self.port_maps, key=_PORT_MAP_RANK.__getitem__)
        else:
            meta["port_map"] = "base-port" if self.default_base else "none"
        for key in meta["vlans"]:
            meta["vlans"][key] = sorted(set(meta["vlans"][key]))
        meta["rows"] = len(unique)
        meta["elapsed_ms"] = int(max(_monotonic() - started, 0) * 1000)
        return unique, meta


async def fetch_mac_table(
    target: str, version: str, params: dict, secret_params: dict, timeout_ms: int = 4000,
    *, interfaces: list | None = None, mode: str = "full",
) -> tuple[list[dict], dict]:
    """Read the device's MAC address table → ``(rows, meta)``.

    ``rows``: ``[{mac, if_index, vlan, fdb_id, bridge_port, status}]``, learned
    entries only, one per (vlan, mac, if_index). ``meta`` is ``fdb_meta``:
    ``source`` (qbridge | bridge | bridge-vlan | none), ``complete``,
    ``truncated``, ``vlan_map`` (fdb-id | assumed | context | none),
    ``port_map`` (base-port | assumed | none), ``vlans`` {read, skipped,
    failed}, ``dropped`` counts by reason, ``rows``, ``elapsed_ms`` and
    ``error``.

    ``interfaces`` - the same poll's interface rows - supplies ifTypes and the
    device's own addresses. ``mode`` ``"full"`` (the default) has
    ``mac_budget_s`` (120 s) and reads per-VLAN contexts per
    ``mac_vlan_contexts`` (auto | always | off); ``"quick"`` has 15 s and reads
    no contexts. Raises ``SnmpFactsError`` only when no request could be built.
    """
    try:
        mod = _load_pysnmp()
    except Exception as e:  # noqa: BLE001
        raise SnmpFactsError(f"pysnmp unavailable: {e}") from e
    params = params or {}
    secret_params = secret_params or {}
    port = int(params.get("port", 161))
    timeout_s = max(timeout_ms / 1000, 0.2)
    try:
        auth = _auth_data(version, params, secret_params, mod)
        transport = await mod.UdpTransportTarget.create(
            (target, port), timeout=timeout_s, retries=0
        )
    except Exception as e:  # noqa: BLE001
        raise SnmpFactsError(f"snmp error: {e}") from e
    engine = mod.SnmpEngine()
    try:
        return await _MacTableRead(
            mod, engine, auth, transport, version, params, secret_params,
            interfaces, mode,
        ).run()
    finally:
        _close_engine(engine)


def fetch_mac_table_sync(
    target: str, version: str, params: dict, secret_params: dict, timeout_ms: int = 4000,
    *, interfaces: list | None = None, mode: str = "full",
) -> tuple[list[dict], dict]:
    return asyncio.run(fetch_mac_table(
        target, version, params, secret_params, timeout_ms,
        interfaces=interfaces, mode=mode,
    ))


def fetch_snmp(target, version, params, secret_params, timeout_ms, *,
               mac_mode: str = "full") -> dict:
    """Fetch a device's full observed SNMP state → ``{data, interfaces,
    neighbors, arp, arp_meta, fdb, fdb_meta, reachable, error}``. Pure (no ORM)
    - the **same** function the core (``poll_device``) and a remote Outpost
    both run, so discovery gives identical results wherever it happens. Facts
    are required (their failure = unreachable); interfaces, the MAC table and
    topology are best-effort.

    ``mac_mode`` is ``"full"`` (what an Outpost's positional call gets) or
    ``"quick"`` for a read inside a request (see :func:`fetch_mac_table`).
    ``fdb_meta`` and ``arp_meta`` are always present - ``complete: false`` with
    error ``"not read"`` when the table wasn't read - and are how the core
    tells this collector from an older agent's.
    """
    args = (target, version, params or {}, secret_params or {}, timeout_ms)
    out = {
        "data": {}, "interfaces": [], "neighbors": [], "arp": [],
        "arp_meta": _arp_meta(error="not read"), "fdb": [],
        "fdb_meta": _mac_meta(error="not read"), "reachable": False, "error": "",
    }
    try:
        out["data"] = fetch_system_facts_sync(*args)
        out["reachable"] = True
        try:
            out["interfaces"] = fetch_interfaces_sync(*args)
        except SnmpFactsError:
            pass
        try:
            out["fdb"], out["fdb_meta"] = fetch_mac_table_sync(
                *args, interfaces=out["interfaces"], mode=mac_mode
            )
        except SnmpFactsError as exc:
            out["fdb_meta"] = _mac_meta(error=str(exc)[:300])
        try:
            topo = fetch_topology_sync(*args, interfaces=out["interfaces"])
            out["neighbors"] = topo.get("neighbors", [])
            out["arp"] = topo.get("arp", [])
            out["arp_meta"] = topo.get("arp_meta") or _arp_meta(error="not read")
        except SnmpFactsError as exc:
            out["arp_meta"] = _arp_meta(error=str(exc)[:300])
    except SnmpFactsError as exc:
        out["error"] = str(exc)[:500]
    return out


# ─── Arbitrary OID fetch (user-defined sensors) ─────────────────────────────

async def fetch_oid(
    target: str, version: str, params: dict, secret_params: dict,
    oid: str, walk: bool, timeout_ms: int = 4000, limit: int | None = None,
) -> dict:
    """Read one user-defined OID → ``{index: prettyValue, ...}``.

    WALK mode returns one entry per table row (key = the OID tail after
    ``oid``); scalar (GET) mode returns ``{"0": value}``. Raises
    ``SnmpFactsError`` on a config/engine failure so the caller records the
    error; an empty dict means the agent simply had nothing there.
    """
    try:
        mod = _load_pysnmp()
    except Exception as e:  # noqa: BLE001
        raise SnmpFactsError(f"pysnmp unavailable: {e}")

    port = int(params.get("port", 161))
    timeout_s = max(timeout_ms / 1000, 0.2)
    try:
        auth = _auth_data(version, params, secret_params, mod)
        transport = await mod.UdpTransportTarget.create(
            (target, port), timeout=timeout_s, retries=0
        )
        engine = mod.SnmpEngine()
        if walk:
            return await _walk_column(
                mod, engine, auth, transport, oid.strip("."), limit
            )
        error_indication, error_status, _, var_binds = await mod.get_cmd(
            engine, auth, transport, mod.ContextData(),
            mod.ObjectType(mod.ObjectIdentity(oid)),
        )
    except Exception as e:  # noqa: BLE001
        raise SnmpFactsError(f"snmp error: {e}")
    if error_indication:
        raise SnmpFactsError(str(error_indication))
    if error_status:
        raise SnmpFactsError(error_status.prettyPrint())
    return {"0": v.prettyPrint() for _, v in var_binds}


async def list_oid_children(
    target: str, version: str, params: dict, secret_params: dict,
    base: str, timeout_ms: int = 4000, limit: int = 64,
) -> list[dict]:
    """List the direct children of ``base`` → ``[{sub, oid, sample}, ...]``.

    One level, not a subtree. A plain walk can't browse the tree: OIDs come back
    in lexicographic order, so walking a high base like ``1.3.6.1.4.1`` spends
    its entire budget inside the first vendor it meets and never reveals that
    the others exist.

    So each child is found with a single GETNEXT, then its whole subtree is
    skipped by probing ``base.child.4294967295`` - greater than anything within
    that child (max sub-identifier), yet still less than the next sibling, so no
    sibling is stepped over. That's one round trip per child instead of one per
    value.
    """
    try:
        mod = _load_pysnmp()
    except Exception as e:  # noqa: BLE001
        raise SnmpFactsError(f"pysnmp unavailable: {e}")

    base = base.strip(".")
    prefix = f"{base}."
    port = int(params.get("port", 161))
    timeout_s = max(timeout_ms / 1000, 0.2)
    out: list[dict] = []
    try:
        auth = _auth_data(version, params, secret_params, mod)
        transport = await mod.UdpTransportTarget.create(
            (target, port), timeout=timeout_s, retries=0
        )
        engine = mod.SnmpEngine()
        probe = base
        while len(out) < limit:
            error_indication, error_status, _, var_binds = await mod.next_cmd(
                engine, auth, transport, mod.ContextData(),
                mod.ObjectType(mod.ObjectIdentity(probe)),
                lexicographicMode=True,
            )
            if error_indication or error_status:
                # Nothing collected yet → the agent never answered, which is a
                # very different thing from an empty subtree and must not be
                # reported as "nothing there". Small BMCs do time out under
                # consecutive browses. Once we have children, keep the partial
                # listing: it's still navigable.
                if not out:
                    raise SnmpFactsError(
                        str(error_indication or error_status.prettyPrint())
                    )
                break
            if not var_binds:
                break
            oid, value = var_binds[0]
            found = str(oid)
            if not found.startswith(prefix):
                break  # walked out of the subtree - done
            sub = found[len(prefix):].split(".")[0]
            out.append({
                "sub": sub,
                "oid": f"{base}.{sub}",
                # Where the first value under this child actually lives, which
                # is what tells a table entry (one level down) from a branch.
                "first_oid": found,
                "sample": value.prettyPrint(),
            })
            probe = f"{base}.{sub}.4294967295"
    except SnmpFactsError:
        raise
    except Exception as e:  # noqa: BLE001
        raise SnmpFactsError(f"snmp error: {e}")
    return out


def list_oid_children_sync(
    target, version, params, secret_params, base, timeout_ms=4000, limit=64
) -> list[dict]:
    """Synchronous wrapper for browsing the tree from a DRF view."""
    return asyncio.run(
        list_oid_children(
            target, version, params, secret_params, base, timeout_ms, limit
        )
    )


def fetch_oid_sync(
    target, version, params, secret_params, oid, walk, timeout_ms=4000,
    limit: int | None = None,
) -> dict:
    """Synchronous wrapper for on-demand sensor polling from a DRF view."""
    return asyncio.run(
        fetch_oid(
            target, version, params, secret_params, oid, walk, timeout_ms, limit
        )
    )
