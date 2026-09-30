"""Bulk edit and delete on the VLAN list (#176).

The list ticks rows and sends them to ``bulk-update`` / ``bulk-delete``; the
edit page sets status, site, group, zone, VRF, description and tags. These pin
the endpoint half: fields land, clears land, another tenant's objects are
refused or untouched, every row that changed leaves a change-log entry, and a
group or site move keeps the edit form's range and VID rules.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from audit.models import ChangeAction, ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import DeploymentSettings, Organization, Tenant

from .models import VLAN, VRF, Site, Status, VLANGroup, Zone
from .test_utils import status_for

User = get_user_model()


class _Base(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        self.other = Tenant.objects.create(org=self.org, name="Other", slug="other")
        self.kyiv = Site.objects.create(tenant=self.tenant, name="Kyiv")
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

    def vlan(self, vid, **kw):
        kw.setdefault("site", self.kyiv)
        return VLAN.objects.create(tenant=self.tenant, vlan_id=vid, name=f"v{vid}", **kw)

    def update(self, rows, **fields):
        return self.client.post(
            "/api/vlans/bulk-update/",
            {"ids": [str(r.id) for r in rows], "fields": fields},
            format="json",
        )

    def logged(self, action, rows):
        return set(
            ChangeLogEntry.objects.filter(
                action=action, object_id__in=[str(r.id) for r in rows]
            ).values_list("object_id", flat=True)
        )


class BulkEditTests(_Base):
    def test_sets_and_clears_the_vrf(self):
        prod = VRF.objects.create(tenant=self.tenant, name="PROD")
        a, b = self.vlan(10), self.vlan(20)
        r = self.update([a, b], vrf_id=str(prod.id))
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["updated"], 2)
        self.assertEqual(set(VLAN.objects.values_list("vrf_id", flat=True)), {prod.id})
        self.assertEqual(self.logged(ChangeAction.UPDATE, [a, b]), {str(a.id), str(b.id)})

        r = self.update([a], vrf_id=None)
        self.assertEqual(r.status_code, 200, r.content)
        a.refresh_from_db()
        b.refresh_from_db()
        self.assertIsNone(a.vrf_id)
        self.assertEqual(b.vrf_id, prod.id)

    def test_refuses_another_tenants_vrf(self):
        foreign = VRF.objects.create(tenant=self.other, name="THEIRS")
        a = self.vlan(10)
        r = self.update([a], vrf_id=str(foreign.id))
        self.assertEqual(r.status_code, 400)
        self.assertIn("vrf_id", r.json())
        a.refresh_from_db()
        self.assertIsNone(a.vrf_id)

    def test_sets_and_clears_the_description(self):
        a = self.vlan(10, description="old")
        b = self.vlan(20, description="")
        r = self.update([a, b], description="core uplinks")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(
            set(VLAN.objects.values_list("description", flat=True)), {"core uplinks"})

        r = self.update([a, b], description="")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(set(VLAN.objects.values_list("description", flat=True)), {""})

    def test_leaves_another_tenants_vlans_alone(self):
        mine = self.vlan(10)
        theirs = VLAN.objects.create(tenant=self.other, vlan_id=10, name="theirs")
        r = self.update([mine, theirs], description="touched")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["updated"], 1)
        theirs.refresh_from_db()
        self.assertEqual(theirs.description, "")


class BulkDeleteTests(_Base):
    def delete(self, rows):
        return self.client.post(
            "/api/vlans/bulk-delete/", {"ids": [str(r.id) for r in rows]}, format="json")

    def test_deletes_the_selection_and_logs_each_row(self):
        a, b, keep = self.vlan(10), self.vlan(20), self.vlan(30)
        r = self.delete([a, b])
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["deleted"], 2)
        self.assertEqual(list(VLAN.objects.values_list("id", flat=True)), [keep.id])
        self.assertEqual(self.logged(ChangeAction.DELETE, [a, b]), {str(a.id), str(b.id)})

    def test_another_tenants_vlan_survives(self):
        theirs = VLAN.objects.create(tenant=self.other, vlan_id=10, name="theirs")
        r = self.delete([theirs])
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["deleted"], 0)
        self.assertTrue(VLAN.objects.filter(pk=theirs.pk).exists())

    def test_an_empty_selection_is_refused(self):
        r = self.client.post("/api/vlans/bulk-delete/", {"ids": []}, format="json")
        self.assertEqual(r.status_code, 400)


class GroupMoveTests(_Base):
    """A bulk move keeps the edit form's rules: a group only takes VIDs in its
    range, and a VID may not repeat in its namespace - the group, else the
    site (#159). The refusal names the VIDs, not a bare 409."""

    def setUp(self):
        super().setUp()
        self.warsaw = Site.objects.create(tenant=self.tenant, name="Warsaw")
        self.core = VLANGroup.objects.create(
            tenant=self.tenant, name="Core", slug="core", min_vid=100, max_vid=200)

    def test_moves_the_selection_into_a_group_and_out_again(self):
        a, b = self.vlan(110), self.vlan(120, site=self.warsaw)
        r = self.update([a, b], group_id=str(self.core.id))
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(set(VLAN.objects.values_list("group_id", flat=True)), {self.core.id})
        self.assertEqual(self.logged(ChangeAction.UPDATE, [a, b]), {str(a.id), str(b.id)})

        r = self.update([a, b], group_id=None)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(set(VLAN.objects.values_list("group_id", flat=True)), {None})

    def test_refuses_vids_outside_the_range(self):
        a, b = self.vlan(50), self.vlan(110)
        r = self.update([a, b], group_id=str(self.core.id))
        self.assertEqual(r.status_code, 400)
        self.assertIn("VLAN 50 is outside Core's range", r.json()["group_id"])
        self.assertFalse(VLAN.objects.filter(group__isnull=False).exists())

    def test_refuses_a_vid_the_group_already_has(self):
        VLAN.objects.create(tenant=self.tenant, vlan_id=110, name="there", group=self.core)
        mover = self.vlan(110, site=self.warsaw)
        r = self.update([mover], group_id=str(self.core.id))
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["group_id"], "VLAN 110 would repeat in Core.")

    def test_refuses_two_selected_vlans_with_one_vid(self):
        a, b = self.vlan(110), self.vlan(110, site=self.warsaw)
        r = self.update([a, b], group_id=str(self.core.id))
        self.assertEqual(r.status_code, 400)
        self.assertIn("VLAN 110 would repeat in Core", r.json()["group_id"])

    def test_leaving_a_group_must_not_repeat_at_the_site(self):
        self.vlan(110)
        grouped = self.vlan(110, group=self.core)
        r = self.update([grouped], group_id=None)
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["group_id"], "VLAN 110 would repeat at Kyiv.")

    def test_a_site_move_names_the_repeat(self):
        self.vlan(105)
        mover = self.vlan(105, site=self.warsaw)
        r = self.update([mover], site_id=str(self.kyiv.id).upper())
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["site_id"], "VLAN 105 would repeat at Kyiv.")
        mover.refresh_from_db()
        self.assertEqual(mover.site_id, self.warsaw.id)

    def test_a_grouped_vlan_moves_site_freely(self):
        """Its namespace is the group, so the site's own VIDs don't matter."""
        self.vlan(110, site=self.warsaw)
        grouped = self.vlan(110, group=self.core)
        r = self.update([grouped], site_id=str(self.warsaw.id))
        self.assertEqual(r.status_code, 200, r.content)

    def test_refuses_another_tenants_group(self):
        theirs = VLANGroup.objects.create(tenant=self.other, name="Theirs", slug="theirs")
        a = self.vlan(110)
        r = self.update([a], group_id=str(theirs.id))
        self.assertEqual(r.status_code, 400)
        self.assertIn("group_id", r.json())
        a.refresh_from_db()
        self.assertIsNone(a.group_id)


