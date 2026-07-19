"""Site-scoped ObjectPermissions — restrict_queryset narrows by site."""
from __future__ import annotations

from django.contrib.auth.models import User
from django.test import TestCase
from rest_framework.test import APITestCase

from api.models import Device, DeviceType, Manufacturer, Prefix, Site, VLAN
from auth_api import rbac
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant


from api.test_utils import status_for


class SiteScopedRBACTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.ams = Site.objects.create(tenant=self.tenant, name="AMS")
        self.lon = Site.objects.create(tenant=self.tenant, name="LON")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="C", slug="c")
        dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="X")
        self.d_ams = Device.objects.create(
            tenant=self.tenant, name="ams1", device_type=dt, site=self.ams
        )
        self.d_lon = Device.objects.create(
            tenant=self.tenant, name="lon1", device_type=dt, site=self.lon
        )
        self.user = User.objects.create_user("u")
        UserProfile.objects.create(user=self.user).tenants.add(self.tenant)

    def _perm(self, actions, sites=None, constraints=None, types=("device",)):
        p = ObjectPermission.objects.create(
            name="p", object_types=list(types), actions=list(actions),
            constraints=constraints,
        )
        p.users.add(self.user)
        if sites:
            p.sites.set(sites)
        return p

    def _devices(self, action):
        qs = rbac.restrict_queryset(
            Device.objects.all(), self.user, self.tenant, "device", action
        )
        return set(qs.values_list("name", flat=True))

    def test_site_scoped_change_limits_to_that_site(self):
        self._perm(["change"], sites=[self.ams])
        self.assertEqual(self._devices("change"), {"ams1"})  # not lon1

    def test_unscoped_view_sees_all(self):
        self._perm(["view"])  # no sites
        self.assertEqual(self._devices("view"), {"ams1", "lon1"})

    def test_edit_own_site_but_read_all_combo(self):
        # The headline use case: local IT edits their site, sees everything.
        self._perm(["change"], sites=[self.ams])       # edit AMS only
        self._perm(["view"])                            # read all
        self.assertEqual(self._devices("view"), {"ams1", "lon1"})  # sees both
        self.assertEqual(self._devices("change"), {"ams1"})        # edits AMS only

    def test_read_only_own_site(self):
        self._perm(["view"], sites=[self.lon])  # only LON, view only
        self.assertEqual(self._devices("view"), {"lon1"})
        self.assertEqual(self._devices("change"), set())  # no change grant → none

    def test_two_sites_scoped(self):
        self._perm(["change"], sites=[self.ams, self.lon])
        self.assertEqual(self._devices("change"), {"ams1", "lon1"})

    def test_site_scope_anded_with_constraint(self):
        # site=AMS AND status... use name constraint as a stand-in.
        self._perm(["view"], sites=[self.ams], constraints={"name": "ams1"})
        self.assertEqual(self._devices("view"), {"ams1"})
        # A constraint that excludes the only AMS device → empty.
        ObjectPermission.objects.all().delete()
        self._perm(["view"], sites=[self.ams], constraints={"name": "nope"})
        self.assertEqual(self._devices("view"), set())

    def test_type_without_site_ignores_scope(self):
        # VLAN has no site path → a site-scoped grant still covers all VLANs.
        VLAN.objects.create(tenant=self.tenant, vlan_id=10, name="v10")
        VLAN.objects.create(tenant=self.tenant, vlan_id=20, name="v20")
        self._perm(["view"], sites=[self.ams], types=("vlan",))
        qs = rbac.restrict_queryset(
            VLAN.objects.all(), self.user, self.tenant, "vlan", "view"
        )
        self.assertEqual(qs.count(), 2)  # site scope ignored — no vlan.site

    def test_not_granted_is_empty(self):
        self.assertEqual(self._devices("delete"), set())  # no delete grant


