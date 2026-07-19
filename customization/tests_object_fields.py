"""Object-reference custom fields: registry endpoints, definition rules,
value validation against real rows, and bulk label resolution."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from api.models import Device
from core.models import Organization, Tenant
from .models import CustomField
from .object_registry import customizable_model_values

User = get_user_model()


class _Base(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        self.admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(self.admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()


class RegistryTests(_Base):
    def test_customizable_models_auto_derived(self):
        vals = customizable_model_values()
        # Everything with CustomFieldsMixin qualifies — including models the
        # old hand-kept list forgot (modules landed with the mixin).
        for slug in ("device", "prefix", "vlan", "moduletype", "rack"):
            self.assertIn(slug, vals)

    def test_meta_endpoint(self):
        data = self.client.get("/api/customization/meta/").json()
        models = {m["value"] for m in data["models"]}
        self.assertIn("device", models)
        refs = {r["value"]: r for r in data["reference_models"]}
        self.assertIn("user", refs)
        self.assertEqual(refs["user"]["label_field"], "username")
        self.assertEqual(refs["device"]["route"], "/devices/$id")


class DefinitionTests(_Base):
    def _post(self, **extra):
        payload = {
            "key": "owner",
            "label": "Owner",
            "type": "object",
            "applies_to": ["device"],
            **extra,
        }
        return self.client.post("/api/custom-fields/", payload, format="json")

    def test_object_field_requires_related_model(self):
        resp = self._post()
        self.assertEqual(resp.status_code, 400)
        self.assertIn("related_model", str(resp.content))

    def test_object_field_rejects_unknown_model(self):
        resp = self._post(related_model="flux-capacitor")
        self.assertEqual(resp.status_code, 400)

    def test_object_field_created(self):
        resp = self._post(related_model="user")
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(resp.json()["related_model"], "user")


class ValueTests(_Base):
    def setUp(self):
        super().setUp()
        CustomField.objects.create(
            tenant=self.tenant, key="owner", label="Owner", type="object",
            related_model="user", applies_to=["device"],
        )
        self.device = Device.objects.create(tenant=self.tenant, name="sw1")

    def _patch(self, value):
        return self.client.patch(
            f"/api/devices/{self.device.id}/",
            {"custom_fields": {"owner": value}},
            format="json",
        )

    def test_valid_reference_saves(self):
        resp = self._patch(str(self.admin.pk))
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(
            resp.json()["custom_fields"]["owner"], str(self.admin.pk)
        )

    def test_unknown_reference_rejected(self):
        resp = self._patch("999999")
        self.assertEqual(resp.status_code, 400)
        self.assertIn("No such user", str(resp.content))

    def test_malformed_pk_rejected(self):
        resp = self._patch("not-a-pk")
        self.assertEqual(resp.status_code, 400)


class LabelResolverTests(_Base):
    def test_bulk_labels(self):
        d = Device.objects.create(tenant=self.tenant, name="core-1")
        data = self.client.get(
            f"/api/customization/object-labels/?model=device&ids={d.id}"
        ).json()
        self.assertEqual(
            data["results"],
            [{"id": str(d.id), "label": "core-1",
              "route": f"/devices/{d.id}"}],
        )

    def test_tenant_scope(self):
        other_org = Organization.objects.create(name="Evil", slug="evil")
        other = Tenant.objects.create(org=other_org, name="Evil", slug="evil")
        d = Device.objects.create(tenant=other, name="theirs")
        data = self.client.get(
            f"/api/customization/object-labels/?model=device&ids={d.id}"
        ).json()
        self.assertEqual(data["results"], [])

    def test_users_resolve_globally(self):
        data = self.client.get(
            f"/api/customization/object-labels/?model=user&ids={self.admin.pk}"
        ).json()
        self.assertEqual(data["results"][0]["label"], "admin")


class TenantScopedReferenceTests(_Base):
    """Object-reference CFs whose target is tenant-scoped exercise the
    tenant-filter branch of _coerce — which raised NameError before the fix
    (secops 'other confirmed bugs')."""

    def setUp(self):
        super().setUp()
        CustomField.objects.create(
            tenant=self.tenant, key="peer", label="Peer device", type="object",
            related_model="device", applies_to=["device"],
        )
        self.device = Device.objects.create(tenant=self.tenant, name="sw1")
        self.peer = Device.objects.create(tenant=self.tenant, name="sw2")

    def _patch(self, value):
        return self.client.patch(
            f"/api/devices/{self.device.id}/",
            {"custom_fields": {"peer": value}},
            format="json",
        )

    def test_valid_tenant_scoped_reference_saves(self):
        resp = self._patch(str(self.peer.id))
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(
            resp.json()["custom_fields"]["peer"], str(self.peer.id)
        )

    def test_cross_tenant_reference_rejected(self):
        other_org = Organization.objects.create(name="Evil", slug="evil")
        other = Tenant.objects.create(org=other_org, name="Evil", slug="evil")
        theirs = Device.objects.create(tenant=other, name="theirs")
        resp = self._patch(str(theirs.id))
        self.assertEqual(resp.status_code, 400)
        self.assertIn("No such", str(resp.content))
