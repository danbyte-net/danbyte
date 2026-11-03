"""MACsec on interfaces: the fields round-trip, the keychain stays in the
tenant and never carries its key, and the settings need MACsec on."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from api.models import Device, DeviceType, Interface, Manufacturer, Site
from core.models import Organization, Tenant
from routing.models import RoutingKeychain

User = get_user_model()


class InterfaceMacsecTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        other = Tenant.objects.create(org=org, name="Other", slug="other")
        site = Site.objects.create(tenant=self.tenant, name="DC1")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="M", slug="m")
        dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="X")
        self.dev = Device.objects.create(
            tenant=self.tenant, name="leaf1", device_type=dt, site=site
        )
        self.eth = Interface.objects.create(device=self.dev, name="eth0")
        self.eth1 = Interface.objects.create(device=self.dev, name="eth1")
        self.kc = RoutingKeychain.objects.create(tenant=self.tenant, name="MKA-1")
        self.foreign_kc = RoutingKeychain.objects.create(tenant=other, name="MKA-X")
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _patch(self, iface, **data):
        return self.client.patch(f"/api/interfaces/{iface.id}/", data, format="json")

    def _bulk(self, fields, ids=None):
        return self.client.post(
            "/api/interfaces/bulk-update/",
            {"ids": [str(i.id) for i in (ids or [self.eth])], "fields": fields},
            format="json",
        )

    def test_round_trip(self):
        r = self._patch(
            self.eth, macsec_enabled=True, macsec_cipher="gcm-aes-xpn-256",
            macsec_keychain_id=str(self.kc.id), macsec_replay_window=64,
        )
        self.assertEqual(r.status_code, 200, r.content)
        body = self.client.get(f"/api/interfaces/{self.eth.id}/").json()
        self.assertTrue(body["macsec_enabled"])
        self.assertEqual(body["macsec_cipher"], "gcm-aes-xpn-256")
        self.assertEqual(body["macsec_cipher_display"], "GCM-AES-XPN-256")
        self.assertEqual(body["macsec_replay_window"], 64)
        self.assertEqual(
            body["macsec_keychain"],
            {"id": str(self.kc.id), "name": "MKA-1", "algorithm": self.kc.algorithm},
        )
        self.assertNotIn("macsec_keychain_id", body)

    def test_defaults(self):
        body = self.client.get(f"/api/interfaces/{self.eth.id}/").json()
        self.assertFalse(body["macsec_enabled"])
        self.assertEqual(body["macsec_cipher"], "")
        self.assertIsNone(body["macsec_keychain"])
        self.assertIsNone(body["macsec_replay_window"])

    def test_create_with_macsec(self):
        r = self.client.post("/api/interfaces/", {
            "device_id": str(self.dev.id), "name": "eth9", "macsec_enabled": True,
            "macsec_cipher": "gcm-aes-128", "macsec_keychain_id": str(self.kc.id),
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        i = Interface.objects.get(pk=r.json()["id"])
        self.assertEqual(i.macsec_keychain_id, self.kc.id)

    def test_foreign_keychain_is_refused(self):
        r = self._patch(
            self.eth, macsec_enabled=True, macsec_keychain_id=str(self.foreign_kc.id)
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("macsec_keychain_id", r.json())
        self.eth.refresh_from_db()
        self.assertIsNone(self.eth.macsec_keychain_id)

    def test_foreign_keychain_is_refused_in_bulk(self):
        r = self._bulk({
            "macsec_enabled": True, "macsec_keychain_id": str(self.foreign_kc.id),
        })
        self.assertEqual(r.status_code, 400)
        self.eth.refresh_from_db()
        self.assertIsNone(self.eth.macsec_keychain_id)

    def test_unknown_cipher_is_refused(self):
        r = self._patch(self.eth, macsec_enabled=True, macsec_cipher="rot13")
        self.assertEqual(r.status_code, 400)
        self.assertIn("macsec_cipher", r.json())
        r = self._bulk({"macsec_enabled": True, "macsec_cipher": "rot13"})
        self.assertEqual(r.status_code, 400)

    def test_settings_need_macsec_on(self):
        for field, value in (
            ("macsec_cipher", "gcm-aes-128"),
            ("macsec_keychain_id", str(self.kc.id)),
            ("macsec_replay_window", 0),
        ):
            r = self._patch(self.eth, **{field: value})
            self.assertEqual(r.status_code, 400, field)
            self.assertIn(field, r.json())

    def test_turning_off_clears_the_settings(self):
        self._patch(
            self.eth, macsec_enabled=True, macsec_cipher="gcm-aes-256",
            macsec_keychain_id=str(self.kc.id), macsec_replay_window=32,
        )
        r = self._patch(self.eth, macsec_enabled=False)
        self.assertEqual(r.status_code, 200, r.content)
        self.eth.refresh_from_db()
        self.assertEqual(self.eth.macsec_cipher, "")
        self.assertIsNone(self.eth.macsec_keychain_id)
        self.assertIsNone(self.eth.macsec_replay_window)

    def test_model_save_clears_when_off(self):
        self.eth.macsec_cipher = "gcm-aes-256"
        self.eth.macsec_keychain = self.kc
        self.eth.save()
        self.eth.refresh_from_db()
        self.assertEqual(self.eth.macsec_cipher, "")
        self.assertIsNone(self.eth.macsec_keychain_id)

    def test_deleting_the_keychain_clears_the_reference(self):
        self._patch(self.eth, macsec_enabled=True, macsec_keychain_id=str(self.kc.id))
        self.kc.delete()
        self.eth.refresh_from_db()
        self.assertTrue(self.eth.macsec_enabled)
        self.assertIsNone(self.eth.macsec_keychain_id)

    def test_bulk(self):
        r = self._bulk({
            "macsec_enabled": True, "macsec_cipher": "gcm-aes-256",
            "macsec_keychain_id": str(self.kc.id), "macsec_replay_window": 0,
        }, ids=[self.eth, self.eth1])
        self.assertEqual(r.status_code, 200, r.content)
        self.eth.refresh_from_db()
        self.assertEqual(self.eth.macsec_keychain_id, self.kc.id)
        self.assertEqual(self.eth.macsec_replay_window, 0)

        # A detail alone only lands where MACsec is already on.
        Interface.objects.filter(pk=self.eth1.pk).update(
            macsec_enabled=False, macsec_cipher="", macsec_keychain=None
        )
        r = self._bulk({"macsec_cipher": "gcm-aes-128"}, ids=[self.eth, self.eth1])
        self.assertEqual(r.status_code, 400)
        r = self._bulk({"macsec_cipher": "gcm-aes-128"}, ids=[self.eth])
        self.assertEqual(r.status_code, 200, r.content)

        # Off with a detail is refused; off alone clears.
        r = self._bulk({"macsec_enabled": False, "macsec_cipher": "gcm-aes-128"})
        self.assertEqual(r.status_code, 400)
        r = self._bulk({"macsec_enabled": False})
        self.assertEqual(r.status_code, 200, r.content)
        self.eth.refresh_from_db()
        self.assertFalse(self.eth.macsec_enabled)
        self.assertEqual(self.eth.macsec_cipher, "")
        self.assertIsNone(self.eth.macsec_keychain_id)
        self.assertIsNone(self.eth.macsec_replay_window)