class SiteScopedWriteEnforcementTests(APITestCase):
    """The write path: a site-scoped editor can't create/move objects out of
    their site(s). (Closes the create/re-parent gap the read filter can't.)"""

    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.ams = Site.objects.create(tenant=self.tenant, name="AMS")
        self.lon = Site.objects.create(tenant=self.tenant, name="LON")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="C", slug="c")
        self.dt = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=mfr, model="X"
        )
        self.user = User.objects.create_user("ed", password="x")
        UserProfile.objects.create(user=self.user).tenants.add(self.tenant)
        # AMS-only device editor: add+change+view scoped to AMS.
        p = ObjectPermission.objects.create(
            name="ams-editor", object_types=["device"],
            actions=["view", "add", "change", "delete"],
        )
        p.users.add(self.user)
        p.sites.set([self.ams])
        self.client.force_login(self.user)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")

    def _post(self, site):
        return self.client.post(
            "/api/devices/",
            {"name": "d", "device_type_id": str(self.dt.id),
             "site_id": str(site.id)},
            format="json",
        )

    def test_create_in_own_site_ok(self):
        res = self._post(self.ams)
        self.assertIn(res.status_code, (200, 201))
        self.assertEqual(Device.objects.filter(site=self.ams).count(), 1)

    def test_create_in_other_site_blocked_and_rolled_back(self):
        res = self._post(self.lon)
        self.assertEqual(res.status_code, 403)
        self.assertEqual(Device.objects.filter(site=self.lon).count(), 0)  # rolled back

    def test_move_out_of_scope_blocked(self):
        d = Device.objects.create(
            tenant=self.tenant, name="d", device_type=self.dt, site=self.ams
        )
        res = self.client.patch(
            f"/api/devices/{d.id}/", {"site_id": str(self.lon.id)}, format="json"
        )
        self.assertEqual(res.status_code, 403)
        d.refresh_from_db()
        self.assertEqual(d.site_id, self.ams.id)  # unchanged

    def test_move_within_scope_ok(self):
        # Add LON to the editor's scope → moving there is fine.
        ObjectPermission.objects.get(name="ams-editor").sites.add(self.lon)
        d = Device.objects.create(
            tenant=self.tenant, name="d", device_type=self.dt, site=self.ams
        )
        res = self.client.patch(
            f"/api/devices/{d.id}/", {"site_id": str(self.lon.id)}, format="json"
        )
        self.assertIn(res.status_code, (200, 202))
        d.refresh_from_db()
        self.assertEqual(d.site_id, self.lon.id)

    def test_unscoped_editor_can_create_anywhere(self):
        ObjectPermission.objects.get(name="ams-editor").sites.clear()  # unscoped
        self.assertIn(self._post(self.lon).status_code, (200, 201))


