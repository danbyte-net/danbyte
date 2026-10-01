"""Bulk delete on circuits, providers, provider networks, circuit types,
wireless LANs and groups, and virtual chassis: each row goes the way a single
delete goes, rows still in use are kept and named, a dry run says what would
happen, and the count is the rows asked about (#252 #253 #267)."""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.models import (
    Circuit,
    CircuitTermination,
    CircuitType,
    Device,
    DeviceType,
    Provider,
    Site,
    VirtualChassis,
    WirelessLAN,
    WirelessLANGroup,
)
from api.tests_wireless_psk import _enable_local_store
from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tag, Tenant


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.admin = User.objects.create_superuser("root", "r@a.c", "pw")
        self.login(self.admin)
        self.site = Site.objects.create(tenant=self.tenant, name="dc1")

    def login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def bulk(self, endpoint, ids, dry_run=False):
        return self.client.post(f"{endpoint}bulk-delete/",
                                {"ids": [str(i) for i in ids], "dry_run": dry_run},
                                format="json")


class CircuitAndProviderTests(_Base):
    def setUp(self):
        super().setUp()
        self.busy = Provider.objects.create(tenant=self.tenant, name="Telco", slug="telco")
        self.free = Provider.objects.create(tenant=self.tenant, name="Spare", slug="spare")
        self.ctype = CircuitType.objects.create(tenant=self.tenant, name="Fibre", slug="fibre")
        self.circuit = Circuit.objects.create(tenant=self.tenant, cid="C-1", provider=self.busy,
                                              type=self.ctype)
        for side in ("A", "Z"):
            CircuitTermination.objects.create(circuit=self.circuit, term_side=side,
                                              site=self.site)

    def test_in_use_providers_are_kept_and_named(self):
        r = self.bulk("/api/providers/", [self.busy.id, self.free.id])
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["deleted"], 1)
        self.assertEqual(body["deleted_ids"], [str(self.free.id)])
        self.assertEqual([s["name"] for s in body["skipped"]], ["Telco"])
        self.assertIn("1 circuit", body["skipped"][0]["reason"])
        self.assertTrue(Provider.objects.filter(pk=self.busy.pk).exists())

    def test_dry_run_deletes_nothing_and_shows_what_goes_along(self):
        r = self.bulk("/api/circuits/", [self.circuit.id], dry_run=True)
        body = r.json()
        self.assertTrue(body["dry_run"])
        self.assertEqual(body["deleted"], 1)
        self.assertTrue(Circuit.objects.filter(pk=self.circuit.pk).exists())
        impact = {i["label"]: i["count"] for i in body["impact"]}
        self.assertEqual(impact.get("circuit terminations"), 2)

    def test_circuit_goes_with_its_terminations_and_counts_once(self):
        r = self.bulk("/api/circuits/", [self.circuit.id])
        self.assertEqual(r.json()["deleted"], 1)
        self.assertFalse(Circuit.objects.filter(pk=self.circuit.pk).exists())
        self.assertFalse(CircuitTermination.objects.filter(circuit_id=self.circuit.pk).exists())
        self.assertEqual(ChangeLogEntry.objects.filter(
            object_type="api.circuit", object_id=str(self.circuit.pk), action="delete").count(), 1)

    def test_circuit_type_in_use_is_kept(self):
        r = self.bulk("/api/circuit-types/", [self.ctype.id])
        self.assertEqual(r.json()["deleted"], 0)
        self.assertEqual(len(r.json()["skipped"]), 1)

    def test_needs_delete_permission(self):
        viewer = User.objects.create_user("viewer", password="x")
        UserProfile.objects.create(user=viewer, role="custom").tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(name="v", object_types=["provider"],
                                               actions=["view", "change"])
        perm.users.add(viewer)
        perm.tenants.add(self.tenant)
        self.login(viewer)
        r = self.bulk("/api/providers/", [self.free.id])
        self.assertEqual(r.status_code, 403, r.content)
        self.assertTrue(Provider.objects.filter(pk=self.free.pk).exists())

    def test_other_tenant_ids_fall_out(self):
        org = Organization.objects.create(name="Other", slug="other")
        other = Tenant.objects.create(org=org, name="Other", slug="other")
        theirs = Provider.objects.create(tenant=other, name="Theirs", slug="theirs")
        r = self.bulk("/api/providers/", [theirs.id])
        self.assertEqual(r.json()["deleted"], 0)
        self.assertTrue(Provider.objects.filter(pk=theirs.pk).exists())


