"""Milestone 11 tests — reverse-DNS enrichment (PTR → dns_name)."""
from __future__ import annotations

from unittest.mock import patch

from django.test import TestCase

from api.models import IPAddress, Prefix
from core.models import Organization, Tenant

from .models import CheckKind, CheckState, CheckTemplate, MonitoringSettings
from .worker import _sync_dns


from api.test_utils import status_for


class DnsSyncTests(TestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        self.prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/8", status=status_for(self.tenant, "container")
        )
        self.ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.5", prefix=self.prefix
        )
        self.template = CheckTemplate.objects.create(
            tenant=self.tenant, name="p", slug="p", kind=CheckKind.ICMP
        )

    def _state(self, status="up"):
        return CheckState.objects.create(
            tenant=self.tenant, target_ip=self.ip, template=self.template,
            kind="icmp", status=status,
        )

    def _cfg(self, **over):
        base = {
            "dns_sync": True,
            "dns_clear_on_missing": False,
            "dns_preserve_if_alive": True,
        }
        base.update(over)
        return {self.tenant.id: base}

    def test_disabled_does_nothing(self):
        st = self._state()
        with patch("monitoring.worker._resolve_ptrs") as r:
            _sync_dns([st], {self.tenant.id: {"dns_sync": False}})
            r.assert_not_called()

    def test_writes_resolved_name(self):
        st = self._state()
        with patch(
            "monitoring.worker.asyncio.run",
            return_value={"10.0.0.5": "host5.example.com"},
        ):
            _sync_dns([st], self._cfg())
        self.ip.refresh_from_db()
        self.assertEqual(self.ip.dns_name, "host5.example.com")

    def test_preserve_if_alive_keeps_name_on_miss(self):
        self.ip.dns_name = "old.example.com"
        self.ip.save()
        st = self._state(status="up")
        with patch("monitoring.worker.asyncio.run", return_value={"10.0.0.5": None}):
            _sync_dns([st], self._cfg(dns_preserve_if_alive=True))
        self.ip.refresh_from_db()
        self.assertEqual(self.ip.dns_name, "old.example.com")  # preserved

    def test_clear_on_missing_when_not_preserving(self):
        self.ip.dns_name = "old.example.com"
        self.ip.save()
        st = self._state(status="down")  # not alive → preserve doesn't apply
        with patch("monitoring.worker.asyncio.run", return_value={"10.0.0.5": None}):
            _sync_dns([st], self._cfg(dns_preserve_if_alive=True, dns_clear_on_missing=True))
        self.ip.refresh_from_db()
        self.assertEqual(self.ip.dns_name, "")  # cleared
