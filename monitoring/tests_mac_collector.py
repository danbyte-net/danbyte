"""SNMP MAC-table collection (#284): ``danbyte_checks.snmp_facts`` read against
an in-memory agent that answers GET and GETBULK the way a switch does.

Fixtures are ``snmpwalk -On`` output: a Q-BRIDGE access switch whose FDB ids
are not its VLAN ids, BRIDGE-MIB-only bridges, a Cisco-style switch with one
forwarding table per VLAN context, and a Junos-style switch that bridges
logical units. The pure parsers are tested on their own too. No database.
"""
from __future__ import annotations

import asyncio
import bisect
import inspect
import re
from unittest.mock import patch

from django.test import SimpleTestCase

from danbyte_checks import snmp_facts as sf

TARGET = "192.0.2.10"
V2C = {"community": "public"}
V3 = {"username": "ops", "auth_key": "auth-pass-123", "priv_key": "priv-pass-123"}

BASE_PORT = "1.3.6.1.2.1.17.1.4.1.2"
PVID = "1.3.6.1.2.1.17.7.1.4.5.1.1"
VLAN_NAME = "1.3.6.1.2.1.17.7.1.4.3.1.1"
VLAN_FDB_ID = "1.3.6.1.2.1.17.7.1.4.2.1.3"
Q_FDB_PORT = "1.3.6.1.2.1.17.7.1.2.2.1.2"
Q_FDB_STATUS = "1.3.6.1.2.1.17.7.1.2.2.1.3"
D_FDB_PORT = "1.3.6.1.2.1.17.4.3.1.2"
D_FDB_STATUS = "1.3.6.1.2.1.17.4.3.1.3"
ENT_LOGICAL = "1.3.6.1.2.1.47.1.2.1.1"
VTP_STATE = "1.3.6.1.4.1.9.9.46.1.3.1.1.2"
IF_STACK = "1.3.6.1.2.1.31.1.2.1.3"
ARP_PHYS = "1.3.6.1.2.1.4.22.1.2"
ARP_TYPE = "1.3.6.1.2.1.4.22.1.4"

LEARNED, SELF, MGMT, OTHER, INVALID = (
    "learned(3)", "self(4)", "mgmt(5)", "other(1)", "invalid(2)",
)

PC = "3c:52:82:aa:10:44"
PHONE = "00:1b:44:11:3a:b7"
PRINTER = "00:80:77:12:34:56"
SERVER = "a4:bf:01:22:33:44"
GATEWAY = "00:00:5e:00:01:0a"
CORE = "70:1f:53:aa:00:01"
AP = "00:3a:7d:11:22:33"
STATIC = "00:11:22:33:44:55"
DESK = [f"02:00:00:00:09:0{i}" for i in range(1, 7)]


# ─── A fake agent behind the pysnmp API ─────────────────────────────────────

class Value:
    """A walked value as the collector sees it: ``prettyPrint()`` is all it reads."""

    def __init__(self, text: str):
        self.text = text

    def prettyPrint(self) -> str:
        return self.text

    def __repr__(self) -> str:
        return f"Value({self.text!r})"


class EndOfMibView(Value):
    def __init__(self):
        super().__init__("No more variables left in this MIB View")


class NoSuchObject(Value):
    def __init__(self):
        super().__init__("No Such Object currently exists at this OID")


class RequestTimedOut:
    def __str__(self) -> str:
        return "No SNMP response received before timeout"


class Community:
    def __init__(self, name, mpModel=1):
        self.name = name
        self.mp_model = mpModel


class Usm:
    def __init__(self, user, **keys):
        self.user = user
        self.keys = keys


class Context:
    def __init__(self, contextEngineId=None, contextName=b""):
        name = contextName
        self.name = name.decode() if isinstance(name, bytes) else str(name)


class Transport:
    def __init__(self, address, timeout, retries):
        self.address, self.timeout, self.retries = address, timeout, retries

    @classmethod
    async def create(cls, address, timeout=1, retries=0):
        return cls(address, timeout, retries)


class Clock:
    """Stands in for ``snmp_facts._monotonic``; each request moves it on."""

    def __init__(self):
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def _key(oid: str) -> tuple:
    return tuple(int(part) for part in oid.split("."))


def _octet_text(data: bytes) -> str:
    """pyasn1's rendering of an OCTET STRING: text when every byte prints."""
    if all(32 <= b <= 126 for b in data):
        return data.decode("ascii")
    return "0x" + data.hex()


def _render(kind: str, raw: str) -> str:
    if kind == "INTEGER":
        found = re.search(r"\((-?\d+)\)$", raw)  # learned(3)
        return found.group(1) if found else raw
    if kind == "STRING":
        return _octet_text(raw.strip('"').encode("latin-1"))
    if kind == "Hex-STRING":
        return _octet_text(bytes.fromhex(raw.replace(" ", "")))
    if kind == "OID":
        return raw.lstrip(".")
    return raw.split()[0].strip("()")  # Gauge32: 5, Timeticks: (100) 0:00:01.00


def walk(*texts: str) -> dict:
    """``snmpwalk -On`` output → ``{oid: Value}``."""
    tree = {}
    for text in texts:
        for line in text.strip().splitlines():
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            oid, _, rest = line.partition(" = ")
            kind, _, raw = rest.partition(": ")
            tree[oid.strip().lstrip(".")] = Value(_render(kind.strip(), raw.strip()))
    return tree


class FakeAgent:
    """Stands in for ``pysnmp.hlapi.v3arch.asyncio``: one agent with a default
    tree and one tree per VLAN context, reached Cisco-style as
    ``community@vid`` (v1/v2c) or the v3 context ``vlan-<vid>``. A community,
    user or context it doesn't know gets no answer at all, like a real agent."""

    def __init__(self, default: dict, vlans: dict | None = None, *,
                 community: str = "public", user: str = "ops",
                 clock: Clock | None = None, step: float = 0.0):
        self.trees = {"": self._index(default)}
        for vid, tree in (vlans or {}).items():
            self.trees[f"vlan-{vid}"] = self._index(tree)
        self.community = community
        self.user = user
        self.clock = clock
        self.step = step
        self.requests: list[dict] = []
        self.rules: list[dict] = []
        self.in_flight = 0
        self.peak = 0
        self.UdpTransportTarget = Transport

    # ── the pysnmp surface the collector uses ──
    def SnmpEngine(self):
        return object()

    def CommunityData(self, name, mpModel=1):
        return Community(name, mpModel)

    def UsmUserData(self, user, **keys):
        return Usm(user, **keys)

    def ContextData(self, contextEngineId=None, contextName=b""):
        return Context(contextEngineId, contextName)

    def ObjectIdentity(self, oid):
        return str(oid).strip(".")

    def ObjectType(self, identity):
        return identity

    def __getattr__(self, name):
        if name.startswith("usm"):  # auth/priv protocol constants
            return name
        raise AttributeError(name)

    async def get_cmd(self, engine, auth, transport, ctx, *oids, **options):
        context = self.context_of(auth, ctx)
        self.requests.append({"op": "get", "context": context, "oids": list(oids)})
        if context is None:
            return RequestTimedOut(), 0, 0, ()
        values = dict(self.trees[context][1])
        return None, 0, 0, [(oid, values.get(oid, NoSuchObject())) for oid in oids]

    async def bulk_cmd(self, engine, auth, transport, ctx, non_repeaters, max_rep, *oids,
                       **options):
        self.in_flight += 1
        self.peak = max(self.peak, self.in_flight)
        try:
            await asyncio.sleep(0)
            context = self.context_of(auth, ctx)
            self.requests.append({
                "op": "bulk", "context": context, "oids": list(oids), "max_rep": max_rep,
                "community": getattr(auth, "name", None),
                "context_name": getattr(ctx, "name", None), "options": options,
            })
            if self.clock is not None:
                self.clock.now += self.step
            if context is None:
                return RequestTimedOut(), 0, 0, ()
            failure = self._failure(context, oids)
            if failure == "timeout":
                return RequestTimedOut(), 0, 0, ()
            if failure == "genErr":
                return None, 5, 1, ()
            if failure == "tooBig":
                return None, 1, 0, ()
            keys, items = self.trees[context]
            cursors, ended, out = list(oids), [False] * len(oids), []
            for _ in range(max_rep):
                for j, cursor in enumerate(cursors):
                    at = bisect.bisect_right(keys, _key(cursor))
                    if ended[j] or at >= len(items):
                        ended[j] = True
                        out.append((cursor, EndOfMibView()))
                    else:
                        out.append(items[at])
                        cursors[j] = items[at][0]
                if all(ended):
                    break
            await asyncio.sleep(0)
            return None, 0, 0, out
        finally:
            self.in_flight -= 1

    async def bulk_walk_cmd(self, engine, auth, transport, ctx, non_repeaters, max_rep, oid,
                            **options):
        base = cursor = str(oid)
        while True:
            error, status, index, table = await self.bulk_cmd(
                engine, auth, transport, ctx, 0, max_rep, cursor
            )
            if error or status:
                yield error, status, index, ()
                return
            page = []
            for name, value in table:
                if isinstance(value, EndOfMibView) or not name.startswith(base + "."):
                    if page:
                        yield None, 0, 0, page
                    return
                page.append((name, value))
                cursor = name
            yield None, 0, 0, page

    # ── test controls ──
    def context_of(self, auth, ctx):
        """The tree a request reads, or None when the agent stays silent."""
        if isinstance(auth, Community):
            if auth.name == self.community:
                return ""
            prefix = self.community + "@"
            if auth.name.startswith(prefix):
                key = "vlan-" + auth.name[len(prefix):]
                return key if key in self.trees else None
            return None
        if auth.user != self.user:
            return None
        name = ctx.name if ctx is not None else ""
        return name if name in self.trees else None

    def fail_on(self, prefix: str, *, after: int = 0, kind: str = "timeout",
                times: int | None = None, context: str | None = None):
        """Requests reaching under ``prefix`` fail once ``after`` of them got
        through (``times`` failures, or for good)."""
        self.rules.append({"prefix": prefix, "after": after, "kind": kind,
                           "times": times, "context": context, "seen": 0})

    def _failure(self, context, oids):
        for rule in self.rules:
            if rule["context"] is not None and rule["context"] != context:
                continue
            if not any(o == rule["prefix"] or o.startswith(rule["prefix"] + ".")
                       for o in oids):
                continue
            rule["seen"] += 1
            if rule["seen"] > rule["after"] and rule["times"] != 0:
                if rule["times"] is not None:
                    rule["times"] -= 1
                return rule["kind"]
        return None

    @staticmethod
    def _index(tree: dict):
        items = sorted(tree.items(), key=lambda item: _key(item[0]))
        return [_key(oid) for oid, _ in items], items

    def walked(self, column: str) -> list[dict]:
        """The GETBULK requests that carried ``column``."""
        return [
            r for r in self.requests
            if r["op"] == "bulk" and any(o == column or o.startswith(column + ".")
                                         for o in r["oids"])
        ]

    def communities(self) -> set:
        return {r.get("community") for r in self.requests if r.get("community")}

    def context_names(self) -> set:
        return {r.get("context_name") for r in self.requests if r["op"] == "bulk"}


