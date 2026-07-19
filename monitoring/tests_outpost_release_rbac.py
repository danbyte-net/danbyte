"""OutpostRelease is a deployment-global resource: a tenant-scoped admin must
not be able to list/upload/select the software pushed to every outpost.
(Secops audit finding #2 — supply-chain escalation.)"""
from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

URL = "/api/monitoring/outpost-releases/"


class OutpostReleaseRbacTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="One", slug="one")

    def _login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_tenant_scoped_admin_denied(self):
        u = User.objects.create_user("ta", password="x")
        UserProfile.objects.create(user=u).tenants.add(self.tenant)
        # A tenant-scoped change-user grant — passes can_manage_admin(tenant)
        # but must NOT pass the deployment gate on a global resource.
        perm = ObjectPermission.objects.create(
            name="tenant admin", object_types=["user"], actions=["change"]
        )
        perm.users.add(u)
        perm.tenants.add(self.tenant)
        self._login(u)
        self.assertEqual(self.client.get(URL).status_code, 403)
        self.assertEqual(
            self.client.post(URL, {"name": "evil"}, format="json").status_code,
            403,
        )

    def test_superuser_allowed(self):
        su = User.objects.create_user("su", password="x", is_superuser=True)
        UserProfile.objects.create(user=su).tenants.add(self.tenant)
        self._login(su)
        self.assertEqual(self.client.get(URL).status_code, 200)
