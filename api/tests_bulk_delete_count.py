"""A bulk delete reports the objects asked about and logs each once - not
every row the database removed along with them (check history)."""
from __future__ import annotations

from datetime import timedelta

from django.contrib.auth.models import User
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import IPAddress, Prefix
from api.test_utils import status_for
from audit.models import ChangeLogEntry
from auth_api.models import UserProfile
from core.models import Organization, Tenant
from monitoring.models import CheckState, CheckTemplate, StateTransition


class BulkDeleteCountTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        pfx = Prefix.objects.create(tenant=self.tenant, cidr="10.9.0.0/24",
                                    status=status_for(self.tenant))
        ping = CheckTemplate.objects.create(tenant=self.tenant, name="Ping", slug="ping",
                                            kind="icmp")
        self.ips = []
        for n in (1, 2):
            ip = IPAddress.objects.create(tenant=self.tenant, ip_address=f"10.9.0.{n}",
                                          prefix=pfx)
            CheckState.objects.create(tenant=self.tenant, target_ip=ip, template=ping,
                                      kind="icmp", status="up")
            for k in range(25):  # history that cascades with the address
                StateTransition.objects.create(
                    tenant=self.tenant, target_ip=ip, template=ping, kind="icmp",
                    from_status="up", to_status="down" if k % 2 else "up",
                    at=timezone.now() - timedelta(minutes=k),
                )
            self.ips.append(ip)
        admin = User.objects.create_user("a", password="x", is_superuser=True)
        UserProfile.objects.create(user=admin).tenants.add(self.tenant)
        self.client.force_login(admin)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")

    def test_two_addresses_read_as_two_and_log_once(self):
        r = self.client.post("/api/ips/bulk-delete/",
                             {"ids": [str(i.id) for i in self.ips]}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["deleted"], 2)
        self.assertFalse(IPAddress.objects.filter(pk__in=[i.pk for i in self.ips]).exists())
        for ip in self.ips:
            self.assertEqual(
                ChangeLogEntry.objects.filter(object_type="api.ipaddress", object_id=str(ip.pk),
                                              action="delete").count(),
                1,
            )