# ─── Walk builders ──────────────────────────────────────────────────────────

def _index_of(mac: str) -> str:
    return ".".join(str(int(part, 16)) for part in mac.split(":"))


def system(name: str) -> str:
    return (
        f'.1.3.6.1.2.1.1.1.0 = STRING: "Access switch, {name}"\n'
        ".1.3.6.1.2.1.1.2.0 = OID: .1.3.6.1.4.1.99999.1\n"
        ".1.3.6.1.2.1.1.3.0 = Timeticks: (8640000) 1 day, 0:00:00.00\n"
        f'.1.3.6.1.2.1.1.5.0 = STRING: "{name}"\n'
    )


def iftable(*ports) -> str:
    """IF-MIB for (ifIndex, ifName, ifDescr, ifType, ifPhysAddress)."""
    lines = []
    for index, name, descr, if_type, mac in ports:
        lines += [
            f'.1.3.6.1.2.1.2.2.1.2.{index} = STRING: "{descr}"',
            f".1.3.6.1.2.1.2.2.1.3.{index} = INTEGER: {if_type}",
            f".1.3.6.1.2.1.2.2.1.6.{index} = Hex-STRING: {mac}",
            f".1.3.6.1.2.1.2.2.1.7.{index} = INTEGER: up(1)",
            f".1.3.6.1.2.1.2.2.1.8.{index} = INTEGER: up(1)",
            f'.1.3.6.1.2.1.31.1.1.1.1.{index} = STRING: "{name}"',
        ]
    return "\n".join(lines)


def gi_ports(count: int, unit: int = 1, mac_prefix: str = "70 1F 53 00 00") -> list:
    return [
        (10100 + n, f"Gi{unit}/0/{n}", f"GigabitEthernet{unit}/0/{n}", "ethernetCsmacd(6)",
         f"{mac_prefix} {n:02X}")
        for n in range(1, count + 1)
    ]


def base_ports(mapping: dict) -> str:
    return "\n".join(f".{BASE_PORT}.{p} = INTEGER: {i}" for p, i in mapping.items())


def qbridge_fdb(*entries) -> str:
    """dot1qTpFdbPort/Status for (fdb_id, mac, port, status)."""
    lines = []
    for fdb_id, mac, port, status in entries:
        index = f"{fdb_id}.{_index_of(mac)}"
        lines.append(f".{Q_FDB_PORT}.{index} = INTEGER: {port}")
        lines.append(f".{Q_FDB_STATUS}.{index} = INTEGER: {status}")
    return "\n".join(lines)


def bridge_fdb(*entries, status_column: bool = True) -> str:
    """dot1dTpFdbPort/Status for (mac, port, status)."""
    lines = []
    for mac, port, status in entries:
        index = _index_of(mac)
        lines.append(f".{D_FDB_PORT}.{index} = INTEGER: {port}")
        if status_column:
            lines.append(f".{D_FDB_STATUS}.{index} = INTEGER: {status}")
    return "\n".join(lines)


def vlan_fdb_ids(mapping: dict) -> str:
    """dot1qVlanFdbId for {vlan: fdb_id} (timeMark 0)."""
    return "\n".join(f".{VLAN_FDB_ID}.0.{v} = Gauge32: {f}" for v, f in mapping.items())


def vlan_names(mapping: dict) -> str:
    return "\n".join(f'.{VLAN_NAME}.{v} = STRING: "{n}"' for v, n in mapping.items())


# sw-acc-03: a Q-BRIDGE access switch. VLAN 10 learns in FDB 1, VLAN 20 in FDB
# 2, VLAN 30 in FDB 3; bridge port n is ifIndex 10100+n, Te1/1/1 is port 10
# and Po1 port 11. The table carries one entry for every reason to drop one.
SW_ACC_03 = walk(
    system("sw-acc-03"),
    iftable(
        *gi_ports(9),
        (10201, "Te1/1/1", "TenGigabitEthernet1/1/1", "ethernetCsmacd(6)", "70 1F 53 00 00 41"),
        (10601, "Po1", "Port-channel1", "ieee8023adLag(161)", "70 1F 53 00 00 61"),
        (30010, "Vl10", "Vlan10", "l3ipvlan(136)", "70 1F 53 00 00 00"),
    ),
    base_ports({**{n: 10100 + n for n in range(1, 10)}, 10: 10201, 11: 10601}),
    f".{PVID}.5 = Gauge32: 10\n.{PVID}.7 = Gauge32: 30\n.{PVID}.9 = Gauge32: 10",
    vlan_names({10: "users", 20: "voice", 30: "printers"}),
    vlan_fdb_ids({10: 1, 20: 2, 30: 3}),
    qbridge_fdb(
        (1, PC, 5, LEARNED),
        (1, PHONE, 5, LEARNED),
        (2, PHONE, 5, LEARNED),                    # the phone in the voice VLAN too
        (3, PRINTER, 7, LEARNED),
        *[(1, mac, 9, LEARNED) for mac in DESK],   # a desk switch behind Gi1/0/9
        (1, SERVER, 11, LEARNED),                  # a bond on Po1
        (1, GATEWAY, 10, LEARNED),                 # the uplink
        (1, CORE, 10, LEARNED),
        (1, STATIC, 6, MGMT),                      # port security: kept
        (1, "70:1f:53:00:00:00", 0, SELF),         # the switch itself
        (2, "70:1f:53:00:00:00", 0, SELF),
        (1, "00:11:22:33:44:66", 6, INVALID),
        (1, "70:1f:53:00:00:05", 5, OTHER),        # Gi1/0/5's own address
        (1, "01:00:5e:7f:00:01", 8, OTHER),        # IPv4 multicast
        (1, "33:33:00:00:00:01", 8, MGMT),         # IPv6 multicast
        (1, "00:00:00:00:00:00", 8, LEARNED),
        (1, "00:50:56:01:02:03", 99, LEARNED),     # bridge port 99 maps to nothing
        (1, "00:50:56:0a:0b:0c", 0, LEARNED),      # port 0
    ),
    # LLDP: Gi1/0/5 names itself (interfaceName), the uplink only by MAC (bridge
    # port 10), the printer port by a local id (desc "Gi1/0/7", port num 77).
    """
    .1.0.8802.1.1.2.1.3.7.1.2.5 = INTEGER: interfaceName(5)
    .1.0.8802.1.1.2.1.3.7.1.2.10 = INTEGER: macAddress(3)
    .1.0.8802.1.1.2.1.3.7.1.2.77 = INTEGER: local(7)
    .1.0.8802.1.1.2.1.3.7.1.3.5 = STRING: "Gi1/0/5"
    .1.0.8802.1.1.2.1.3.7.1.3.10 = Hex-STRING: 70 1F 53 00 00 41
    .1.0.8802.1.1.2.1.3.7.1.3.77 = STRING: "77"
    .1.0.8802.1.1.2.1.3.7.1.4.5 = STRING: "GigabitEthernet1/0/5"
    .1.0.8802.1.1.2.1.3.7.1.4.10 = STRING: "uplink to core"
    .1.0.8802.1.1.2.1.3.7.1.4.77 = STRING: "Gi1/0/7"
    .1.0.8802.1.1.2.1.4.1.1.7.0.5.1 = STRING: "001B44113AB7:P1"
    .1.0.8802.1.1.2.1.4.1.1.7.0.10.2 = STRING: "Te1/0/12"
    .1.0.8802.1.1.2.1.4.1.1.7.0.77.3 = Hex-STRING: 00 80 77 12 34 56
    .1.0.8802.1.1.2.1.4.1.1.8.0.5.1 = STRING: "SW PORT"
    .1.0.8802.1.1.2.1.4.1.1.8.0.10.2 = STRING: "TenGigabitEthernet1/0/12"
    .1.0.8802.1.1.2.1.4.1.1.8.0.77.3 = STRING: ""
    .1.0.8802.1.1.2.1.4.1.1.9.0.5.1 = STRING: "SEP001B44113AB7"
    .1.0.8802.1.1.2.1.4.1.1.9.0.10.2 = STRING: "sw-core-01"
    .1.0.8802.1.1.2.1.4.1.1.9.0.77.3 = STRING: "printer-07"
    .1.0.8802.1.1.2.1.4.1.1.12.0.5.1 = Hex-STRING: 24 00
    .1.0.8802.1.1.2.1.4.1.1.12.0.10.2 = Hex-STRING: 28 00
    .1.0.8802.1.1.2.1.4.1.1.12.0.77.3 = Hex-STRING: 01 00
    """,
    # ARP on the Vlan10 SVI. .77 is invalid; .90's address prints as text.
    """
    .1.3.6.1.2.1.4.22.1.2.30010.10.10.3.1 = Hex-STRING: 00 00 5E 00 01 0A
    .1.3.6.1.2.1.4.22.1.2.30010.10.10.3.44 = Hex-STRING: 3C 52 82 AA 10 44
    .1.3.6.1.2.1.4.22.1.2.30010.10.10.3.77 = Hex-STRING: 00 80 77 12 34 56
    .1.3.6.1.2.1.4.22.1.2.30010.10.10.3.90 = Hex-STRING: 3C 52 5A 41 42 43
    .1.3.6.1.2.1.4.22.1.4.30010.10.10.3.1 = INTEGER: static(4)
    .1.3.6.1.2.1.4.22.1.4.30010.10.10.3.44 = INTEGER: dynamic(3)
    .1.3.6.1.2.1.4.22.1.4.30010.10.10.3.77 = INTEGER: invalid(2)
    .1.3.6.1.2.1.4.22.1.4.30010.10.10.3.90 = INTEGER: dynamic(3)
    """,
)

