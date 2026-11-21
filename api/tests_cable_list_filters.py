"""The cable list's search box."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import (
    Cable,
    CableTermination,
    Device,
    Interface,
)

User = get_user_model()


class CableListFilterTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _dev(self, name):
        return Device.objects.create(tenant=self.tenant, name=name)

    def _cable(self, a, b, **kw):
        cable = Cable.objects.create(tenant=self.tenant, **kw)
        CableTermination.objects.create(cable=cable, end="A", **a)
        CableTermination.objects.create(cable=cable, end="B", **b)
        return cable

    def _ids(self, query):
        r = self.client.get(f"/api/cables/?{query}")
        self.assertEqual(r.status_code, 200, r.content)
        return {row["id"] for row in r.json()["results"]}

    def test_search_finds_a_cable_by_label(self):
        sw = self._dev("sw1")
        rtr = self._dev("rtr1")
        cable = self._cable(
            {"interface": Interface.objects.create(device=sw, name="Gi1")},
            {"interface": Interface.objects.create(device=rtr, name="Gi2")},
            label="TDC-F06", type="cat6",
        )
        self._cable(
            {"interface": Interface.objects.create(device=sw, name="Gi3")},
            {"interface": Interface.objects.create(device=rtr, name="Gi4")},
            label="other", type="cat6",
        )
        self.assertEqual(self._ids("search=TDC-F06"), {str(cable.id)})
        self.assertEqual(self._ids("search=tdc-f0"), {str(cable.id)})
        self.assertEqual(self._ids("search=TDC-F06&view=table"), {str(cable.id)})