class SitePrefixScopeTests(APITestCase):
    """A site-scoped user may carve inside their own site's address space OR
    create a brand-new range that overlaps nothing (a "dark"/non-routed
    subnet). They can never overlap the shared (global) space or another
    site's prefixes."""

    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.ams = Site.objects.create(tenant=self.tenant, name="AMS")
        # AMS owns 10.0.0.0/18 (assigned by a tenant admin out of band).
        self.scope = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/18", status=status_for(self.tenant, "container"), site=self.ams
        )
        # HQ's shared (site-less) space that site users must not carve into.
        self.shared = Prefix.objects.create(
            tenant=self.tenant, cidr="172.16.0.0/16",
            status=status_for(self.tenant, "container"), site=None,
        )
        self.user = User.objects.create_user("site", password="x")
        UserProfile.objects.create(user=self.user).tenants.add(self.tenant)
        p = ObjectPermission.objects.create(
            name="ams-prefix", object_types=["prefix"],
            actions=["view", "add", "change"],
        )
        p.users.add(self.user)
        p.sites.set([self.ams])
        self.client.force_login(self.user)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")

    def _post(self, cidr, site=None):
        return self.client.post(
            "/api/prefixes/",
            {"cidr": cidr, "status": "active",
             "site_id": str((site or self.ams).id)},
            format="json",
        )

    def test_child_within_scope_ok(self):
        res = self._post("10.0.5.0/24")  # inside 10.0.0.0/18
        self.assertIn(res.status_code, (200, 201))
        self.assertTrue(Prefix.objects.filter(cidr="10.0.5.0/24").exists())

    def test_dark_subnet_outside_scope_ok(self):
        # Outside their assigned space but overlaps nothing → a fresh dark range.
        res = self._post("10.1.0.0/24")
        self.assertIn(res.status_code, (200, 201), res.content)
        self.assertTrue(Prefix.objects.filter(cidr="10.1.0.0/24").exists())

    def test_unrelated_dark_subnet_ok(self):
        res = self._post("192.168.50.0/24")
        self.assertIn(res.status_code, (200, 201), res.content)

    def test_overlap_shared_space_blocked(self):
        # Carving inside HQ's shared 172.16.0.0/16 → collision, refused.
        res = self._post("172.16.5.0/24")
        self.assertEqual(res.status_code, 403)
        self.assertFalse(Prefix.objects.filter(cidr="172.16.5.0/24").exists())

    def test_overlap_other_site_blocked(self):
        lon = Site.objects.create(tenant=self.tenant, name="LON")
        Prefix.objects.create(
            tenant=self.tenant, cidr="10.9.0.0/18",
            status=status_for(self.tenant), site=lon,
        )
        res = self._post("10.9.1.0/24")  # inside LON's space
        self.assertEqual(res.status_code, 403)

    def test_no_scope_can_still_create_dark(self):
        # A site with no assigned range can still stand up non-colliding ranges.
        empty = Site.objects.create(tenant=self.tenant, name="BER")
        ObjectPermission.objects.get(name="ams-prefix").sites.set([empty])
        res = self._post("192.168.99.0/24", site=empty)
        self.assertIn(res.status_code, (200, 201), res.content)

    def test_admin_unscoped_can_create_anywhere(self):
        ObjectPermission.objects.get(name="ams-prefix").sites.clear()  # unscoped
        self.assertIn(self._post("172.16.5.0/24").status_code, (200, 201))


class PerObjectSiteFlagTests(APITestCase):
    """The serializer's per-object change/delete flag is site-aware, so the UI
    doesn't show an Edit button that would 403."""

    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.ams = Site.objects.create(tenant=self.tenant, name="AMS")
        self.lon = Site.objects.create(tenant=self.tenant, name="LON")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="C", slug="c")
        dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="X")
        self.ams_dev = Device.objects.create(
            tenant=self.tenant, name="ams1", device_type=dt, site=self.ams
        )
        self.lon_dev = Device.objects.create(
            tenant=self.tenant, name="lon1", device_type=dt, site=self.lon
        )
        self.user = User.objects.create_user("v", password="x")
        UserProfile.objects.create(user=self.user).tenants.add(self.tenant)
        # Edit AMS only; read everything.
        edit = ObjectPermission.objects.create(
            name="edit-ams", object_types=["device"], actions=["change"],
        )
        edit.users.add(self.user)
        edit.sites.set([self.ams])
        view = ObjectPermission.objects.create(
            name="view-all", object_types=["device"], actions=["view"],
        )
        view.users.add(self.user)
        self.client.force_login(self.user)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")

    def _perms(self, dev):
        return self.client.get(f"/api/devices/{dev.id}/").json()["permissions"]

    def test_own_site_object_is_editable(self):
        self.assertTrue(self._perms(self.ams_dev)["change"])

    def test_other_site_object_not_editable_in_flag(self):
        # Visible (view-all) but the change flag is False — no misleading button.
        self.assertFalse(self._perms(self.lon_dev)["change"])