SW_ACC_03_ROWS = {
    (PC, "10105", 10, 1, 5, "learned"),
    (PHONE, "10105", 10, 1, 5, "learned"),
    (PHONE, "10105", 20, 2, 5, "learned"),
    (PRINTER, "10107", 30, 3, 7, "learned"),
    *[(mac, "10109", 10, 1, 9, "learned") for mac in DESK],
    (SERVER, "10601", 10, 1, 11, "learned"),
    (GATEWAY, "10201", 10, 1, 10, "learned"),
    (CORE, "10201", 10, 1, 10, "learned"),
    (STATIC, "10106", 10, 1, 6, "mgmt"),
}

# sw-acc-07: Cisco-style. The default context is VLAN 1; every VLAN has its own
# forwarding table and bridge-port table, listed in ENTITY-MIB entLogicalTable.
SW07_IFACES = iftable(
    *gi_ports(8, mac_prefix="70 1F 53 07 00"),
    (10201, "Te1/1/1", "TenGigabitEthernet1/1/1", "ethernetCsmacd(6)", "70 1F 53 07 00 41"),
    (1, "Vl1", "Vlan1", "propVirtual(53)", "70 1F 53 07 00 00"),
)
SW07_VLAN1 = (
    base_ports({1: 10101, 2: 10102, 25: 10201}),
    bridge_fdb((CORE, 25, LEARNED), (AP, 1, LEARNED), ("70:1f:53:07:00:00", 0, SELF)),
)
SW07_ENTITY = """
.1.3.6.1.2.1.47.1.2.1.1.2.1 = STRING: "vlan1"
.1.3.6.1.2.1.47.1.2.1.1.2.2 = STRING: "vlan10"
.1.3.6.1.2.1.47.1.2.1.1.2.3 = STRING: "vlan20"
.1.3.6.1.2.1.47.1.2.1.1.2.4 = STRING: "vlan1002"
.1.3.6.1.2.1.47.1.2.1.1.2.5 = STRING: "vlan30"
.1.3.6.1.2.1.47.1.2.1.1.3.1 = OID: .1.3.6.1.2.1.17
.1.3.6.1.2.1.47.1.2.1.1.3.2 = OID: .1.3.6.1.2.1.17
.1.3.6.1.2.1.47.1.2.1.1.3.3 = OID: .1.3.6.1.2.1.17
.1.3.6.1.2.1.47.1.2.1.1.3.4 = OID: .1.3.6.1.2.1.17
.1.3.6.1.2.1.47.1.2.1.1.3.5 = OID: .1.3.6.1.2.1.14
.1.3.6.1.2.1.47.1.2.1.1.4.1 = STRING: "public@1"
.1.3.6.1.2.1.47.1.2.1.1.4.2 = STRING: "public@10"
.1.3.6.1.2.1.47.1.2.1.1.4.3 = STRING: "public@20"
.1.3.6.1.2.1.47.1.2.1.1.4.4 = STRING: "public@1002"
.1.3.6.1.2.1.47.1.2.1.1.4.5 = STRING: "public"
.1.3.6.1.2.1.47.1.2.1.1.8.1 = STRING: "vlan-1"
.1.3.6.1.2.1.47.1.2.1.1.8.2 = STRING: "vlan-10"
.1.3.6.1.2.1.47.1.2.1.1.8.3 = STRING: "vlan-20"
.1.3.6.1.2.1.47.1.2.1.1.8.4 = STRING: "vlan-1002"
.1.3.6.1.2.1.47.1.2.1.1.8.5 = STRING: "vlan-30"
"""
SW07_CONTEXTS = {
    1: walk(*SW07_VLAN1),
    10: walk(
        base_ports({5: 10105, 6: 10106, 25: 10201}),
        bridge_fdb((PC, 5, LEARNED), (PHONE, 5, LEARNED), (CORE, 25, LEARNED)),
    ),
    # Bridge port 7 is in VLAN 20's port table only.
    20: walk(
        base_ports({5: 10105, 7: 10107, 25: 10201}),
        bridge_fdb((PHONE, 5, LEARNED), (PRINTER, 7, LEARNED)),
    ),
    # Never read: 30 is an OSPF entity, 1002 a reserved VLAN.
    30: walk(base_ports({3: 10103}), bridge_fdb((SERVER, 3, LEARNED))),
    1002: walk(base_ports({3: 10103}), bridge_fdb((SERVER, 3, LEARNED))),
}
SW07_ROWS = {
    (CORE, "10201", 1), (AP, "10101", 1),
    (PC, "10105", 10), (PHONE, "10105", 10), (CORE, "10201", 10),
    (PHONE, "10105", 20), (PRINTER, "10107", 20),
}


def sw07(**options) -> FakeAgent:
    return FakeAgent(
        walk(system("sw-acc-07"), SW07_IFACES, *SW07_VLAN1, SW07_ENTITY),
        SW07_CONTEXTS, **options,
    )


def bridge_only(*extra: str, vlans: dict | None = None, **options) -> FakeAgent:
    """A BRIDGE-MIB bridge (no Q-BRIDGE): Gi1/0/1-4, ports 1-4 = 10101-10104."""
    return FakeAgent(
        walk(
            system("br-01"), iftable(*gi_ports(4)),
            base_ports({n: 10100 + n for n in range(1, 5)}),
            bridge_fdb((PC, 1, LEARNED), (PRINTER, 2, LEARNED)),
            *extra,
        ),
        vlans, **options,
    )


def big_qbridge(count: int, **options) -> FakeAgent:
    """A Q-BRIDGE switch with ``count`` learned MACs in VLAN 10 on Gi1/0/1-8."""
    entries = [
        (1, f"02:00:00:00:{n // 256:02x}:{n % 256:02x}", 1 + n % 8, LEARNED)
        for n in range(count)
    ]
    return FakeAgent(
        walk(
            system("sw-big"), iftable(*gi_ports(8)),
            base_ports({n: 10100 + n for n in range(1, 9)}),
            vlan_fdb_ids({10: 1}), qbridge_fdb(*entries),
        ),
        **options,
    )


# ─── Running the collector against a fake ───────────────────────────────────

def interfaces_of(agent: FakeAgent) -> list[dict]:
    """The same poll's interface rows, read through the real fetch_interfaces."""
    with patch.object(sf, "_load_pysnmp", return_value=agent):
        rows = sf.fetch_interfaces_sync(TARGET, "v2c", {}, V2C, 2000)
    agent.requests.clear()
    return rows


def read_macs(agent: FakeAgent, *, version: str = "v2c", params: dict | None = None,
              secret: dict | None = None, mode: str = "full", interfaces=None):
    if interfaces is None:
        interfaces = interfaces_of(agent)
    with patch.object(sf, "_load_pysnmp", return_value=agent):
        return sf.fetch_mac_table_sync(
            TARGET, version, params or {}, secret or (V3 if version == "v3" else V2C),
            2000, interfaces=interfaces, mode=mode,
        )


def rows_by(rows, *keys) -> set:
    return {tuple(row[k] for k in keys) for row in rows}


ROW_KEYS = ("mac", "if_index", "vlan", "fdb_id", "bridge_port", "status")


# ─── Q-BRIDGE ────────────────────────────────────────────────────────────────

