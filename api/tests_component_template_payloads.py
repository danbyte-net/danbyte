"""Every device-type component-template kind accepts the payload the
component-template dialog sends (#513).

The dialog posts ``name``/``description`` plus the kind's extras; kinds whose
model has no ``type`` column must neither 500 on create nor on read.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import (
    AntennaTemplate,
    CoolingIntakeTemplate,
    DeviceType,
    PowerPortTemplate,
    RearPortTemplate,
)

User = get_user_model()


def _first_choice(model, field):
    return model._meta.get_field(field).choices[0][0]


class ComponentTemplateDialogPayloadTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("root", "r@a.c", "pw")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        self.dt = DeviceType.objects.create(tenant=self.tenant, name="Chassis")

    def _payloads(self):
        from .models import (
            ConsolePortTemplate,
            InterfaceTemplate,
            PowerOutletTemplate,
        )

        ppt = PowerPortTemplate.objects.create(device_type=self.dt, name="PSU0")
        rpt = RearPortTemplate.objects.create(
            device_type=self.dt, name="rear0", positions=2
        )
        intake = CoolingIntakeTemplate.objects.create(device_type=self.dt, name="in0")
        cooling = {"connector": "", "diameter_mm": None, "max_flow_lpm": None}
        return {
            "interface-templates": {
                "type": _first_choice(InterfaceTemplate, "type"),
                "enabled": True, "mgmt_only": False, "combo_group": "",
                "poe_mode": "", "poe_type": "",
            },
            "console-port-templates": {
                "type": _first_choice(ConsolePortTemplate, "type"),
            },
            "console-server-port-templates": {
                "type": _first_choice(ConsolePortTemplate, "type"),
            },
            "aux-port-templates": {"type": ""},
            "power-port-templates": {
                "type": "", "maximum_draw": None, "allocated_draw": None,
            },
            "power-outlet-templates": {
                "type": _first_choice(PowerOutletTemplate, "type"),
                "power_port_template_id": str(ppt.id), "feed_leg": "",
            },
            "cooling-intake-templates": dict(cooling),
            "cooling-outflow-templates": {
                **cooling, "intake_template_id": str(intake.id),
            },
            "rear-port-templates": {
                "type": "8p8c", "positions": 1, "is_splitter": False,
            },
            "front-port-templates": {
                "type": "8p8c", "rear_port_template_id": str(rpt.id),
                "rear_port_position": 1,
            },
            "module-bay-templates": {
                "position": "1", "default_module_type_id": None,
            },
            "antenna-templates": {
                "antenna_type": _first_choice(AntennaTemplate, "antenna_type"),
                "gain_dbi": None, "bands": [], "polarization": "",
                "connector": "", "direct_mount": False,
            },
            "inventory-item-templates": {
                "manufacturer_id": None, "part_id": "", "kind": "other",
                "media": "", "capacity_bytes": None, "speed": "",
            },
            "device-bay-templates": {},
        }

    def test_each_kind_creates_and_lists_with_the_dialog_payload(self):
        for endpoint, extras in self._payloads().items():
            with self.subTest(endpoint=endpoint):
                body = {
                    "device_type_id": str(self.dt.id),
                    "name": f"{endpoint}-1",
                    "description": "",
                    **extras,
                }
                r = self.client.post(f"/api/{endpoint}/", body, format="json")
                self.assertEqual(r.status_code, 201, r.content)
                r = self.client.get(
                    f"/api/{endpoint}/", {"device_type": str(self.dt.id)}
                )
                self.assertEqual(r.status_code, 200, r.content)

    def test_typeless_kinds_ignore_a_stray_type(self):
        """An older client that still sends ``type`` for a bay must not 500."""
        for endpoint in ("device-bay-templates", "module-bay-templates",
                         "inventory-item-templates"):
            with self.subTest(endpoint=endpoint):
                r = self.client.post(
                    f"/api/{endpoint}/",
                    {"device_type_id": str(self.dt.id), "name": "x",
                     "type": "", "description": ""},
                    format="json",
                )
                self.assertEqual(r.status_code, 201, r.content)
                self.assertNotIn("type", r.json())