class SiteRoleTemplateTests(APITestCase):
    """The one-click site editor/viewer templates assemble the right grants."""

    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.ams = Site.objects.create(tenant=self.tenant, name="AMS")
        self.lon = Site.objects.create(tenant=self.tenant, name="LON")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="C", slug="c")
        self.dt = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=mfr, model="X"
        )
        self.d_ams = Device.objects.create(
            tenant=self.tenant, name="ams1", device_type=self.dt, site=self.ams
        )
        self.d_lon = Device.objects.create(
            tenant=self.tenant, name="lon1", device_type=self.dt, site=self.lon
        )
        self.admin = User.objects.create_user("a", password="x", is_superuser=True)
        prof = UserProfile.objects.create(user=self.admin)
        prof.tenants.add(self.tenant)
        self.target = User.objects.create_user("local", password="x")
        UserProfile.objects.create(user=self.target).tenants.add(self.tenant)
        self.client.force_login(self.admin)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")

    def _devices(self, action):
        from auth_api import rbac
        qs = rbac.restrict_queryset(
            Device.objects.all(), self.target, self.tenant, "device", action
        )
        return set(qs.values_list("name", flat=True))

    def test_editor_creates_edit_own_plus_read_all(self):
        res = self.client.post(
            "/api/rbac/site-role/",
            {"role": "editor", "site_ids": [str(self.ams.id)],
             "user_ids": [self.target.id]},
            format="json",
        )
        self.assertEqual(res.status_code, 201)
        self.assertEqual(len(res.json()["created"]), 2)
        # The target now edits AMS only, but reads everything.
        self.assertEqual(self._devices("change"), {"ams1"})
        self.assertEqual(self._devices("view"), {"ams1", "lon1"})

    def test_viewer_creates_read_own_only(self):
        res = self.client.post(
            "/api/rbac/site-role/",
            {"role": "viewer", "site_ids": [str(self.lon.id)],
             "user_ids": [self.target.id]},
            format="json",
        )
        self.assertEqual(res.status_code, 201)
        self.assertEqual(len(res.json()["created"]), 1)
        self.assertEqual(self._devices("view"), {"lon1"})    # own site only
        self.assertEqual(self._devices("change"), set())     # no edit grant

    def test_bad_role_400(self):
        res = self.client.post(
            "/api/rbac/site-role/",
            {"role": "boss", "site_ids": [str(self.ams.id)]}, format="json",
        )
        self.assertEqual(res.status_code, 400)

    def test_no_site_400(self):
        res = self.client.post(
            "/api/rbac/site-role/", {"role": "editor", "site_ids": []},
            format="json",
        )
        self.assertEqual(res.status_code, 400)

    def test_non_admin_forbidden(self):
        c = self.client_class()
        c.force_login(self.target)  # not a permission admin
        c.post(f"/api/tenants/{self.tenant.id}/switch/")
        res = c.post(
            "/api/rbac/site-role/",
            {"role": "viewer", "site_ids": [str(self.ams.id)]}, format="json",
        )
        self.assertEqual(res.status_code, 403)


