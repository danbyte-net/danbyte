"""Policy routing: a static route's kernel table, ``ip rule`` rows, and the
masquerade rule's out interface. The acceptance case renders a management
port's two lines: the route in table 100 and the rule that sends the port's
own source address there."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from api.models import (
    VRF,
    Device,
    DeviceType,
    ExportTemplate,
    Interface,
    Manufacturer,
    NATRule,
    Site,
)
from api.status_registry import seed_builtin_statuses
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from .models import PolicyRule, StaticRoute

User = get_user_model()

MGMT_TEMPLATE = """{% for r in routing.static_routes if r.table %}post-up ip route replace {{ r.prefix|replace("0.0.0.0/0","default") }} via {{ r.next_hop }} dev {{ r.next_hop_interface }} table {{ r.table }}
{% endfor %}{% for p in routing.policy_rules %}post-up ip rule add from {{ p.from }} lookup {{ p.table }} priority {{ p.priority }}
{% endfor %}"""


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        seed_builtin_statuses(self.tenant)
        self.ams = Site.objects.create(tenant=self.tenant, name="AMS")
        self.lon = Site.objects.create(tenant=self.tenant, name="LON")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="C", slug="c")
        dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="X")
        self.r1 = Device.objects.create(tenant=self.tenant, name="ce1", device_type=dt, site=self.ams)
        self.r2 = Device.objects.create(tenant=self.tenant, name="ce2", device_type=dt, site=self.lon)
        self.mgmt = Interface.objects.create(device=self.r1, name="mgmt0")
        self.far = Interface.objects.create(device=self.r2, name="mgmt0")
        self.vrf = VRF.objects.create(tenant=self.tenant, name="MGMT", rd="65000:9")
        self.admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self._login(self.admin)

    def _login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _route(self, **over):
        body = {"device_id": str(self.r1.id), "prefix": "0.0.0.0/0", "next_hop": "192.0.2.1"}
        body.update(over)
        return self.client.post("/api/routing/static-routes/", body, format="json")

    def _rule(self, **over):
        body = {"device_id": str(self.r1.id), "priority": 1000,
                "from_prefix": "192.0.2.10", "table": 100}
        body.update(over)
        return self.client.post("/api/routing/ip-rules/", body, format="json")


class RouteTableTests(_Base):
    def test_table_and_vrf_exclude_each_other(self):
        r = self._route(table=100, vrf_id=str(self.vrf.id))
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("table", r.json())

    def test_reserved_tables_are_refused(self):
        for t in (0, 253, 254, 255):
            r = self._route(table=t)
            self.assertEqual(r.status_code, 400, (t, r.content))
            self.assertIn("table", r.json())

    def test_one_prefix_in_two_tables(self):
        self.assertEqual(self._route().status_code, 201)
        self.assertEqual(self._route(table=100).status_code, 201)
        self.assertEqual(self._route(table=100).status_code, 409)
        self.assertEqual(
            self.client.get("/api/routing/static-routes/?table=100").json()["count"], 1
        )


class PolicyRuleTests(_Base):
    def test_create_normalises_a_host_and_derives_the_family(self):
        r = self._rule()
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(body["from_prefix"], "192.0.2.10/32")
        self.assertEqual(body["family"], "ipv4")
        r = self._rule(priority=1001, from_prefix="2001:db8::1", family="ipv4")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["family"], "ipv6")

    def test_owner_is_one_box(self):
        from api.models import Cluster, ClusterType, VirtualMachine

        ct = ClusterType.objects.create(tenant=self.tenant, name="pve", slug="pve")
        cl = Cluster.objects.create(tenant=self.tenant, name="c1", type=ct)
        vm = VirtualMachine.objects.create(tenant=self.tenant, name="vr1", cluster=cl)
        r = self._rule(virtual_machine_id=str(vm.id))
        self.assertEqual(r.status_code, 400, r.content)
        r = self._rule(device_id=None, virtual_machine_id=str(vm.id))
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["virtual_machine"]["name"], "vr1")

    def test_lookup_needs_one_table_and_others_none(self):
        self.assertEqual(self._rule(table=None).status_code, 400)
        r = self._rule(table=100, vrf_id=str(self.vrf.id))
        self.assertEqual(r.status_code, 400)
        r = self._rule(table=None, vrf_id=str(self.vrf.id))
        self.assertEqual(r.status_code, 201, r.content)
        r = self._rule(priority=2000, action="blackhole")
        self.assertEqual(r.status_code, 400)
        r = self._rule(priority=2000, action="blackhole", table=None)
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(self._rule(priority=3000, table=254).status_code, 400)

    def test_priority_is_unique_per_box_and_family(self):
        self.assertEqual(self._rule().status_code, 201)
        self.assertEqual(self._rule().status_code, 409)
        self.assertEqual(self._rule(device_id=str(self.r2.id)).status_code, 201)

    def test_an_interface_on_another_device_is_refused(self):
        r = self._rule(iif_id=str(self.far.id))
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("iif", r.json())
        r = self._rule(oif_id=str(self.mgmt.id))
        self.assertEqual(r.status_code, 201, r.content)

    def test_a_vrf_of_another_tenant_is_refused(self):
        org = Organization.objects.create(name="O", slug="o")
        other = Tenant.objects.create(org=org, name="O", slug="o")
        theirs = VRF.objects.create(tenant=other, name="THEIRS")
        r = self._rule(table=None, vrf_id=str(theirs.id))
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("vrf_id", r.json())

    def test_a_site_limited_user_writes_only_on_their_site(self):
        user = User.objects.create_user("u")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        p = ObjectPermission.objects.create(
            name="ams", object_types=["policyrule", "device", "interface"],
            actions=["view", "add", "change"],
        )
        p.users.add(user)
        p.sites.set([self.ams])
        self._login(user)
        self.assertEqual(self._rule().status_code, 201)
        r = self._rule(device_id=str(self.r2.id))
        self.assertIn(r.status_code, (400, 403), r.content)
        self.assertFalse(PolicyRule.objects.filter(device=self.r2).exists())

    def test_the_change_log_records_a_rule(self):
        from audit.models import ChangeLogEntry

        rid = self._rule().json()["id"]
        self.assertTrue(ChangeLogEntry.objects.filter(object_id=rid).exists())


class RenderTests(_Base):
    def test_the_two_mgmt_lines_render(self):
        self.assertEqual(self._route(
            table=100, next_hop_interface_id=str(self.mgmt.id),
        ).status_code, 201)
        self._route(prefix="10.0.0.0/8", next_hop="10.1.1.1")  # main table, skipped
        self.assertEqual(self._rule(from_prefix="192.0.2.10").status_code, 201)
        tmpl = ExportTemplate.objects.create(
            tenant=self.tenant, name="interfaces", object_type="device",
            template_code=MGMT_TEMPLATE,
        )
        r = self.client.get(f"/api/devices/{self.r1.id}/render/?template={tmpl.id}")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["output"], (
            "post-up ip route replace default via 192.0.2.1 dev mgmt0 table 100\n"
            "post-up ip rule add from 192.0.2.10/32 lookup 100 priority 1000\n"
        ))

    def test_the_block_shape(self):
        from .render import routing_context

        StaticRoute.objects.create(tenant=self.tenant, device=self.r1, prefix="0.0.0.0/0",
                                   next_hop="192.0.2.1", table=100)
        PolicyRule.objects.create(tenant=self.tenant, device=self.r1, priority=10,
                                  family="ipv4", vrf=self.vrf, iif=self.mgmt, invert=True)
        block = routing_context(self.r1)
        self.assertEqual(block["static_routes"][0]["table"], 100)
        rule = block["policy_rules"][0]
        self.assertEqual((rule["vrf"], rule["iif"], rule["invert"], rule["from"]),
                         ("MGMT", "mgmt0", True, None))
        self.assertIn("MGMT", [v["name"] for v in block["vrfs"]])


class NATOutInterfaceTests(_Base):
    def test_masquerade_names_its_out_interface(self):
        r = self.client.post("/api/nat-rules/", {
            "name": "mgmt-masq", "kind": "masquerade", "protocol": "any",
            "device_id": str(self.r1.id), "out_interface_id": str(self.mgmt.id),
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["out_interface"]["name"], "mgmt0")
        r = self.client.post("/api/nat-rules/", {
            "name": "bad", "kind": "masquerade", "protocol": "any",
            "device_id": str(self.r1.id), "out_interface_id": str(self.far.id),
        }, format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("out_interface_id", r.json())
        self.assertEqual(NATRule.objects.count(), 1)
