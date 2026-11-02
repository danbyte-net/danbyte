"""Ethernet segment members with their own DF preference: the through
model over the old many-to-many table, effective resolution, the
``interface_ids`` round trip, site limits, and the leaf A / leaf B render."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase
from rest_framework.test import APITestCase

from api.models import Device, DeviceType, ExportTemplate, Interface, Manufacturer, Site
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from .models import EthernetSegment, EthernetSegmentMember
from .render import routing_context

User = get_user_model()

ES_TEMPLATE = """{% for i in interfaces if routing.by_interface[i.name].es %}{% set es = routing.by_interface[i.name].es %}interface {{ i.name }}
 evpn mh es-id {{ es.es_id }}
 evpn mh es-sys-mac {{ es.sys_mac }}
 evpn mh es-df-pref {{ es.df_preference }}
{% endfor %}"""


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.ams = Site.objects.create(tenant=self.tenant, name="AMS")
        self.lon = Site.objects.create(tenant=self.tenant, name="LON")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="C", slug="c")
        dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="X")
        self.leaf_a = Device.objects.create(tenant=self.tenant, name="leaf-a", device_type=dt,
                                            site=self.ams)
        self.leaf_b = Device.objects.create(tenant=self.tenant, name="leaf-b", device_type=dt,
                                            site=self.lon)
        self.bond_a = Interface.objects.create(device=self.leaf_a, name="bond-s1", type="lag")
        self.bond_b = Interface.objects.create(device=self.leaf_b, name="bond-s1", type="lag")
        self.admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self._login(self.admin)

    def _login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _segment(self, **over):
        body = {"name": "srv1", "es_id": 1, "sys_mac": "44:38:39:ff:00:01",
                "df_preference": 50000,
                "interface_ids": [str(self.bond_a.id), str(self.bond_b.id)]}
        body.update(over)
        return self.client.post("/api/routing/ethernet-segments/", body, format="json")


class MemberTests(_Base):
    def test_effective_value_and_one_call_edit(self):
        r = self._segment()
        self.assertEqual(r.status_code, 201, r.content)
        sid = r.json()["id"]
        r = self.client.patch(f"/api/routing/ethernet-segments/{sid}/", {
            "member_df_preferences": {str(self.bond_a.id): 60000},
        }, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        members = {m["device"]["name"]: m for m in r.json()["members"]}
        self.assertEqual(members["leaf-a"]["df_preference"], 60000)
        self.assertEqual(members["leaf-a"]["df_preference_effective"], 60000)
        self.assertIsNone(members["leaf-b"]["df_preference"])
        self.assertEqual(members["leaf-b"]["df_preference_effective"], 50000)
        # The v0.16 shape is still there.
        self.assertEqual(len(r.json()["interfaces"]), 2)

    def test_interface_ids_round_trip_keeps_overrides(self):
        sid = self._segment().json()["id"]
        EthernetSegmentMember.objects.filter(interface=self.bond_a).update(df_preference=7)
        extra = Interface.objects.create(device=self.leaf_a, name="bond-s2", type="lag")
        r = self.client.patch(f"/api/routing/ethernet-segments/{sid}/", {
            "interface_ids": [str(self.bond_a.id), str(self.bond_b.id), str(extra.id)],
        }, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(
            EthernetSegmentMember.objects.get(interface=self.bond_a).df_preference, 7
        )
        self.assertIsNone(EthernetSegmentMember.objects.get(interface=extra).df_preference)

    def test_a_port_sits_in_one_segment(self):
        self._segment()
        r = self._segment(name="srv2", es_id=2, interface_ids=[str(self.bond_a.id)])
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("interface_ids", r.json())

    def test_a_preference_for_a_port_outside_the_segment_is_refused(self):
        sid = self._segment(interface_ids=[str(self.bond_a.id)]).json()["id"]
        r = self.client.patch(f"/api/routing/ethernet-segments/{sid}/", {
            "member_df_preferences": {str(self.bond_b.id): 1},
        }, format="json")
        self.assertEqual(r.status_code, 400, r.content)

    def test_member_endpoint_and_change_log(self):
        from audit.models import ChangeLogEntry

        self._segment()
        mid = EthernetSegmentMember.objects.get(interface=self.bond_b).id
        r = self.client.get(f"/api/routing/ethernet-segment-members/?device={self.leaf_b.id}")
        self.assertEqual(r.json()["count"], 1)
        r = self.client.patch(f"/api/routing/ethernet-segment-members/{mid}/",
                              {"df_preference": 100}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["df_preference_effective"], 100)
        entry = ChangeLogEntry.objects.filter(object_id=str(mid)).last()
        self.assertIsNotNone(entry)
        self.assertIn("df_preference", entry.changes)

    def test_a_site_limited_user_cannot_edit_another_sites_member(self):
        self._segment()
        user = User.objects.create_user("u")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        p = ObjectPermission.objects.create(
            name="ams", object_types=["ethernetsegmentmember"], actions=["view", "change"],
        )
        p.users.add(user)
        p.sites.set([self.ams])
        self._login(user)
        mine = EthernetSegmentMember.objects.get(interface=self.bond_a).id
        theirs = EthernetSegmentMember.objects.get(interface=self.bond_b).id
        r = self.client.patch(f"/api/routing/ethernet-segment-members/{mine}/",
                              {"df_preference": 1}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        r = self.client.patch(f"/api/routing/ethernet-segment-members/{theirs}/",
                              {"df_preference": 1}, format="json")
        self.assertIn(r.status_code, (403, 404))
        self.assertIsNone(EthernetSegmentMember.objects.get(id=theirs).df_preference)


class RenderTests(_Base):
    def test_leaf_a_and_leaf_b_render_their_own_df_pref(self):
        sid = self._segment().json()["id"]
        self.client.patch(f"/api/routing/ethernet-segments/{sid}/", {
            "member_df_preferences": {str(self.bond_a.id): 60000},
        }, format="json")
        tmpl = ExportTemplate.objects.create(
            tenant=self.tenant, name="frr", object_type="device", template_code=ES_TEMPLATE,
        )

        def render(dev):
            r = self.client.get(f"/api/devices/{dev.id}/render/?template={tmpl.id}")
            self.assertEqual(r.status_code, 200, r.content)
            return r.json()["output"]

        body = ("interface bond-s1\n evpn mh es-id 1\n evpn mh es-sys-mac 44:38:39:ff:00:01\n"
                " evpn mh es-df-pref {}\n")
        self.assertEqual(render(self.leaf_a), body.format(60000))
        self.assertEqual(render(self.leaf_b), body.format(50000))

    def test_context_keys(self):
        sid = self._segment().json()["id"]
        EthernetSegmentMember.objects.filter(interface=self.bond_b).update(df_preference=10)
        ctx = routing_context(self.leaf_b)
        es = ctx["by_interface"]["bond-s1"]["es"]
        self.assertEqual((es["df_preference"], es["segment_df_preference"]), (10, 50000))
        seg = ctx["ethernet_segments"][0]
        self.assertEqual((seg["df_preference"], seg["local_df_preference"]), (50000, 10))
        members = {m["device"]: m for m in es["members"]}
        self.assertEqual(members["leaf-b"]["df_preference_effective"], 10)
        self.assertEqual(members["leaf-a"]["df_preference_effective"], 50000)
        self.assertTrue(EthernetSegment.objects.filter(id=sid).exists())


class MigrationTests(TransactionTestCase):
    """0016 adopts the existing many-to-many rows in place: the rows are
    kept, with no DF preference of their own."""

    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        # The closing flush empties migration-seeded rows a kept test DB
        # still needs.
        from auth_api.builtin_groups import ensure_builtin_groups

        ensure_builtin_groups()

    def test_existing_memberships_survive(self):
        executor = MigrationExecutor(connection)
        before = [("routing", "0015_policy_rules_route_table")]
        after = [("routing", "0016_ethernetsegmentmember")]
        executor.migrate(before)
        old = executor.loader.project_state(before).apps
        org = old.get_model("core", "Organization").objects.create(name="M", slug="m")
        tenant = old.get_model("core", "Tenant").objects.create(org=org, name="M", slug="m")
        site = old.get_model("api", "Site").objects.create(tenant=tenant, name="S")
        mfr = old.get_model("api", "Manufacturer").objects.create(tenant=tenant, name="X",
                                                                 slug="x")
        dt = old.get_model("api", "DeviceType").objects.create(tenant=tenant, manufacturer=mfr,
                                                              model="X")
        dev = old.get_model("api", "Device").objects.create(tenant=tenant, name="l1",
                                                           device_type=dt, site=site)
        iface = old.get_model("api", "Interface").objects.create(device=dev, name="bond1")
        seg = old.get_model("routing", "EthernetSegment").objects.create(
            tenant=tenant, name="s1", es_id=1, sys_mac="44:38:39:ff:00:01", df_preference=5,
        )
        seg.interfaces.add(iface)

        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        executor.migrate(after)
        new = executor.loader.project_state(after).apps
        rows = list(new.get_model("routing", "EthernetSegmentMember").objects.all())
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].interface_id, iface.id)
        self.assertIsNone(rows[0].df_preference)

        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        executor.migrate(executor.loader.graph.leaf_nodes())
