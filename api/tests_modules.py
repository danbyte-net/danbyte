"""Modules & module bays (M1): bay templates stamp on device create, module
types import from the library, and installing a module materialises its
{module}-tokenised interfaces onto the host device (uninstall removes them).
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Organization, Tenant
from .devicetype_import import import_yaml_auto
from .models import (
    Device, DeviceType, Module, ModuleBayTemplate, ModuleType,
    ModuleInterfaceTemplate, render_module_name, sync_device_components,
)

User = get_user_model()

MODULE_TYPE_YAML = """\
manufacturer: Cisco
model: C9300-NM-8X
part_number: C9300-NM-8X
interfaces:
  - name: TenGigabitEthernet1/{module}/1
    type: 10gbase-x-sfpp
  - name: TenGigabitEthernet1/{module}/2
    type: 10gbase-x-sfpp
"""

DEVICE_TYPE_YAML = """\
manufacturer: Cisco
model: Catalyst 9300-24T
slug: cisco-c9300-24t
u_height: 1
module-bays:
  - name: Network Module
    position: '1'
interfaces:
  - name: GigabitEthernet1/0/1
    type: 1000base-t
"""

CHASSIS_YAML = """\
manufacturer: Generic
model: Blade Chassis 8
slug: blade-chassis-8
u_height: 10
subdevice_role: parent
device-bays:
  - name: Slot 1
  - name: Slot 2
"""

BLADE_YAML = """\
manufacturer: Generic
model: Blade B1
slug: blade-b1
u_height: 0
subdevice_role: child
exclude_from_utilization: true
inventory-items:
  - name: PSU 1
    manufacturer: Delta Electronics
    part_id: DPS-495
  - name: Fan tray
