"""An all-digit query matches numid - the short id printed on labels finds
its object, including cables (which have no name to search by)."""
from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import Cable, Device


class NumidSearchTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        admin = User.objects.create_superuser("nsr", "n@x", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _hit_ids(self, group, q):
        r = self.client.get(f"/api/search/?q={q}")
        self.assertEqual(r.status_code, 200, r.content)
        return [h["id"] for h in r.json()["groups"][group]]

    def test_device_found_by_short_id(self):
        dev = Device.objects.create(tenant=self.tenant, name="edge-fw")
        dev.refresh_from_db()
        self.assertIsNotNone(dev.numid)
        self.assertIn(str(dev.id), self._hit_ids("devices", dev.numid))

    def test_cable_found_by_short_id(self):
        cable = Cable.objects.create(tenant=self.tenant)
        cable.refresh_from_db()
        self.assertIsNotNone(cable.numid)
        self.assertIn(str(cable.id), self._hit_ids("cables", cable.numid))

    def test_digits_in_names_still_match(self):
        dev = Device.objects.create(tenant=self.tenant, name="rack42-sw")
        self.assertIn(str(dev.id), self._hit_ids("devices", "42"))
