"""Standalone monitoring endpoints respect RBAC, not just authentication —
a tenant member without ipaddress-view can't run/read checks. (Secops #4.)"""
from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.models import IPAddress, Prefix
from api.test_utils import status_for
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant


class MonitoringViewRbacTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="One", slug="one")
        pfx = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/24", status=status_for(self.tenant)
        )
        self.ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.5/24", prefix=pfx,
            status=status_for(self.tenant)
        )
        self.prefix = pfx
        self.user = User.objects.create_user("m", password="x")
        UserProfile.objects.create(user=self.user).tenants.add(self.tenant)
        # Granted something unrelated so they're a real tenant member.
        perm = ObjectPermission.objects.create(
            name="vlan view", object_types=["vlan"], actions=["view"]
        )
        perm.users.add(self.user)
        perm.tenants.add(self.tenant)
        self.client.force_login(self.user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_check_now_denied_without_ip_view(self):
        # Row-scoped fetch: an IP the caller can't view 404s (non-leaking) rather
        # than 403 — the same contract restrict_for_view uses across the app, so
        # existence isn't confirmed to someone without access.
        self.assertEqual(
            self.client.post(f"/api/monitoring/ips/{self.ip.id}/check-now/").status_code,
            404,
        )

    def test_ip_checks_denied_without_ip_view(self):
        self.assertEqual(
            self.client.get(f"/api/monitoring/ips/{self.ip.id}/checks/").status_code,
            404,
        )

    def test_allowed_with_ip_view(self):
        perm = ObjectPermission.objects.create(
            name="ip view", object_types=["ipaddress"], actions=["view"]
        )
        perm.users.add(self.user)
        perm.tenants.add(self.tenant)
        self.assertEqual(
            self.client.get(f"/api/monitoring/ips/{self.ip.id}/checks/").status_code,
            200,
        )
