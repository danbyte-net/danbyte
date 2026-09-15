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
    Community,
    PrefixList,
    PrefixListRule,
    RoutingKeychain,
    RoutingPolicy,
    RoutingPolicyRule,
    StaticRoute,
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


class FilterTests(_Base):
    def test_address_pieces_from_strings_and_rows(self):
        self.assertEqual(FILTERS["netmask"]("10.0.0.0/8"), "255.0.0.0")
        self.assertEqual(FILTERS["wildcard"]("10.0.0.0/8"), "0.255.255.255")
        self.assertEqual(FILTERS["host"]("10.0.0.5/24"), "10.0.0.5")
        self.assertEqual(FILTERS["network"]("10.0.0.5/24"), "10.0.0.0/24")
        self.assertEqual(FILTERS["prefixlen"]("2001:db8::1/64"), 64)
        # An IPAddress row: the length comes from its prefix.
        self.assertEqual(FILTERS["cidr"](self.ip), "10.1.1.5/24")
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

    def test_vm_render_gets_an_empty_block(self):
        from api.models import Cluster, ClusterType, VirtualMachine

        ct = ClusterType.objects.create(tenant=self.tenant, name="kvm", slug="kvm")
        cluster = Cluster.objects.create(tenant=self.tenant, name="c1", type=ct)
        vm = VirtualMachine.objects.create(tenant=self.tenant, name="vm1", cluster=cluster)
        t = ExportTemplate.objects.create(
            tenant=self.tenant, name="vm", object_type="virtualmachine",
            template_code="{{ routing | length }}",
        )
        r = self.client.get(f"/api/virtual-machines/{vm.id}/render/?template={t.id}")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["output"].strip(), "0")
