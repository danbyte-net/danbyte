"""seed_fabric - an opt-in demo leaf/spine fabric for the routing pages.

Two spines and four leaves at one site: an IS-IS underlay on point-to-point
/31 links, iBGP EVPN from every leaf to both spines (route reflectors), a
VTEP per leaf carrying three L2VNIs and one L3VNI, an anycast gateway per
server VLAN, a default static route, one peer group, one policy on a
prefix list, and a keychain with no key set. Re-runnable and deterministic:
names, addresses and ids are fixed, so a second run changes nothing.

Never part of bootstrap - demo inventory is opt-in:

    .venv/bin/python manage.py seed_fabric [--wipe]
"""
from __future__ import annotations

from django.core.management.base import BaseCommand
from django.db import transaction
from django.utils.text import slugify

from api.models import (
    ASN,
    L2VPN,
    RIR,
    VLAN,
    VRF,
    Device,
    DeviceRole,
    DeviceType,
    FHRPGroup,
    FHRPGroupAssignment,
    Interface,
    IPAddress,
    L2VPNTermination,
    Manufacturer,
    Prefix,
    RouteTarget,
    Site,
)
from api.status_registry import resolve_status, seed_builtin_statuses
from core.models import Organization, Tenant
from routing.models import (
    VTEP,
    BGPAddressFamily,
    BGPInstance,
    BGPPeerGroup,
    BGPSession,
    ISISInstance,
    ISISInterface,
    PrefixList,
    PrefixListRule,
    Redistribution,
    RoutingKeychain,
    RoutingPolicy,
    RoutingPolicyRule,
    StaticRoute,
    VTEPMembership,
    link_remote_address,
)

ORG_NAME = "Acme Networks"
TENANT_SLUG = "acme"
SITE_NAME = "dc-fra-01"
FABRIC_ASN = 65100
AREA = "49.0001"

SPINES = ["spine1", "spine2"]
LEAVES = ["leaf1", "leaf2", "leaf3", "leaf4"]

# Loopbacks: spines 10.255.0.1-2, leaves 10.255.0.11-14.
LOOPBACK = {**{s: f"10.255.0.{i + 1}" for i, s in enumerate(SPINES)},
            **{lf: f"10.255.0.{i + 11}" for i, lf in enumerate(LEAVES)}}

# Server VLANs: (vid, name, VNI, gateway /24). The L3VNI ties them together.
VLANS = [
    (100, "servers", 10100, "10.100.0.0/24"),
    (110, "storage", 10110, "10.110.0.0/24"),
    (120, "mgmt", 10120, "10.120.0.0/24"),
]
L3VNI = 5000
TENANT_VRF = ("TENANT-A", f"{FABRIC_ASN}:{L3VNI}")


def _link(spine_idx: int, leaf_idx: int) -> tuple[str, str]:
    """The /31 for a spine↔leaf link: spine side, leaf side."""
    n = 2 * leaf_idx
    return f"10.0.{spine_idx + 1}.{n}", f"10.0.{spine_idx + 1}.{n + 1}"


