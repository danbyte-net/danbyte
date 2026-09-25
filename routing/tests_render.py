"""The ``routing`` block a config template sees, the address filters every
template gets, and the same block on the Ansible inventory. A template
written against this slice keeps working as later slices add keys.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from api.export_templates import FILTERS, TESTS
from api.models import (
    VRF,
    Device,
    DeviceType,
    ExportTemplate,
    Interface,
    IPAddress,
    Manufacturer,
    Prefix,
    Site,
)
from core.models import Organization, Tenant

from .models import (
    BGPSession,
    Community,
    PrefixList,
    PrefixListRule,
    RoutingKeychain,
    RoutingPolicy,
    RoutingPolicyRule,
    StaticRoute,
    VTEPMembership,
)
from .render import routing_context

User = get_user_model()

TEMPLATE = """hostname {{ device.name }}
{% for vrf in routing.vrfs %}
vrf definition {{ vrf.name }}
 rd {{ vrf.rd }}
{% endfor %}
{% for i in interfaces %}
interface {{ i.name }}
{% for ip in ip_addresses if ip.assigned_interface_id == i.id %}
 ip address {{ ip | host }} {{ ip | netmask }}
{% endfor %}
{% endfor %}
{% for r in routing.static_routes %}
ip route {% if r.vrf %}vrf {{ r.vrf }} {% endif %}{{ r.prefix | host }} {{ r.prefix | netmask }} {{ r.next_hop or r.next_hop_interface }}{% if r.distance %} {{ r.distance }}{% endif %}
{% endfor %}
{% for k in routing.keychains %}
key chain {{ k.name }}
{% endfor %}
"""


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        site = Site.objects.create(tenant=self.tenant, name="AMS")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="C", slug="c")
        dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="X")
        self.vrf = VRF.objects.create(tenant=self.tenant, name="CUST", rd="65000:1")
        self.dev = Device.objects.create(tenant=self.tenant, name="ams-r1", device_type=dt, site=site)
        self.eth0 = Interface.objects.create(device=self.dev, name="eth0", vrf=self.vrf)
        net = Prefix.objects.create(tenant=self.tenant, cidr="10.1.1.0/24")
        self.ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.1.1.5", prefix=net,
            assigned_device=self.dev, assigned_interface=self.eth0,
        )
        StaticRoute.objects.create(
            tenant=self.tenant, device=self.dev, prefix="0.0.0.0/0", next_hop="10.1.1.1",
        )
        StaticRoute.objects.create(
            tenant=self.tenant, device=self.dev, vrf=self.vrf, prefix="10.20.0.0/16",
            next_hop="10.1.1.2", distance=250,
        )
        RoutingKeychain.objects.create(tenant=self.tenant, name="ISIS-KEY")
        self.template = ExportTemplate.objects.create(
            tenant=self.tenant, name="ios", object_type="device", template_code=TEMPLATE,
        )
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()


class LinkPeerTests(_Base):
    """Each interface in the render context carries its cable's far end, so a
    template can write `description to spine1 swp1` the way the running
    config has it, without reaching a model method the sandbox refuses."""

    def _peer(self):
        from api.models import Cable, CableTermination

        spine = Device.objects.create(
            tenant=self.tenant, name="spine1", device_type=self.dev.device_type,
            site=self.dev.site,
        )
        far = Interface.objects.create(
            device=spine, name="swp1", description="to ams-r1",
            custom_fields={"frr_name": "Gi3"},
        )
        cable = Cable.objects.create(tenant=self.tenant, label="C-1")
        CableTermination.objects.create(cable=cable, end="A", interface=self.eth0)
        CableTermination.objects.create(cable=cable, end="B", interface=far)
        return far

    def test_the_far_end_is_a_plain_dict_on_each_interface(self):
        self._peer()
        Interface.objects.create(device=self.dev, name="eth1")  # uncabled
        t = ExportTemplate.objects.create(
            tenant=self.tenant, name="peers", object_type="device",
            template_code=(
                "{% for i in interfaces %}{{ i.name }}:"
                "{% if i.link_peer %} to {{ i.link_peer.device }} "
                "{{ i.link_peer.custom_fields.frr_name }} "
                "({{ i.link_peer.interface }}){% else %} -{% endif %}|"
                "{% endfor %}"
            ),
        )

        r = self.client.get(f"/api/devices/{self.dev.id}/render/?template={t.id}")

        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(
            r.json()["output"].strip("|\n").split("|"),
            ["eth0: to spine1 Gi3 (swp1)", "eth1: -"],
        )

    def test_the_far_end_cannot_reach_its_row(self):
        """The dict is the whole surface: no `.device.credentials` behind it."""
        from api.export_templates import device_render_interfaces

        self._peer()
        peer = device_render_interfaces(self.dev)[0].link_peer
        self.assertEqual(
            set(peer), {"device", "interface", "description", "custom_fields"}
        )
        self.assertIsInstance(peer["device"], str)

    def test_a_page_of_ports_costs_no_query_per_port(self):
        from django.db import connection
        from django.test.utils import CaptureQueriesContext

        from api.export_templates import device_render_interfaces

        self._peer()
        for i in range(8):
            Interface.objects.create(device=self.dev, name=f"eth{i + 1}")
        with CaptureQueriesContext(connection) as ctx:
            rows = device_render_interfaces(self.dev)
            [r.link_peer for r in rows]
        self.assertEqual(len(rows), 9)
        # Interfaces, terminations, cables, far terminations, far interfaces,
        # far devices: six IN queries whatever the port count.
        self.assertLessEqual(len(ctx.captured_queries), 6)


class FilterTests(_Base):
    def test_address_pieces_from_strings_and_rows(self):
        self.assertEqual(FILTERS["netmask"]("10.0.0.0/8"), "255.0.0.0")
        self.assertEqual(FILTERS["wildcard"]("10.0.0.0/8"), "0.255.255.255")
        self.assertEqual(FILTERS["host"]("10.0.0.5/24"), "10.0.0.5")
        self.assertEqual(FILTERS["network"]("10.0.0.5/24"), "10.0.0.0/24")
        self.assertEqual(FILTERS["prefixlen"]("2001:db8::1/64"), 64)
        # An IPAddress row: the length comes from its prefix.
        self.assertEqual(FILTERS["cidr"](self.ip), "10.1.1.5/24")
        # An address with its own mask renders that, not the prefix's.
        self.ip.mask_length = 31
        self.assertEqual(FILTERS["cidr"](self.ip), "10.1.1.5/31")
        self.assertEqual(FILTERS["netmask"](self.ip), "255.255.255.254")
        self.ip.mask_length = None
        self.assertEqual(FILTERS["netmask"](self.ip), "255.255.255.0")
        # A bare string with no length is a host.
        self.assertEqual(FILTERS["cidr"]("192.0.2.1"), "192.0.2.1/32")
        self.assertEqual(FILTERS["cidr"]("2001:db8::1"), "2001:db8::1/128")
        self.assertTrue(TESTS["ipv4"](self.ip))
        self.assertFalse(TESTS["ipv6"](self.ip))
        self.assertFalse(TESTS["ipv4"]("nope"))

    def test_template_using_a_filter_saves(self):
        r = self.client.post("/api/export-templates/", {
            "name": "t", "object_type": "device",
            "template_code": "{{ ip_addresses[0] | netmask }}",
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        r = self.client.post("/api/export-templates/", {
            "name": "t2", "object_type": "device",
            "template_code": "{{ x | nosuchfilter }}",
        }, format="json")
        self.assertEqual(r.status_code, 400)


class RoutingContextTests(_Base):
    def test_block_shape(self):
        ctx = routing_context(self.dev)
        self.assertEqual([v["name"] for v in ctx["vrfs"]], ["CUST"])
        self.assertEqual(ctx["vrfs"][0]["rd"], "65000:1")
        self.assertEqual(
            [(r["vrf"], r["prefix"], r["next_hop"]) for r in ctx["static_routes"]],
            [(None, "0.0.0.0/0", "10.1.1.1"), ("CUST", "10.20.0.0/16", "10.1.1.2")],
        )
        self.assertEqual(ctx["keychains"][0], {
            "id": ctx["keychains"][0]["id"], "name": "ISIS-KEY",
            "algorithm": "md5", "key_set": False,
            "placeholder": "<keychain:ISIS-KEY>",
        })
        self.assertEqual(ctx["policies"], {})
        self.assertEqual(ctx["communities"], [])

    def test_policy_closure_pulls_the_lists_it_matches(self):
        from .render import _policies_closure

        pl = PrefixList.objects.create(tenant=self.tenant, name="CUST")
        PrefixListRule.objects.create(prefix_list=pl, sequence=10, prefix="10.0.0.0/8", le=24)
        other = PrefixList.objects.create(tenant=self.tenant, name="UNUSED")
        c = Community.objects.create(tenant=self.tenant, name="C", value="65000:1")
        p = RoutingPolicy.objects.create(tenant=self.tenant, name="IN")
        rule = RoutingPolicyRule.objects.create(policy=p, sequence=10, set_local_pref=200)
        rule.match_prefix_lists.add(pl)
        rule.set_communities.add(c)
        RoutingPolicy.objects.create(tenant=self.tenant, name="NOT-REFERENCED")
        out = _policies_closure(self.tenant.id, {"IN"})
        self.assertEqual(list(out["policies"]), ["IN"])
        self.assertEqual(list(out["prefix_lists"]), ["CUST"])
        self.assertEqual(out["prefix_lists"]["CUST"]["rules"][0]["le"], 24)
        self.assertNotIn(other.name, out["prefix_lists"])
        self.assertEqual(out["policies"]["IN"]["rules"][0]["set"]["communities"], ["65000:1"])

    def test_render_endpoint_writes_a_config(self):
        r = self.client.get(f"/api/devices/{self.dev.id}/render/?template={self.template.id}")
        self.assertEqual(r.status_code, 200, r.content)
        out = r.json()["output"]
        self.assertIn("hostname ams-r1", out)
        self.assertIn("vrf definition CUST\n rd 65000:1", out)
        self.assertIn(" ip address 10.1.1.5 255.255.255.0", out)
        self.assertIn("ip route 0.0.0.0 0.0.0.0 10.1.1.1", out)
        self.assertIn("ip route vrf CUST 10.20.0.0 255.255.0.0 10.1.1.2 250", out)
        self.assertIn("key chain ISIS-KEY", out)

    def test_inventory_carries_the_block_when_asked(self):
        r = self.client.get("/api/inventory/ansible/").json()
        self.assertNotIn("routing", r["_meta"]["hostvars"]["ams-r1"]["danbyte"])
        r = self.client.get("/api/inventory/ansible/?routing=1").json()
        block = r["_meta"]["hostvars"]["ams-r1"]["danbyte"]["routing"]
        self.assertEqual(len(block["static_routes"]), 2)
        # The single-device call always has it.
        r = self.client.get(f"/api/devices/{self.dev.id}/inventory/").json()
        self.assertEqual(len(r["hostvars"]["danbyte"]["routing"]["static_routes"]), 2)

    def test_vm_render_gets_its_own_block(self):
        from api.models import Cluster, ClusterType, VirtualMachine

        ct = ClusterType.objects.create(tenant=self.tenant, name="kvm", slug="kvm")
        cluster = Cluster.objects.create(tenant=self.tenant, name="c1", type=ct)
        vm = VirtualMachine.objects.create(tenant=self.tenant, name="vm1", cluster=cluster)
        t = ExportTemplate.objects.create(
            tenant=self.tenant, name="vm", object_type="virtualmachine",
            template_code="{{ routing.static_routes | length }}/{{ routing.vtep }}",
        )
        StaticRoute.objects.create(tenant=self.tenant, virtual_machine=vm,
                                   prefix="0.0.0.0/0", next_hop="10.0.0.1")
        r = self.client.get(f"/api/virtual-machines/{vm.id}/render/?template={t.id}")
        self.assertEqual(r.status_code, 200, r.content)
        # A VM routes (#217); the fabric parts stay empty for it.
        self.assertEqual(r.json()["output"].strip(), "1/None")


class FabricTemplateTests(APITestCase):
    """The two complete templates in ``docs/features/routing-templates.md``,
    rendered for a leaf of the demo fabric. They are read from the docs so
    the page and the test cannot drift apart."""

    @classmethod
    def templates(cls) -> dict[str, str]:
        import re
        from pathlib import Path

        doc = (Path(__file__).resolve().parent.parent / "docs/features/routing-templates.md").read_text()
        out = {}
        for block in re.findall(r"```jinja\n(.*?)```", doc, re.S):
            m = re.match(r"\{# template: (\w+) #\}\n", block)
            if m:
                out[m.group(1)] = block[m.end():]
        return out

    def setUp(self):
        from django.core.management import call_command

        call_command("seed_fabric", verbosity=0)
        self.tenant = Tenant.objects.get(slug="acme")
        self.leaf = Device.objects.get(tenant=self.tenant, name="leaf1")
        self.spine = Device.objects.get(tenant=self.tenant, name="spine1")
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _render(self, kind, device):
        t, _ = ExportTemplate.objects.get_or_create(
            tenant=self.tenant, name=kind, object_type="device",
            defaults={"template_code": self.templates()[kind]},
        )
        r = self.client.get(f"/api/devices/{device.id}/render/?template={t.id}")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()["output"]

    def test_seeder_is_idempotent(self):
        from django.core.management import call_command

        before = (Device.objects.count(), BGPSession.objects.count(),
                  VTEPMembership.objects.count(), Interface.objects.count())
        call_command("seed_fabric", verbosity=0)
        after = (Device.objects.count(), BGPSession.objects.count(),
                 VTEPMembership.objects.count(), Interface.objects.count())
        self.assertEqual(before, after)
        self.assertEqual(BGPSession.objects.filter(peer_session__isnull=True).count(), 0)

    def test_nxos_template_renders_a_leaf(self):
        out = self._render("nxos", self.leaf)
        for line in (
            "hostname leaf1",
            "vrf context TENANT-A\n  rd 65100:5000\n  vni 5000",
            "vlan 100\n  name servers\n  vn-segment 10100",
            "interface nve1",
            "  member vni 5000 associate-vrf",
            "  member vni 10100\n    ingress-replication protocol bgp\n    suppress-arp",
            "fabric forwarding anycast-gateway-mac 00:00:5e:00:01:01",
            "interface Loopback0\n  ip address 10.255.0.11/32\n  ip router isis UNDERLAY",
            "interface Vlan100\n  description servers gateway\n  vrf member TENANT-A",
            "router isis UNDERLAY\n  net 49.0001.0000.0011.0000.00",
            "router bgp 65100\n  router-id 10.255.0.11",
            "  template peer SPINES\n    remote-as 65100\n    update-source Loopback0\n    bfd",
            "  neighbor 10.255.0.1\n    inherit peer SPINES\n    description to spine1\n    password 0 <keychain:FABRIC>",
            "  vrf TENANT-A\n    address-family ipv4 unicast\n      redistribute connected",
            "vrf context TENANT-A\n  ip route 0.0.0.0/0 10.100.0.254",
            "ip prefix-list LOOPBACKS seq 10 permit 10.255.0.0/24 ge 32 le 32",
            "route-map EVPN-EXPORT permit 10\n  match ip address prefix-list LOOPBACKS",
        ):
            self.assertIn(line, out, out)
        self.assertNotIn("psk", out.lower())

    def test_the_keychain_placeholder_is_the_contract_form(self):
        """A push tool substitutes `<keychain:NAME>`; the doc templates must
        print exactly that, and the regex must find every one of them."""
        from .render import KEYCHAIN_PLACEHOLDER_RE, keychain_placeholder

        for name in ("nxos", "frr"):
            out = self._render(name, self.leaf)
            found = KEYCHAIN_PLACEHOLDER_RE.findall(out)
            self.assertEqual(set(found), {"FABRIC"}, (name, found))
            self.assertIn(keychain_placeholder("FABRIC"), out)
            # No bare `<FABRIC>`-style leftovers from the old convention.
            self.assertNotIn("<FABRIC>", out)

    def test_frr_template_renders_a_leaf_and_a_spine(self):
        out = self._render("frr", self.leaf)
        for line in (
            "frr defaults datacenter\nhostname leaf1",
            "vrf TENANT-A\n vni 5000\nexit-vrf",
            "interface Ethernet1/49\n description to spine1\n ip address 10.0.1.1/31\n ip router isis UNDERLAY\n isis network point-to-point\n isis bfd",
            "interface Loopback0\n ip address 10.255.0.11/32\n ip router isis UNDERLAY\n isis passive",
            "interface Vlan100 vrf TENANT-A",
            "router isis UNDERLAY\n net 49.0001.0000.0011.0000.00\n is-type level-2-only\n metric-style wide\n area-password md5 <keychain:FABRIC>",
            "router bgp 65100\n bgp router-id 10.255.0.11\n neighbor SPINES peer-group\n neighbor SPINES remote-as internal\n neighbor SPINES update-source Loopback0\n neighbor SPINES bfd\n neighbor SPINES password <keychain:FABRIC>\n neighbor 10.255.0.1 peer-group SPINES",
            " address-family l2vpn evpn\n  neighbor SPINES activate\n  neighbor 10.255.0.1 activate\n  neighbor 10.255.0.1 route-map EVPN-EXPORT out",
            "  advertise-all-vni\n  vni 10100\n   route-target import 65100:10100\n   route-target export 65100:10100\n  exit-vni",
            "router bgp 65100 vrf TENANT-A\n bgp router-id 10.255.0.11\n address-family ipv4 unicast\n  redistribute connected\n  redistribute static\n exit-address-family\n address-family l2vpn evpn\n  advertise ipv4 unicast",
            "ip route 0.0.0.0/0 10.100.0.254 vrf TENANT-A",
        ):
            self.assertIn(line, out, out)
        spine = self._render("frr", self.spine)
        self.assertIn(" bgp cluster-id 10.255.0.0", spine)
        # An ungrouped internal session prints the AS number, the way the
        # running config has it - not the word "internal".
        self.assertIn(" neighbor 10.255.0.11 remote-as 65100", spine)
        self.assertIn("  neighbor 10.255.0.11 route-reflector-client", spine)
        self.assertNotIn("vni", spine.split("router bgp")[1].split("exit")[0])