class WirelessTests(_Base):
    def test_keys_leave_the_store_and_used_groups_stay(self):
        from monitoring.secret_store import active_secret_store

        _enable_local_store()
        group = WirelessLANGroup.objects.create(tenant=self.tenant, name="Campus",
                                                slug="campus")
        spare = WirelessLANGroup.objects.create(tenant=self.tenant, name="Spare",
                                                slug="spare")
        lan_id = self.client.post(
            "/api/wireless-lans/",
            {"ssid": "corp", "auth_type": "wpa-personal", "psk": "hunter2-hunter2",
             "group_id": str(group.id)},
            format="json",
        ).json()["id"]
        lan = WirelessLAN.objects.get(pk=lan_id)
        path = lan.psk_secret_path
        r = self.bulk("/api/wireless-lan-groups/", [group.id, spare.id])
        self.assertEqual(r.json()["deleted"], 1)
        self.assertEqual([s["name"] for s in r.json()["skipped"]], ["Campus"])
        r = self.bulk("/api/wireless-lans/", [lan.id])
        self.assertEqual(r.json()["deleted"], 1)
        self.assertIsNone(active_secret_store().get(self.tenant.id, path))


class VirtualChassisTests(_Base):
    def setUp(self):
        super().setUp()
        dt = DeviceType.objects.create(tenant=self.tenant, name="sw")
        self.vc = VirtualChassis.objects.create(tenant=self.tenant, name="stack1")
        self.other = VirtualChassis.objects.create(tenant=self.tenant, name="stack2")
        self.a = Device.objects.create(
            tenant=self.tenant, name="sw1", device_type=dt, site=self.site,
            virtual_chassis=self.vc, vc_position=1, vc_priority=10,
        )
        Device.objects.create(
            tenant=self.tenant, name="sw2", device_type=dt, site=self.site,
            virtual_chassis=self.vc, vc_position=2,
        )

    def test_members_are_released_and_logged(self):
        dry = self.bulk("/api/virtual-chassis/", [self.vc.id, self.other.id], dry_run=True)
        self.assertEqual(dry.json()["released"], [{"label": "member devices", "count": 2}])
        r = self.bulk("/api/virtual-chassis/", [self.vc.id])
        self.assertEqual(r.json()["deleted"], 1)
        self.a.refresh_from_db()
        self.assertIsNone(self.a.virtual_chassis_id)
        self.assertIsNone(self.a.vc_position)
        self.assertIsNone(self.a.vc_priority)
        entry = ChangeLogEntry.objects.get(object_id=str(self.a.pk), action="update")
        self.assertIn("virtual_chassis_id", entry.changes)

    def test_bulk_update_sets_domain_description_and_tags(self):
        tag = Tag.objects.create(name="lab", slug="lab", tenant=self.tenant)
        r = self.client.post("/api/virtual-chassis/bulk-update/", {
            "ids": [str(self.vc.id), str(self.other.id)],
            "fields": {"domain": "dom-7", "description": "moved",
                       "add_tag_ids": [tag.id]},
        }, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["updated"], 2)
        for vc in (self.vc, self.other):
            vc.refresh_from_db()
            self.assertEqual((vc.domain, vc.description), ("dom-7", "moved"))
            self.assertEqual(list(vc.tags.values_list("slug", flat=True)), ["lab"])
        self.assertTrue(ChangeLogEntry.objects.filter(
            object_id=str(self.vc.pk), action="update").exists())

    def test_bulk_update_refuses_what_it_does_not_write(self):
        url = "/api/virtual-chassis/bulk-update/"
        ids = [str(self.vc.id)]
        for fields in ({"name": "x"}, {"domain": "d" * 65}, {"description": 7}):
            r = self.client.post(url, {"ids": ids, "fields": fields}, format="json")
            self.assertEqual(r.status_code, 400, (fields, r.content))
        self.vc.refresh_from_db()
        self.assertEqual(self.vc.name, "stack1")
