"""A tenant's own names for the six check states."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from api.models import Status
from api.status_registry import MONITORING_STATE_VALUES
from core.models import Organization, Tenant

from .models import CheckStatus
from .status_labels import status_labels, status_options


class RegistryParityTests(APITestCase):
    def test_registry_matches_the_check_status_enum(self):
        """``api`` cannot import ``monitoring``, so the state list is written
        out twice. If they drift, a status can claim a state that no check
        ever ends in - or miss one that does."""
        self.assertEqual(
            MONITORING_STATE_VALUES, {c.value for c in CheckStatus}
        )


class StatusLabelBase(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        self.other = Tenant.objects.create(org=self.org, name="Beta", slug="beta")
        self.user = get_user_model().objects.create_superuser("admin", "a@b.c", "pw")
        self.client.force_login(self.user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def make(self, tenant, name, slug, state, color="#dc2626"):
        return Status.objects.create(
            tenant=tenant, name=name, slug=slug, color=color,
            monitoring_state=state,
        )


class ResolverTests(StatusLabelBase):
    def test_only_claimed_states_are_returned(self):
        self.make(self.tenant, "Critical", "critical", "down")
        labels = status_labels(self.tenant)
        self.assertEqual(list(labels), ["down"])
        self.assertEqual(labels["down"]["name"], "Critical")
        self.assertEqual(labels["down"]["color"], "#dc2626")
        # text_color comes from the shared luminance helper, so a badge painted
        # in the tenant's colour stays readable without the client guessing.
        self.assertEqual(labels["down"]["text_color"], "#fff")

    def test_another_tenants_names_do_not_leak(self):
        self.make(self.other, "Kaput", "kaput", "down")
        self.assertEqual(status_labels(self.tenant), {})

    def test_a_plain_status_claims_nothing(self):
        Status.objects.create(tenant=self.tenant, name="Active", slug="active")
        self.assertEqual(status_labels(self.tenant), {})

    def test_options_fall_back_to_the_shipped_names(self):
        self.make(self.tenant, "Critical", "critical", "down")
        opts = status_options(self.tenant, ["up", "degraded", "down"])
        self.assertEqual([o["value"] for o in opts], ["up", "degraded", "down"])
        self.assertEqual(opts[0]["label"], "Up")
        self.assertEqual(opts[0]["color"], "")
        self.assertEqual(opts[2]["label"], "Critical")
        self.assertEqual(opts[2]["color"], "#dc2626")

    def test_options_for_no_tenant_are_the_shipped_six(self):
        opts = status_options(None)
        self.assertEqual(len(opts), 6)
        self.assertTrue(all(o["color"] == "" for o in opts))


class EndpointTests(StatusLabelBase):
    URL = "/api/monitoring/status-labels/"

    def test_endpoint_serves_the_active_tenants_names(self):
        self.make(self.tenant, "Critical", "critical", "down")
        r = self.client.get(self.URL)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.data["labels"]["down"]["name"], "Critical")

    def test_endpoint_needs_a_session(self):
        self.client.logout()
        self.assertEqual(self.client.get(self.URL).status_code, 401)


class StatusApiTests(StatusLabelBase):
    URL = "/api/statuses/"

    def test_a_status_can_claim_a_state(self):
        r = self.client.post(
            self.URL,
            {"name": "Critical", "color": "#dc2626", "monitoring_state": "down"},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.data)
        self.assertEqual(r.data["monitoring_state"], "down")

    def test_a_second_claimant_is_refused_by_name(self):
        self.make(self.tenant, "Critical", "critical", "down")
        r = self.client.post(
            self.URL, {"name": "Outage", "monitoring_state": "down"}, format="json"
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("Critical", str(r.data["monitoring_state"]))

    def test_another_tenants_claim_is_not_a_clash(self):
        self.make(self.other, "Critical", "critical", "down")
        r = self.client.post(
            self.URL, {"name": "Outage", "monitoring_state": "down"}, format="json"
        )
        self.assertEqual(r.status_code, 201, r.data)

    def test_a_status_may_keep_its_own_state_on_edit(self):
        s = self.make(self.tenant, "Critical", "critical", "down")
        r = self.client.patch(
            f"{self.URL}{s.id}/",
            {"name": "Critical!", "monitoring_state": "down"},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.data)

    def test_an_unknown_state_is_refused(self):
        r = self.client.post(
            self.URL, {"name": "Wat", "monitoring_state": "sideways"}, format="json"
        )
        self.assertEqual(r.status_code, 400)

    def test_a_claim_can_be_released(self):
        s = self.make(self.tenant, "Critical", "critical", "down")
        r = self.client.patch(
            f"{self.URL}{s.id}/", {"monitoring_state": ""}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.data)
        s.refresh_from_db()
        self.assertEqual(s.monitoring_state, "")
        # …and the state is free for somebody else to take.
        r = self.client.post(
            self.URL, {"name": "Outage", "monitoring_state": "down"}, format="json"
        )
        self.assertEqual(r.status_code, 201, r.data)
