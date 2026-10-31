"""Tag ids on the hand-written bulk paths (#456).

Interface bulk create and the bulk updates take ``tag_ids`` /
``add_tag_ids`` without a serializer. They must check them as the
``tag_ids`` field does: ids only, of tags the active tenant may use, with
site-local tags fenced for site-scoped users. A string must never reach the
tag manager, which would make it the name of a new, tenant-less tag."""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.models import Device, DeviceType, Interface, Manufacturer, Prefix, Site
from api.test_utils import status_for
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tag, Tenant


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="A", slug="a")
        self.other = Tenant.objects.create(org=org, name="B", slug="b")
        self.site_a = Site.objects.create(tenant=self.tenant, name="SA")
        self.site_b = Site.objects.create(tenant=self.tenant, name="SB")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="M", slug="m")
        self.dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="X")
        self.device = Device.objects.create(
            tenant=self.tenant, name="sw1", device_type=self.dt, site=self.site_a
        )
        self.mine = Tag.objects.create(tenant=self.tenant, name="core", slug="core")
        self.glob = Tag.objects.create(tenant=None, name="legacy", slug="legacy")
        self.foreign = Tag.objects.create(tenant=self.other, name="theirs", slug="theirs")
        self.local_b = Tag.objects.create(
            tenant=self.tenant, name="b-only", slug="b-only", owning_site=self.site_b
        )

    def _login_admin(self):
        su = User.objects.create_superuser("su", password="x")
        UserProfile.objects.create(user=su).tenants.add(self.tenant)
        self.client.force_login(su)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")

    def _bulk_create(self, tag_ids, names=("eth0", "eth1")):
        return self.client.post(
            "/api/interfaces/bulk-create/",
            {"device_id": str(self.device.id), "names": list(names), "tag_ids": tag_ids},
            format="json",
        )


class InterfaceBulkCreateTagTests(_Base):
    def setUp(self):
        super().setUp()
        self._login_admin()

    def test_integer_ids_tag_every_interface(self):
        # The page's own payload: numeric ids.
        r = self._bulk_create([self.mine.id, self.glob.id])
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["created"], 2)
        for iface in Interface.objects.filter(device=self.device):
            self.assertEqual(
                set(iface.tags.values_list("pk", flat=True)), {self.mine.id, self.glob.id}
            )

    def test_names_are_refused_and_no_tag_is_created(self):
        before = Tag.objects.count()
        r = self._bulk_create(["new-global", "core"])
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("tag_ids", r.json())
        self.assertEqual(Tag.objects.count(), before)
        self.assertFalse(Tag.objects.filter(name="new-global").exists())
        self.assertFalse(Interface.objects.filter(device=self.device).exists())

    def test_foreign_tenant_tag_is_refused(self):
        r = self._bulk_create([self.mine.id, self.foreign.id])
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("tag_ids", r.json())
        self.assertFalse(Interface.objects.filter(device=self.device).exists())

    def test_unknown_id_is_refused(self):
        r = self._bulk_create([987654])
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("tag_ids", r.json())

    def test_not_a_list_is_refused(self):
        r = self._bulk_create("core")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(Tag.objects.filter(tenant__isnull=True).count(), 1)

    def test_no_tags_still_works(self):
        r = self._bulk_create([])
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["created"], 2)


class BulkUpdateTagTests(_Base):
    def setUp(self):
        super().setUp()
        self._login_admin()
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/24", status=status_for(self.tenant)
        )
        self.iface = Interface.objects.create(device=self.device, name="eth9")

    def _update(self, url, pk, fields):
        return self.client.post(url, {"ids": [str(pk)], "fields": fields}, format="json")

    def test_prefix_foreign_tag_is_refused(self):
        r = self._update(
            "/api/prefixes/bulk-update/", self.prefix.id, {"add_tag_ids": [self.foreign.id]}
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("add_tag_ids", r.json())
        self.assertFalse(self.prefix.tags.exists())

    def test_prefix_tag_name_is_refused_without_creating_it(self):
        before = Tag.objects.count()
        r = self._update(
            "/api/prefixes/bulk-update/", self.prefix.id, {"add_tag_ids": ["sneaky"]}
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(Tag.objects.count(), before)

    def test_prefix_own_and_global_tags_apply(self):
        r = self._update(
            "/api/prefixes/bulk-update/", self.prefix.id,
            {"add_tag_ids": [self.mine.id, self.glob.id]},
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(
            set(self.prefix.tags.values_list("pk", flat=True)), {self.mine.id, self.glob.id}
        )

    def test_component_bulk_update_foreign_tag_is_refused(self):
        r = self._update(
            "/api/interfaces/bulk-update/", self.iface.id, {"add_tag_ids": [self.foreign.id]}
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("add_tag_ids", r.json())
        self.assertFalse(self.iface.tags.exists())

    def test_remove_with_a_name_is_not_a_server_error(self):
        self.prefix.tags.add(self.mine)
        r = self._update(
            "/api/prefixes/bulk-update/", self.prefix.id, {"remove_tag_ids": ["core"]}
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(list(self.prefix.tags.all()), [self.mine])


class SiteLocalTagFenceTests(_Base):
    """Under enhanced site separation a site-scoped user may not attach
    another site's local tag, as the single interface create refuses it."""

    def setUp(self):
        from core.models import DeploymentSettings

        super().setUp()
        dep = DeploymentSettings.load()
        dep.enhanced_site_separation = True
        dep.save()
        self.local_a = Tag.objects.create(
            tenant=self.tenant, name="a-only", slug="a-only", owning_site=self.site_a
        )
        user = User.objects.create_user("site-a", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        grant = ObjectPermission.objects.create(
            name="site-a", object_types=["interface", "device", "tag"],
            actions=["view", "add", "change"],
        )
        grant.users.add(user)
        grant.sites.set([self.site_a])
        self.client.force_login(user)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")

    def test_own_site_and_tenant_tags_apply(self):
        r = self._bulk_create([self.local_a.id, self.mine.id])
        self.assertEqual(r.status_code, 200, r.content)
        iface = Interface.objects.get(device=self.device, name="eth0")
        self.assertEqual(
            set(iface.tags.values_list("pk", flat=True)), {self.local_a.id, self.mine.id}
        )

    def test_other_sites_local_tag_is_refused(self):
        r = self._bulk_create([self.local_b.id])
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("tag_ids", r.json())
        self.assertFalse(Interface.objects.filter(device=self.device).exists())
