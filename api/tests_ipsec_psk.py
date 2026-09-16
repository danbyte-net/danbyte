"""An IPsec profile's pre-shared key lives in the secret store, never in the
row (#168) - the same arrangement as an SSID's PSK (#68), through the same
model, serializer and viewset mixins, so this module checks the profile's
side of that contract: reference only in the row, write-only in, audited
reveal out, refused without a store, gone with the profile.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from audit.models import ChangeAction, ChangeLogEntry
from core.models import DeploymentSettings, Organization, Tenant

from .models import IPSecProfile

User = get_user_model()


def _store(provider: str) -> None:
    ds = DeploymentSettings.load()
    ds.secrets_provider = provider
    ds.save(update_fields=["secrets_provider"])


class IPSecPSKTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("root", "r@a.c", "pw")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        _store("local")

    def _create(self, **extra):
        payload = {"name": "site-to-site", **extra}
        return self.client.post("/api/ipsec-profiles/", payload, format="json")

    def test_psk_is_stored_under_its_own_folder_and_never_read_back(self):
        r = self._create(psk="correct horse battery")
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertTrue(body["psk_set"])
        self.assertNotIn("psk", body)
        p = IPSecProfile.objects.get(pk=body["id"])
        self.assertNotIn("horse", str(p.__dict__))
        self.assertEqual(p.psk_secret_path, f"ipsec-profiles/{p.id}")
        self.assertEqual(p.psk_secret_provider, "local")
        for url in (f"/api/ipsec-profiles/{p.id}/", "/api/ipsec-profiles/",
                    "/api/ipsec-profiles/?picker=1"):
            self.assertNotIn("horse", self.client.get(url).content.decode())

    def test_reveal_returns_it_and_leaves_an_audit_trail(self):
        pid = self._create(psk="correct horse battery").json()["id"]
        r = self.client.post(f"/api/ipsec-profiles/{pid}/reveal-psk/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["psk"], "correct horse battery")
        entry = ChangeLogEntry.objects.filter(
            action=ChangeAction.REVEAL, object_id=str(pid)
        ).first()
        self.assertIsNotNone(entry)
        self.assertEqual(entry.object_label, "IPsec profile")
        self.assertEqual(entry.changes, {"revealed": "psk"})

    def test_without_a_secret_store_a_psk_is_refused_not_stored_in_the_clear(self):
        _store("")
        r = self._create(psk="correct horse battery")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("psk", r.json())
        self.assertFalse(IPSecProfile.objects.filter(name="site-to-site").exists())
        # A profile without a key is still fine to document.
        r = self._create()
        self.assertEqual(r.status_code, 201, r.content)
        self.assertFalse(r.json()["psk_set"])

    def test_blank_keeps_null_clears_and_a_new_value_rotates(self):
        pid = self._create(psk="first").json()["id"]
        r = self.client.patch(f"/api/ipsec-profiles/{pid}/",
                              {"description": "edited", "psk": ""}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()["psk_set"])
        self.client.patch(f"/api/ipsec-profiles/{pid}/", {"psk": "second"}, format="json")
        r = self.client.post(f"/api/ipsec-profiles/{pid}/reveal-psk/")
        self.assertEqual(r.json()["psk"], "second")
        r = self.client.patch(f"/api/ipsec-profiles/{pid}/", {"psk": None}, format="json")
        self.assertFalse(r.json()["psk_set"])
        p = IPSecProfile.objects.get(pk=pid)
        self.assertEqual((p.psk_secret_path, p.psk_secret_provider), ("", ""))
        r = self.client.post(f"/api/ipsec-profiles/{pid}/reveal-psk/")
        self.assertEqual(r.status_code, 400, r.content)

    def test_deleting_the_profile_takes_the_key_with_it(self):
        from monitoring.secret_store import active_secret_store

        pid = self._create(psk="correct horse battery").json()["id"]
        p = IPSecProfile.objects.get(pk=pid)
        path, tenant_id = p.psk_secret_path, p.tenant_id
        self.assertIsNotNone(active_secret_store().get(tenant_id, path))
        r = self.client.delete(f"/api/ipsec-profiles/{pid}/")
        self.assertEqual(r.status_code, 204, r.content)
        self.assertIsNone(active_secret_store().get(tenant_id, path))

    def test_the_two_kinds_of_key_do_not_share_a_folder(self):
        pid = self._create(psk="vpn-key").json()["id"]
        r = self.client.post("/api/wireless-lans/",
                             {"ssid": "corp", "auth_type": "wpa-personal", "psk": "wifi-key"},
                             format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(self.client.post(f"/api/ipsec-profiles/{pid}/reveal-psk/").json()["psk"], "vpn-key")
        self.assertEqual(self.client.post(f"/api/wireless-lans/{r.json()['id']}/reveal-psk/").json()["psk"], "wifi-key")
