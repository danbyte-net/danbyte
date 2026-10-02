"""Bulk delete and bulk update check the ids they are given (#280): an id
that is not a UUID, or a body that is not an object, is a 400 that says so -
never a 500 from the database filter."""
from __future__ import annotations

from django.contrib.auth.models import User
from django.core.exceptions import ValidationError as DjangoValidationError
from django.test import SimpleTestCase
from rest_framework.test import APITestCase

from api.exception_handler import exception_handler
from api.models import Circuit, CircuitType, Provider
from auth_api.models import UserProfile
from core.models import Organization, Tenant

BULK_DELETE = (
    "/api/circuits/bulk-delete/",
    "/api/providers/bulk-delete/",
    "/api/virtual-chassis/bulk-delete/",
    "/api/wireless-lans/bulk-delete/",
    "/api/vlans/bulk-delete/",
    "/api/interfaces/bulk-delete/",
    "/api/prefixes/bulk-delete/",
    "/api/tenants/bulk-delete/",
    "/api/routing/prefix-lists/bulk-delete/",
    "/api/monitoring/watched-endpoints/bulk-delete/",
)
BULK_UPDATE = (
    "/api/virtual-chassis/bulk-update/",
    "/api/interfaces/bulk-update/",
    "/api/ips/bulk-update/",
    "/api/sites/bulk-update/",
    "/api/locations/bulk-update/",
)


class BulkIdsTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        admin = User.objects.create_user("a", password="x", is_superuser=True)
        UserProfile.objects.create(user=admin).tenants.add(self.tenant)
        self.client.force_login(admin)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")

    def test_an_id_that_is_not_one_is_a_400(self):
        for url in BULK_DELETE + BULK_UPDATE:
            with self.subTest(url=url):
                r = self.client.post(url, {"ids": ["nope"], "fields": {"description": "x"}},
                                     format="json")
                self.assertEqual(r.status_code, 400, r.content)
                self.assertEqual(r.json(), {"ids": "«nope» is not an id."})

    def test_a_body_that_is_not_an_object_is_a_400(self):
        for url in BULK_DELETE + BULK_UPDATE:
            with self.subTest(url=url):
                r = self.client.post(url, ["x"], format="json")
                self.assertEqual(r.status_code, 400, r.content)
                self.assertIn("ids", r.json())

    def test_real_ids_still_delete(self):
        provider = Provider.objects.create(tenant=self.tenant, name="P", slug="p")
        ctype = CircuitType.objects.create(tenant=self.tenant, name="Fibre", slug="fibre")
        circuit = Circuit.objects.create(tenant=self.tenant, cid="C-1", provider=provider,
                                         type=ctype)
        r = self.client.post("/api/circuits/bulk-delete/",
                             {"ids": [str(circuit.id).upper()]}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["deleted_ids"], [str(circuit.id)])


class DjangoValidationErrorTests(SimpleTestCase):
    def test_it_answers_400_with_the_message(self):
        r = exception_handler(DjangoValidationError("“nope” is not a valid UUID."), {})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.data, {"non_field_errors": ["“nope” is not a valid UUID."]})
