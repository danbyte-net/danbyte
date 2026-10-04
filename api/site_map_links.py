"""What a line on the site map carries, and how fast it is (#246).

A line is a circuit, a tunnel, a cable, or the cables between a pair of sites.
``?include=capacity`` on ``/api/site-map/connections/`` and
``/api/site-map/cables/`` adds to each:

* ``capacity`` - its figure under the rules of ``api.link_capacity``, naming
  its ``source``; None when no speed is known;
* ``links`` - the end-to-end links the figure is made of (the first
  ``MAX_LINKS``), each with its ``a`` and ``z`` end - the device and port it
  lands on and that port's speed - and its own ``capacity``;
* ``link_count`` - how many links there are.

A cable into a patch panel ends where its strands come out of the panels. The
walk crosses the front⇄rear pass-throughs over the cable hops the caller
already loaded (``topology_views._physical_links``), with one more query for
the front ports behind the rear ports among them - nothing per hop or per
link, so a map costs the same however many links it draws.

Names follow the caller's grants: a device (or virtual machine) at an end is
named only when they may view it, and a circuit's ends are resolved only with
cable view. A speed read off interfaces makes a link's figure only when they
may view the devices at both of its ends.
"""
from __future__ import annotations

from collections import defaultdict

from .link_capacity import (
    cable_capacity,
    circuit_capacity,
    combined,
    interface_kbps,
    tunnel_capacity,
)
from .topology_views import _is_splitter_side

#: The links one line lists; ``link_count`` counts them all.
MAX_LINKS = 50

_PANEL_KINDS = ("front_port", "rear_port")


def include_capacity(request) -> bool:
    """``?include=capacity`` - the map page asks for it; the dashboard and
    site-page mini maps share the same endpoints without it, and pay
    nothing for it."""
    raw = request.query_params.get("include") or ""
    return "capacity" in {token.strip() for token in raw.split(",")}


def _positions(kind, port) -> int:
    """The strands a cable end carries: a panel port's positions, else one."""
    if kind in _PANEL_KINDS:
        return port.positions or 1
    return 1


class StrandWalker:
    """Follows each strand of a cable out through patch panels to the port it
    ends on, over ``links`` - every cable hop of the tenant, as
    ``topology_views._physical_links`` loads them."""

    def __init__(self, tenant, links):
        from .models import FrontPort

        self.by_port: dict = defaultdict(list)
        self.by_cable: dict = defaultdict(list)
        rear_ids = set()
        for link in links:
            cab, da, pa, ka, db, pb, kb = link
            self.by_port[(ka, pa.id)].append((cab, db, pb, kb))
            self.by_port[(kb, pb.id)].append((cab, da, pa, ka))
            self.by_cable[cab.id].append(link)
            rear_ids.update(p.id for k, p in ((ka, pa), (kb, pb)) if k == "rear_port")
        # Which front port each rear position comes out of: the one query the
        # walk adds. Only rear ports a cable reaches are ever asked about.
        self.fronts: dict = defaultdict(list)
        if rear_ids:
            for fp in (
                FrontPort.objects.filter(device__tenant=tenant, rear_port_id__in=rear_ids)
                .only("id", "rear_port", "rear_port_position", "positions")
                .order_by()
            ):
                self.fronts[fp.rear_port_id].append(fp)

    def _strand(self, kind, port, position):
        """The other side of a panel for strand ``position``:
        ``(kind, port, position)``, or None for an unmapped strand."""
        if position > (port.positions or 1):
            return None
        if kind == "front_port":
            return "rear_port", port.rear_port, port.rear_port_position + position - 1
        for fp in self.fronts.get(port.id, ()):
            start = fp.rear_port_position
            if start <= position < start + (fp.positions or 1):
                return "front_port", fp, position - start + 1
        return None

    def end(self, kind, port, device, position, cable_id):
        """Where strand ``position`` of cable ``cable_id`` comes out after
        entering ``port``: ``(device, port, kind)``, or None when it stops
        dark inside a panel (unpatched or unmapped) or loops. A splitter is an
        end of its own; its fan-out is never followed."""
        seen = set()
        while kind in _PANEL_KINDS and not _is_splitter_side(kind, port):
            if (kind, port.id) in seen:
                return None
            seen.add((kind, port.id))
            partner = self._strand(kind, port, position)
            if partner is None:
                return None
            pkind, pport, ppos = partner
            hops = [h for h in self.by_port.get((pkind, pport.id), ()) if h[0].id != cable_id]
            if not hops:
                return None
            cab, device, port, kind = hops[0]
            position, cable_id = ppos, cab.id
        return device, port, kind

    def cable_links(self, hops) -> list:
        """The end-to-end links the strands of ``hops`` carry - one cable's
        hops, each ``(cable, dev_a, port_a, kind_a, dev_b, port_b, kind_b)``
        - each once, as ``(a end, z end)``. A strand dark on either side
        carries none; two strands of one duplex connector are one link."""
        out: dict = {}
        for cab, da, pa, ka, db, pb, kb in hops:
            for strand in range(1, min(_positions(ka, pa), _positions(kb, pb)) + 1):
                a = self.end(ka, pa, da, strand, cab.id)
                z = self.end(kb, pb, db, strand, cab.id)
                if a is None or z is None:
                    continue
                out.setdefault(frozenset(((a[2], a[1].id), (z[2], z[1].id))), (a, z))
        return list(out.values())

    def circuit_end(self, termination_id):
        """What a circuit termination's cable reaches, through any panels:
        ``(device, port, kind)``, or None when it is not cabled or stops
        dark."""
        hops = self.by_port.get(("circuit_termination", termination_id), ())
        if not hops:
            return None
        cab, device, port, kind = hops[0]
        return self.end(kind, port, device, 1, cab.id)


