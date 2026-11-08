"""Planning new cables on a floor plan - "Connect to…".

Which ports of two devices a new cable may join, and the pairs proposed
between a source and its targets. Pure rules over rows already read, so the
floor plan's ``cable-plan`` preview (``mode: new``), its port picker and the
tests share one answer. Direct cables only: a cable from a port to a port,
never a path through a patch panel.

A port is **free** when no cable ends on it, it is not ``mark_connected``,
no reservation holds it, and - an interface - it is enabled, physical and
not management-only (unless management ports are asked for).

Two ports are **compatible** when:

- the cable API would join their kinds (``cable_points.compatible_ends``);
- their media agree: copper with copper, fibre with fibre or an empty
  transceiver cage, DAC with DAC or a cage, a cage with a cage of the same
  family (SFP or QSFP); unknown media agree with anything;
- their speeds agree when both are known.

Pairing is deterministic: device pairs in the order given, and per pair the
first compatible port of each side by rank. An *uplink* link (both devices
switch-sized: eight or more physical interfaces) takes flagged uplink ports
first, then the faster ports, then the last ports by number - where
uplinks sit by convention. Any other link takes the faster ports on the
smaller device, the lowest free port in natural order on both, and leaves
a flagged uplink port of a switch-sized device for last.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from .cable_points import compatible_ends
from .dcim_choices import VIRTUAL_INTERFACE_TYPES
from .natural import natural_key
from .speed import speed_mbps

#: The port kinds offered per family of cable.
FAMILIES: dict[str, tuple[str, ...]] = {
    "data": ("interface", "front_port", "rear_port"),
    "console": ("console_port", "console_server_port"),
    "power": ("power_port", "power_outlet"),
}

#: Most cables to one target device ("2 cables").
PER_TARGET_MAX = 8

#: A device with this many physical interfaces is switch-sized.
SWITCH_PORTS = 8

_NOT_CABLED = re.compile(
    r"^(ieee802\.|other-wireless$|gsm$|cdma$|lte$|4g$|5g$|"
    r"cisco-stack|juniper-vcp|extreme-summitstack)"
)
_BACKPLANE = re.compile(r"base-k[xrp]")
_TYPE_SPEED = re.compile(r"^(\d+(?:\.\d+)?)(m|g|t)?base", re.IGNORECASE)
_CAGE = re.compile(r"-x-([a-z0-9-]+)$")
_DAC = re.compile(r"base-(cr\d*|cu|cx\d*)$")
_COPPER = re.compile(r"base-(t\d*|tx)$")
_FC_CAGE = re.compile(r"^\d+gfc-([a-z0-9]+)$")

_COPPER_CONNECTORS = {
    "8p8c", "8p6c", "8p4c", "8p2c", "gg45", "tera-4p", "bnc", "f", "mrj21",
}
_FIBRE_CONNECTORS = re.compile(r"^(lc|sc|st|fc|mtrj|mpo)")


def _cage_family(cage: str) -> str:
    """``sfp`` for SFP, SFP+, SFP28…; ``qsfp`` for QSFP+, QSFP28…; else the
    cage itself."""
    for fam in ("qsfp", "sfp", "osfp", "cfp"):
        if cage.startswith(fam):
            return fam
    return cage


def interface_media(type_: str) -> tuple[str, str, int | None]:
    """``(media, connector, speed_mbps)`` from an interface type: media is
    ``copper``, ``fibre``, ``dac``, ``cage`` (an empty transceiver cage) or
    ``""`` (unknown)."""
    t = (type_ or "").lower()
    speed = None
    m = _TYPE_SPEED.match(t)
    if m:
        n = float(m.group(1))
        unit = (m.group(2) or "m").lower()
        speed = int(n * {"m": 1, "g": 1000, "t": 1_000_000}[unit])
    cage = _CAGE.search(t) or _FC_CAGE.match(t)
    if cage:
        return "cage", cage.group(1), speed
    if _DAC.search(t):
        return "dac", "", speed
    if _COPPER.search(t):
        return "copper", "rj45", speed
    if "base-" in t:
        return "fibre", "", speed
    return "", "", speed


def connector_media(type_: str) -> str:
    """A patch-panel port's media from its connector type."""
    t = (type_ or "").lower()
    if t in _COPPER_CONNECTORS:
        return "copper"
    if _FIBRE_CONNECTORS.match(t):
        return "fibre"
    return ""


def cabled_interface(port) -> bool:
    """An interface a cable can plug into: physical, not wireless."""
    t = (port.type or "").lower()
    if getattr(port, "virtual", False) or t in VIRTUAL_INTERFACE_TYPES:
        return False
    return not (_NOT_CABLED.match(t) or _BACKPLANE.search(t))