class QBridgeTests(SimpleTestCase):
    def test_fdb_ids_resolve_to_vlans_and_every_drop_is_counted(self):
        rows, meta = read_macs(FakeAgent(SW_ACC_03))
        self.assertEqual(rows_by(rows, *ROW_KEYS), SW_ACC_03_ROWS)
        self.assertEqual(len(rows), len(SW_ACC_03_ROWS))
        self.assertEqual(meta["dropped"], {
            "self": 3,      # two self entries and an invalid one
            "port0": 1, "group": 3, "own": 1, "unmapped": 1,
        })
        self.assertEqual(
            {k: meta[k] for k in (
                "source", "complete", "truncated", "vlan_map", "port_map", "rows", "error",
            )},
            {"source": "qbridge", "complete": True, "truncated": False,
             "vlan_map": "fdb-id", "port_map": "base-port", "rows": 14, "error": ""},
        )
        self.assertEqual(meta["vlans"], {"read": [], "skipped": [], "failed": []})

    def test_walk_order_and_request_shape(self):
        agent = FakeAgent(SW_ACC_03)
        read_macs(agent)
        first = [r["oids"][0] for r in agent.requests]
        self.assertTrue(first[0].startswith(BASE_PORT))
        self.assertTrue(first[1].startswith(VLAN_FDB_ID))
        self.assertTrue(first[2].startswith(Q_FDB_PORT))
        fdb = agent.walked(Q_FDB_PORT)
        # Port and status ride in one GETBULK, 50 rows deep, with no MIB lookup.
        self.assertEqual(fdb[0]["oids"], [Q_FDB_PORT, Q_FDB_STATUS])
        self.assertEqual(fdb[0]["max_rep"], 50)
        self.assertEqual(fdb[0]["options"], {"lookupMib": False})
        # Q-BRIDGE answered, so neither BRIDGE-MIB nor any context is asked.
        self.assertEqual(agent.walked(D_FDB_PORT), [])
        self.assertEqual(agent.walked(ENT_LOGICAL), [])
        self.assertEqual(agent.communities(), {"public"})

    def test_shared_learning_leaves_the_vlan_unknown(self):
        agent = FakeAgent(walk(
            system("sw-shared"), iftable(*gi_ports(4)),
            base_ports({n: 10100 + n for n in range(1, 5)}),
            vlan_fdb_ids({10: 1, 11: 1, 20: 2, 30: 3, 31: 3}),
            qbridge_fdb(
                (1, PC, 1, LEARNED), (2, PHONE, 2, LEARNED),
                (3, PC, 1, LEARNED),  # a second shared FDB: the same unknown VLAN
            ),
        ))
        rows, meta = read_macs(agent)
        self.assertEqual(rows_by(rows, "mac", "vlan", "fdb_id"),
                         {(PC, None, 1), (PHONE, 20, 2)})
        self.assertEqual(len(rows), 2)  # one row per (vlan, mac, port)
        self.assertEqual(meta["vlan_map"], "fdb-id")

    def test_without_dot1qvlanfdbid_named_vlans_are_assumed(self):
        agent = FakeAgent(walk(
            system("sw-assumed"), iftable(*gi_ports(4)),
            base_ports({n: 10100 + n for n in range(1, 5)}),
            vlan_names({10: "users", 20: "voice"}),
            qbridge_fdb((10, PC, 1, LEARNED), (20, PHONE, 2, LEARNED)),
        ))
        rows, meta = read_macs(agent)
        self.assertEqual(rows_by(rows, "mac", "vlan", "fdb_id"),
                         {(PC, 10, 10), (PHONE, 20, 20)})
        self.assertEqual(meta["vlan_map"], "assumed")
        self.assertTrue(meta["complete"])

    def test_without_dot1qvlanfdbid_unnamed_fdb_ids_stay_unknown(self):
        agent = FakeAgent(walk(
            system("sw-none"), iftable(*gi_ports(4)),
            base_ports({n: 10100 + n for n in range(1, 5)}),
            vlan_names({10: "users", 20: "voice"}),
            qbridge_fdb((1, PC, 1, LEARNED), (2, PHONE, 2, LEARNED)),
        ))
        rows, meta = read_macs(agent)
        self.assertEqual(rows_by(rows, "mac", "vlan", "fdb_id"),
                         {(PC, None, 1), (PHONE, None, 2)})
        self.assertEqual(meta["vlan_map"], "none")

    def test_pvids_count_as_named_vlans(self):
        agent = FakeAgent(walk(
            system("sw-pvid"), iftable(*gi_ports(4)),
            base_ports({n: 10100 + n for n in range(1, 5)}),
            f".{PVID}.1 = Gauge32: 10\n.{PVID}.2 = Gauge32: 20",
            qbridge_fdb((10, PC, 1, LEARNED), (20, PHONE, 2, LEARNED)),
        ))
        rows, meta = read_macs(agent)
        self.assertEqual(meta["vlan_map"], "assumed")
        self.assertEqual(rows_by(rows, "mac", "vlan"), {(PC, 10), (PHONE, 20)})


# ─── BRIDGE-MIB fallback and port mapping ───────────────────────────────────

class BridgeFallbackTests(SimpleTestCase):
    def test_bridge_mib_when_qbridge_has_no_rows(self):
        agent = bridge_only()
        rows, meta = read_macs(agent)
        self.assertEqual(rows_by(rows, *ROW_KEYS), {
            (PC, "10101", None, None, 1, "learned"),
            (PRINTER, "10102", None, None, 2, "learned"),
        })
        self.assertEqual(
            (meta["source"], meta["vlan_map"], meta["port_map"], meta["complete"]),
            ("bridge", "none", "base-port", True),
        )
        first = [r["oids"][0] for r in agent.requests]
        order = [BASE_PORT, VLAN_FDB_ID, Q_FDB_PORT, D_FDB_PORT, ENT_LOGICAL, VTP_STATE]
        self.assertEqual([next(c for c in order if f.startswith(c)) for f in first], order)

    def test_identity_ports_are_assumed_only_for_ethernet_ifindexes(self):
        # A Linux bridge without dot1dBasePortIfIndex: ports are ifIndexes.
        ifaces = iftable(
            (1, "lo", "lo", "softwareLoopback(24)", "00 00 00 00 00 00"),
            (3, "eth1", "eth1", "ethernetCsmacd(6)", "52 54 00 00 00 03"),
            (4, "eth2", "eth2", "ethernetCsmacd(6)", "52 54 00 00 00 04"),
        )
        good = FakeAgent(walk(
            system("br-linux"), ifaces,
            bridge_fdb((PC, 3, LEARNED), (PRINTER, 4, LEARNED), ("52:54:00:00:00:03", 3, SELF)),
        ))
        rows, meta = read_macs(good)
        self.assertEqual(rows_by(rows, "mac", "if_index", "bridge_port"),
                         {(PC, "3", 3), (PRINTER, "4", 4)})
        self.assertEqual(meta["port_map"], "assumed")

        bad = FakeAgent(walk(
            system("br-linux"), ifaces,
            bridge_fdb((PC, 3, LEARNED), (PRINTER, 1, LEARNED)),  # port 1 is lo
        ))
        rows, meta = read_macs(bad)
        self.assertEqual(rows, [])
        self.assertEqual((meta["port_map"], meta["dropped"]["unmapped"]), ("none", 2))

    def test_no_status_column_keeps_rows_but_not_the_devices_own_mac(self):
        agent = FakeAgent(walk(
            system("br-02"), iftable(*gi_ports(2)), base_ports({1: 10101, 2: 10102}),
            bridge_fdb((PC, 1, ""), ("70:1f:53:00:00:02", 2, ""), status_column=False),
        ))
        rows, meta = read_macs(agent)
        self.assertEqual(rows_by(rows, "mac", "status"), {(PC, "")})
        self.assertEqual(meta["dropped"]["own"], 1)

    def test_logical_units_map_to_their_one_physical_port(self):
        # Junos-style: the bridge port is ge-0/0/1.0, stacked on ge-0/0/1.
        agent = FakeAgent(walk(
            system("ex-01"),
            iftable(
                (513, "ge-0/0/1", "ge-0/0/1", "ethernetCsmacd(6)", "2C 6B F5 00 01 01"),
                (514, "ge-0/0/2", "ge-0/0/2", "ethernetCsmacd(6)", "2C 6B F5 00 01 02"),
                (520, "ge-0/0/1.0", "ge-0/0/1.0", "propVirtual(53)", "2C 6B F5 00 01 01"),
                (521, "ge-0/0/2.0", "ge-0/0/2.0", "propVirtual(53)", "2C 6B F5 00 01 02"),
                (540, "ae0", "ae0", "ieee8023adLag(161)", "2C 6B F5 00 01 40"),
                (541, "ae0.0", "ae0.0", "propVirtual(53)", "2C 6B F5 00 01 40"),
                (550, "irb.5", "irb.5", "propVirtual(53)", "2C 6B F5 00 01 50"),
            ),
            base_ports({1: 520, 2: 521, 3: 541, 4: 550}),
            f"""
            .{IF_STACK}.0.520 = INTEGER: active(1)
            .{IF_STACK}.520.513 = INTEGER: active(1)
            .{IF_STACK}.521.514 = INTEGER: active(1)
            .{IF_STACK}.541.540 = INTEGER: active(1)
            .{IF_STACK}.550.513 = INTEGER: active(1)
            .{IF_STACK}.550.514 = INTEGER: active(1)
            .{IF_STACK}.513.0 = INTEGER: active(1)
            """,
            vlan_fdb_ids({10: 1}),
            qbridge_fdb(
                (1, PC, 1, LEARNED), (1, PHONE, 2, LEARNED),
                (1, SERVER, 3, LEARNED), (1, PRINTER, 4, LEARNED),
            ),
        ))
        rows, meta = read_macs(agent)
        self.assertEqual(rows_by(rows, "mac", "if_index", "bridge_port"), {
            (PC, "513", 1), (PHONE, "514", 2),
            (SERVER, "540", 3),    # ae0.0 → ae0: the aggregate is the port
            (PRINTER, "550", 4),   # on two physical ports: left alone
        })
        self.assertTrue(meta["complete"])
        self.assertEqual(len(agent.walked(IF_STACK)), 1)


