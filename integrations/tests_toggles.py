"""Every integration toggle is actually savable.

A ``ModelSerializer`` drops a field it was not told about **silently**: the
switch renders, the PUT returns 200, the toast says saved, and nothing was
written. That is how ``zabbix_enabled`` shipped as a dead control. These hold
the registry and the API shape together so it cannot happen to the next one.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .connections_api import IntegrationSettingsSerializer
from .models import IntegrationSettings
from .toggles import ANY_OF, KEYS, integration_enabled


class RegistryShapeTests(APITestCase):
    def test_every_toggle_key_maps_to_a_real_model_field(self):
        fields = {f.name for f in IntegrationSettings._meta.get_fields()}
        for key, field in KEYS.items():
            self.assertIn(field, fields, f"{key} names a field that is gone")

    def test_every_toggle_is_writable_through_the_api(self):
        """The one that bit us: a key in the registry with no serializer field
        is a switch in the UI that saves nothing."""
        self.assertEqual(
            set(KEYS.values()), set(IntegrationSettingsSerializer.Meta.fields)
        )

    def test_an_umbrella_key_names_real_members(self):
        for members in ANY_OF.values():
            for member in members:
                self.assertIn(member, KEYS)


class ToggleApiTests(APITestCase):
    URL = "/api/integrations/settings/"

    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.user = get_user_model().objects.create_superuser("admin", "a@b.c", "pw")
        self.client.force_login(self.user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def test_each_toggle_round_trips(self):
        for key, field in KEYS.items():
            with self.subTest(key=key):
                r = self.client.put(self.URL, {field: True}, format="json")
                self.assertEqual(r.status_code, 200, r.data)
                self.assertIs(r.data.get(field), True, f"{field} was dropped")
                self.assertTrue(
                    integration_enabled(
                        Tenant.objects.get(pk=self.tenant.pk), key
                    )
                )
                self.client.put(self.URL, {field: False}, format="json")

    def test_a_toggle_starts_off(self):
        r = self.client.get(self.URL)
        self.assertEqual(r.status_code, 200)
        self.assertFalse(any(r.data.values()))
