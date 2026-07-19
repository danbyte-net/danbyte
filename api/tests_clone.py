"""CloneableMixin — GET /<type>/<id>/clone/ returns a create-form seed that
carries the allowlisted context but drops identity/unique fields, is
tenant-scoped, and honours RBAC."""
from __future__ import annotations

from django.contrib.auth.models import User
from django.test import Client, TestCase

from api.models import Device, DeviceRole, DeviceType, Manufacturer, Prefix, Site
from api.test_utils import status_for
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tag, Tenant


def _switch(client, tenant):
    s = client.session
    s["current_tenant_id"] = str(tenant.id)
    s.save()


class CloneEndpointTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.a = Tenant.objects.create(org=org, name="A", slug="a")
        self.b = Tenant.objects.create(org=org, name="B", slug="b")
        self.site = Site.objects.create(tenant=self.a, name="dc-1")
        self.tag = Tag.objects.create(name="prod", slug="prod")
        self.prefix = Prefix.objects.create(
            tenant=self.a, cidr="10.1.0.0/24", status=status_for(self.a),
            site=self.site, description="core net",
        )
        self.prefix.tags.add(self.tag)
        # A device to clone (name/serial are identity).
        mfr = Manufacturer.objects.create(tenant=self.a, name="Acme", slug="acme")
        self.dtype = DeviceType.objects.create(
            tenant=self.a, manufacturer=mfr, name="X1", model="X1"
        )
        self.role = DeviceRole.objects.create(tenant=self.a, name="fw", slug="fw")
        self.device = Device.objects.create(
            tenant=self.a, name="fw-1", device_type=self.dtype, role=self.role,
            site=self.site, status=status_for(self.a),
            serial_number="SN-1", asset_tag="AT-1", description="edge fw",
        )
        # B's prefix — A must not be able to clone it.
        self.b_prefix = Prefix.objects.create(
            tenant=self.b, cidr="10.9.0.0/24", status=status_for(self.b)
        )

    def _su(self):
        su = User.objects.create_user("su", password="x", is_superuser=True)
        UserProfile.objects.create(user=su).tenants.add(self.a)
        c = Client()
        c.force_login(su)
        _switch(c, self.a)
        return c

    def _member(self, actions, obj_type):
        u = User.objects.create_user("m", password="x")
        UserProfile.objects.create(user=u, role="custom").tenants.add(self.a)
        perm = ObjectPermission.objects.create(
            name="grant", object_types=[obj_type], actions=actions
        )
        perm.users.add(u)
        c = Client()
        c.force_login(u)
        _switch(c, self.a)
        return c

    def test_prefix_clone_carries_context_drops_identity(self):
        c = self._su()
        r = c.get(f"/api/prefixes/{self.prefix.id}/clone/")
        self.assertEqual(r.status_code, 200, r.content)
        init = r.json()["initial"]
        # Carried: classification + description + tags + custom fields.
        self.assertEqual(init["description"], "core net")
        self.assertEqual(init["site"]["id"], str(self.site.id))
        self.assertEqual([t["slug"] for t in init["tags"]], ["prod"])
        self.assertIn("custom_fields", init)
        # Dropped: the unique CIDR, the id, and the human numid.
        self.assertNotIn("cidr", init)
        self.assertNotIn("id", init)
        self.assertNotIn("numid", init)

    def test_device_clone_drops_name_serial_asset(self):
        c = self._su()
        init = c.get(f"/api/devices/{self.device.id}/clone/").json()["initial"]
        self.assertEqual(init["device_type"]["id"], str(self.dtype.id))
        self.assertEqual(init["role"]["id"], str(self.role.id))
        for identity in ("name", "serial_number", "asset_tag", "id", "numid"):
            self.assertNotIn(identity, init)

    def test_clone_is_tenant_scoped(self):
        # Acting in A, cloning B's prefix must 404 (not found in scope).
        c = self._su()
        self.assertEqual(
            c.get(f"/api/prefixes/{self.b_prefix.id}/clone/").status_code, 404
        )

    def test_clone_requires_auth(self):
        # Default-closed DRF → 401 for the anonymous caller.
        self.assertEqual(
            Client().get(f"/api/prefixes/{self.prefix.id}/clone/").status_code, 401
        )

    def test_clone_allowed_for_viewer(self):
        # Clone is a read of a source the user can see; view is enough to fetch
        # the seed (the create is separately add-gated).
        c = self._member(["view"], "prefix")
        self.assertEqual(
            c.get(f"/api/prefixes/{self.prefix.id}/clone/").status_code, 200
        )

    def test_clone_denied_without_view(self):
        # view on device, not prefix → the type-level RBAC check denies (403)
        # before any object lookup.
        c = self._member(["view"], "device")
        self.assertEqual(
            c.get(f"/api/prefixes/{self.prefix.id}/clone/").status_code, 403
        )