class SiteFenceTests(_Base):
    """Under enhanced site separation a site-scoped user may pick only global
    or own-site local VRFs, zones and statuses - as on the edit form."""

    def setUp(self):
        super().setUp()
        self.warsaw = Site.objects.create(tenant=self.tenant, name="Warsaw")
        dep = DeploymentSettings.load()
        dep.enhanced_site_separation = True
        dep.save()
        user = User.objects.create_user("kyiv-ops", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        grant = ObjectPermission.objects.create(
            name="kyiv", object_types=["vlan", "vrf", "zone", "status"],
            actions=["view", "change"],
        )
        grant.users.add(user)
        grant.sites.set([self.kyiv])
        self.client.force_login(user)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")

    def test_refuses_another_sites_local_catalogs(self):
        a = self.vlan(10, status=status_for(self.tenant))
        foreign = {
            "vrf_id": VRF.objects.create(
                tenant=self.tenant, name="WAW", owning_site=self.warsaw),
            "zone_id": Zone.objects.create(
                tenant=self.tenant, name="waw-dmz", slug="waw-dmz", owning_site=self.warsaw),
            "status_id": Status.objects.create(
                tenant=self.tenant, name="WAW only", slug="waw-only",
                available_to=["vlan"], owning_site=self.warsaw),
        }
        for key, obj in foreign.items():
            with self.subTest(key):
                r = self.update([a], **{key: str(obj.id)})
                self.assertEqual(r.status_code, 400, r.content)
                self.assertIn(key, r.json())
        a.refresh_from_db()
        self.assertIsNone(a.vrf_id)
        self.assertIsNone(a.zone_id)
        self.assertEqual(a.status.slug, "active")

    def test_takes_global_and_own_site_catalogs(self):
        a = self.vlan(10)
        shared = VRF.objects.create(tenant=self.tenant, name="SHARED")
        local = Zone.objects.create(
            tenant=self.tenant, name="kyiv-dmz", slug="kyiv-dmz", owning_site=self.kyiv)
        r = self.update([a], vrf_id=str(shared.id), zone_id=str(local.id))
        self.assertEqual(r.status_code, 200, r.content)
        a.refresh_from_db()
        self.assertEqual((a.vrf_id, a.zone_id), (shared.id, local.id))
