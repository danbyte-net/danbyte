"""Multi-select on power panels and power feeds (#313): a safe bulk delete
that names cabled feeds and keeps panels that still have feeds unless their
feeds go too, and a bulk update that checks values as the edit form's PATCH
does, all or nothing, with a change-log entry per row."""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.models import (
    Cable,
    CableTermination,
    Device,
    DeviceType,
    PowerFeed,
    PowerPanel,
    PowerPort,
    Rack,
    Site,
    Status,
)
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
        self.site2 = Site.objects.create(tenant=self.tenant, name="dc2")
        self.panel = PowerPanel.objects.create(tenant=self.tenant, site=self.site, name="MDB-1")
        self.empty = PowerPanel.objects.create(tenant=self.tenant, site=self.site, name="MDB-2")
        self.far = PowerPanel.objects.create(tenant=self.tenant, site=self.site2, name="MDB-9")
        self.f1 = PowerFeed.objects.create(tenant=self.tenant, power_panel=self.panel, name="A")
        self.f2 = PowerFeed.objects.create(tenant=self.tenant, power_panel=self.panel, name="B")
        self.rack = Rack.objects.create(tenant=self.tenant, site=self.site, name="R1")
        dt = DeviceType.objects.create(tenant=self.tenant, name="pdu")
        self.pdu = Device.objects.create(tenant=self.tenant, name="pdu-1", device_type=dt,
                                         site=self.site)
        self.psu = PowerPort.objects.create(device=self.pdu, name="PSU1")
        cable = Cable.objects.create(tenant=self.tenant, label="P-1")
        CableTermination.objects.create(cable=cable, end="A", power_feed=self.f1)
        CableTermination.objects.create(cable=cable, end="B", power_port=self.psu)

    def login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def member(self, *grants):
        """A tenant member holding ``(types, actions, sites)`` grants."""
        user = User.objects.create_user(f"u{User.objects.count()}", password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(self.tenant)
        for types, actions, sites in grants:
            perm = ObjectPermission.objects.create(
                name=f"{types} {actions}", object_types=list(types), actions=list(actions)
            )
            perm.users.add(user)
            perm.tenants.add(self.tenant)
            for site in sites:
                perm.sites.add(site)
        self.login(user)
        return user

    def delete(self, endpoint, ids, **extra):
        return self.client.post(f"{endpoint}bulk-delete/",
                                {"ids": [str(i) for i in ids], **extra}, format="json")

    def update(self, endpoint, ids, fields):
        return self.client.post(f"{endpoint}bulk-update/",
                                {"ids": [str(i) for i in ids], "fields": fields},
                                format="json")

    def logged(self, obj, action):
        return ChangeLogEntry.objects.filter(
            object_id=str(obj.pk), action=action).exists()


class FeedDeleteTests(_Base):
    def test_dry_run_names_the_cabled_feed_and_deletes_nothing(self):
        r = self.delete("/api/power-feeds/", [self.f1.id, self.f2.id], dry_run=True)
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["deleted"], 2)
        self.assertEqual(body["skipped"], [])
        self.assertEqual(len(body["notes"]), 1)
        note = body["notes"][0]
        self.assertEqual((note["id"], note["name"]), (str(self.f1.id), "A"))
        self.assertIn("pdu-1", note["detail"])
        self.assertIn("PSU1", note["detail"])
        self.assertEqual(PowerFeed.objects.filter(power_panel=self.panel).count(), 2)

    def test_feeds_go_with_their_cable_ends_and_each_is_logged(self):
        r = self.delete("/api/power-feeds/", [self.f1.id, self.f2.id])
        self.assertEqual(r.json()["deleted"], 2)
        self.assertFalse(PowerFeed.objects.filter(pk__in=[self.f1.pk, self.f2.pk]).exists())
        self.assertFalse(CableTermination.objects.filter(power_feed_id=self.f1.pk).exists())
        self.assertTrue(self.logged(self.f1, "delete"))
        self.assertTrue(self.logged(self.f2, "delete"))

    def test_other_tenant_ids_fall_out(self):
        org = Organization.objects.create(name="Other", slug="other")
        other = Tenant.objects.create(org=org, name="Other", slug="other")
        site = Site.objects.create(tenant=other, name="x")
        panel = PowerPanel.objects.create(tenant=other, site=site, name="P")
        theirs = PowerFeed.objects.create(tenant=other, power_panel=panel, name="T")
        r = self.delete("/api/power-feeds/", [theirs.id])
        self.assertEqual(r.json()["deleted"], 0)
        self.assertTrue(PowerFeed.objects.filter(pk=theirs.pk).exists())

    def test_needs_delete_permission(self):
        self.member((["powerfeed"], ["view", "change"], []))
        r = self.delete("/api/power-feeds/", [self.f2.id])
        self.assertEqual(r.status_code, 403, r.content)
        self.assertTrue(PowerFeed.objects.filter(pk=self.f2.pk).exists())

    def test_site_scoped_delete_leaves_other_sites_alone(self):
        theirs = PowerFeed.objects.create(tenant=self.tenant, power_panel=self.far, name="Z")
        self.member((["powerfeed"], ["view", "delete"], [self.site]))
        r = self.delete("/api/power-feeds/", [self.f2.id, theirs.id])
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["deleted_ids"], [str(self.f2.id)])
        self.assertTrue(PowerFeed.objects.filter(pk=theirs.pk).exists())