# ─── Per-VLAN contexts (Cisco-style) ────────────────────────────────────────

class PerVlanContextTests(SimpleTestCase):
    def test_entity_mib_contexts_over_v2c(self):
        agent = sw07()
        rows, meta = read_macs(agent)
        self.assertEqual(rows_by(rows, "mac", "if_index", "vlan"), SW07_ROWS)
        self.assertEqual(len(rows), 7)  # VLAN 1 read twice, kept once
        self.assertTrue(all(r["fdb_id"] is None and r["status"] == "learned" for r in rows))
        self.assertEqual(
            {k: meta[k] for k in ("source", "complete", "vlan_map", "port_map", "error")},
            {"source": "bridge-vlan", "complete": True, "vlan_map": "context",
             "port_map": "base-port", "error": ""},
        )
        self.assertEqual(meta["vlans"], {"read": [1, 10, 20], "skipped": [], "failed": []})
        # 1002 is reserved and VLAN 30's entity is OSPF, not a bridge.
        self.assertEqual(agent.communities(),
                         {"public", "public@1", "public@10", "public@20"})
        self.assertEqual(meta["dropped"]["self"], 2)  # the default context and VLAN 1

    def test_v3_reads_the_vlan_context_names(self):
        agent = sw07()
        rows, meta = read_macs(agent, version="v3")
        self.assertEqual(rows_by(rows, "mac", "if_index", "vlan"), SW07_ROWS)
        self.assertEqual(agent.context_names(), {"", "vlan-1", "vlan-10", "vlan-20"})
        self.assertEqual(agent.communities(), set())
        self.assertTrue(meta["complete"])

    def test_vlan_one_context_supersedes_a_default_context_with_every_vlan(self):
        # Some agents fill the default context with every VLAN's entries.
        agent = FakeAgent(
            walk(
                system("sw-acc-08"), SW07_IFACES, SW07_ENTITY,
                base_ports({1: 10101, 5: 10105, 25: 10201}),
                bridge_fdb((CORE, 25, LEARNED), (AP, 1, LEARNED), (PC, 5, LEARNED)),
            ),
            SW07_CONTEXTS,
        )
        rows, meta = read_macs(agent)
        self.assertEqual(rows_by(rows, "mac", "if_index", "vlan"), SW07_ROWS)
        self.assertNotIn((PC, "10105", 1), rows_by(rows, "mac", "if_index", "vlan"))

    def test_without_vlan_one_read_the_default_context_stands_for_it(self):
        agent = FakeAgent(
            walk(system("sw-acc-07"), SW07_IFACES, *SW07_VLAN1, SW07_ENTITY),
            {v: SW07_CONTEXTS[v] for v in (10, 20)},  # VLAN 1's context is silent
        )
        rows, meta = read_macs(agent)
        self.assertEqual(rows_by(rows, "mac", "if_index", "vlan"), SW07_ROWS)
        self.assertEqual(meta["vlans"], {"read": [10, 20], "skipped": [], "failed": [1]})
        self.assertFalse(meta["complete"])
        self.assertEqual(meta["error"], "per-VLAN contexts failed: VLAN 1 (timeout)")

    def test_each_context_maps_through_its_own_port_table(self):
        rows, _ = read_macs(sw07())
        printer = [r for r in rows if r["mac"] == PRINTER]
        # Bridge port 7 exists in VLAN 20's dot1dBasePortIfIndex only.
        self.assertEqual([(r["bridge_port"], r["if_index"]) for r in printer], [(7, "10107")])

    def test_two_contexts_at_a_time(self):
        agent = sw07()
        read_macs(agent)
        self.assertEqual(agent.peak, 2)
        agent = sw07()
        with patch.object(sf, "MAC_CONTEXT_CONCURRENCY", 1):
            read_macs(agent)
        self.assertEqual(agent.peak, 1)

    def test_vtp_fallback_reads_operational_vlans_only(self):
        agent = FakeAgent(
            walk(
                system("sw-vtp"), SW07_IFACES, *SW07_VLAN1,
                f"""
                .{VTP_STATE}.1.1 = INTEGER: operational(1)
                .{VTP_STATE}.1.10 = INTEGER: operational(1)
                .{VTP_STATE}.1.20 = INTEGER: suspended(2)
                .{VTP_STATE}.1.1002 = INTEGER: operational(1)
                .{VTP_STATE}.1.1003 = INTEGER: operational(1)
                """,
            ),
            {v: SW07_CONTEXTS[v] for v in (1, 10, 20)},
        )
        rows, meta = read_macs(agent)
        self.assertEqual(meta["vlans"]["read"], [1, 10])
        self.assertEqual(agent.communities(), {"public", "public@1", "public@10"})
        self.assertEqual({r["vlan"] for r in rows}, {1, 10})
        self.assertEqual(meta["source"], "bridge-vlan")

    def test_cap_moves_vlans_to_skipped(self):
        rows, meta = read_macs(sw07(), params={"mac_max_vlans": 2})
        self.assertEqual(meta["vlans"], {"read": [1, 10], "skipped": [20], "failed": []})
        self.assertNotIn(20, {r["vlan"] for r in rows})
        # The cap is configuration, not a failure: what was read is complete.
        self.assertTrue(meta["complete"])

    def test_quick_mode_reads_no_contexts_and_says_so(self):
        agent = sw07()
        rows, meta = read_macs(agent, mode="quick")
        self.assertEqual(agent.communities(), {"public"})
        self.assertEqual(rows_by(rows, "mac", "vlan"), {(CORE, 1), (AP, 1)})
        self.assertEqual(meta["vlans"], {"read": [], "skipped": [1, 10, 20], "failed": []})
        self.assertFalse(meta["complete"])
        self.assertFalse(meta["truncated"])
        self.assertIn("quick read", meta["error"])
        self.assertEqual((meta["source"], meta["vlan_map"]), ("bridge", "context"))

    def test_off_mode_never_looks_for_contexts(self):
        agent = sw07()
        rows, meta = read_macs(agent, params={"mac_vlan_contexts": "off"})
        self.assertEqual(agent.walked(ENT_LOGICAL), [])
        self.assertEqual(agent.communities(), {"public"})
        self.assertEqual(rows_by(rows, "mac", "vlan"), {(CORE, None), (AP, None)})
        self.assertEqual((meta["source"], meta["vlan_map"], meta["complete"]),
                         ("bridge", "none", True))

    def test_auto_on_a_plain_bridge_reads_no_contexts(self):
        agent = bridge_only()
        _, meta = read_macs(agent)
        self.assertEqual(agent.communities(), {"public"})
        self.assertEqual(meta["vlans"], {"read": [], "skipped": [], "failed": []})
        self.assertTrue(meta["complete"])

    def test_always_mode_uses_the_hint_when_the_agent_lists_nothing(self):
        agent = bridge_only(vlans={10: SW07_CONTEXTS[10]})
        params = {"mac_vlan_contexts": "always", "mac_vlan_hint": [10, 1003]}
        rows, meta = read_macs(agent, params=params)
        self.assertEqual(meta["vlans"]["read"], [10])
        self.assertEqual(meta["source"], "bridge-vlan")
        # A context answered, so the default context is VLAN 1.
        self.assertEqual({r["vlan"] for r in rows}, {1, 10})
        self.assertEqual(agent.communities(), {"public", "public@10"})
        # Auto ignores the hint.
        agent = bridge_only(vlans={10: SW07_CONTEXTS[10]})
        read_macs(agent, params={"mac_vlan_hint": [10]})
        self.assertEqual(agent.communities(), {"public"})

    def test_three_failed_contexts_in_a_row_stop_the_read(self):
        agent = bridge_only()  # no VLAN context answers
        params = {"mac_vlan_contexts": "always", "mac_vlan_hint": [10, 20, 30, 40, 50]}
        rows, meta = read_macs(agent, params=params)
        vlans = meta["vlans"]
        self.assertTrue({10, 20, 30} <= set(vlans["failed"]))
        self.assertIn(50, vlans["skipped"])
        self.assertEqual(sorted(vlans["failed"] + vlans["skipped"]), [10, 20, 30, 40, 50])
        self.assertNotIn("public@50", agent.communities())
        self.assertFalse(meta["complete"])
        self.assertIn("failed contexts in a row", meta["error"])
        self.assertIn("community@vlan", meta["error"])
        self.assertNotIn("public", meta["error"])  # the community is never shown
        # The default context still counts; with no context read, no VLAN.
        self.assertEqual(rows_by(rows, "mac", "vlan"), {(PC, None), (PRINTER, None)})
        self.assertEqual((meta["source"], meta["vlan_map"]), ("bridge", "none"))

    def test_v3_abort_names_the_context_prefix(self):
        agent = bridge_only()
        params = {"mac_vlan_contexts": "always", "mac_vlan_hint": [10, 20, 30]}
        _, meta = read_macs(agent, version="v3", params=params)
        self.assertIn("context vlan- match prefix", meta["error"])
        self.assertNotIn("pass", meta["error"])

    def test_a_success_resets_the_failure_streak(self):
        agent = bridge_only(vlans={30: SW07_CONTEXTS[10]})
        params = {"mac_vlan_contexts": "always", "mac_vlan_hint": [10, 20, 30, 40, 50]}
        with patch.object(sf, "MAC_CONTEXT_CONCURRENCY", 1):
            _, meta = read_macs(agent, params=params)
        self.assertEqual(meta["vlans"], {"read": [30], "skipped": [], "failed": [10, 20, 40, 50]})
        self.assertIn("public@50", agent.communities())
        self.assertNotIn("in a row", meta["error"])
        self.assertIn("VLAN 10 (timeout)", meta["error"])
        self.assertFalse(meta["complete"])