class Command(BaseCommand):
    help = "Seed a demo leaf/spine EVPN fabric (opt-in, re-runnable)."

    def add_arguments(self, parser):
        parser.add_argument(
            "--wipe", action="store_true",
            help="Delete the fabric's devices and overlay objects before seeding.",
        )

    @transaction.atomic
    def handle(self, *args, wipe=False, **options):
        org, _ = Organization.objects.get_or_create(
            name=ORG_NAME, defaults={"slug": slugify(ORG_NAME)}
        )
        self.t, _ = Tenant.objects.get_or_create(
            org=org, slug=TENANT_SLUG, defaults={"name": ORG_NAME, "color": "#3b82f6"}
        )
        seed_builtin_statuses(self.t)
        if wipe:
            self._wipe()
        self.site, _ = Site.objects.get_or_create(tenant=self.t, name=SITE_NAME)
        self._catalogs()
        self._devices()
        self._underlay()
        self._overlay_objects()
        self._bgp()
        self._vteps()
        self._static_routes()
        self.stdout.write(self.style.SUCCESS(
            f"Fabric ready at {SITE_NAME}: {len(SPINES)} spines, {len(LEAVES)} leaves, "
            f"{len(VLANS)} L2VNIs + 1 L3VNI."
        ))

    # ── helpers ──────────────────────────────────────────────────────────

    def _status(self, model, value="active"):
        return resolve_status(self.t, value, model)

    def _wipe(self):
        names = SPINES + LEAVES
        Device.objects.filter(tenant=self.t, name__in=names).delete()
        L2VPN.objects.filter(tenant=self.t, slug__in=[
            *(f"vni-{vni}" for _, _, vni, _ in VLANS), f"vni-{L3VNI}"]).delete()
        FHRPGroup.objects.filter(tenant=self.t, name__startswith="anycast-").delete()
        BGPPeerGroup.objects.filter(tenant=self.t, name="SPINES").delete()
        RoutingPolicy.objects.filter(tenant=self.t, name="EVPN-EXPORT").delete()
        PrefixList.objects.filter(tenant=self.t, name="LOOPBACKS").delete()
        RoutingKeychain.objects.filter(tenant=self.t, name="FABRIC").delete()
        self.stdout.write(self.style.WARNING("Wiped the fabric."))

    def _prefix(self, cidr, *, vrf=None, vlan=None, status="active"):
        p, _ = Prefix.objects.get_or_create(
            tenant=self.t, vrf=vrf, cidr=cidr,
            defaults={"site": self.site, "vlan": vlan, "status": self._status("prefix", status)},
        )
        return p

    def _ip(self, address, prefix, *, device=None, interface=None, vrf=None):
        ip, _ = IPAddress.objects.get_or_create(
            tenant=self.t, vrf=vrf, ip_address=address,
            defaults={"prefix": prefix, "site": self.site,
                      "status": self._status("ipaddress"),
                      "assigned_device": device, "assigned_interface": interface},
        )
        # Converge on a re-run: the prefix or the assignment may have moved.
        fields = []
        if ip.prefix_id != prefix.id:
            ip.prefix = prefix
            fields.append("prefix")
        if device is not None and ip.assigned_device_id != device.id:
            ip.assigned_device = device
            fields.append("assigned_device")
        if device is not None and ip.assigned_interface_id != (interface.id if interface else None):
            ip.assigned_interface = interface
            fields.append("assigned_interface")
        if fields:
            ip.save(update_fields=fields)
        return ip

    # ── steps ────────────────────────────────────────────────────────────

    def _catalogs(self):
        rir, _ = RIR.objects.get_or_create(
            tenant=self.t, name="RFC 6996", defaults={"slug": "rfc-6996", "is_private": True}
        )
        self.asn, _ = ASN.objects.get_or_create(
            tenant=self.t, asn=FABRIC_ASN, defaults={"rir": rir, "description": "Fabric"}
        )
        self.asn.sites.add(self.site)
        rt, _ = RouteTarget.objects.get_or_create(tenant=self.t, name=TENANT_VRF[1])
        self.vrf, _ = VRF.objects.get_or_create(
            tenant=self.t, name=TENANT_VRF[0],
            defaults={"rd": TENANT_VRF[1], "color": "#8b5cf6", "description": "Tenant A"},
        )
        self.vrf.import_targets.add(rt)
        self.vrf.export_targets.add(rt)
        self.keychain, _ = RoutingKeychain.objects.get_or_create(
            tenant=self.t, name="FABRIC",
            defaults={"algorithm": "hmac-sha-256", "description": "Underlay and EVPN sessions"},
        )
        self.loopbacks, _ = PrefixList.objects.get_or_create(
            tenant=self.t, name="LOOPBACKS", defaults={"family": "ipv4"}
        )
        PrefixListRule.objects.update_or_create(
            prefix_list=self.loopbacks, sequence=10,
            defaults={"action": "permit", "prefix": "10.255.0.0/24", "ge": 32, "le": 32},
        )
        self.policy, _ = RoutingPolicy.objects.get_or_create(
            tenant=self.t, name="EVPN-EXPORT",
            defaults={"description": "Only the loopbacks leave the underlay"},
        )
        rule, _ = RoutingPolicyRule.objects.update_or_create(
            policy=self.policy, sequence=10, defaults={"action": "permit"},
        )
        rule.match_prefix_lists.set([self.loopbacks])
        RoutingPolicyRule.objects.update_or_create(
            policy=self.policy, sequence=20, defaults={"action": "deny"},
        )
        self.peer_group, _ = BGPPeerGroup.objects.update_or_create(
            tenant=self.t, name="SPINES",
            defaults={"remote_asn_mode": "internal", "address_families": ["l2vpn-evpn"],
                      "send_community": "both", "bfd": True, "keychain": self.keychain,
                      "update_source": "Loopback0",
                      "description": "Every leaf's sessions to the route reflectors"},
        )

    def _devices(self):
        mfr, _ = Manufacturer.objects.get_or_create(
            tenant=self.t, name="Generic", defaults={"slug": "generic"}
        )
        types = {}
        for key, model in (("spine", "Spine 32x100G"), ("leaf", "Leaf 48x25G+8x100G")):
            types[key], _ = DeviceType.objects.get_or_create(
                tenant=self.t, name=model,
                defaults={"manufacturer": mfr, "model": model, "u_height": 1},
            )
        roles = {}
        for key, color in (("spine", "#3b82f6"), ("leaf", "#10b981")):
            roles[key], _ = DeviceRole.objects.get_or_create(
                tenant=self.t, slug=key, defaults={"name": key.title(), "color": color}
            )
        self.devices: dict[str, Device] = {}
        self.lo: dict[str, Interface] = {}
        self.lo_ip: dict[str, IPAddress] = {}
        self._prefix("10.255.0.0/24", status="container")
        for name in SPINES + LEAVES:
            kind = "spine" if name in SPINES else "leaf"
            d, _ = Device.objects.update_or_create(
                tenant=self.t, name=name,
                defaults={"site": self.site, "device_type": types[kind], "role": roles[kind],
                          "status": self._status("device")},
            )
            self.devices[name] = d
            lo, _ = Interface.objects.get_or_create(
                device=d, name="Loopback0", defaults={"type": "virtual"}
            )
            self.lo[name] = lo
            host = self._prefix(f"{LOOPBACK[name]}/32")
            ip = self._ip(LOOPBACK[name], host, device=d, interface=lo)
            self.lo_ip[name] = ip
            if d.primary_ip_id != ip.id:
                d.primary_ip = ip
                d.save(update_fields=["primary_ip"])

    def _underlay(self):
        """Point-to-point /31s, every leaf to both spines, in IS-IS L2."""
        self.isis: dict[str, ISISInstance] = {}
        for name, d in self.devices.items():
            sysid = LOOPBACK[name].split(".")
            net = f"{AREA}.{int(sysid[2]):04d}.{int(sysid[3]):04d}.0000.00"
            inst, _ = ISISInstance.objects.update_or_create(
                tenant=self.t, device=d, process="UNDERLAY",
                defaults={"net": net, "router_id": LOOPBACK[name], "level": "2",
                          "metric_style": "wide", "bfd": True,
                          "authentication": "md5", "keychain": self.keychain,
                          "status": self._status("routinginstance")},
            )
            self.isis[name] = inst
            ISISInterface.objects.update_or_create(
                instance=inst, interface=self.lo[name],
                defaults={"families": ["ipv4"], "passive": True},
            )
        for si, spine in enumerate(SPINES):
            for li, leaf in enumerate(LEAVES):
                s_addr, l_addr = _link(si, li)
                p = self._prefix(f"{s_addr}/31")
                s_if, _ = Interface.objects.get_or_create(
                    device=self.devices[spine], name=f"Ethernet1/{li + 1}",
                    defaults={"type": "100gbase-x-qsfp28", "description": f"to {leaf}"},
                )
                l_if, _ = Interface.objects.get_or_create(
                    device=self.devices[leaf], name=f"Ethernet1/{49 + si}",
                    defaults={"type": "100gbase-x-qsfp28", "description": f"to {spine}"},
                )
                self._ip(s_addr, p, device=self.devices[spine], interface=s_if)
                self._ip(l_addr, p, device=self.devices[leaf], interface=l_if)
                for name, iface in ((spine, s_if), (leaf, l_if)):
                    ISISInterface.objects.update_or_create(
                        instance=self.isis[name], interface=iface,
                        defaults={"families": ["ipv4"], "network_type": "point-to-point",
                                  "bfd": True},
                    )

    def _overlay_objects(self):
        """The VNIs as L2VPNs, their VLANs and terminations, the anycast SVIs."""
        self.l2vnis: list[L2VPN] = []
        self.vlans: dict[int, VLAN] = {}
        self.gateways: dict[int, tuple[Prefix, str]] = {}
        for vid, vname, vni, cidr in VLANS:
            vlan, _ = VLAN.objects.get_or_create(
                tenant=self.t, site=self.site, vlan_id=vid, defaults={"name": vname}
            )
            self.vlans[vid] = vlan
            rt, _ = RouteTarget.objects.get_or_create(tenant=self.t, name=f"{FABRIC_ASN}:{vni}")
            l2, _ = L2VPN.objects.update_or_create(
                tenant=self.t, slug=f"vni-{vni}",
                defaults={"name": vname.upper(), "type": "vxlan-evpn", "identifier": vni,
                          "status": self._status("l2vpn"), "description": f"VLAN {vid} {vname}"},
            )
            l2.import_targets.set([rt])
            l2.export_targets.set([rt])
            L2VPNTermination.objects.get_or_create(l2vpn=l2, vlan=vlan)
            self.l2vnis.append(l2)
            self.gateways[vid] = (self._prefix(cidr, vrf=self.vrf, vlan=vlan),
                                  cidr.rsplit(".", 1)[0] + ".1")
        self.l3vni, _ = L2VPN.objects.update_or_create(
            tenant=self.t, slug=f"vni-{L3VNI}",
            defaults={"name": f"{TENANT_VRF[0]}-L3", "type": "vxlan-evpn",
                      "identifier": L3VNI, "vrf": self.vrf,
                      "status": self._status("l2vpn"), "description": "Symmetric IRB"},
        )
        rt = RouteTarget.objects.get(tenant=self.t, name=TENANT_VRF[1])
        self.l3vni.import_targets.set([rt])
        self.l3vni.export_targets.set([rt])
        # One anycast gateway per VLAN: an SVI in the VRF on every leaf, the
        # shared address through an FHRP group of the anycast kind.
        for vid, vname, _vni, _cidr in VLANS:
            prefix, gw = self.gateways[vid]
            group, _ = FHRPGroup.objects.update_or_create(
                tenant=self.t, name=f"anycast-{vid}",
                defaults={"protocol": "anycast", "group_id": vid % 256,
                          "description": f"Anycast gateway for VLAN {vid}"},
            )
            vip = self._ip(gw, prefix, vrf=self.vrf)
            if group.virtual_ip_id != vip.id:
                group.virtual_ip = vip
                group.save(update_fields=["virtual_ip"])
            for leaf in LEAVES:
                svi, _ = Interface.objects.get_or_create(
                    device=self.devices[leaf], name=f"Vlan{vid}",
                    defaults={"type": "virtual", "description": f"{vname} gateway"},
                )
                if svi.vrf_id != self.vrf.id:
                    svi.vrf = self.vrf
                    svi.save(update_fields=["vrf"])
                FHRPGroupAssignment.objects.get_or_create(
                    fhrp_group=group, interface=svi, defaults={"priority": 100}
                )

    def _bgp(self):
        """iBGP EVPN: every leaf to both spines, spines as route reflectors."""
        status = self._status("routinginstance")
        sess_status = self._status("bgpsession")
        inst: dict[str, BGPInstance] = {}
        for name, d in self.devices.items():
            inst[name], _ = BGPInstance.objects.update_or_create(
                tenant=self.t, device=d, vrf=None,
                defaults={"asn": self.asn, "router_id": LOOPBACK[name], "bfd": True,
                          "cluster_id": "10.255.0.0" if name in SPINES else "",
                          "status": status},
            )
            BGPAddressFamily.objects.update_or_create(
                instance=inst[name], afi_safi="l2vpn-evpn",
                defaults={"export_policy": self.policy if name in LEAVES else None},
            )
            if name in LEAVES:
                BGPAddressFamily.objects.update_or_create(
                    instance=inst[name], afi_safi="ipv4-unicast",
                    defaults={"networks": [f"{LOOPBACK[name]}/32"], "maximum_paths": 2},
                )
                # The routed side of the L3VNI: a BGP instance in the tenant
                # VRF, its connected subnets into EVPN as type-5 routes.
                vinst, _ = BGPInstance.objects.update_or_create(
                    tenant=self.t, device=d, vrf=self.vrf,
                    defaults={"asn": self.asn, "router_id": LOOPBACK[name], "status": status},
                )
                v4, _ = BGPAddressFamily.objects.update_or_create(
                    instance=vinst, afi_safi="ipv4-unicast",
                )
                Redistribution.objects.get_or_create(bgp_af=v4, source="connected")
                Redistribution.objects.get_or_create(bgp_af=v4, source="static")
                BGPAddressFamily.objects.update_or_create(
                    instance=vinst, afi_safi="l2vpn-evpn",
                    defaults={"advertise_ipv4_unicast": True},
                )
        sessions = []
        for leaf in LEAVES:
            for spine in SPINES:
                s, _ = BGPSession.objects.update_or_create(
                    tenant=self.t, instance=inst[leaf], remote_address=LOOPBACK[spine],
                    defaults={"name": spine, "description": f"to {spine}",
                              "peer_group": self.peer_group,
                              "local_address": self.lo_ip[leaf], "peer_device": self.devices[spine],
                              "status": sess_status},
                )
                m, _ = BGPSession.objects.update_or_create(
                    tenant=self.t, instance=inst[spine], remote_address=LOOPBACK[leaf],
                    defaults={"name": leaf, "description": f"to {leaf}",
                              "remote_asn_mode": "internal",
                              "address_families": ["l2vpn-evpn"], "route_reflector_client": True,
                              "send_community": "both", "bfd": True, "keychain": self.keychain,
                              "local_address": self.lo_ip[spine], "peer_device": self.devices[leaf],
                              "status": sess_status},
                )
                sessions.append((s, m))
        for s, m in sessions:
            link_remote_address(s)
            link_remote_address(m)
            for a, b in ((s, m), (m, s)):
                if a.peer_session_id != b.id:
                    a.peer_session = b
                    a.save(update_fields=["peer_session"])

    def _vteps(self):
        status = self._status("vtep")
        for leaf in LEAVES:
            vtep, _ = VTEP.objects.update_or_create(
                tenant=self.t, device=self.devices[leaf],
                defaults={"source_interface": self.lo[leaf], "source_ip": self.lo_ip[leaf],
                          "anycast_gateway_mac": "00:00:5e:00:01:01", "arp_suppression": True,
                          "status": status},
            )
            for l2 in self.l2vnis:
                VTEPMembership.objects.get_or_create(vtep=vtep, l2vpn=l2)
            VTEPMembership.objects.update_or_create(
                vtep=vtep, l2vpn=self.l3vni,
                defaults={"rd": f"{LOOPBACK[leaf]}:{L3VNI}"},
            )

    def _static_routes(self):
        """Tenant A leaves the fabric through a firewall behind leaf1."""
        status = self._status("staticroute")
        for leaf in LEAVES:
            StaticRoute.objects.update_or_create(
                tenant=self.t, device=self.devices[leaf], vrf=self.vrf, prefix="0.0.0.0/0",
                next_hop="10.100.0.254", next_hop_interface=None,
                defaults={"kind": "nexthop", "status": status,
                          "description": "Tenant A default via the firewall"},
            )
