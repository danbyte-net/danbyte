"""SNMP system-facts fetch — the read-only *observed* layer for Phase 1 of the
discovery feature (issue #84).

A single SNMP GET of the system MIB (sysDescr/sysObjectID/sysUpTime/sysContact/
sysName/sysLocation), returned as a named dict — never raw OIDs to the caller.
Reuses the v2c/v3 credential shape used by ``monitoring.checkers.snmp`` so an
``SnmpProfile``'s ``params`` + ``secret_params`` work unchanged here.

This is *observed* data: it is stored alongside the device's source-of-truth
fields and never overwrites them (reconciliation is a later phase).
"""
from __future__ import annotations

import asyncio

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
    """Mirror of ``SnmpChecker._auth_data`` — build pysnmp auth from the same
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
        import pysnmp.hlapi.v3arch.asyncio as mod
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


# ─── Interface enrichment (IF-MIB ifTable + ifXTable) — Phase 2 ─────────────
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

# Q-BRIDGE-MIB (802.1Q) — for per-interface access VLAN (PVID). VLAN membership
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
    """Best-effort MAC formatting from pysnmp's prettyPrint of ifPhysAddress."""
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
        import pysnmp.hlapi.v3arch.asyncio as mod
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
        except Exception:  # noqa: BLE001 — a missing column shouldn't fail the rest
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
    except Exception:  # noqa: BLE001 — ipAddrTable is optional
        pass

    # Q-BRIDGE-MIB: per-interface access VLAN (PVID). Optional — L3-only devices
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
            "type_name": _IANA_IFTYPE.get(r.get("type", ""), ""),
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
_LLDP_LOC_PORT_DESC = "1.0.8802.1.1.2.1.3.7.1.4"
_LLDP_REM_SYSNAME = "1.0.8802.1.1.2.1.4.1.1.9"
_LLDP_REM_PORT_DESC = "1.0.8802.1.1.2.1.4.1.1.8"
_LLDP_REM_PORT_ID = "1.0.8802.1.1.2.1.4.1.1.7"
# ipNetToMediaPhysAddress, indexed by ifIndex.a.b.c.d
_ARP_PHYS = "1.3.6.1.2.1.4.22.1.2"


def parse_lldp(loc_ports: dict, rem_sysname: dict, rem_port_desc: dict,
               rem_port_id: dict) -> list[dict]:
    """Pure LLDP join: rem-table rows (keyed timeMark.localPort.remIndex) +
    local-port names → ``[{local_port, remote_device, remote_port}]``."""
    out = []
    for index, sysname in rem_sysname.items():
        if not sysname:
            continue
        parts = index.split(".")
        local_port_num = parts[1] if len(parts) >= 2 else ""
        out.append({
            "local_port": loc_ports.get(local_port_num) or f"port {local_port_num}",
            "remote_device": sysname,
            "remote_port": rem_port_desc.get(index) or rem_port_id.get(index) or "",
        })
    return out


def parse_arp(phys: dict) -> list[dict]:
    """Pure ARP parse: ipNetToMediaPhysAddress (index ifIndex.a.b.c.d) →
    ``[{ip, mac, if_index}]``."""
    out = []
    for index, mac in phys.items():
        parts = index.split(".")
        if len(parts) >= 5:
            out.append({
                "if_index": parts[0],
                "ip": ".".join(parts[1:5]),
                "mac": _fmt_mac(mac),
            })
    return out


async def _walk_column(mod, engine, auth, transport, base: str) -> dict:
    """Walk one column → ``{oid_tail_after_base: prettyValue}``. Tolerant: a
    missing/blocked column yields ``{}`` rather than failing the whole fetch."""
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
    except Exception:  # noqa: BLE001
        return result
    return result


async def fetch_topology(
    target: str, version: str, params: dict, secret_params: dict, timeout_ms: int = 4000
) -> dict:
    """Discover LLDP neighbours + the ARP table → ``{neighbors, arp}``."""
    try:
        import pysnmp.hlapi.v3arch.asyncio as mod
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
    loc = await _walk_column(mod, engine, auth, transport, _LLDP_LOC_PORT_DESC)
    sysn = await _walk_column(mod, engine, auth, transport, _LLDP_REM_SYSNAME)
    pdesc = await _walk_column(mod, engine, auth, transport, _LLDP_REM_PORT_DESC)
    pid = await _walk_column(mod, engine, auth, transport, _LLDP_REM_PORT_ID)
    phys = await _walk_column(mod, engine, auth, transport, _ARP_PHYS)
    return {
        "neighbors": parse_lldp(loc, sysn, pdesc, pid),
        "arp": parse_arp(phys),
    }


def fetch_topology_sync(
    target: str, version: str, params: dict, secret_params: dict, timeout_ms: int = 4000
) -> dict:
    return asyncio.run(
        fetch_topology(target, version, params, secret_params, timeout_ms)
    )


def fetch_snmp(target, version, params, secret_params, timeout_ms) -> dict:
    """Fetch a device's full observed SNMP state → ``{data, interfaces,
    neighbors, arp, reachable, error}``. Pure (no ORM) — the **same** function
    the core (``poll_device``) and a remote Outpost both run, so discovery gives
    identical results wherever it happens. Facts are required (their failure =
    unreachable); interfaces + topology are best-effort.
    """
    args = (target, version, params or {}, secret_params or {}, timeout_ms)
    out = {
        "data": {}, "interfaces": [], "neighbors": [], "arp": [],
        "reachable": False, "error": "",
    }
    try:
        out["data"] = fetch_system_facts_sync(*args)
        out["reachable"] = True
        try:
            out["interfaces"] = fetch_interfaces_sync(*args)
        except SnmpFactsError:
            pass
        try:
            topo = fetch_topology_sync(*args)
            out["neighbors"] = topo.get("neighbors", [])
            out["arp"] = topo.get("arp", [])
        except SnmpFactsError:
            pass
    except SnmpFactsError as exc:
        out["error"] = str(exc)[:500]
    return out