class PanelDeleteTests(_Base):
    def test_panel_with_feeds_is_kept_and_named(self):
        r = self.delete("/api/power-panels/", [self.panel.id, self.empty.id])
        body = r.json()
        self.assertEqual(body["deleted_ids"], [str(self.empty.id)])
        self.assertEqual([s["name"] for s in body["skipped"]], ["MDB-1"])
        self.assertIn("2 power feeds", body["skipped"][0]["reason"])
        self.assertTrue(PowerPanel.objects.filter(pk=self.panel.pk).exists())
        self.assertFalse(PowerPanel.objects.filter(pk=self.empty.pk).exists())

    def test_with_feeds_dry_run_counts_the_feeds_and_names_the_cabled_one(self):
        r = self.delete("/api/power-panels/", [self.panel.id], dry_run=True, with_feeds=True)
        body = r.json()
        self.assertEqual(body["deleted"], 1, body)
        self.assertEqual(body["skipped"], [])
        impact = {i["label"]: i["count"] for i in body["impact"]}
        self.assertEqual(impact.get("power feeds"), 2)
        self.assertEqual([n["name"] for n in body["notes"]], ["A"])
        self.assertEqual(PowerFeed.objects.filter(power_panel=self.panel).count(), 2)

    def test_with_feeds_deletes_panel_and_feeds_and_logs_each(self):
        r = self.delete("/api/power-panels/", [self.panel.id], with_feeds=True)
        self.assertEqual(r.json()["deleted"], 1, r.content)
        self.assertFalse(PowerPanel.objects.filter(pk=self.panel.pk).exists())
        self.assertFalse(PowerFeed.objects.filter(pk__in=[self.f1.pk, self.f2.pk]).exists())
        for obj in (self.panel, self.f1, self.f2):
            self.assertTrue(self.logged(obj, "delete"), obj)

    def test_with_feeds_needs_the_right_to_delete_the_feeds(self):
        self.member((["powerpanel"], ["view", "delete"], []),
                    (["powerfeed"], ["view"], []))
        r = self.delete("/api/power-panels/", [self.panel.id], with_feeds=True)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["deleted"], 0)
        self.assertEqual(len(r.json()["skipped"]), 1)
        self.assertTrue(PowerPanel.objects.filter(pk=self.panel.pk).exists())
        self.assertEqual(PowerFeed.objects.filter(power_panel=self.panel).count(), 2)

    def test_with_feeds_needs_every_feed_in_the_callers_sites(self):
        # Panels anywhere, feeds only in dc2: the dc1 panel's feeds are not
        # the caller's to delete, so that panel stays.
        self.member((["powerpanel"], ["view", "delete"], []),
                    (["powerfeed"], ["view", "delete"], [self.site2]))
        x1 = PowerFeed.objects.create(tenant=self.tenant, power_panel=self.far, name="X1")
        r = self.delete("/api/power-panels/", [self.far.id, self.panel.id], with_feeds=True)
        self.assertEqual(r.json()["deleted_ids"], [str(self.far.id)], r.content)
        self.assertEqual([s["name"] for s in r.json()["skipped"]], ["MDB-1"])
        self.assertTrue(PowerPanel.objects.filter(pk=self.panel.pk).exists())
        self.assertFalse(PowerFeed.objects.filter(pk=x1.pk).exists())
        self.assertEqual(PowerFeed.objects.filter(power_panel=self.panel).count(), 2)