class Visible:
    """The devices and virtual machines the caller may view, each loaded once
    on first use. ``devices`` hands in an id set the caller already has."""

    def __init__(self, user, tenant, devices=None):
        self.user, self.tenant = user, tenant
        self._devices = devices
        self._vms = None

    def device(self, device_id) -> bool:
        if self._devices is None:
            from .topology_views import viewable_device_ids

            self._devices = viewable_device_ids(self.user, self.tenant)
        return device_id in self._devices

    def vm(self, vm_id) -> bool:
        if self._vms is None:
            from auth_api import rbac

            from .models import VirtualMachine

            self._vms = set(
                rbac.restrict_queryset(
                    VirtualMachine.objects.filter(tenant=self.tenant),
                    self.user, self.tenant, "virtualmachine", "view",
                ).values_list("id", flat=True)
            )
        return vm_id in self._vms


def _port_ref(kind, port, speed_kbps=None) -> dict:
    return {"id": str(port.id), "name": port.name, "kind": kind, "speed_kbps": speed_kbps}


def _hidden_end(site_id=None) -> dict:
    return {"site_id": site_id, "device": None, "port": None, "restricted": True}


def _end_hidden(end, visible) -> bool:
    """A walked end on a device the caller may not view. A circuit's demarc
    names no device, so it hides nothing."""
    device, _port, kind = end
    return kind != "circuit_termination" and not visible.device(device.id)


def _end_kbps(end) -> int | None:
    _device, port, kind = end
    return interface_kbps(port.speed) if kind == "interface" else None


def _walked_end(end, visible) -> dict:
    """A walked end as the payload names it."""
    device, port, kind = end
    if kind == "circuit_termination":
        return {"site_id": None, "device": None, "port": _port_ref(kind, port),
                "restricted": False}
    if not visible.device(device.id):
        return _hidden_end()
    return {
        "site_id": str(device.site_id) if device.site_id else None,
        "device": {"id": str(device.id), "name": device.name},
        "port": _port_ref(kind, port, _end_kbps(end)),
        "restricted": False,
    }


def _line(capacities, links) -> dict:
    return {"capacity": combined(capacities), "links": links[:MAX_LINKS],
            "link_count": len(links)}