# ─── Budgets, caps and incomplete walks ─────────────────────────────────────

class BudgetTests(SimpleTestCase):
    def test_quick_budget_stops_the_read(self):
        clock = Clock()
        agent = big_qbridge(300, clock=clock, step=4.0)
        interfaces = interfaces_of(agent)
        with patch.object(sf, "_monotonic", clock):
            rows, meta = read_macs(agent, mode="quick", interfaces=interfaces)
        self.assertTrue(meta["truncated"])
        self.assertFalse(meta["complete"])
        self.assertIn("time budget (15 s)", meta["error"])
        self.assertTrue(0 < len(rows) < 300)
        self.assertEqual(meta["rows"], len(rows))
        # Mapped and VLAN-tagged all the same: both lookups are read first.
        self.assertTrue(all(r["if_index"].startswith("101") for r in rows))
        self.assertEqual({r["vlan"] for r in rows}, {10})
        self.assertEqual(meta["vlan_map"], "fdb-id")

    def test_full_mode_budget_comes_from_the_profile(self):
        clock = Clock()
        agent = big_qbridge(300, clock=clock, step=4.0)
        interfaces = interfaces_of(agent)
        with patch.object(sf, "_monotonic", clock):
            _, meta = read_macs(agent, params={"mac_budget_s": 10}, interfaces=interfaces)
        self.assertTrue(meta["truncated"])
        self.assertIn("time budget (10 s)", meta["error"])
        # The same read fits the 120 s default (about 40 s at 4 s a request).
        clock = Clock()
        agent = big_qbridge(300, clock=clock, step=4.0)
        interfaces = interfaces_of(agent)
        with patch.object(sf, "_monotonic", clock):
            _, meta = read_macs(agent, interfaces=interfaces)
        self.assertTrue(meta["complete"])
        self.assertEqual(meta["rows"], 300)
        self.assertLess(meta["elapsed_ms"], 120_000)

    def test_row_cap(self):
        with patch.object(sf, "MAC_ROW_CAP", 5):
            rows, meta = read_macs(big_qbridge(120))
        self.assertEqual(len(rows), 5)
        self.assertTrue(meta["truncated"])
        self.assertFalse(meta["complete"])
        self.assertIn("row cap (5)", meta["error"])

    def test_an_error_mid_walk_is_incomplete_not_empty(self):
        agent = big_qbridge(120)
        agent.fail_on(Q_FDB_PORT, after=1, kind="genErr")
        rows, meta = read_macs(agent)
        self.assertEqual(len(rows), 50)  # the first page survives
        self.assertFalse(meta["complete"])
        self.assertFalse(meta["truncated"])
        self.assertTrue(meta["error"].startswith("dot1qTpFdbTable:"))

    def test_a_timeout_mid_walk_is_retried_once_then_stops_everything(self):
        agent = big_qbridge(120)
        agent.fail_on(Q_FDB_PORT, after=1, kind="timeout")
        rows, meta = read_macs(agent)
        self.assertEqual(len(agent.walked(Q_FDB_PORT)), 3)  # page 1, page 2 twice
        # Nothing is asked after the timeout.
        self.assertTrue(agent.requests[-1]["oids"][0].startswith(Q_FDB_PORT + "."))
        self.assertEqual(len(rows), 50)
        self.assertEqual({r["vlan"] for r in rows}, {10})  # read before the table
        self.assertEqual(meta["error"], "dot1qTpFdbTable: timeout")
        self.assertFalse(meta["complete"])

    def test_one_lost_answer_is_retried_and_the_read_completes(self):
        agent = big_qbridge(120)
        agent.fail_on(Q_FDB_PORT, kind="timeout", times=1)
        rows, meta = read_macs(agent)
        self.assertTrue(meta["complete"])
        self.assertEqual(len(rows), 120)

    def test_a_silent_agent_gives_an_incomplete_empty_read(self):
        agent = FakeAgent(SW_ACC_03, community="secret")  # we ask with "public"
        rows, meta = read_macs(agent, interfaces=[])
        self.assertEqual(rows, [])
        self.assertFalse(meta["complete"])
        self.assertEqual(meta["error"], "dot1dBasePortIfIndex: timeout")
        self.assertEqual(len(agent.requests), 2)  # one walk, retried once


class WalkColumnsTests(SimpleTestCase):
    """``_walk_columns`` on its own, with scripted responses."""

    class Scripted:
        def __init__(self, *responses):
            self.responses = list(responses)
            self.calls = []

        def ContextData(self, contextEngineId=None, contextName=b""):
            return Context(contextEngineId, contextName)

        def ObjectIdentity(self, oid):
            return oid

        def ObjectType(self, identity):
            return identity

        async def bulk_cmd(self, engine, auth, transport, ctx, non_rep, max_rep, *oids, **kw):
            self.calls.append((list(oids), max_rep))
            return self.responses.pop(0)

    def run_walk(self, mod, columns, **kwargs):
        return asyncio.run(sf._walk_columns(mod, None, None, None, columns, **kwargs))

    def test_lockstep_columns_end_independently(self):
        a, b = "1.3.6.1.9.1", "1.3.6.1.9.2"
        mod = self.Scripted(
            (None, 0, 0, [(f"{a}.1", Value("x")), (f"{b}.1", Value("1")),
                          (f"{a}.2", Value("y")), (f"{b}.3", Value("3"))]),
            (None, 0, 0, [(f"{a}.3", Value("z")), ("1.3.6.1.9.3.1", Value("-"))]),
            (None, 0, 0, [(f"{b}.1", Value("-"))]),
        )
        rows, complete = self.run_walk(mod, {"a": a, "b": b}, max_rep=2)
        self.assertTrue(complete)
        self.assertEqual(rows, {"1": {"a": "x", "b": "1"}, "2": {"a": "y"},
                                "3": {"b": "3", "a": "z"}})
        self.assertEqual(mod.calls[1][0], [f"{a}.2", f"{b}.3"])
        self.assertEqual(mod.calls[2][0], [f"{a}.3"])  # b had ended

    def test_an_error_on_the_first_request_is_incomplete(self):
        mod = self.Scripted((RequestTimedOut(), 0, 0, ()), (RequestTimedOut(), 0, 0, ()))
        stats: dict = {}
        rows, complete = self.run_walk(mod, {"a": "1.3.6.1.9.1"}, stats=stats)
        self.assertEqual((rows, complete), ({}, False))
        self.assertTrue(stats["timeout"])

    def test_snmpv1_nosuchname_ends_that_column_only(self):
        a, b = "1.3.6.1.9.1", "1.3.6.1.9.2"
        mod = self.Scripted(
            (None, 0, 0, [(f"{a}.1", Value("x")), (f"{b}.1", Value("1"))]),
            (None, 2, 2, [(f"{a}.1", Value("")), (f"{b}.1", Value(""))]),
            (None, 0, 0, [(f"{a}.2", Value("y"))]),
            (None, 0, 0, [("1.3.6.1.9.3", Value("-"))]),
        )
        rows, complete = self.run_walk(mod, {"a": a, "b": b}, max_rep=1)
        self.assertTrue(complete)
        self.assertEqual(rows, {"1": {"a": "x", "b": "1"}, "2": {"a": "y"}})

    def test_toobig_halves_the_repetitions(self):
        a = "1.3.6.1.9.1"
        mod = self.Scripted(
            (None, 1, 0, ()),
            (None, 0, 0, [(f"{a}.1", Value("x")), ("1.3.6.1.9.2", Value("-"))]),
        )
        rows, complete = self.run_walk(mod, {"a": a})
        self.assertTrue(complete)
        self.assertEqual([m for _, m in mod.calls], [50, 25])

    def test_a_looping_agent_is_stopped(self):
        a = "1.3.6.1.9.1"
        mod = self.Scripted(
            (None, 0, 0, [(f"{a}.5", Value("x"))]),
            (None, 0, 0, [(f"{a}.5", Value("x"))]),
        )
        stats: dict = {}
        rows, complete = self.run_walk(mod, {"a": a}, max_rep=1, stats=stats)
        self.assertFalse(complete)
        self.assertIn("not increasing", stats["error"])


# ─── Pure parsers ───────────────────────────────────────────────────────────