@dataclass
class Port:
    """One port as the pairing sees it."""

    kind: str
    id: str
    name: str
    device: str
    device_name: str = ""
    type: str = ""
    media: str = ""
    connector: str = ""
    speed_mbps: int | None = None
    uplink: bool = False
    mgmt: bool = False
    poe: str = ""
    extra: dict = field(default_factory=dict)

    def data(self) -> dict:
        return {
            "kind": self.kind, "id": self.id, "name": self.name,
            "device": self.device, "device_name": self.device_name,
            "type": self.type, "media": self.media, "connector": self.connector,
            "speed_mbps": self.speed_mbps, "uplink": self.uplink,
            "mgmt_only": self.mgmt, "poe_mode": self.poe,
        }


def port_of(kind: str, obj, device_name: str = "") -> Port:
    """``obj`` (a port row of ``kind``) as a :class:`Port`."""
    p = Port(
        kind=kind, id=str(obj.pk), name=obj.name, device=str(obj.device_id),
        device_name=device_name, type=getattr(obj, "type", "") or "",
    )
    if kind == "interface":
        p.media, p.connector, p.speed_mbps = interface_media(obj.type)
        if p.speed_mbps is None:
            p.speed_mbps = speed_mbps(obj.speed)
        p.uplink = bool(obj.is_uplink or getattr(obj, "evpn_mh_uplink", False))
        p.mgmt = bool(obj.mgmt_only)
        p.poe = obj.poe_mode or ""
    elif kind in ("front_port", "rear_port"):
        p.media = connector_media(obj.type)
    return p


_MEDIA_OK = {
    ("copper", "copper"), ("fibre", "fibre"), ("dac", "dac"),
    ("fibre", "cage"), ("dac", "cage"), ("cage", "cage"),
}


def compatible(a: Port, b: Port) -> tuple[bool, str]:
    """Whether a direct cable may join ``a`` and ``b``, with the reason
    when it may not."""
    if a.device == b.device and a.id == b.id:
        return False, "The same port."
    if not compatible_ends(a.kind, b.kind):
        return False, "These kinds of port don't cable together."
    if a.media and b.media:
        if (a.media, b.media) not in _MEDIA_OK and (b.media, a.media) not in _MEDIA_OK:
            return False, f"{a.media.capitalize()} doesn't plug into {b.media}."
        if a.media == "cage" and b.media == "cage" and \
                _cage_family(a.connector) != _cage_family(b.connector):
            return False, "Different transceiver cages."
    if a.speed_mbps and b.speed_mbps and a.speed_mbps != b.speed_mbps:
        return False, "Different speeds."
    return True, ""


def cable_type_for(a: Port, b: Port) -> str:
    """A cable type that fits the pair, or blank: a copper patch lead, a
    DAC, a power cord. Fibre is left to the user (multimode or single)."""
    if "power_port" in (a.kind, b.kind):
        return "power"
    media = {a.media, b.media} - {""}
    if media <= {"copper"} and media:
        return "cat6"
    if "dac" in media or media == {"cage"}:
        return "dac-passive"
    return ""


def _rank(port: Port, *, uplink_link: bool, big: bool):
    nk = natural_key(port.name)
    if uplink_link:
        # Flagged uplinks, then faster, then the last ports.
        return (not port.uplink, -(port.speed_mbps or 0), _Desc(nk))
    if big:
        # A switch's access ports: the lowest free one, its uplinks last.
        return (port.uplink, 0, nk)
    # A server's (or a panel's): the fastest, then the first.
    return (False, -(port.speed_mbps or 0), nk)


class _Desc:
    """Reverses a natural key in a sort."""

    def __init__(self, key):
        self.key = key

    def __lt__(self, other):
        return self.key > other.key

    def __eq__(self, other):
        return self.key == other.key


def switch_sized(ports: list[Port], physical_count: int | None = None) -> bool:
    n = physical_count if physical_count is not None else sum(
        1 for p in ports if p.kind == "interface"
    )
    return n >= SWITCH_PORTS


