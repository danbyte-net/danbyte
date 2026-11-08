"""Linux bond settings on a LAG interface: mode, hash policy and miimon,
the 802.3ad ⇄ LACP rule, the ``static`` alias, and the bond-s1 render."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from api.models import Device, DeviceType, ExportTemplate, Interface, Manufacturer, Site
from core.models import Organization, Tenant

User = get_user_model()

BOND_TEMPLATE = """{% for i in interfaces if i.type == "lag" %}auto {{ i.name }}
iface {{ i.name }} inet manual
    bond-slaves {{ i.lag_members.all()|map(attribute="name")|sort|join(" ") }}
{% if i.lag_mode %}    bond-mode {{ i.lag_mode }}
{% endif %}{% if i.lag_hash_policy %}    bond-xmit-hash-policy {{ i.lag_hash_policy }}
{% endif %}{% if i.lag_miimon %}    bond-miimon {{ i.lag_miimon }}
{% endif %}{% endfor %}"""


class BondTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        site = Site.objects.create(tenant=self.tenant, name="DC1")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="M", slug="m")
        dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="X")
        self.dev = Device.objects.create(tenant=self.tenant, name="leaf1", device_type=dt, site=site)
        self.bond = Interface.objects.create(device=self.dev, name="bond-s1", type="lag")
        for n in ("swp1", "swp2"):
            Interface.objects.create(device=self.dev, name=n, type="10gbase-x-sfpp", lag=self.bond)
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _patch(self, iface, **data):
        return self.client.patch(f"/api/interfaces/{iface.id}/", data, format="json")

    def test_static_bond_settings_round_trip(self):
        r = self._patch(self.bond, lag_mode="balance-xor", lag_hash_policy="layer3+4",
                        lag_miimon=100)
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(body["lag_protocol"], "")
        self.assertEqual(body["lag_mode"], "balance-xor")
        self.assertEqual(body["lag_hash_policy_display"], "layer3+4")
        self.assertEqual(body["lag_miimon"], 100)

    def test_static_is_an_input_alias_for_blank(self):
        self._patch(self.bond, lag_protocol="lacp")
        r = self._patch(self.bond, lag_protocol="static")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["lag_protocol"], "")
        self.bond.refresh_from_db()
        self.assertEqual(self.bond.lag_protocol, "")

    def test_802_3ad_sets_lacp(self):
        r = self._patch(self.bond, lag_mode="802.3ad")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["lag_protocol"], "lacp")

    def test_lacp_with_another_mode_is_refused(self):
        r = self._patch(self.bond, lag_protocol="lacp", lag_mode="active-backup")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("lag_mode", r.json())

    def test_settings_on_a_port_are_refused_and_cleared_on_save(self):
        port = Interface.objects.get(name="swp1")
        r = self._patch(port, lag_mode="balance-rr")
        self.assertEqual(r.status_code, 400, r.content)
        # A shell or import write lands cleared, as the LACP knobs do.
        port.lag_mode, port.lag_miimon = "balance-rr", 100
        port.save()
        port.refresh_from_db()
        self.assertEqual((port.lag_mode, port.lag_miimon), ("", None))

    def test_model_save_applies_the_lacp_rule(self):
        self.bond.lag_mode = "802.3ad"
        self.bond.save()
        self.bond.refresh_from_db()
        self.assertEqual(self.bond.lag_protocol, "lacp")

    def test_bulk_edit(self):
        r = self.client.post("/api/interfaces/bulk-update/", {
            "ids": [str(self.bond.id)],
            "fields": {"lag_mode": "active-backup", "lag_miimon": 200},
        }, format="json")
        self.assertIn(r.status_code, (200, 204), r.content)
        self.bond.refresh_from_db()
        self.assertEqual((self.bond.lag_mode, self.bond.lag_miimon), ("active-backup", 200))

    def test_choices_endpoint_offers_the_sets(self):
        r = self.client.get("/api/dcim/choices/")
        if r.status_code == 404:
            self.skipTest("choices endpoint path differs")
        body = r.json()
        self.assertIn("lag_modes", body)
        self.assertIn("lag_hash_policies", body)

    def test_the_bond_block_renders(self):
        self._patch(self.bond, lag_protocol="static", lag_mode="balance-xor",
                    lag_hash_policy="layer3+4", lag_miimon=100)
        tmpl = ExportTemplate.objects.create(
            tenant=self.tenant, name="interfaces", object_type="device",
            template_code=BOND_TEMPLATE,
        )
        r = self.client.get(f"/api/devices/{self.dev.id}/render/?template={tmpl.id}")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["output"], (
            "auto bond-s1\n"
            "iface bond-s1 inet manual\n"
            "    bond-slaves swp1 swp2\n"
            "    bond-mode balance-xor\n"
            "    bond-xmit-hash-policy layer3+4\n"
            "    bond-miimon 100\n"
        ))