class PureParserTests(SimpleTestCase):
    def test_parse_fdb_table(self):
        rows = {
            "1.0.27.68.17.58.183": {"port": "5", "status": "3"},
            "2.0.27.68.17.58.183": {"port": "5"},
            "1.300.1.1.1.1.1": {"port": "5", "status": "3"},  # not a MAC
            "0.27.68.17.58.183": {"port": "5", "status": "3"},  # BRIDGE index
        }
        self.assertEqual(sf.parse_fdb_table(rows, qbridge=True), [
            {"mac": PHONE, "fdb_id": 1, "bridge_port": 5, "status": "learned"},
            {"mac": PHONE, "fdb_id": 2, "bridge_port": 5, "status": ""},
        ])
        self.assertEqual(sf.parse_fdb_table(rows, qbridge=False), [
            {"mac": PHONE, "fdb_id": None, "bridge_port": 5, "status": "learned"},
        ])

    def test_status_names_and_numbers(self):
        rows = {f"0.0.0.0.0.{i}": {"port": "1", "status": s}
                for i, s in enumerate(["1", "2", "3", "4", "5", "learned", "9"], start=1)}
        self.assertEqual([e["status"] for e in sf.parse_fdb_table(rows, qbridge=False)],
                         ["other", "invalid", "learned", "self", "mgmt", "learned", "other"])

    def test_map_fdb_vlans(self):
        self.assertEqual(sf.map_fdb_vlans({1, 2, 3}, {"0.10": "1", "0.20": "2"}),
                         ({1: 10, 2: 20, 3: None}, "fdb-id"))
        self.assertEqual(sf.map_fdb_vlans({1}, {"0.10": "1", "0.11": "1"}),
                         ({1: None}, "fdb-id"))
        self.assertEqual(sf.map_fdb_vlans({10, 20}, {}, {10, 20, 30}),
                         ({10: 10, 20: 20}, "assumed"))
        self.assertEqual(sf.map_fdb_vlans({10, 21}, {}, {10, 20}),
                         ({10: None, 21: None}, "none"))

    def test_drop_reasons(self):
        own = {"70:1f:53:00:00:05"}
        self.assertEqual(sf.mac_drop_reason("01:00:5e:00:00:fb", own), "group")
        self.assertEqual(sf.mac_drop_reason("33:33:ff:00:00:01", own), "group")
        self.assertEqual(sf.mac_drop_reason("01:80:c2:00:00:0e", own), "group")
        self.assertEqual(sf.mac_drop_reason("00:00:00:00:00:00", own), "group")
        self.assertEqual(sf.mac_drop_reason("70:1F:53:00:00:05", own), "own")
        self.assertEqual(sf.mac_drop_reason("701f.5300.0005", own), "own")
        self.assertEqual(sf.mac_drop_reason(PC, own), "")
        self.assertEqual(sf.own_macs([{"if_index": "1", "mac": "<RZABC"}]),
                         {"3c:52:5a:41:42:43"})

    def test_learned_rows_counts_each_drop(self):
        entries = [
            {"mac": PC, "fdb_id": None, "bridge_port": 3, "status": "learned"},
            {"mac": PHONE, "fdb_id": None, "bridge_port": 3, "status": "other"},
            {"mac": STATIC, "fdb_id": None, "bridge_port": 4, "status": "mgmt"},
            {"mac": AP, "fdb_id": None, "bridge_port": 3, "status": "self"},
            {"mac": AP, "fdb_id": None, "bridge_port": 3, "status": "invalid"},
            {"mac": "01:00:5e:00:00:01", "fdb_id": None, "bridge_port": 3, "status": ""},
            {"mac": "70:1f:53:00:00:03", "fdb_id": None, "bridge_port": 3, "status": ""},
            {"mac": SERVER, "fdb_id": None, "bridge_port": 0, "status": "learned"},
            {"mac": SERVER, "fdb_id": None, "bridge_port": None, "status": "learned"},
            {"mac": CORE, "fdb_id": None, "bridge_port": 9, "status": "learned"},
        ]
        interfaces = [{"if_index": "10103", "type": "6", "type_name": "ethernet",
                       "mac": "70:1f:53:00:00:03"}]
        dropped = {"self": 0, "port0": 0, "group": 0, "own": 0, "unmapped": 0}
        rows, how = sf.learned_rows(entries, {"3": "10103", "4": "10104"}, interfaces, dropped)
        self.assertEqual(how, "base-port")
        self.assertEqual(rows_by(rows, "mac", "if_index", "bridge_port", "status"), {
            (PC, "10103", 3, "learned"), (PHONE, "10103", 3, "other"),
            (STATIC, "10104", 4, "mgmt"),
        })
        self.assertEqual(dropped, {"self": 2, "port0": 2, "group": 1, "own": 1, "unmapped": 1})

    def test_map_bridge_ports(self):
        lag = [{"if_index": "7", "type": "53", "type_name": "lag"},
               {"if_index": "8", "type": "6", "type_name": "ethernet"}]
        self.assertEqual(sf.map_bridge_ports({3}, {"3": "10103"}), ({3: "10103"}, "base-port"))
        self.assertEqual(sf.map_bridge_ports({7, 8}, {}, lag), ({7: "7", 8: "8"}, "assumed"))
        self.assertEqual(sf.map_bridge_ports({7, 9}, {}, lag), ({}, "none"))

    def test_unit_ports(self):
        interfaces = [
            {"if_index": "513", "type": "6"}, {"if_index": "520", "type": "53"},
            {"if_index": "540", "type": "161"}, {"if_index": "541", "type": "53"},
        ]
        stack = {"520.513": "1", "541.540": "active", "0.520": "1", "513.0": "1",
                 "540.513": "2"}
        self.assertEqual(sf.unit_ports(stack, interfaces), {"520": "513", "541": "540"})

    def test_entity_and_vtp_vlans(self):
        rows = {
            "1": {"type": "1.3.6.1.2.1.17", "context": "vlan-1", "descr": "vlan1"},
            "2": {"type": "1.3.6.1.2.1.17", "context": "", "descr": "VLAN 0020"},
            "3": {"type": "1.3.6.1.2.1.17", "context": "", "descr": "",
                  "community": "s3cret@30"},
            "4": {"type": "BRIDGE-MIB::dot1dBridge", "context": "vlan-40"},
            "5": {"type": "1.3.6.1.2.1.14", "context": "vlan-50"},
            "6": {"type": "1.3.6.1.2.1.17", "context": "default"},
        }
        self.assertEqual(sf.parse_entity_vlans(rows), [1, 20, 30, 40])
        self.assertEqual(sf.parse_vtp_vlans({"1.1": "1", "1.10": "operational", "1.20": "2"}),
                         [1, 10])

    def test_plan_context_vlans(self):
        self.assertEqual(
            sf.plan_context_vlans([20, "10", 1, 1002, 1005, 0, 4095, "x", 10]),
            ([1, 10, 20], []),
        )
        self.assertEqual(sf.plan_context_vlans(range(1, 6), 3), ([1, 2, 3], [4, 5]))

    def test_mac_options(self):
        opts = sf._mac_options(
            {"mac_vlan_contexts": "bogus", "mac_max_vlans": 5000, "mac_budget_s": 1}, "full"
        )
        self.assertEqual((opts["contexts"], opts["max_vlans"], opts["budget_s"]),
                         ("auto", 1024, 5))
        self.assertEqual(sf._mac_options({}, "full")["budget_s"], 120)
        self.assertEqual(sf._mac_options({"mac_budget_s": 300}, "quick")["budget_s"], 15)
        self.assertEqual(sf._mac_options({"mac_budget_s": 10}, "quick")["budget_s"], 10)
        self.assertEqual(sf._mac_options({"mac_vlan_hint": "10, 20"}, "full")["hint"],
                         ["10", "20"])


class LldpAndArpTests(SimpleTestCase):
    INTERFACES = [
        {"if_index": "10105", "name": "Gi1/0/5", "descr": "GigabitEthernet1/0/5",
         "alias": "desk 12"},
        {"if_index": "10107", "name": "Gi1/0/7", "descr": "GigabitEthernet1/0/7", "alias": ""},
        {"if_index": "10201", "name": "Te1/1/1", "descr": "TenGigabitEthernet1/1/1",
         "alias": "uplink"},
    ]

    def resolve(self, subtype, port_id, desc, base=None, port="5"):
        return sf.resolve_lldp_local_ports(
            {port}, {port: subtype}, {port: port_id}, {port: desc},
            self.INTERFACES, base or {},
        )[port]

    def test_local_port_by_port_id_name(self):
        self.assertEqual(self.resolve("5", "Gi1/0/5", "whatever"), "10105")
        self.assertEqual(self.resolve("1", "desk 12", ""), "10105")       # alias
        self.assertEqual(self.resolve("5", "0x476931", "", {"5": "10107"}), "10107")
        # hex "Gi1": no interface → the bridge port decides

    def test_local_port_by_bridge_port(self):
        # A MAC-typed port id can't name a port; port 10 is bridge port 10.
        self.assertEqual(
            self.resolve("3", "0x701f53000041", "uplink to core", {"10": "10201"}, port="10"),
            "10201",
        )
        # A bridge port whose ifIndex isn't an interface of the device is ignored.
        self.assertEqual(self.resolve("3", "", "Gi1/0/7", {"5": "999"}), "10107")

    def test_local_port_by_description(self):
        self.assertEqual(self.resolve("7", "77", "Gi1/0/7", port="77"), "10107")
        self.assertEqual(self.resolve("7", "77", "GigabitEthernet1/0/7", port="77"), "10107")
        self.assertEqual(self.resolve("7", "77", "nothing like it", port="77"), "")

    def test_caps(self):
        self.assertEqual(sf.parse_lldp_caps("0x2400"), ["bridge", "telephone"])
        self.assertEqual(sf.parse_lldp_caps("0x2800"), ["bridge", "router"])
        self.assertEqual(sf.parse_lldp_caps("("), ["bridge", "router"])  # 0x28 prints
        self.assertEqual(sf.parse_lldp_caps("0x0180"), ["stationOnly", "cVlanComponent"])
        self.assertEqual(sf.parse_lldp_caps(""), [])

    def test_parse_lldp_new_keys_only_when_asked(self):
        rem = {"0.5.1": "SEP001B44113AB7"}
        old = sf.parse_lldp({"5": "Gi1/0/5"}, rem, {}, {"0.5.1": "P1"})
        self.assertEqual(old, [{"local_port": "Gi1/0/5", "remote_device": "SEP001B44113AB7",
                                "remote_port": "P1"}])
        new = sf.parse_lldp({"5": "Gi1/0/5"}, rem, {}, {"0.5.1": "P1"},
                            rem_caps={"0.5.1": "0x2400"}, local_if_index={"5": "10105"})
        self.assertEqual(new[0]["local_if_index"], "10105")
        self.assertEqual(new[0]["remote_caps"], ["bridge", "telephone"])

    def test_arp_type(self):
        phys = {"2.10.0.0.5": "0x001122334455", "2.10.0.0.6": "0x001122334466",
                "2.10.0.0.7": "<RZABC", "2.10.0.0.8": "0x001122334488"}
        types = {"2.10.0.0.5": "3", "2.10.0.0.6": "2", "2.10.0.0.7": "static"}
        out = {a["ip"]: (a["mac"], a["type"]) for a in sf.parse_arp(phys, types)}
        self.assertEqual(out, {
            "10.0.0.5": ("00:11:22:33:44:55", "dynamic"),
            "10.0.0.7": ("3c:52:5a:41:42:43", "static"),  # printable octets
            "10.0.0.8": ("00:11:22:33:44:88", ""),        # no type reported
        })
        self.assertEqual(sf.parse_arp({"2.10.0.0.5": "0x001122334455"})[0]["type"], "")


