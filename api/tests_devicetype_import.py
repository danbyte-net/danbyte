"""Import from the NetBox devicetype-library (YAML → DeviceType + templates)."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Organization, Tenant
from .devicetype_import import positionize, to_raw_url
from .models import DeviceType

User = get_user_model()

# Trimmed but structurally faithful devicetype-library file (Cisco C9300-48P).
SAMPLE_YAML = """\
manufacturer: Cisco
model: Catalyst 9300-48P
slug: cisco-c9300-48p
part_number: C9300-48P
u_height: 1
is_full_depth: true
airflow: front-to-rear
console-ports:
  - name: con0
    type: rj-45
  - name: usb
    type: usb-mini-b
power-ports:
  - name: PS1
    type: iec-60320-c16
    maximum_draw: 715
  - name: PS2
    type: iec-60320-c16
    maximum_draw: 715
interfaces:
  - name: GigabitEthernet0/0
    type: 1000base-t
    mgmt_only: true
  - name: GigabitEthernet1/0/1
    type: 1000base-t
  - name: GigabitEthernet1/0/2
    type: 1000base-t
  - name: TenGigabitEthernet1/1/1
    type: 10gbase-x-sfpp
module-bays:
  - name: Network Module
    position: '1'
"""

PANEL_YAML = """\
manufacturer: Generic
model: 24-port LC panel
u_height: 1
rear-ports:
  - name: R1
    type: lc
    positions: 2
front-ports:
  - name: F1
    type: lc
    rear_port: R1
    rear_port_position: 1
  - name: F2
    type: lc
    rear_port: R1
    rear_port_position: 2
"""


class HelperTests(APITestCase):
    def test_positionize(self):
        self.assertEqual(
            positionize("GigabitEthernet1/0/1"),
            "GigabitEthernet{position}/0/1",
        )
        self.assertEqual(positionize("xe-0/0/0"), "xe-{position:0}/0/0")
        # No leading slot segment → untouched.
        self.assertEqual(positionize("con0"), "con0")
        self.assertEqual(positionize("Ethernet48"), "Ethernet48")

    def test_to_raw_url(self):
        self.assertEqual(
            to_raw_url(
                "https://github.com/netbox-community/devicetype-library/"
                "blob/master/device-types/Cisco/C9300-48P.yaml"
            ),
            "https://raw.githubusercontent.com/netbox-community/"
            "devicetype-library/master/device-types/Cisco/C9300-48P.yaml",
        )
        # Raw / non-github URLs pass through.
        self.assertEqual(to_raw_url("https://example.com/x.yaml"),
                         "https://example.com/x.yaml")


class ImportEndpointTests(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "admin@example.com", "x")
        self.client.force_login(admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

    def _import(self, items, stack=False):
        return self.client.post(
            "/api/device-types/import-yaml/",
            {"items": items, "stack_positions": stack},
            format="json",
        )

    def test_imports_full_type(self):
        resp = self._import([SAMPLE_YAML])
        self.assertEqual(resp.status_code, 200, resp.content)
        r = resp.json()["results"][0]
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["name"], "Catalyst 9300-48P")
        self.assertEqual(r["created"]["interfaces"], 4)
        self.assertEqual(r["created"]["console_ports"], 2)
        self.assertEqual(r["created"]["power_ports"], 2)
        # module-bays import as bay templates now (was a skip note pre-M1).
        self.assertEqual(r["created"]["module_bays"], 1)

        dt = DeviceType.objects.get(tenant=self.tenant, name="Catalyst 9300-48P")
        self.assertEqual(dt.manufacturer.name, "Cisco")
        self.assertEqual(dt.part_number, "C9300-48P")
        self.assertEqual(dt.u_height, 1)
        # Hardware attributes now map instead of being skipped.
        self.assertTrue(dt.is_full_depth)
        self.assertEqual(dt.airflow, "front-to-rear")
        names = set(dt.interface_templates.values_list("name", flat=True))
        self.assertIn("GigabitEthernet1/0/1", names)
        mgmt = dt.interface_templates.get(name="GigabitEthernet0/0")
        self.assertTrue(mgmt.mgmt_only)

    def test_weight_and_elevation_images(self):
        from unittest.mock import patch

        yaml_doc = SAMPLE_YAML + (
            "slug: cisco-c9300-48p2\nweight: 7.7\nweight_unit: kg\n"
            "front_image: true\n"
        ).replace("slug: cisco-c9300-48p2", "")  # slug already in SAMPLE_YAML
        fake = type("R", (), {"status_code": 200, "content": b"\\x89PNG fake"})()
        with patch("requests.get", return_value=fake):
            resp = self._import([yaml_doc])
        r = resp.json()["results"][0]
        self.assertTrue(r["ok"], r)
        dt = DeviceType.objects.get(tenant=self.tenant, name="Catalyst 9300-48P")
        self.assertEqual(str(dt.weight), "7.70")  # DecimalField(dp=2)
        self.assertEqual(dt.weight_unit, "kg")
        self.assertTrue(dt.front_image)  # downloaded via the mocked fetch
        self.assertTrue(any("front_image: downloaded" in s for s in r["skipped"]))

    def test_stack_positions_rewrite(self):
        resp = self._import([SAMPLE_YAML], stack=True)
        r = resp.json()["results"][0]
        self.assertTrue(r["ok"], r)
        dt = DeviceType.objects.get(tenant=self.tenant, name="Catalyst 9300-48P")
        names = set(dt.interface_templates.values_list("name", flat=True))
        self.assertIn("GigabitEthernet{position}/0/1", names)
        self.assertIn("TenGigabitEthernet{position}/1/1", names)
        # Mgmt 0/0 becomes the Juniper-style zero-based token.
        self.assertIn("GigabitEthernet{position:0}/0", names)
        # Console con0 has no slot segment — untouched.
        self.assertEqual(dt.console_port_templates.filter(name="con0").count(), 1)

    def test_front_rear_port_mapping(self):
        resp = self._import([PANEL_YAML])
        r = resp.json()["results"][0]
        self.assertTrue(r["ok"], r)
        dt = DeviceType.objects.get(tenant=self.tenant, name="24-port LC panel")
        f2 = dt.front_port_templates.get(name="F2")
        self.assertEqual(f2.rear_port_template.name, "R1")
        self.assertEqual(f2.rear_port_position, 2)

    def test_duplicate_reports_error_and_batch_continues(self):
        self._import([SAMPLE_YAML])
        resp = self._import([SAMPLE_YAML, PANEL_YAML])
        results = resp.json()["results"]
        self.assertFalse(results[0]["ok"])
        self.assertIn("already exists", results[0]["error"])
        self.assertTrue(results[1]["ok"])

    def test_garbage_yaml_reports_error(self):
        resp = self._import(["{{{ not yaml"])
        r = resp.json()["results"][0]
        self.assertFalse(r["ok"])

    def test_empty_items_rejected(self):
        self.assertEqual(self._import([]).status_code, 400)