class SiteDelegationTests(APITestCase):
    """A local site editor may invite *viewers* to their own site(s) only when
    the deployment enables ``allow_site_editor_delegation``."""

    def setUp(self):
        from core.models import DeploymentSettings

        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.ams = Site.objects.create(tenant=self.tenant, name="AMS")
        self.lon = Site.objects.create(tenant=self.tenant, name="LON")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="C", slug="c")
        dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="X")
        self.d_ams = Device.objects.create(
            tenant=self.tenant, name="ams1", device_type=dt, site=self.ams
        )
        self.d_lon = Device.objects.create(
            tenant=self.tenant, name="lon1", device_type=dt, site=self.lon
        )
        # A site editor of AMS (scoped change grant on the site-bound types).
        self.editor = User.objects.create_user("editor", password="x")
        UserProfile.objects.create(user=self.editor).tenants.add(self.tenant)
        from auth_api.site_paths import SITE_PATHS

        types = sorted(set(SITE_PATHS) - {"site"})
        edit = ObjectPermission.objects.create(
            name="ams edit", object_types=types,
            actions=["view", "add", "change", "delete"],
        )
        edit.users.add(self.editor)
        edit.sites.set([self.ams])

        self.target = User.objects.create_user("local", password="x")
        UserProfile.objects.create(user=self.target).tenants.add(self.tenant)
        self.ds = DeploymentSettings.load()

    def _login(self, user):
        self.client.force_login(user)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")

    def _post(self, **body):
        return self.client.post("/api/rbac/site-role/", body, format="json")

    def _views(self, user, action="view"):
        qs = rbac.restrict_queryset(
            Device.objects.all(), user, self.tenant, "device", action
        )
        return set(qs.values_list("name", flat=True))

    def test_editor_is_not_a_permission_admin(self):
        # Sanity: the editor isn't accidentally a permission admin.
        from auth_api.permissions import can_manage_admin

        self.assertFalse(can_manage_admin(self.editor, self.tenant))
        self.assertEqual(rbac.editable_sites(self.editor, self.tenant), {self.ams.id})

    def test_delegation_off_editor_forbidden(self):
        self.ds.allow_site_editor_delegation = False
        self.ds.save()
        self._login(self.editor)
        res = self._post(role="viewer", site_ids=[str(self.ams.id)],
                         user_ids=[self.target.id])
        self.assertEqual(res.status_code, 403)

    def test_delegation_on_editor_invites_viewer_own_site(self):
        self.ds.allow_site_editor_delegation = True
        self.ds.save()
        self._login(self.editor)
        res = self._post(role="viewer", site_ids=[str(self.ams.id)],
                         user_ids=[self.target.id])
        self.assertEqual(res.status_code, 201)
        self.assertEqual(len(res.json()["created"]), 1)
        self.assertEqual(self._views(self.target), {"ams1"})  # own site only

    def test_delegation_on_editor_cannot_mint_editor(self):
        self.ds.allow_site_editor_delegation = True
        self.ds.save()
        self._login(self.editor)
        res = self._post(role="editor", site_ids=[str(self.ams.id)],
                         user_ids=[self.target.id])
        self.assertEqual(res.status_code, 403)

    def test_delegation_on_editor_cannot_reach_other_site(self):
        self.ds.allow_site_editor_delegation = True
        self.ds.save()
        self._login(self.editor)
        res = self._post(role="viewer", site_ids=[str(self.lon.id)],
                         user_ids=[self.target.id])
        self.assertEqual(res.status_code, 403)

    def test_admin_unaffected_by_flag(self):
        self.ds.allow_site_editor_delegation = False
        self.ds.save()
        admin = User.objects.create_user("a", password="x", is_superuser=True)
        UserProfile.objects.create(user=admin).tenants.add(self.tenant)
        self._login(admin)
        res = self._post(role="editor", site_ids=[str(self.lon.id)],
                         user_ids=[self.target.id])
        self.assertEqual(res.status_code, 201)


class NullSiteVisibilityTests(TestCase):
    """The NULL-site rule: a site-scoped grant can VIEW shared (site=None)
    rows — they're context everyone needs — but never write them. VLANs are
    site-scoped now (``vlan`` joined SITE_PATHS)."""

    def setUp(self):
        org = Organization.objects.create(name="ON", slug="on")
        self.tenant = Tenant.objects.create(org=org, name="TN", slug="tn")
        self.ams = Site.objects.create(tenant=self.tenant, name="AMS")
        self.lon = Site.objects.create(tenant=self.tenant, name="LON")
        st = status_for(self.tenant)
        Prefix.objects.create(tenant=self.tenant, cidr="10.1.0.0/24", site=self.ams, status=st)
        Prefix.objects.create(tenant=self.tenant, cidr="10.2.0.0/24", site=self.lon, status=st)
        Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/8", status=st)  # shared
        VLAN.objects.create(tenant=self.tenant, vlan_id=10, name="v-ams", site=self.ams)
        VLAN.objects.create(tenant=self.tenant, vlan_id=20, name="v-lon", site=self.lon)
        VLAN.objects.create(tenant=self.tenant, vlan_id=30, name="v-shared")  # no site
        self.user = User.objects.create_user("nsu")
        UserProfile.objects.create(user=self.user).tenants.add(self.tenant)
        p = ObjectPermission.objects.create(
            name="ams-scoped", object_types=["prefix", "vlan"],
            actions=["view", "add", "change", "delete"],
        )
        p.users.add(self.user)
        p.sites.set([self.ams])

    def _vals(self, model, slug, action, field):
        qs = rbac.restrict_queryset(
            model.objects.all(), self.user, self.tenant, slug, action
        )
        return set(qs.values_list(field, flat=True))

    def test_view_includes_shared_null_site_rows(self):
        self.assertEqual(
            self._vals(Prefix, "prefix", "view", "cidr"),
            {"10.1.0.0/24", "10.0.0.0/8"},  # own site + shared, not LON
        )

    def test_writes_exclude_shared_null_site_rows(self):
        self.assertEqual(self._vals(Prefix, "prefix", "change", "cidr"), {"10.1.0.0/24"})
        self.assertEqual(self._vals(Prefix, "prefix", "delete", "cidr"), {"10.1.0.0/24"})

    def test_vlan_is_site_scoped_with_shared_read(self):
        self.assertEqual(self._vals(VLAN, "vlan", "view", "name"), {"v-ams", "v-shared"})
        self.assertEqual(self._vals(VLAN, "vlan", "change", "name"), {"v-ams"})

    def test_site_slug_itself_has_no_null_arm(self):
        # The `site` slug's path is `id` (never NULL) — a scoped view grant on
        # sites must not open every site via a vacuous isnull clause.
        p = ObjectPermission.objects.create(
            name="site-view", object_types=["site"], actions=["view"]
        )
        p.users.add(self.user)
        p.sites.set([self.ams])
        qs = rbac.restrict_queryset(
            Site.objects.all(), self.user, self.tenant, "site", "view"
        )
        self.assertEqual(set(qs.values_list("name", flat=True)), {"AMS"})