def arp_table(count: int) -> str:
    """ipNetToMediaPhysAddress/Type for ``count`` dynamic entries on ifIndex 30010."""
    lines = []
    for n in range(count):
        index = f"30010.10.20.{n // 250}.{n % 250 + 1}"
        lines.append(f".{ARP_PHYS}.{index} = Hex-STRING: 02 00 00 01 {n // 256:02X} {n % 256:02X}")
        lines.append(f".{ARP_TYPE}.{index} = INTEGER: dynamic(3)")
    return "\n".join(lines)


def router(arp_entries: int, **options) -> FakeAgent:
    """A router with one SVI and ``arp_entries`` ARP entries; no MAC table."""
    return FakeAgent(
        walk(
            system("rtr-01"),
            iftable((30010, "Vl20", "Vlan20", "l3ipvlan(136)", "70 1F 53 20 00 00")),
            arp_table(arp_entries),
        ),
        **options,
    )


class ArpMetaTests(SimpleTestCase):
    """``arp_meta``: whether the ARP walk ran to its end."""

    def fetch(self, agent):
        with patch.object(sf, "_load_pysnmp", return_value=agent):
            return sf.fetch_snmp(TARGET, "v2c", {}, V2C, 2000)

    def test_a_walk_to_the_end_is_complete(self):
        result = self.fetch(router(60))  # three GETBULKs of 25
        self.assertEqual(result["arp_meta"], {"complete": True, "rows": 60, "error": ""})
        self.assertEqual(len(result["arp"]), 60)

    def test_an_empty_table_is_complete(self):
        result = self.fetch(sw07())  # a switch with no ARP entries at all
        self.assertEqual(result["arp_meta"], {"complete": True, "rows": 0, "error": ""})

    def test_invalid_entries_are_not_counted(self):
        result = self.fetch(FakeAgent(SW_ACC_03))  # 4 entries, one invalid(2)
        self.assertEqual(result["arp_meta"]["rows"], 3)
        self.assertEqual(result["arp_meta"]["rows"], len(result["arp"]))

    def test_an_error_mid_walk_is_incomplete(self):
        agent = router(60)
        agent.fail_on(ARP_PHYS, after=1, kind="genErr")
        result = self.fetch(agent)
        self.assertEqual(len(result["arp"]), 25)  # the first page is kept
        meta = result["arp_meta"]
        self.assertEqual((meta["complete"], meta["rows"]), (False, 25))
        self.assertNotEqual(meta["error"], "")

    def test_a_timeout_mid_walk_is_incomplete(self):
        agent = router(60)
        agent.fail_on(ARP_PHYS, after=1, kind="timeout")
        result = self.fetch(agent)
        self.assertEqual(result["arp_meta"], {"complete": False, "rows": 25, "error": "timeout"})
        self.assertEqual(len(agent.walked(ARP_PHYS)), 2)  # topology walks aren't retried

    def test_no_answer_at_all_is_incomplete_not_empty(self):
        agent = router(10)
        agent.fail_on(ARP_PHYS, kind="timeout")
        result = self.fetch(agent)
        self.assertEqual(result["arp"], [])
        self.assertEqual(result["arp_meta"], {"complete": False, "rows": 0, "error": "timeout"})

    def test_unreachable_device_says_not_read(self):
        result = self.fetch(router(10, community="secret"))
        self.assertFalse(result["reachable"])
        self.assertEqual(result["arp_meta"], {"complete": False, "rows": 0, "error": "not read"})

    def test_a_topology_failure_carries_its_error(self):
        with patch.object(sf, "fetch_topology_sync",
                          side_effect=sf.SnmpFactsError("snmp error: no transport")):
            result = self.fetch(router(10))
        self.assertTrue(result["reachable"])
        self.assertEqual(result["arp_meta"],
                         {"complete": False, "rows": 0, "error": "snmp error: no transport"})


# ─── fetch_snmp end to end, and what older callers rely on ──────────────────

class FetchSnmpTests(SimpleTestCase):
    def fetch(self, agent, *args, **kwargs):
        with patch.object(sf, "_load_pysnmp", return_value=agent):
            return sf.fetch_snmp(*args, **kwargs)

    def test_positional_call_as_the_outpost_makes_it(self):
        result = self.fetch(FakeAgent(SW_ACC_03), TARGET, "v2c", {}, V2C, 2000)
        self.assertTrue(result["reachable"])
        self.assertEqual(result["error"], "")
        self.assertEqual(result["data"]["sys_name"], "sw-acc-03")
        self.assertEqual(set(result), {
            "data", "interfaces", "neighbors", "arp", "arp_meta", "fdb", "fdb_meta",
            "reachable", "error",
        })
        self.assertEqual(result["arp_meta"], {"complete": True, "rows": 3, "error": ""})
        # Old FDB keys keep their meaning: a MAC and the ifIndex of an interface row.
        names = {i["if_index"]: i["name"] for i in result["interfaces"]}
        by_mac = {(f["mac"], f["vlan"]): f for f in result["fdb"]}
        self.assertEqual(names[by_mac[(PRINTER, 30)]["if_index"]], "Gi1/0/7")
        self.assertTrue(all(set(f) == set(ROW_KEYS) for f in result["fdb"]))
        self.assertTrue(result["fdb_meta"]["complete"])
        self.assertEqual(rows_by(result["fdb"], *ROW_KEYS), SW_ACC_03_ROWS)

        neighbors = {n["remote_device"]: n for n in result["neighbors"]}
        self.assertEqual(neighbors["SEP001B44113AB7"], {
            "local_port": "GigabitEthernet1/0/5", "remote_device": "SEP001B44113AB7",
            "remote_port": "SW PORT", "local_if_index": "10105",
            "remote_caps": ["bridge", "telephone"],
        })
        self.assertEqual(
            (neighbors["sw-core-01"]["local_if_index"], neighbors["sw-core-01"]["remote_caps"]),
            ("10201", ["bridge", "router"]),
        )
        self.assertEqual(
            (neighbors["printer-07"]["local_port"], neighbors["printer-07"]["local_if_index"],
             neighbors["printer-07"]["remote_caps"]),
            ("Gi1/0/7", "10107", ["stationOnly"]),
        )
        self.assertEqual(
            {(a["ip"], a["mac"], a["if_index"], a["type"]) for a in result["arp"]},
            {("10.10.3.1", GATEWAY, "30010", "static"),
             ("10.10.3.44", PC, "30010", "dynamic"),
             ("10.10.3.90", "3c:52:5a:41:42:43", "30010", "dynamic")},
        )

    def test_outpost_runs_it_in_a_worker_thread(self):
        agent = FakeAgent(SW_ACC_03)

        async def outpost():
            return await asyncio.to_thread(sf.fetch_snmp, TARGET, "v2c", {}, V2C, 2000)

        with patch.object(sf, "_load_pysnmp", return_value=agent):
            result = asyncio.run(outpost())
        self.assertEqual(result["fdb_meta"]["rows"], len(SW_ACC_03_ROWS))

    def test_signature_keeps_the_positional_contract(self):
        params = inspect.signature(sf.fetch_snmp).parameters
        self.assertEqual(
            [p.name for p in params.values() if p.kind is p.POSITIONAL_OR_KEYWORD],
            ["target", "version", "params", "secret_params", "timeout_ms"],
        )
        self.assertIs(params["mac_mode"].kind, inspect.Parameter.KEYWORD_ONLY)
        self.assertEqual(params["mac_mode"].default, "full")

    def test_quick_mode_passes_through(self):
        agent = sw07()
        result = self.fetch(agent, TARGET, "v2c", {}, V2C, 2000, mac_mode="quick")
        self.assertEqual(agent.communities(), {"public"})
        self.assertFalse(result["fdb_meta"]["complete"])
        full = self.fetch(sw07(), TARGET, "v2c", {}, V2C, 2000)
        self.assertEqual(full["fdb_meta"]["vlans"]["read"], [1, 10, 20])

    def test_unreachable_device_still_carries_fdb_meta(self):
        result = self.fetch(FakeAgent(SW_ACC_03, community="secret"),
                            TARGET, "v2c", {}, V2C, 2000)
        self.assertFalse(result["reachable"])
        self.assertIn("timeout", result["error"])
        self.assertEqual(result["fdb"], [])
        self.assertFalse(result["fdb_meta"]["complete"])

    def test_profile_options_ride_in_params(self):
        agent = sw07()
        result = self.fetch(agent, TARGET, "v2c", {"mac_vlan_contexts": "off"}, V2C, 2000)
        self.assertEqual(agent.communities(), {"public"})
        self.assertTrue(result["fdb_meta"]["complete"])
