"""A binding PUT names its field or is refused.

``PUT {engine_id|profile_id|vrf_id}`` sets a binding and ``null`` clears it. A
body that leaves the field out, or sends ``""``, used to be read as "clear" too.
The site form wiped its bindings by sending an explicit clear it never meant
(#324); that is fixed in the client, and the server now also refuses the
partial bodies rather than read them as a reset. A profile change that leaves
out the poll-address override keeps the stored one.
"""
from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from api.models import VRF, Site
from core.models import Organization, Tenant
from monitoring.engines import binding_engine_id, set_binding
from monitoring.models import (
    MonitoringEngine,
    SnmpProfile,
    SnmpProfileBinding,
    SnmpVrfBinding,
)

User = get_user_model()


class BindingPayloadGuardTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "a@b.c", "pw")
        self.client.force_login(admin)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

        self.site = Site.objects.create(tenant=self.tenant, name="branch")
        self.engine = MonitoringEngine.objects.create(
            tenant=self.tenant, name="op", slug="op", kind="remote",
        )
        set_binding(self.tenant, "site", self.site.id, self.engine)
        self.profile = SnmpProfile.objects.create(
            tenant=self.tenant, name="Prod", slug="prod", version="v2c",
        )
        SnmpProfileBinding.objects.create(
            tenant=self.tenant, scope="site", object_id=self.site.id,
            profile=self.profile,
        )
        self.vrf = VRF.objects.create(tenant=self.tenant, name="mgmt")
        SnmpVrfBinding.objects.create(
            tenant=self.tenant, scope="site", object_id=self.site.id, vrf=self.vrf,
        )
        self.engine_url = f"/api/monitoring/engine-binding/site/{self.site.id}/"
        self.profile_url = f"/api/monitoring/snmp-binding/site/{self.site.id}/"
        self.vrf_url = f"/api/monitoring/snmp-vrf-binding/site/{self.site.id}/"

    def _put(self, url, body):
        return self.client.put(url, body, format="json")

    def _engine_binding(self):
        return binding_engine_id(self.tenant, "site", self.site.id)

    def _profile_binding(self):
        return SnmpProfileBinding.objects.filter(
            tenant=self.tenant, scope="site", object_id=self.site.id
        ).first()

    def _vrf_binding(self):
        return SnmpVrfBinding.objects.filter(
            tenant=self.tenant, scope="site", object_id=self.site.id
        ).first()

    # ── engine ──────────────────────────────────────────────────────────────

    def test_engine_binding_survives_a_body_without_the_field(self):
        r = self._put(self.engine_url, {})
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("engine_id", r.json())
        self.assertEqual(self._engine_binding(), str(self.engine.id))

    def test_engine_binding_survives_an_empty_string(self):
        r = self._put(self.engine_url, {"engine_id": ""})
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(self._engine_binding(), str(self.engine.id))

    def test_engine_binding_rejects_a_value_that_is_not_an_id(self):
        r = self._put(self.engine_url, {"engine_id": "not-an-id"})
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("engine_id", r.json())
        self.assertEqual(self._engine_binding(), str(self.engine.id))

    def test_engine_binding_null_still_clears(self):
        r = self._put(self.engine_url, {"engine_id": None})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIsNone(r.json()["engine_id"])
        self.assertIsNone(self._engine_binding())

    def test_engine_binding_still_sets(self):
        other = MonitoringEngine.objects.create(
            tenant=self.tenant, name="op2", slug="op2", kind="remote",
        )
        r = self._put(self.engine_url, {"engine_id": str(other.id)})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self._engine_binding(), str(other.id))

    # ── SNMP profile ────────────────────────────────────────────────────────

    def test_profile_binding_survives_a_body_without_the_field(self):
        r = self._put(self.profile_url, {})
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("profile_id", r.json())
        self.assertIsNotNone(self._profile_binding())

    def test_profile_binding_survives_an_empty_string(self):
        r = self._put(self.profile_url, {"profile_id": ""})
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIsNotNone(self._profile_binding())

    def test_profile_binding_null_still_clears(self):
        r = self._put(self.profile_url, {"profile_id": None})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIsNone(r.json()["profile_id"])
        self.assertIsNone(self._profile_binding())

    def test_profile_change_without_target_keeps_the_override(self):
        SnmpProfileBinding.objects.filter(
            tenant=self.tenant, scope="site", object_id=self.site.id
        ).update(target="10.9.9.9")
        other = SnmpProfile.objects.create(
            tenant=self.tenant, name="Lab", slug="lab", version="v2c",
        )
        r = self._put(self.profile_url, {"profile_id": str(other.id)})
        self.assertEqual(r.status_code, 200, r.content)
        b = self._profile_binding()
        self.assertEqual(b.profile_id, other.id)
        self.assertEqual(b.target, "10.9.9.9")

    def test_profile_change_with_target_sets_it(self):
        r = self._put(
            self.profile_url,
            {"profile_id": str(self.profile.id), "target": " 10.1.1.1 "},
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self._profile_binding().target, "10.1.1.1")

    # ── SNMP VRF ────────────────────────────────────────────────────────────

    def test_vrf_binding_survives_a_body_without_the_field(self):
        r = self._put(self.vrf_url, {})
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("vrf_id", r.json())
        self.assertIsNotNone(self._vrf_binding())

    def test_vrf_binding_survives_an_empty_string(self):
        r = self._put(self.vrf_url, {"vrf_id": ""})
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIsNotNone(self._vrf_binding())

    def test_vrf_binding_null_still_clears(self):
        r = self._put(self.vrf_url, {"vrf_id": None})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIsNone(r.json()["vrf_id"])
        self.assertIsNone(self._vrf_binding())
