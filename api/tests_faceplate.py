"""Faceplate layout persistence + Aux ports (the eighth component kind).

The faceplate doc rides on DeviceType.faceplate (JSONB, null = automatic
layout). Shape validation lives in DeviceTypeSerializer.validate_faceplate;
these tests pin the contract the drag-and-drop builder saves against.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.utils import timezone
from rest_framework.test import APITestCase

from core.models import Organization, Tenant
from .models import (
    AuxPortTemplate,
    Cable,
    CableTermination,
    Device,
    DeviceType,
    Interface,
)

User = get_user_model()

VALID_DOC = {
    "v": 1,
    "rear": [],
    "front": [
        {
            "id": "a",
            "label": "1–48",
            "rows": 2,
            "bank": 12,
            "slots": [
                {"t": "port", "name": "TwentyFiveGigE1/0/1"},
                {"t": "port", "name": "TwentyFiveGigE1/0/2"},
                {"t": "blank"},
                {"t": "label", "text": "MGMT"},
                {"t": "port", "kind": "aux-port", "name": "USB1"},
            ],
        }
    ],
}


class FaceplateFieldTests(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "admin@example.com", "x")
        self.client.force_login(admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()
        self.dt = DeviceType.objects.create(
            tenant=self.tenant, name="C9500-48Y4C", u_height=1
        )

    def _patch(self, doc):
        return self.client.patch(
            f"/api/device-types/{self.dt.id}/",
            {"faceplate": doc},
            format="json",
        )

    def test_round_trip(self):
        resp = self._patch(VALID_DOC)
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(resp.json()["faceplate"], VALID_DOC)
        # And it comes back on GET.
        got = self.client.get(f"/api/device-types/{self.dt.id}/").json()
        self.assertEqual(got["faceplate"], VALID_DOC)

    def test_null_clears(self):
        self._patch(VALID_DOC)
        resp = self._patch(None)
        self.assertEqual(resp.status_code, 200)
        self.assertIsNone(resp.json()["faceplate"])

    def test_rejects_wrong_version(self):
        self.assertEqual(self._patch({"v": 2, "front": [], "rear": []}).status_code, 400)

    def test_rejects_non_dict(self):
        self.assertEqual(self._patch(["not", "a", "doc"]).status_code, 400)

    def test_rejects_bad_slot_kind(self):
        doc = {
            "v": 1, "rear": [],
            "front": [
                {"id": "a", "rows": 1, "bank": 0,
                 "slots": [{"t": "port", "kind": "flux-capacitor", "name": "x"}]}
            ],
        }
        self.assertEqual(self._patch(doc).status_code, 400)

    def test_rejects_port_without_name(self):
        doc = {
            "v": 1, "rear": [],
            "front": [
                {"id": "a", "rows": 1, "bank": 0, "slots": [{"t": "port"}]}
            ],
        }
        self.assertEqual(self._patch(doc).status_code, 400)

    def test_accepts_module_bay_placeholder(self):
        # A group may carry a `bay` marker (placed in the builder) - the device
        # render composes an installed module's faceplate there.
        doc = {
            "v": 1, "rear": [],
            "front": [
                {"id": "b", "bay": "Network Module", "label": "Network Module",
                 "rows": 1, "bank": 0, "slots": [{"t": "blank"}]}
            ],
        }
        resp = self._patch(doc)
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(resp.json()["faceplate"]["front"][0]["bay"],
                         "Network Module")

    def test_rejects_non_string_bay(self):
        doc = {
            "v": 1, "rear": [],
            "front": [
                {"id": "b", "bay": 42, "rows": 1, "bank": 0, "slots": []}
            ],
        }
        self.assertEqual(self._patch(doc).status_code, 400)

    def _patch_ports(self, ports):
        return self.client.patch(
            f"/api/device-types/{self.dt.id}/",
            {"image_ports": ports}, format="json",
        )

    def test_image_ports_roundtrip(self):
        ports = {
            "front": [
                {"kind": "interface", "name": "Gi1/0/1", "x": 0.1, "y": 0.5,
                 "w": 0.03, "h": 0.4},
            ],
            "rear": [],
        }
        resp = self._patch_ports(ports)
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(
            resp.json()["image_ports"]["front"][0]["name"], "Gi1/0/1"
        )
        # Clearable back to null.
        self.assertEqual(self._patch_ports(None).status_code, 200)
        self.assertIsNone(
            self.client.get(
                f"/api/device-types/{self.dt.id}/"
            ).json()["image_ports"]
        )

    def test_image_ports_reject_out_of_bounds_and_bad_kind(self):
        for bad in (
            {"front": [{"name": "x", "x": 1.5, "y": 0.5, "w": 0.1, "h": 0.1}]},
            {"front": [{"kind": "flux", "name": "x", "x": 0.1, "y": 0.1,
                        "w": 0.1, "h": 0.1}]},
            {"front": [{"name": "", "x": 0.1, "y": 0.1, "w": 0.1, "h": 0.1}]},
            {"front": "nope"},
        ):
            self.assertEqual(self._patch_ports(bad).status_code, 400, bad)

    def test_image_ports_accept_photo_only_kinds(self):
        """Hardware parts and MODULE BAYS are placeable on a photo - you mark
        where a chassis's line-card slots physically are."""
        ports = {
            "front": [
                {"kind": "inventory-item", "name": "Disk 0", "x": 0.1,
                 "y": 0.5, "w": 0.03, "h": 0.35},
                {"kind": "module-bay", "name": "Slot 1", "x": 0.4, "y": 0.5,
                 "w": 0.2, "h": 0.45},
            ],
            "rear": [],
        }
        resp = self._patch_ports(ports)
        self.assertEqual(resp.status_code, 200, resp.content)
        kinds = [m["kind"] for m in resp.json()["image_ports"]["front"]]
        self.assertEqual(kinds, ["inventory-item", "module-bay"])

    def test_faceplate_still_rejects_photo_only_kinds(self):
        """The boundary is the point: the schematic faceplate stays PORT-only.
        A module bay appears there as a group's `bay` placeholder (which the
        device render composes an installed module into), never as a slot."""
        for kind in ("module-bay", "inventory-item"):
            doc = {
                "v": 1, "rear": [],
                "front": [
                    {"id": "a", "rows": 1, "bank": 0, "slots": [
                        {"t": "port", "kind": kind, "name": "Slot 1"},
                    ]}
                ],
            }
            self.assertEqual(self._patch(doc).status_code, 400, kind)

    def test_rejects_duplicate_kind_name(self):
        doc = {
            "v": 1, "rear": [],
            "front": [
                {"id": "a", "rows": 1, "bank": 0, "slots": [
                    {"t": "port", "name": "eth0"},
                    {"t": "port", "name": "ETH0"},  # case-insensitive dupe
                ]}
            ],
        }
        self.assertEqual(self._patch(doc).status_code, 400)

    def test_three_rows_and_full_width(self):
        doc = {
            "v": 1, "full": True, "rear": [],
            "front": [
                {"id": "a", "rows": 3, "bank": 0, "slots": [
                    {"t": "port", "name": "eth0"},
                ]}
            ],
        }
        resp = self._patch(doc)
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertTrue(resp.json()["faceplate"]["full"])
        # 5 rows don't exist on any panel.
        doc["front"][0]["rows"] = 5
        self.assertEqual(self._patch(doc).status_code, 400)

    def test_same_name_different_kind_is_fine(self):
        doc = {
            "v": 1, "rear": [],
            "front": [
                {"id": "a", "rows": 1, "bank": 0, "slots": [
                    {"t": "port", "name": "usb"},
                    {"t": "port", "kind": "aux-port", "name": "usb"},
                ]}
            ],
        }
        self.assertEqual(self._patch(doc).status_code, 200)

    def test_tenant_isolation(self):
        other_org = Organization.objects.create(name="Evil", slug="evil")
        other = Tenant.objects.create(org=other_org, name="Evil", slug="evil")
        foreign = DeviceType.objects.create(tenant=other, name="X", u_height=1)
        resp = self.client.patch(
            f"/api/device-types/{foreign.id}/",
            {"faceplate": VALID_DOC},
            format="json",
        )
        self.assertEqual(resp.status_code, 404)


