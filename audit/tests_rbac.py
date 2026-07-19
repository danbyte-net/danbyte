"""Audit + journal reads respect the caller's per-type view grants — a member
who can't view devices must not read device change history. (Secops #5.)"""
from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.models import Device, Prefix
from api.test_utils import status_for
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant


class AuditRbacTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="One", slug="one")
        # Two audited objects of different types.
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/24", status=status_for(self.tenant)
        )
        self.device = Device.objects.create(tenant=self.tenant, name="dev-1")

        # A member granted view on prefixes only.
        self.user = User.objects.create_user("m", password="x")
        UserProfile.objects.create(user=self.user).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="prefix view", object_types=["prefix"], actions=["view"]
        )
        perm.users.add(self.user)
        perm.tenants.add(self.tenant)

        self.client.force_login(self.user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _types(self, url):
        rows = self.client.get(url).json()["results"]
        return {r["object_type"] for r in rows}

    def test_changelog_scoped_to_viewable_types(self):
        types = self._types("/api/changelog/?page_size=200")
        self.assertIn("api.prefix", types)
        self.assertNotIn("api.device", types)

    def test_superuser_sees_all_changelog_types(self):
        su = User.objects.create_user("su", password="x", is_superuser=True)
        UserProfile.objects.create(user=su).tenants.add(self.tenant)
        self.client.force_login(su)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        types = self._types("/api/changelog/?page_size=200")
        self.assertIn("api.device", types)