class FeedUpdateTests(_Base):
    def setUp(self):
        super().setUp()
        self.active = Status.objects.create(tenant=self.tenant, name="Active", slug="active",
                                            available_to=["powerfeed"])
        self.vlan_only = Status.objects.create(tenant=self.tenant, name="Reserved",
                                               slug="reserved", available_to=["vlan"])

    def test_sets_every_bulk_field_and_logs_each_row(self):
        tag = Tag.objects.create(name="ups", slug="ups", tenant=self.tenant)
        r = self.update("/api/power-feeds/", [self.f1.id, self.f2.id], {
            "status_id": str(self.active.id), "type": "redundant", "supply": "dc",
            "phase": "three", "voltage": -48, "amperage": 32, "max_utilization": 70,
            "power_panel_id": str(self.empty.id), "rack_id": str(self.rack.id),
            "add_tag_ids": [tag.id],
        })
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["updated"], 2)
        for f in (self.f1, self.f2):
            f.refresh_from_db()
            self.assertEqual(
                (f.status_id, f.type, f.supply, f.phase, f.voltage, f.amperage,
                 f.max_utilization, f.power_panel_id, f.rack_id),
                (self.active.id, "redundant", "dc", "three", -48, 32, 70,
                 self.empty.id, self.rack.id),
            )
            self.assertEqual(list(f.tags.values_list("slug", flat=True)), ["ups"])
            self.assertTrue(self.logged(f, "update"))

    def test_clears_rack_and_nullable_numbers(self):
        PowerFeed.objects.update(rack=self.rack, voltage=230)
        r = self.update("/api/power-feeds/", [self.f1.id],
                        {"rack_id": None, "voltage": None})
        self.assertEqual(r.status_code, 200, r.content)
        self.f1.refresh_from_db()
        self.assertEqual((self.f1.rack_id, self.f1.voltage), (None, None))

    def test_refuses_what_a_patch_refuses_and_changes_nothing(self):
        org = Organization.objects.create(name="Other", slug="other")
        other = Tenant.objects.create(org=org, name="Other", slug="other")
        theirs = PowerPanel.objects.create(
            tenant=other, site=Site.objects.create(tenant=other, name="x"), name="P")
        for fields in (
            {"type": "huge"},
            {"supply": ""},
            {"max_utilization": None},
            {"max_utilization": -1},
            {"amperage": -5},
            {"voltage": "lots"},
            {"power_panel_id": None},
            {"power_panel_id": str(theirs.id)},
            {"status_id": str(self.vlan_only.id)},
            {"name": "renamed"},
            {"comments": "x"},
        ):
            r = self.update("/api/power-feeds/", [self.f1.id, self.f2.id],
                            {"type": "redundant", **fields})
            self.assertEqual(r.status_code, 400, (fields, r.content))
        self.f1.refresh_from_db()
        self.assertEqual((self.f1.type, self.f1.power_panel_id, self.f1.name),
                         ("primary", self.panel.id, "A"))

    def test_a_move_may_not_give_a_panel_two_feeds_of_one_name(self):
        PowerFeed.objects.create(tenant=self.tenant, power_panel=self.empty, name="A")
        r = self.update("/api/power-feeds/", [self.f1.id, self.f2.id],
                        {"power_panel_id": str(self.empty.id)})
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("A", str(r.json()))
        self.f2.refresh_from_db()
        self.assertEqual(self.f2.power_panel_id, self.panel.id)

    def test_a_site_scoped_editor_may_not_move_a_feed_out_of_their_sites(self):
        self.member((["powerfeed"], ["view", "change"], [self.site]),
                    (["powerpanel"], ["view"], []))
        r = self.update("/api/power-feeds/", [self.f2.id],
                        {"power_panel_id": str(self.far.id)})
        self.assertIn(r.status_code, (400, 403), r.content)
        self.f2.refresh_from_db()
        self.assertEqual(self.f2.power_panel_id, self.panel.id)

    def test_needs_change_permission(self):
        self.member((["powerfeed"], ["view", "delete"], []))
        r = self.update("/api/power-feeds/", [self.f2.id], {"type": "redundant"})
        self.assertEqual(r.status_code, 403, r.content)

    def test_rename_and_clone_are_not_offered(self):
        for path in ("bulk-rename", "bulk-clone"):
            r = self.client.post(f"/api/power-feeds/{path}/",
                                 {"ids": [str(self.f1.id)], "find": "A", "replace": "Z"},
                                 format="json")
            self.assertIn(r.status_code, (404, 405), (path, r.status_code))