class AuxPortTests(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "admin@example.com", "x")
        self.client.force_login(admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()
        self.dt = DeviceType.objects.create(
            tenant=self.tenant, name="edge-router", u_height=1
        )

    def test_crud(self):
        device = Device.objects.create(tenant=self.tenant, name="r1")
        resp = self.client.post(
            "/api/aux-ports/",
            {"device_id": str(device.id), "name": "HDMI out", "type": "hdmi"},
            format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        pid = resp.json()["id"]
        got = self.client.get(f"/api/aux-ports/{pid}/").json()
        self.assertEqual(got["type"], "hdmi")
        self.assertEqual(got["type_display"], "HDMI")
        self.assertEqual(
            self.client.delete(f"/api/aux-ports/{pid}/").status_code, 204
        )

    def test_template_stamps_on_device_create(self):
        AuxPortTemplate.objects.create(
            device_type=self.dt, name="USB{position}", type="usb-a"
        )
        AuxPortTemplate.objects.create(
            device_type=self.dt, name="HDMI", type="hdmi"
        )
        resp = self.client.post(
            "/api/devices/",
            {"name": "r2", "device_type_id": str(self.dt.id)},
            format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        device = Device.objects.get(name="r2")
        names = set(device.aux_ports.values_list("name", flat=True))
        # Standalone device: {position} resolves to its default (1).
        self.assertEqual(names, {"USB1", "HDMI"})


class FacePortsResolveTests(APITestCase):
    """GET /api/devices/{id}/face-ports/ turns a device type's photo-port
    markers into the device's real components (id, kind, cabled?), which the 3D
    room view needs to cable a clicked port."""

    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "admin@example.com", "x")
        self.client.force_login(admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()
        self.dt = DeviceType.objects.create(
            tenant=self.tenant, name="C9300", u_height=1,
            image_ports={
                "front": [
                    {"kind": "interface", "name": "Gi1/0/1",
                     "x": 0.1, "y": 0.5, "w": 0.03, "h": 0.4},
                    {"kind": "interface", "name": "Gi1/0/99",
                     "x": 0.2, "y": 0.5, "w": 0.03, "h": 0.4},
                ],
                "rear": [],
            },
        )
        self.dev = Device.objects.create(
            tenant=self.tenant, name="sw1", device_type=self.dt
        )
        self.eth = Interface.objects.create(
            device=self.dev, name="Gi1/0/1", speed="25G", enabled=True
        )

    def _get(self):
        return self.client.get(f"/api/devices/{self.dev.id}/face-ports/")

    def test_resolves_marker_to_interface(self):
        resp = self._get()
        self.assertEqual(resp.status_code, 200, resp.content)
        front = resp.json()["front"]
        self.assertEqual(front[0]["name"], "Gi1/0/1")
        self.assertEqual(front[0]["kind"], "interface")
        self.assertEqual(front[0]["id"], str(self.eth.id))
        self.assertFalse(front[0]["connected"])
        # Speed/enabled ride along so 3D can reuse the 2D port-state colouring.
        self.assertEqual(front[0]["speed"], "25G")
        self.assertTrue(front[0]["enabled"])
        # A marker with no matching component resolves to a null id, not a 500.
        self.assertIsNone(front[1]["id"])
        self.assertIsNone(front[1]["kind"])

    def test_resolves_inventory_marker_with_status(self):
        from api.models import InventoryItem
        from api.status_registry import seed_builtin_statuses
        from api.models import Status

        seed_builtin_statuses(self.tenant)
        failed = Status.objects.get(tenant=self.tenant, slug="failed")
        self.dt.image_ports = {
            "front": [{"kind": "inventory-item", "name": "Bay 1",
                       "x": 0.3, "y": 0.5, "w": 0.02, "h": 0.6}],
            "rear": [],
        }
        self.dt.save(update_fields=["image_ports"])
        InventoryItem.objects.create(
            device=self.dev, name="Bay 1", kind="disk", media="nvme",
            status=failed,
        )
        front = self._get().json()["front"]
        self.assertEqual(front[0]["name"], "Bay 1")
        self.assertIsNotNone(front[0]["id"])
        self.assertIsNone(front[0]["kind"])  # not cable-able
        self.assertEqual(front[0]["status"]["name"], "Failed")
        # The id joins the marker to the tenant's Status catalog - the legend
        # keys hardware by it, since StatusMini carries no slug.
        self.assertEqual(front[0]["status"]["id"], str(failed.id))

    def test_drift_rides_along_for_hardware(self):
        """A part whose observed health disagrees with its set status carries a
        drift line, so the 3D room can flag it without a second request."""
        from api.models import InventoryItem, Status
        from api.status_registry import seed_builtin_statuses
        from monitoring.models import DeviceSnmp

        seed_builtin_statuses(self.tenant)
        active = Status.objects.get(tenant=self.tenant, slug="active")
        self.dt.image_ports = {
            "front": [{"kind": "inventory-item", "name": "disk0",
                       "x": 0.3, "y": 0.5, "w": 0.02, "h": 0.6}],
            "rear": [],
        }
        self.dt.save(update_fields=["image_ports"])
        part = InventoryItem.objects.create(
            device=self.dev, name="disk0", kind="disk", status=active
        )
        DeviceSnmp.objects.create(
            device=self.dev, tenant=self.tenant, polled_at=timezone.now(),
            sensors=[{"name": "disk0", "status": "failed", "raw": "Critical",
                      "kind": "disk", "sensor": "Drive health"}],
        )
        front = self._get().json()["front"]
        self.assertEqual(front[0]["id"], str(part.id))
        # Intent is untouched - the status still reads Active, drift sits beside.
        self.assertEqual(front[0]["status"]["name"], "Active")
        self.assertEqual(front[0]["drift"], "SNMP says failed")

    def test_drift_is_null_when_they_agree(self):
        front = self._get().json()["front"]
        self.assertIsNone(front[0]["drift"])
        self.assertIsNone(front[1]["drift"])

    def _bay_markers(self):
        self.dt.image_ports = {
            "front": [{"kind": "module-bay", "name": "Slot 1",
                       "x": 0.3, "y": 0.5, "w": 0.2, "h": 0.45}],
            "rear": [],
        }
        self.dt.save(update_fields=["image_ports"])

    def test_module_bay_marker_empty_then_installed(self):
        """The whole chain a bay marker travels: a module-bay TEMPLATE on the
        type → a bay stamped onto a new device → a marker naming that template
        → resolved empty, then occupied once a module is seated. "Empty" is a
        real answer; "not on this device" is not."""
        from api.models import Manufacturer, ModuleBayTemplate, ModuleType

        ModuleBayTemplate.objects.create(device_type=self.dt, name="Slot 1")
        # Stamped by device creation, exactly as the palette's template implies.
        resp = self.client.post(
            "/api/devices/",
            {"name": "c9400", "device_type_id": str(self.dt.id)},
            format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        chassis = Device.objects.get(name="c9400")
        bay = chassis.module_bays.get(name="Slot 1")
        self._bay_markers()

        front = self.client.get(
            f"/api/devices/{chassis.id}/face-ports/"
        ).json()["front"]
        self.assertEqual(front[0]["id"], str(bay.id))
        self.assertIsNone(front[0]["kind"])  # not cable-able
        self.assertIsNone(front[0]["module"])
        # A bay is not a hardware part - it has no lifecycle status of its own.
        self.assertIsNone(front[0]["status"])

        mfr = Manufacturer.objects.create(tenant=self.tenant, name="Cisco")
        mt = ModuleType.objects.create(
            tenant=self.tenant, manufacturer=mfr, name="C9400-LC-48U"
        )
        resp = self.client.post(
            "/api/modules/",
            {"device_id": str(chassis.id), "module_bay_id": str(bay.id),
             "module_type_id": str(mt.id), "serial_number": "FOC123"},
            format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.content)

        front = self.client.get(
            f"/api/devices/{chassis.id}/face-ports/"
        ).json()["front"]
        self.assertEqual(front[0]["id"], str(bay.id))
        self.assertEqual(front[0]["module"]["id"], resp.json()["id"])
        self.assertEqual(front[0]["module"]["module_type"]["name"],
                         "C9400-LC-48U")
        self.assertEqual(front[0]["module"]["serial_number"], "FOC123")

    def test_module_bay_marker_with_no_bay_is_a_ghost(self):
        self._bay_markers()
        front = self._get().json()["front"]
        self.assertIsNone(front[0]["id"])
        self.assertIsNone(front[0]["module"])

    def test_marker_matches_component_name_case_insensitively(self):
        """Imported photo markers routinely disagree with the live component
        names by case alone ("Psu 1" vs "PSU 1"). Exact wins when it exists;
        the tolerant pass keeps the marker resolvable instead of grey."""
        from api.models import PowerPort

        self.dt.image_ports = {
            "front": [],
            "rear": [{"kind": "power-port", "name": "Psu 1",
                      "x": 0.8, "y": 0.5, "w": 0.05, "h": 0.3}],
        }
        self.dt.save(update_fields=["image_ports"])
        port = PowerPort.objects.create(device=self.dev, name="PSU 1")
        rear = self._get().json()["rear"]
        marked = next(e for e in rear if e["marker"] == "Psu 1")
        self.assertEqual(marked["id"], str(port.id))
        self.assertEqual(marked["kind"], "power_port")

    def test_unmarked_power_components_resolve_synthetically(self):
        """Power ports/outlets no marker covers come back as synthetic REAR
        entries (marker == the component's own name) - the 3D room draws
        deterministic quads for them, and a quad that face-ports can't
        resolve could never start a connection."""
        from api.models import PowerOutlet, PowerPort

        p1 = PowerPort.objects.create(device=self.dev, name="PSU 1")
        p2 = PowerPort.objects.create(device=self.dev, name="PSU 2")
        out = PowerOutlet.objects.create(device=self.dev, name="C13-01")
        cable = Cable.objects.create(tenant=self.tenant)
        CableTermination.objects.create(cable=cable, end="A", power_port=p1)
        body = self._get().json()
        rear = {e["marker"]: e for e in body["rear"]}
        self.assertEqual(rear["PSU 1"]["id"], str(p1.id))
        self.assertEqual(rear["PSU 1"]["kind"], "power_port")
        self.assertTrue(rear["PSU 1"]["connected"])
        self.assertEqual(rear["PSU 1"]["cable_id"], str(cable.id))
        self.assertFalse(rear["PSU 2"]["connected"])
        self.assertEqual(rear["C13-01"]["kind"], "power_outlet")
        self.assertEqual(rear["C13-01"]["id"], str(out.id))
        # Interfaces are NOT synthesized - the front markers still carry them.
        self.assertNotIn("Gi1/0/1", rear)

    def test_marked_power_ports_are_not_duplicated_synthetically(self):
        """A component a marker claims (even via the tolerant match) must not
        come back a second time as a synthetic entry."""
        from api.models import PowerPort

        self.dt.image_ports = {
            "front": [],
            "rear": [{"kind": "power-port", "name": "Psu 1",
                      "x": 0.8, "y": 0.5, "w": 0.05, "h": 0.3}],
        }
        self.dt.save(update_fields=["image_ports"])
        PowerPort.objects.create(device=self.dev, name="PSU 1")
        p2 = PowerPort.objects.create(device=self.dev, name="PSU 2")
        rear = self._get().json()["rear"]
        self.assertEqual([e["marker"] for e in rear], ["Psu 1", "PSU 2"])
        self.assertEqual(rear[1]["id"], str(p2.id))

    def test_connected_flag_and_cable_id(self):
        peer = Device.objects.create(
            tenant=self.tenant, name="sw2", device_type=self.dt
        )
        p_eth = Interface.objects.create(device=peer, name="Gi1/0/1")
        cable = Cable.objects.create(tenant=self.tenant, type="cat6")
        CableTermination.objects.create(cable=cable, end="A", interface=self.eth)
        CableTermination.objects.create(cable=cable, end="B", interface=p_eth)
        front = self._get().json()["front"]
        self.assertTrue(front[0]["connected"])
        self.assertEqual(front[0]["cable_id"], str(cable.id))