class LinkFigures:
    """``capacity`` / ``links`` / ``link_count`` for each line one response
    draws. ``links`` are the tenant's cable hops (``_physical_links``);
    ``cable_view`` says whether the caller may see cables at all - without
    it no cable is walked and a circuit's ends stay unresolved."""

    def __init__(self, user, tenant, links, *, cable_view, devices=None):
        self.visible = Visible(user, tenant, devices)
        self.walker = StrandWalker(tenant, links) if cable_view else None

    def circuit(self, circuit, term_a, term_z) -> dict:
        """One circuit between two sites, ``term_a`` at the line's ``site_a``.
        The commit rate wins, then the terminations' port and upstream speeds,
        then the speed of the interfaces cabled to it - the slower one, and
        only when the caller may view every device it is cabled to."""
        ends, speeds, hidden = [], [], False
        for term in (term_a, term_z):
            ref = {
                "site_id": str(term.site_id),
                "termination": {
                    "id": str(term.id),
                    "side": term.term_side,
                    "port_speed_kbps": term.port_speed_kbps,
                    "upstream_speed_kbps": term.upstream_speed_kbps,
                },
            }
            if self.walker is None:
                ref.update(device=None, port=None, restricted=True)
            else:
                end = self.walker.circuit_end(term.id)
                if end is None:
                    ref.update(device=None, port=None, restricted=False)
                else:
                    walked = _walked_end(end, self.visible)
                    ref.update(device=walked["device"], port=walked["port"],
                               restricted=walked["restricted"])
                    hidden = hidden or _end_hidden(end, self.visible)
                    speeds.append(_end_kbps(end))
            ends.append(ref)
        known = [s for s in speeds if s]
        cap = circuit_capacity(
            circuit.commit_rate_kbps,
            [(t.port_speed_kbps, t.upstream_speed_kbps) for t in (term_a, term_z)],
            min(known) if known and not hidden else None,
        )
        link = {"a": ends[0], "z": ends[1], "capacity": cap.as_dict() if cap else None,
                "cable_id": None}
        return _line([cap], [link])

    def _tunnel_end(self, term, site_id) -> dict:
        iface, vmi = term.interface, term.vm_interface
        if iface is not None:
            if not self.visible.device(iface.device_id):
                return _hidden_end(str(site_id))
            return {
                "site_id": str(site_id),
                "device": {"id": str(iface.device_id), "name": iface.device.name},
                "port": _port_ref("interface", iface, interface_kbps(iface.speed)),
                "restricted": False,
            }
        if not self.visible.vm(vmi.vm_id):
            return _hidden_end(str(site_id))
        return {
            "site_id": str(site_id),
            "device": None,
            "virtual_machine": {"id": str(vmi.vm_id), "name": vmi.vm.name},
            "port": _port_ref("vm_interface", vmi),
            "restricted": False,
        }

    def tunnel(self, tunnel, term_a, term_z, site_a_id, site_z_id) -> dict:
        """One tunnel between two sites: its own capacity figure - nothing
        derives one - and the interface it ends on at each site."""
        cap = tunnel_capacity(tunnel.capacity_kbps)
        link = {
            "a": self._tunnel_end(term_a, site_a_id),
            "z": self._tunnel_end(term_z, site_z_id),
            "capacity": cap.as_dict() if cap else None,
            "cable_id": None,
        }
        return _line([cap], [link])

    def cables(self, hops, site_a_id=None) -> dict:
        """The cables behind ``hops`` as one line: every end-to-end link
        their strands carry, once, each figured from the lower of its two end
        speeds - and only when the caller may view both ends. A cable that
        carries no link at all counts as one of unknown speed. With
        ``site_a_id`` each hop is turned so that its ``a`` end is there."""
        per_cable: dict = {}
        for hop in hops:
            if site_a_id is not None and hop[1].site_id != site_a_id:
                cab, da, pa, ka, db, pb, kb = hop
                hop = (cab, db, pb, kb, da, pa, ka)
            per_cable.setdefault(hop[0].id, []).append(hop)
        capacities, links, seen = [], [], set()
        for cable_id, cable_hops in per_cable.items():
            carried = self.walker.cable_links(cable_hops) if self.walker else []
            if not carried:
                capacities.append(None)
                continue
            for a, z in carried:
                key = frozenset(((a[2], a[1].id), (z[2], z[1].id)))
                if key in seen:
                    continue
                seen.add(key)
                hidden = _end_hidden(a, self.visible) or _end_hidden(z, self.visible)
                cap = None if hidden else cable_capacity(_end_kbps(a), _end_kbps(z))
                capacities.append(cap)
                links.append({
                    "a": _walked_end(a, self.visible),
                    "z": _walked_end(z, self.visible),
                    "capacity": cap.as_dict() if cap else None,
                    "cable_id": str(cable_id),
                })
        return _line(capacities, links)

    def cable(self, cable_id) -> dict:
        """One cable as its own line, its hops as loaded (``a`` at its A end)."""
        return self.cables(self.walker.by_cable.get(cable_id, ()) if self.walker else ())
