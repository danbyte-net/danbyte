"""Antennas (#111): pure L1 inventory for what radiates.

Integrated elements are components stamped from device-type templates; an
external antenna is its own small device whose RF aux port takes the coax.
Nothing here is cable-terminable - that is the aux port's job.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import (
    Antenna,
    AntennaTemplate,
    CableTermination,
    Device,
    DeviceType,
    diff_device_components,
    materialize_device_components,
    sync_device_components,
)

User = get_user_model()


class AntennaTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("root", "r@a.c", "pw")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        self.dt = DeviceType.objects.create(tenant=self.tenant, name="AP-655")

    def _device(self, name="ap1"):
        return Device.objects.create(
            tenant=self.tenant, name=name, device_type=self.dt
        )

    def test_templates_stamp_integrated_elements(self):
        AntennaTemplate.objects.create(
            device_type=self.dt, name="ant{position}",
            antenna_type="internal", gain_dbi="4.50",
            bands=["2.4ghz", "5ghz", "6ghz"], polarization="dual",
        )
        device = self._device()
        created = materialize_device_components(device)
        self.assertEqual(created.get("antennas"), 1)
        ant = device.antennas.get()
        self.assertEqual(ant.antenna_type, "internal")
        self.assertEqual(str(ant.gain_dbi), "4.50")
        self.assertEqual(ant.bands, ["2.4ghz", "5ghz", "6ghz"])
        # Idempotent, like every other kind.
        again = materialize_device_components(device)
        self.assertEqual(again.get("antennas"), 0)

    def test_sync_diff_sees_antenna_drift(self):
        device = self._device()
        AntennaTemplate.objects.create(
            device_type=self.dt, name="ant0", antenna_type="internal"
        )
        diff = diff_device_components(device)
        self.assertEqual(diff["antennas"]["add"], ["ant0"])
        sync_device_components(device)
        self.assertTrue(device.antennas.filter(name="ant0").exists())
        # An extra the type doesn't define is removable, opt-in.
        Antenna.objects.create(device=device, name="stray")
        diff = diff_device_components(device)
        self.assertEqual(diff["antennas"]["extra"], ["stray"])
        sync_device_components(device, remove_extra=True)
        self.assertFalse(device.antennas.filter(name="stray").exists())

    def test_api_crud_and_band_validation(self):
        device = self._device()
        r = self.client.post(
            "/api/antennas/",
            {
                "device_id": str(device.id), "name": "sector-1",
                "antenna_type": "sector", "gain_dbi": "17.00",
                "bands": ["5ghz"], "polarization": "dual-slant",
                "connector": "n-type", "direct_mount": False,
            },
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(body["gain_dbi"], "17.00")
        self.assertEqual(body["bands"], ["5ghz"])
        # Bands are validated slugs - never free text.
        r = self.client.post(
            "/api/antennas/",
            {"device_id": str(device.id), "name": "bad",
             "bands": ["5 gigahertz"]},
            format="json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("bands", r.json())

    def test_antennas_are_not_cable_points(self):
        # The coax terminates on an RF aux port; the antenna itself never
        # joins the cable model.
        self.assertNotIn("antenna", CableTermination.POINT_FIELDS)

    def test_rf_connector_is_an_aux_port_type(self):
        # The other half of #111: the AP -> antenna coax run documents with
        # what already exists, an aux port typed as an RF connector.
        r = self.client.post(
            "/api/aux-ports/",
            {"device_id": str(self._device("ap2").id), "name": "RF1",
             "type": "n-type"},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)

    def test_another_tenants_device_is_out_of_reach(self):
        org = Organization.objects.create(name="Other", slug="other")
        other = Tenant.objects.create(org=org, name="Other", slug="other")
        dt = DeviceType.objects.create(tenant=other, name="ap")
        theirs = Device.objects.create(tenant=other, name="their-ap",
                                       device_type=dt)
        r = self.client.post(
            "/api/antennas/",
            {"device_id": str(theirs.id), "name": "nope"},
            format="json",
        )
        self.assertEqual(r.status_code, 400, r.content)

    def test_ranged_names_expand_server_side(self):
        """"RF[1-2]" through the raw API makes RF1 and RF2 - the dialogs used
        to be the only place the shorthand meant anything, so a script got one
        literally-named row."""
        r = self.client.post(
            "/api/antenna-templates/",
            {"device_type_id": str(self.dt.id), "name": "ant[1-4]",
             "antenna_type": "internal", "gain_dbi": "4.50",
             "bands": ["2.4ghz", "5ghz"]},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["name"], "ant1")  # the first row comes back
        names = sorted(
            self.dt.antenna_templates.values_list("name", flat=True)
        )
        self.assertEqual(names, ["ant1", "ant2", "ant3", "ant4"])
        # Every row carries the shared fields, not just the first.
        self.assertTrue(all(
            t.bands == ["2.4ghz", "5ghz"]
            for t in self.dt.antenna_templates.all()
        ))

    def test_ranged_device_components_expand_too(self):
        device = self._device("ap9")
        r = self.client.post(
            "/api/aux-ports/",
            {"device_id": str(device.id), "name": "RF[1-2]", "type": "n-type"},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(
            sorted(device.aux_ports.values_list("name", flat=True)),
            ["RF1", "RF2"],
        )
        r = self.client.post(
            "/api/interfaces/",
            {"device_id": str(device.id), "name": "eth[0-3]",
             "type": "2.5gbase-t"},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(device.interfaces.count(), 4)

    def test_a_ranged_clash_refuses_cleanly(self):
        device = self._device("ap10")
        self.client.post("/api/aux-ports/",
                         {"device_id": str(device.id), "name": "RF2"},
                         format="json")
        r = self.client.post(
            "/api/aux-ports/",
            {"device_id": str(device.id), "name": "RF[1-3]"},
            format="json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("name", r.json())
        # Nothing partial was written.
        self.assertEqual(device.aux_ports.count(), 1)

    def test_an_oversized_range_stays_literal(self):
        # Mirrors the frontend cap: a typo must not fan out 99k rows.
        device = self._device("ap11")
        r = self.client.post(
            "/api/aux-ports/",
            {"device_id": str(device.id), "name": "p[1-9999]"},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(device.aux_ports.count(), 1)
        self.assertEqual(device.aux_ports.get().name, "p[1-9999]")

    def test_bundle_round_trips_antenna_templates(self):
        AntennaTemplate.objects.create(
            device_type=self.dt, name="ant0", antenna_type="omni",
            gain_dbi="5.00", bands=["2.4ghz"], polarization="vertical",
            connector="rp-sma", direct_mount=True,
        )
        r = self.client.get(f"/api/device-types/{self.dt.id}/library-export/")
        self.assertEqual(r.status_code, 200, r.content)
        bundle = r.json()
        self.assertEqual(len(bundle["components"]["antennas"]), 1)
        exported = bundle["components"]["antennas"][0]
        self.assertEqual(exported["antenna_type"], "omni")
        self.assertTrue(exported["direct_mount"])

        bundle["name"] = "AP-655-copy"
        r = self.client.post(
            "/api/device-types/import-bundle/", bundle, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["components"]["antennas"], 1)
        made = DeviceType.objects.get(tenant=self.tenant, name="AP-655-copy")
        t = made.antenna_templates.get()
        self.assertEqual(t.connector, "rp-sma")
        self.assertEqual(t.bands, ["2.4ghz"])
