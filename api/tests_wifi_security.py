"""Wi-Fi security modes, cipher and PMF go together (#177)."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .tests_wireless_psk import _enable_local_store
from .wifi_security import problems

User = get_user_model()
URL = "/api/wireless-lans/"


class RuleTests(APITestCase):
    def test_what_fits_and_what_does_not(self):
        self.assertEqual(problems("wpa3-personal", "gcmp-256", "required", psk=True), {})
        self.assertEqual(problems("wpa2-wpa3-personal", "aes", "optional", psk=True), {})
        self.assertEqual(problems("owe", "aes", "required", psk=False), {})
        self.assertEqual(problems("", "", "", psk=False), {})
        self.assertIn("auth_cipher", problems("wpa3-personal", "tkip", "", psk=False))
        self.assertIn("auth_cipher", problems("wpa2-wpa3-personal", "gcmp-256", "", psk=False))
        self.assertIn("pmf", problems("wpa3-enterprise", "aes", "optional", psk=False))
        self.assertIn("pmf", problems("wpa2-wpa3-personal", "aes", "disabled", psk=False))
        self.assertIn("psk", problems("owe", "", "", psk=True))
        self.assertIn("psk", problems("wpa2-enterprise", "", "", psk=True))
        # The older values still stand.
        self.assertEqual(problems("wpa-personal", "tkip", "", psk=True), {})


class ApiTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("root", "r@a.c", "pw")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        _enable_local_store()

    def create(self, **body):
        return self.client.post(URL, {"ssid": "corp", **body}, format="json")

    def test_a_wpa3_network_with_its_passphrase(self):
        r = self.create(auth_type="wpa3-personal", auth_cipher="aes", pmf="required",
                        psk="correct horse battery")
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual((body["auth_type_display"], body["auth_cipher_display"], body["pmf"]),
                         ("WPA3-Personal (SAE)", "AES-CCMP", "required"))

    def test_nonsense_is_refused_by_field(self):
        r = self.create(auth_type="wpa3-personal", auth_cipher="tkip", pmf="disabled")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(set(r.json()), {"auth_cipher", "pmf"})
        r = self.create(auth_type="owe", psk="not for owe")
        self.assertEqual(r.status_code, 400)
        self.assertIn("psk", r.json())

    def test_switching_away_from_personal_needs_the_passphrase_cleared(self):
        wid = self.create(auth_type="wpa2-personal", psk="hunter2-hunter2").json()["id"]
        r = self.client.patch(f"{URL}{wid}/", {"auth_type": "wpa2-enterprise"}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("psk", r.json())
        r = self.client.patch(f"{URL}{wid}/", {"auth_type": "wpa2-enterprise", "psk": None},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(r.json()["psk_set"])

    def test_an_edit_that_keeps_the_mode_keeps_working(self):
        wid = self.create(auth_type="wpa2-personal", psk="hunter2-hunter2").json()["id"]
        r = self.client.patch(f"{URL}{wid}/", {"description": "HQ"}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        r = self.client.patch(f"{URL}{wid}/", {"pmf": "optional", "psk": ""}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()["psk_set"])
