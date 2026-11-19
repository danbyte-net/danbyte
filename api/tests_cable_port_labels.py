"""The cable form's port lists carry each port's label and description, at
a cost flat in the number of ports (#537)."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import (
    AuxPort,
    ConsolePort,
    ConsoleServerPort,
    Device,
    FrontPort,
    Interface,
    PowerOutlet,
    PowerPort,
    RearPort,
)

User = get_user_model()

#: endpoint -> (model, has a label)
KINDS = {
    "interfaces": (Interface, True),
    "front-ports": (FrontPort, True),
    "rear-ports": (RearPort, True),
    "console-ports": (ConsolePort, False),
    "console-server-ports": (ConsoleServerPort, False),
    "power-ports": (PowerPort, False),
    "power-outlets": (PowerOutlet, False),
    "aux-ports": (AuxPort, False),
}


class CablePortLabelTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.device = Device.objects.create(tenant=self.tenant, name="sw1")
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        self.n = 0

    def _grow(self, model, labelled, k):
        for _ in range(k):
            i = self.n
            self.n += 1
            kw = {"device": self.device, "name": f"p{i}", "description": f"desc {i}"}
            if labelled:
                kw["label"] = f"label {i}"
            if model is FrontPort:
                kw["rear_port"] = RearPort.objects.create(
                    device=self.device, name=f"r-for-{i}")
            model.objects.create(**kw)

    def _get(self, endpoint):
        url = f"/api/{endpoint}/?device={self.device.id}&page_size=500"
        self.client.get(url)
        with CaptureQueriesContext(connection) as ctx:
            r = self.client.get(url)
        self.assertEqual(r.status_code, 200, r.content)
        return len(ctx.captured_queries), r.json()["results"]

    def test_every_port_list_carries_label_and_description_flat(self):
        for endpoint, (model, labelled) in KINDS.items():
            with self.subTest(endpoint=endpoint):
                self._grow(model, labelled, 2)
                small, rows = self._get(endpoint)
                self._grow(model, labelled, 8)
                big, rows = self._get(endpoint)
                self.assertEqual(small, big, "more ports must not cost more queries")
                row = next(r for r in rows if r["name"].startswith("p"))
                self.assertTrue(row["description"].startswith("desc "))
                if labelled:
                    self.assertTrue(row["label"].startswith("label "))