def propose(
    device_pairs: list[tuple[str, str]],
    free: dict[str, list[Port]],
    *,
    per_target: int = 1,
    sizes: dict[str, int] | None = None,
    limit: int = 256,
) -> tuple[list[tuple[Port, Port]], list[dict]]:
    """Pair ports for each ``(a device, b device)`` in ``device_pairs``:
    ``per_target`` cables each, from the ports in ``free`` (by device id),
    a port used once. ``sizes`` is each device's physical interface count.

    Answers ``(pairs, short)`` where ``short`` lists the device pairs that
    got fewer cables than asked, with the reason."""
    sizes = sizes or {}
    used: set = set()
    out: list[tuple[Port, Port]] = []
    short: list[dict] = []
    for a_dev, b_dev in device_pairs:
        a_big = switch_sized(free.get(a_dev, []), sizes.get(a_dev))
        b_big = switch_sized(free.get(b_dev, []), sizes.get(b_dev))
        uplink_link = a_big and b_big

        def ranked(dev, big, uplink_link=uplink_link):
            return sorted(
                free.get(dev, []),
                key=lambda p: (_rank(p, uplink_link=uplink_link, big=big), p.kind, p.id),  # noqa: B023
            )

        a_ports = ranked(a_dev, a_big)
        b_ports = ranked(b_dev, b_big)
        # The side that prefers (the smaller device) chooses first.
        flip = a_big and not b_big
        outer, inner = (b_ports, a_ports) if flip else (a_ports, b_ports)
        made = 0
        reason = ""
        while made < per_target and len(out) < limit:
            pick = None
            for po in outer:
                if (po.kind, po.id) in used:
                    continue
                for pi in inner:
                    if (pi.kind, pi.id) in used:
                        continue
                    if compatible(po, pi)[0]:
                        pick = (pi, po) if flip else (po, pi)
                        break
                if pick:
                    break
            if pick is None:
                left_a = [p for p in a_ports if (p.kind, p.id) not in used]
                left_b = [p for p in b_ports if (p.kind, p.id) not in used]
                reason = (
                    "No free ports." if not left_a or not left_b
                    else "No compatible free ports."
                )
                break
            used.add((pick[0].kind, pick[0].id))
            used.add((pick[1].kind, pick[1].id))
            out.append(pick)
            made += 1
        if made < per_target:
            short.append({
                "a_device": a_dev, "b_device": b_dev, "made": made,
                "reason": reason or "Too many cables at once.",
            })
    return out, short


# ─── reading ports ──────────────────────────────────────────────────────────


def _models() -> dict:
    from .models import (
        ConsolePort,
        ConsoleServerPort,
        FrontPort,
        Interface,
        PowerOutlet,
        PowerPort,
        RearPort,
    )

    return {
        "interface": Interface, "front_port": FrontPort, "rear_port": RearPort,
        "console_port": ConsolePort, "console_server_port": ConsoleServerPort,
        "power_port": PowerPort, "power_outlet": PowerOutlet,
    }


def free_ports(device_ids, family: str = "data", *, include_mgmt: bool = False,
               exclude=(), names: dict | None = None) -> dict[str, list[Port]]:
    """The free ports of ``device_ids`` in ``family``, by device id, in
    natural order. ``exclude`` is ``{(kind, id)}`` taken elsewhere (another
    cable of the same draft)."""
    from django.db.models import Exists, OuterRef

    from .models import CableTermination, PortReservation

    names = names or {}
    exclude = {(k, str(i)) for k, i in exclude}
    out: dict[str, list[Port]] = {str(d): [] for d in device_ids}
    models_ = _models()
    for kind in FAMILIES.get(family, ()):
        model = models_[kind]
        qs = model.objects.filter(device_id__in=list(device_ids)).annotate(
            _cabled=Exists(CableTermination.objects.filter(**{kind: OuterRef("pk")})),
            _held=Exists(PortReservation.objects.filter(**{kind: OuterRef("pk")})),
        ).filter(_cabled=False, _held=False)
        if any(f.name == "mark_connected" for f in model._meta.fields):
            qs = qs.filter(mark_connected=False)
        if kind == "interface":
            qs = qs.filter(enabled=True)
            if not include_mgmt:
                qs = qs.filter(mgmt_only=False)
        for obj in qs:
            if kind == "interface" and not cabled_interface(obj):
                continue
            if (kind, str(obj.pk)) in exclude:
                continue
            dev = str(obj.device_id)
            out[dev].append(port_of(kind, obj, names.get(dev, "")))
    order = FAMILIES.get(family, ())
    for ports in out.values():
        ports.sort(key=lambda p: (order.index(p.kind), natural_key(p.name)))
    return out


def interface_counts(device_ids) -> dict[str, int]:
    """Each device's physical interfaces (cabled or not): its size."""
    from .models import Interface

    out = {str(d): 0 for d in device_ids}
    for obj in Interface.objects.filter(device_id__in=list(device_ids)).only(
        "id", "device_id", "type", "virtual"
    ):
        if cabled_interface(obj):
            out[str(obj.device_id)] += 1
    return out


def read_port(kind: str, port_id):
    """The port row of ``kind`` with ``port_id``, or None."""
    from django.core.exceptions import ValidationError as DjangoValidationError

    model = _models().get(kind)
    if model is None:
        return None
    try:
        return model.objects.filter(pk=port_id).first()
    except (DjangoValidationError, ValueError, TypeError):
        return None


def kind_family(kind: str) -> str | None:
    """The family a port kind belongs to, or None."""
    for fam, kinds in FAMILIES.items():
        if kind in kinds:
            return fam
    return None