class RbacActionMapTests(TestCase):
    """`rbac_action_map` lets a viewset declare the true action of a custom
    @action (bulk-delete needs `delete`, bulk-create needs `add`)."""

    def test_map_overrides_default_change(self):
        from auth_api.drf import _action_for

        class _Req:
            method = "POST"

        class _View:
            rbac_action_map = {"bulk_delete": "delete", "bulk_create": "add"}
            action = "bulk_delete"

        v = _View()
        self.assertEqual(_action_for(v, _Req()), "delete")
        v.action = "bulk_create"
        self.assertEqual(_action_for(v, _Req()), "add")
        v.action = "some_other_write"  # unmapped → the old default
        self.assertEqual(_action_for(v, _Req()), "change")


class MeSeparationPayloadTests(APITestCase):
    """/api/me carries site_separation + editable_sites for the SPA."""

    def setUp(self):
        from core.models import DeploymentSettings

        org = Organization.objects.create(name="OM", slug="om")
        self.tenant = Tenant.objects.create(org=org, name="TM", slug="tm")
        self.site = Site.objects.create(tenant=self.tenant, name="S1")
        self.user = User.objects.create_user("meu", password="x")
        UserProfile.objects.create(user=self.user).tenants.add(self.tenant)
        p = ObjectPermission.objects.create(
            name="s1-edit", object_types=["device"],
            actions=["view", "add", "change"],
        )
        p.users.add(self.user)
        p.sites.set([self.site])
        dep = DeploymentSettings.load()
        dep.enhanced_site_separation = True
        dep.save()

    def _me(self):
        self.client.force_login(self.user)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")
        return self.client.get("/api/me/").json()

    def test_site_scoped_user_payload(self):
        me = self._me()
        self.assertTrue(me["site_separation"])
        self.assertEqual(me["editable_sites"], [str(self.site.id)])

    def test_unscoped_user_sees_all(self):
        ObjectPermission.objects.get(name="s1-edit").sites.clear()
        me = self._me()
        self.assertEqual(me["editable_sites"], "all")

    def test_superuser_sees_all_flag_off(self):
        from core.models import DeploymentSettings

        dep = DeploymentSettings.load()
        dep.enhanced_site_separation = False
        dep.save()
        su = User.objects.create_user("root", password="x", is_superuser=True)
        UserProfile.objects.create(user=su).tenants.add(self.tenant)
        self.client.force_login(su)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")
        me = self.client.get("/api/me/").json()
        self.assertFalse(me["site_separation"])
        self.assertEqual(me["editable_sites"], "all")