"""


class _Base(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "admin@example.com", "x")
        self.client.force_login(admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()


class RenderTests(_Base):
    def test_render_module_name(self):
        self.assertEqual(
            render_module_name("Te1/{module}/1", "1"), "Te1/1/1"
        )
        # No position → token stays visible instead of silently renaming.
        self.assertEqual(
            render_module_name("Te1/{module}/1", ""), "Te1/{module}/1"
        )
        self.assertEqual(render_module_name("eth0", "2"), "eth0")


class ImportTests(_Base):
    def test_auto_detects_module_type(self):
        r = import_yaml_auto(self.tenant, MODULE_TYPE_YAML)
        self.assertEqual(r["kind"], "module-type")
        self.assertTrue(r["ok"], r)
        mt = ModuleType.objects.get(tenant=self.tenant, name="C9300-NM-8X")
        self.assertEqual(mt.interface_templates.count(), 2)
        self.assertEqual(mt.manufacturer.name, "Cisco")
        # Token preserved for install-time rendering.
        self.assertTrue(
            mt.interface_templates.filter(
                name="TenGigabitEthernet1/{module}/1"
            ).exists()
        )

    def test_device_type_maps_module_bays(self):
        r = import_yaml_auto(self.tenant, DEVICE_TYPE_YAML)
        self.assertEqual(r["kind"], "device-type")
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["created"]["module_bays"], 1)
        dt = DeviceType.objects.get(tenant=self.tenant, name="Catalyst 9300-24T")
        bay = dt.module_bay_templates.get()
        self.assertEqual(bay.name, "Network Module")
        self.assertEqual(bay.position, "1")
        # No skip note for module-bays anymore.
        self.assertFalse(any("module-bays" in x for x in r["skipped"]))

    def test_duplicate_module_type(self):
        import_yaml_auto(self.tenant, MODULE_TYPE_YAML)
        r = import_yaml_auto(self.tenant, MODULE_TYPE_YAML)
        self.assertFalse(r["ok"])
        self.assertIn("already exists", r["error"])


class InstallTests(_Base):
    def setUp(self):
        super().setUp()
        import_yaml_auto(self.tenant, DEVICE_TYPE_YAML)
        import_yaml_auto(self.tenant, MODULE_TYPE_YAML)
        self.dt = DeviceType.objects.get(tenant=self.tenant, name="Catalyst 9300-24T")
        self.mt = ModuleType.objects.get(tenant=self.tenant, name="C9300-NM-8X")
        resp = self.client.post(
            "/api/devices/",
            {"name": "sw1", "device_type_id": str(self.dt.id)},
            format="json",
        )
        assert resp.status_code == 201, resp.content
        self.device = Device.objects.get(tenant=self.tenant, name="sw1")

    def _bay(self):
        return self.device.module_bays.get()

    def test_bay_stamped_on_device_create(self):
        bay = self._bay()
        self.assertEqual(bay.name, "Network Module")
        self.assertEqual(bay.position, "1")

    def test_install_materialises_interfaces(self):
        resp = self.client.post(
            "/api/modules/",
            {
                "device_id": str(self.device.id),
                "module_bay_id": str(self._bay().id),
                "module_type_id": str(self.mt.id),
                "serial_number": "NM8X-0001",
            },
            format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(resp.json()["created_interfaces"], 2)
        names = set(self.device.interfaces.values_list("name", flat=True))
        # {module} → bay position "1".
        self.assertIn("TenGigabitEthernet1/1/1", names)
        self.assertIn("TenGigabitEthernet1/1/2", names)

    def test_module_type_faceplate_roundtrip(self):
        # Same doc rules as device types; served to the device render via
        # the modules list.
        doc = {"v": 1, "front": [{"id": "g1", "rows": 1, "bank": 0,
                                  "slots": [{"t": "port",
                                             "name": "TenGigabitEthernet1/{module}/1"}]}],
               "rear": []}
        r = self.client.patch(
            f"/api/module-types/{self.mt.id}/", {"faceplate": doc},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        # Invalid docs rejected by the shared validator.
        bad = self.client.patch(
            f"/api/module-types/{self.mt.id}/",
            {"faceplate": {"v": 2}}, format="json",
        )
        self.assertEqual(bad.status_code, 400)
        # Installed module rows carry the faceplate for composition.
        self.client.post("/api/modules/", {
            "device_id": str(self.device.id),
            "module_bay_id": str(self._bay().id),
            "module_type_id": str(self.mt.id),
        }, format="json")
        rows = self.client.get(
            f"/api/modules/?device={self.device.id}"
        ).json()["results"]
        self.assertEqual(
            rows[0]["module_type_faceplate"]["front"][0]["slots"][0]["name"],
            "TenGigabitEthernet1/{module}/1",
        )

    def test_bay_accepts_one_module(self):
        payload = {
            "device_id": str(self.device.id),
            "module_bay_id": str(self._bay().id),
            "module_type_id": str(self.mt.id),
        }
        self.assertEqual(
            self.client.post("/api/modules/", payload, format="json").status_code,
            201,
        )
        resp = self.client.post("/api/modules/", payload, format="json")
        self.assertEqual(resp.status_code, 400)
        self.assertIn("already has a module", str(resp.content))

    def test_bay_must_belong_to_device(self):
        other = Device.objects.create(tenant=self.tenant, name="other")
        resp = self.client.post(
            "/api/modules/",
            {
                "device_id": str(other.id),
                "module_bay_id": str(self._bay().id),
                "module_type_id": str(self.mt.id),
            },
            format="json",
        )
        self.assertEqual(resp.status_code, 400)

    def test_uninstall_removes_contributed_interfaces(self):
        resp = self.client.post(
            "/api/modules/",
            {
                "device_id": str(self.device.id),
                "module_bay_id": str(self._bay().id),
                "module_type_id": str(self.mt.id),
            },
            format="json",
        )
        module_id = resp.json()["id"]
        before = set(self.device.interfaces.values_list("name", flat=True))
        self.assertIn("TenGigabitEthernet1/1/1", before)
        self.assertEqual(
            self.client.delete(f"/api/modules/{module_id}/").status_code, 204
        )
        after = set(self.device.interfaces.values_list("name", flat=True))
        self.assertNotIn("TenGigabitEthernet1/1/1", after)
        # The device's own template interfaces survive.
        self.assertIn("GigabitEthernet1/0/1", after)

    def test_module_bays_listing(self):
        data = self.client.get(
            f"/api/module-bays/?device={self.device.id}"
        ).json()
        self.assertEqual(data["count"], 1)
        self.assertIsNone(data["results"][0]["module"])


class TenantIsolationTests(_Base):
    def test_module_type_isolated(self):
        other_org = Organization.objects.create(name="Evil", slug="evil")
        other = Tenant.objects.create(org=other_org, name="Evil", slug="evil")
        foreign = ModuleType.objects.create(tenant=other, name="X-NM")
        ModuleInterfaceTemplate.objects.create(module_type=foreign, name="x1")
        self.assertEqual(
            self.client.get(f"/api/module-types/{foreign.id}/").status_code, 404
        )
        data = self.client.get(
            f"/api/module-interface-templates/?module_type={foreign.id}"
        ).json()
        self.assertEqual(data["count"], 0)


class DeviceBayTests(_Base):
    def setUp(self):
        super().setUp()
        import_yaml_auto(self.tenant, CHASSIS_YAML)
        import_yaml_auto(self.tenant, BLADE_YAML)
        self.chassis_dt = DeviceType.objects.get(
            tenant=self.tenant, name="Blade Chassis 8"
        )
        self.blade_dt = DeviceType.objects.get(tenant=self.tenant, name="Blade B1")
        resp = self.client.post(
            "/api/devices/",
            {"name": "chassis-1", "device_type_id": str(self.chassis_dt.id)},
            format="json",
        )
        assert resp.status_code == 201, resp.content
        self.chassis = Device.objects.get(tenant=self.tenant, name="chassis-1")

    def test_import_maps_bays_and_roles(self):
        self.assertEqual(self.chassis_dt.subdevice_role, "parent")
        self.assertEqual(self.chassis_dt.device_bay_templates.count(), 2)
        self.assertEqual(self.blade_dt.subdevice_role, "child")
        self.assertTrue(self.blade_dt.exclude_from_utilization)

    def test_bays_stamped_and_child_installs(self):
        bays = list(self.chassis.device_bays.order_by("name"))
        self.assertEqual([b.name for b in bays], ["Slot 1", "Slot 2"])
        blade = Device.objects.create(
            tenant=self.tenant, name="blade-1", device_type=self.blade_dt
        )
        resp = self.client.patch(
            f"/api/device-bays/{bays[0].id}/",
            {"installed_device_id": str(blade.id)},
            format="json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(resp.json()["installed_device"]["name"], "blade-1")
        # Empty the bay again.
        resp = self.client.patch(
            f"/api/device-bays/{bays[0].id}/",
            {"installed_device_id": None},
            format="json",
        )
        self.assertEqual(resp.status_code, 200)
        self.assertIsNone(resp.json()["installed_device"])

    def test_parent_cannot_install_into_bay(self):
        bay = self.chassis.device_bays.first()
        other_chassis = Device.objects.create(
            tenant=self.tenant, name="chassis-2", device_type=self.chassis_dt
        )
        resp = self.client.patch(
            f"/api/device-bays/{bay.id}/",
            {"installed_device_id": str(other_chassis.id)},
            format="json",
        )
        self.assertEqual(resp.status_code, 400)
        self.assertIn("parent chassis", str(resp.content))

    def test_self_install_rejected(self):
        bay = self.chassis.device_bays.first()
        resp = self.client.patch(
            f"/api/device-bays/{bay.id}/",
            {"installed_device_id": str(self.chassis.id)},
            format="json",
        )
        self.assertEqual(resp.status_code, 400)

    def test_excluded_type_skips_rack_utilisation(self):
        from .models import Rack, Site

        site = Site.objects.create(tenant=self.tenant, name="s1")
        rack = Rack.objects.create(tenant=self.tenant, site=site, name="r-x")
        blank = Device.objects.create(
            tenant=self.tenant, name="blank-1", device_type=self.blade_dt,
            rack=rack, position=5,
        )
        self.assertIsNotNone(blank)
        data = self.client.get(f"/api/racks/{rack.id}/").json()
        self.assertEqual(data["used_units"], 0)


class InventoryItemTests(_Base):
    def setUp(self):
        super().setUp()
        import_yaml_auto(self.tenant, BLADE_YAML)
        self.dt = DeviceType.objects.get(tenant=self.tenant, name="Blade B1")
        resp = self.client.post(
            "/api/devices/",
            {"name": "blade-a", "device_type_id": str(self.dt.id)},
            format="json",
        )
        assert resp.status_code == 201, resp.content
        self.device = Device.objects.get(tenant=self.tenant, name="blade-a")

    def test_import_maps_inventory_items(self):
        tmpls = {t.name: t for t in self.dt.inventory_item_templates.all()}
        self.assertEqual(set(tmpls), {"PSU 1", "Fan tray"})
        self.assertEqual(tmpls["PSU 1"].part_id, "DPS-495")
        self.assertEqual(tmpls["PSU 1"].manufacturer.name, "Delta Electronics")
        self.assertIsNone(tmpls["Fan tray"].manufacturer)

    def test_items_stamped_on_device_create(self):
        items = {i.name: i for i in self.device.inventory_items.all()}
        self.assertEqual(set(items), {"PSU 1", "Fan tray"})
        self.assertEqual(items["PSU 1"].part_id, "DPS-495")

    def test_crud_and_nesting(self):
        parent = self.device.inventory_items.get(name="Fan tray")
        resp = self.client.post(
            "/api/inventory-items/",
            {"device_id": str(self.device.id), "name": "Fan 1",
             "parent_id": str(parent.id), "serial_number": "F-001"},
            format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        self.assertEqual(resp.json()["parent"]["name"], "Fan tray")
        # Parent must live on the same device.
        other = Device.objects.create(tenant=self.tenant, name="other")
        bad = self.client.post(
            "/api/inventory-items/",
            {"device_id": str(other.id), "name": "Fan 2",
             "parent_id": str(parent.id)},
            format="json",
        )
        self.assertEqual(bad.status_code, 400)
        self.assertIn("same device", str(bad.content))


class DefaultModuleTests(_Base):
    """A bay template can name a default module type, pre-seated when a device
    is created and into an *empty* matching bay on sync-from-type — never
    overwriting a module the operator installed by hand."""

    def setUp(self):
        super().setUp()
        import_yaml_auto(self.tenant, DEVICE_TYPE_YAML)
        import_yaml_auto(self.tenant, MODULE_TYPE_YAML)
        self.dt = DeviceType.objects.get(tenant=self.tenant, name="Catalyst 9300-24T")
        self.mt = ModuleType.objects.get(tenant=self.tenant, name="C9300-NM-8X")
        self.bay_tmpl = self.dt.module_bay_templates.get()

    def _make_device(self, name="sw1"):
        resp = self.client.post(
            "/api/devices/",
            {"name": name, "device_type_id": str(self.dt.id)},
            format="json",
        )
        assert resp.status_code == 201, resp.content
        return Device.objects.get(tenant=self.tenant, name=name)

    def test_default_seated_on_device_create(self):
        self.bay_tmpl.default_module_type = self.mt
        self.bay_tmpl.save()
        device = self._make_device()
        bay = device.module_bays.get()
        self.assertTrue(hasattr(bay, "module"))
        self.assertEqual(bay.module.module_type_id, self.mt.id)
        # {module} → bay position "1" — the module's interfaces materialise.
        names = set(device.interfaces.values_list("name", flat=True))
        self.assertIn("TenGigabitEthernet1/1/1", names)
        self.assertIn("TenGigabitEthernet1/1/2", names)

    def test_no_default_leaves_bay_empty(self):
        device = self._make_device()
        self.assertFalse(hasattr(device.module_bays.get(), "module"))

    def test_sync_seats_into_empty_bay(self):
        # Device created before a default existed → bay empty.
        device = self._make_device()
        self.assertFalse(hasattr(device.module_bays.get(), "module"))
        # Operator adds a default and syncs the device from its type.
        self.bay_tmpl.default_module_type = self.mt
        self.bay_tmpl.save()
        sync_device_components(device)
        bay = device.module_bays.get()
        self.assertTrue(hasattr(bay, "module"))
        self.assertEqual(bay.module.module_type_id, self.mt.id)

    def test_sync_does_not_overwrite_manual_module(self):
        other = ModuleType.objects.create(tenant=self.tenant, name="C9300-NM-2Q")
        device = self._make_device()
        bay = device.module_bays.get()
        resp = self.client.post(
            "/api/modules/",
            {
                "device_id": str(device.id),
                "module_bay_id": str(bay.id),
                "module_type_id": str(other.id),
            },
            format="json",
        )
        self.assertEqual(resp.status_code, 201, resp.content)
        # Set a *different* default and sync — the hand-installed module stays.
        self.bay_tmpl.default_module_type = self.mt
        self.bay_tmpl.save()
        sync_device_components(device)
        modules = Module.objects.filter(module_bay=bay)
        self.assertEqual(modules.count(), 1)
        self.assertEqual(modules.get().module_type_id, other.id)

    def test_default_module_type_roundtrips_via_api(self):
        resp = self.client.patch(
            f"/api/module-bay-templates/{self.bay_tmpl.id}/",
            {"default_module_type_id": str(self.mt.id)},
            format="json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertEqual(resp.json()["default_module_type"]["id"], str(self.mt.id))
        self.bay_tmpl.refresh_from_db()
        self.assertEqual(self.bay_tmpl.default_module_type_id, self.mt.id)
        # Clear it back to an empty bay.
        resp = self.client.patch(
            f"/api/module-bay-templates/{self.bay_tmpl.id}/",
            {"default_module_type_id": None},
            format="json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        self.bay_tmpl.refresh_from_db()
        self.assertIsNone(self.bay_tmpl.default_module_type_id)

    def test_cross_tenant_default_rejected(self):
        other_org = Organization.objects.create(name="Beta", slug="beta")
        other_tenant = Tenant.objects.create(
            org=other_org, name="Beta", slug="beta"
        )
        foreign = ModuleType.objects.create(tenant=other_tenant, name="Foreign")
        resp = self.client.patch(
            f"/api/module-bay-templates/{self.bay_tmpl.id}/",
            {"default_module_type_id": str(foreign.id)},
            format="json",
        )
        self.assertEqual(resp.status_code, 400, resp.content)
        self.bay_tmpl.refresh_from_db()
        self.assertIsNone(self.bay_tmpl.default_module_type_id)