class PanelUpdateTests(_Base):
    def test_sets_site_and_tags_and_logs_each_row(self):
        tag = Tag.objects.create(name="hall", slug="hall", tenant=self.tenant)
        r = self.update("/api/power-panels/", [self.panel.id, self.empty.id],
                        {"site_id": str(self.site2.id), "add_tag_ids": [tag.id]})
        self.assertEqual(r.status_code, 200, r.content)
        for p in (self.panel, self.empty):
            p.refresh_from_db()
            self.assertEqual(p.site_id, self.site2.id)
            self.assertEqual(list(p.tags.values_list("slug", flat=True)), ["hall"])
            self.assertTrue(self.logged(p, "update"))

    def test_a_move_may_not_give_a_site_two_panels_of_one_name(self):
        PowerPanel.objects.create(tenant=self.tenant, site=self.site2, name="MDB-1")
        r = self.update("/api/power-panels/", [self.panel.id],
                        {"site_id": str(self.site2.id)})
        self.assertEqual(r.status_code, 400, r.content)
        self.panel.refresh_from_db()
        self.assertEqual(self.panel.site_id, self.site.id)

    def test_refuses_other_fields_and_foreign_sites(self):
        org = Organization.objects.create(name="Other", slug="other")
        other = Tenant.objects.create(org=org, name="Other", slug="other")
        theirs = Site.objects.create(tenant=other, name="x")
        for fields in ({"site_id": str(theirs.id)}, {"site_id": None}, {"name": "x"}):
            r = self.update("/api/power-panels/", [self.panel.id], fields)
            self.assertEqual(r.status_code, 400, (fields, r.content))
        self.panel.refresh_from_db()
        self.assertEqual(self.panel.site_id, self.site.id)

    def test_a_site_scoped_editor_may_not_move_a_panel_out_of_their_sites(self):
        self.member((["powerpanel"], ["view", "change"], [self.site]))
        r = self.update("/api/power-panels/", [self.empty.id], {"site_id": str(self.site2.id)})
        self.assertIn(r.status_code, (400, 403), r.content)
        self.empty.refresh_from_db()
        self.assertEqual(self.empty.site_id, self.site.id)
