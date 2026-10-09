"""Installed modules own the interfaces they create (#333).

Install records ``Interface.module`` and refuses a name the device already
uses; removing the module - directly, through its bay, or by changing its
type - removes exactly those interfaces; sync-from-type never counts them
as extras. Also covers the 0196 backfill heuristic.
"""
from __future__ import annotations

import datetime
from importlib import import_module

from django.apps import apps as django_apps
from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from api.tests import status_for
from core.models import Organization, Tenant

from .models import (
    Device,
    DeviceType,
    Interface,
    InterfaceTemplate,
    IPAddress,
    Module,
    ModuleBayTemplate,
    ModuleInterfaceTemplate,
    ModuleType,
    Prefix,
    diff_device_components,
    materialize_device_components,
    sync_device_components,
)

User = get_user_model()


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "admin@example.com", "x")
        self.client.force_login(admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

        # Device type: native Te1/1/1 and Gi0/0/1, one bay "Slot1" at position 1.
        self.dt = DeviceType.objects.create(tenant=self.tenant, name="SW-48")
        InterfaceTemplate.objects.create(
            device_type=self.dt, name="Gi0/0/1", type="1000base-t"
        )
        ModuleBayTemplate.objects.create(
            device_type=self.dt, name="Slot1", position="1"
        )
        self.device = Device.objects.create(
            tenant=self.tenant, name="sw1", device_type=self.dt
        )
        materialize_device_components(self.device)
        self.bay = self.device.module_bays.get(name="Slot1")

        self.nm8x = ModuleType.objects.create(tenant=self.tenant, name="NM-8X")
        for n in ("Te1/{module}/1", "Te1/{module}/2"):
            ModuleInterfaceTemplate.objects.create(
                module_type=self.nm8x, name=n, type="10gbase-x-sfpp"
            )
        self.nm1g = ModuleType.objects.create(tenant=self.tenant, name="NM-1G")
        for n in ("Gi1/{module}/1", "Gi1/{module}/2"):
            ModuleInterfaceTemplate.objects.create(
                module_type=self.nm1g, name=n, type="1000base-t"
            )

    def _names(self):
        return set(self.device.interfaces.values_list("name", flat=True))

    def _install(self, module_type, bay=None):
        return self.client.post(
            "/api/modules/",
            {
                "device_id": str(self.device.id),
                "module_bay_id": str((bay or self.bay).id),
                "module_type_id": str(module_type.id),
            },
            format="json",
        )


class InstallOwnershipTests(_Base):
    def test_install_records_owner(self):
        r = self._install(self.nm8x)
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["created_interfaces"], 2)
        module = Module.objects.get(pk=r.json()["id"])
        self.assertEqual(
            set(module.interfaces.values_list("name", flat=True)),
            {"Te1/1/1", "Te1/1/2"},
        )
        self.assertIsNone(self.device.interfaces.get(name="Gi0/0/1").module_id)
        iface = self.device.interfaces.get(name="Te1/1/1")
        row = self.client.get(f"/api/interfaces/{iface.id}/").json()
        self.assertEqual(row["module_id"], str(module.id))

    def test_name_clash_with_native_interface_is_refused(self):
        native = Interface.objects.create(device=self.device, name="Te1/1/1")
        r = self._install(self.nm8x)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("Te1/1/1", r.json()["module_type_id"])
        # Nothing half-installed: no module row, no new interface, native kept.
        self.assertFalse(Module.objects.exists())
        self.assertEqual(self._names(), {"Gi0/0/1", "Te1/1/1"})
        native.refresh_from_db()
        self.assertIsNone(native.module_id)

    def test_clash_with_another_modules_interface_is_refused(self):
        ModuleBayTemplate.objects.create(
            device_type=self.dt, name="Slot1b", position="1"
        )
        materialize_device_components(self.device)
        self.assertEqual(self._install(self.nm8x).status_code, 201)
        r = self._install(self.nm8x, bay=self.device.module_bays.get(name="Slot1b"))
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(Module.objects.count(), 1)

    def test_default_module_with_clash_is_not_seated(self):
        tmpl = self.dt.module_bay_templates.get()
        tmpl.default_module_type = self.nm8x
        tmpl.save()
        InterfaceTemplate.objects.create(
            device_type=self.dt, name="Te1/1/1", type="10gbase-x-sfpp"
        )
        dev = Device.objects.create(tenant=self.tenant, name="sw2", device_type=self.dt)
        materialize_device_components(dev)
        self.assertFalse(dev.modules.exists())
        self.assertIsNone(dev.interfaces.get(name="Te1/1/1").module_id)


class UninstallTests(_Base):
    def test_remove_module_keeps_native_interface_of_same_name(self):
        # A module recorded before ownership: the native Te1/1/1 shares the
        # rendered name but was never the module's (report case 1).
        Interface.objects.create(device=self.device, name="Te1/1/1")
        module = Module.objects.create(
            device=self.device, module_bay=self.bay, module_type=self.nm8x
        )
        r = self.client.delete(f"/api/modules/{module.id}/")
        self.assertEqual(r.status_code, 204)
        self.assertIn("Te1/1/1", self._names())

    def test_remove_module_deletes_only_its_own(self):
        module_id = self._install(self.nm8x).json()["id"]
        self.assertEqual(
            self.client.delete(f"/api/modules/{module_id}/").status_code, 204
        )
        self.assertEqual(self._names(), {"Gi0/0/1"})

    def test_removes_renamed_interface_it_owns(self):
        module_id = self._install(self.nm8x).json()["id"]
        Interface.objects.filter(name="Te1/1/1").update(name="uplink-a")
        self.client.delete(f"/api/modules/{module_id}/")
        self.assertEqual(self._names(), {"Gi0/0/1"})

    def test_ip_assignment_follows_interface_delete_rule(self):
        module_id = self._install(self.nm8x).json()["id"]
        iface = self.device.interfaces.get(name="Te1/1/1")
        prefix = Prefix.objects.create(
            tenant=self.tenant, cidr="10.9.9.0/24", status=status_for(self.tenant)
        )
        ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.9.9.1", prefix=prefix,
            assigned_device=self.device, assigned_interface=iface,
        )
        self.client.delete(f"/api/modules/{module_id}/")
        ip.refresh_from_db()
        # The address survives, unassigned - the interface delete rule.
        self.assertIsNone(ip.assigned_interface_id)

    def test_bay_delete_removes_module_interfaces(self):
        self._install(self.nm8x)
        r = self.client.delete(f"/api/module-bays/{self.bay.id}/")
        self.assertEqual(r.status_code, 204, r.content)
        self.assertFalse(Module.objects.exists())
        self.assertEqual(self._names(), {"Gi0/0/1"})

    def test_bay_queryset_delete_removes_module_interfaces(self):
        self._install(self.nm8x)
        self.device.module_bays.all().delete()
        self.assertEqual(self._names(), {"Gi0/0/1"})

    def test_device_delete_cascades(self):
        self._install(self.nm8x)
        self.device.delete()
        self.assertFalse(Interface.objects.exists())
        self.assertFalse(Module.objects.exists())


class TypeChangeTests(_Base):
    def test_patch_type_swaps_interfaces(self):
        module_id = self._install(self.nm8x).json()["id"]
        r = self.client.patch(
            f"/api/modules/{module_id}/",
            {"module_type_id": str(self.nm1g.id)},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self._names(), {"Gi0/0/1", "Gi1/1/1", "Gi1/1/2"})
        module = Module.objects.get(pk=module_id)
        self.assertEqual(module.interfaces.count(), 2)
        self.client.delete(f"/api/modules/{module_id}/")
        self.assertEqual(self._names(), {"Gi0/0/1"})

    def test_patch_other_fields_keeps_interfaces(self):
        module_id = self._install(self.nm8x).json()["id"]
        iface = self.device.interfaces.get(name="Te1/1/1")
        r = self.client.patch(
            f"/api/modules/{module_id}/", {"serial_number": "X1"}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(Interface.objects.filter(pk=iface.pk).exists())

    def test_type_change_clash_rolls_back(self):
        module_id = self._install(self.nm8x).json()["id"]
        Interface.objects.create(device=self.device, name="Gi1/1/1")
        r = self.client.patch(
            f"/api/modules/{module_id}/",
            {"module_type_id": str(self.nm1g.id)},
            format="json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        module = Module.objects.get(pk=module_id)
        self.assertEqual(module.module_type_id, self.nm8x.id)
        self.assertEqual(
            set(module.interfaces.values_list("name", flat=True)),
            {"Te1/1/1", "Te1/1/2"},
        )

    def test_move_to_another_bay_rerenders(self):
        ModuleBayTemplate.objects.create(
            device_type=self.dt, name="Slot2", position="2"
        )
        materialize_device_components(self.device)
        module_id = self._install(self.nm8x).json()["id"]
        slot2 = self.device.module_bays.get(name="Slot2")
        r = self.client.patch(
            f"/api/modules/{module_id}/",
            {"module_bay_id": str(slot2.id)},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self._names(), {"Gi0/0/1", "Te1/2/1", "Te1/2/2"})

    def test_move_to_occupied_bay_refused(self):
        ModuleBayTemplate.objects.create(
            device_type=self.dt, name="Slot2", position="2"
        )
        materialize_device_components(self.device)
        slot2 = self.device.module_bays.get(name="Slot2")
        first = self._install(self.nm8x).json()["id"]
        self.assertEqual(self._install(self.nm1g, bay=slot2).status_code, 201)
        r = self.client.patch(
            f"/api/modules/{first}/", {"module_bay_id": str(slot2.id)}, format="json"
        )
        self.assertEqual(r.status_code, 400, r.content)


class SyncTests(_Base):
    def setUp(self):
        super().setUp()
        self.bay.position = "0"
        self.bay.save()
        self.assertEqual(self._install(self.nm1g).status_code, 201)

    def test_module_interfaces_are_not_extras(self):
        diff = diff_device_components(self.device)
        self.assertNotIn("interfaces", diff)

    def test_remove_extra_keeps_module_interfaces(self):
        Interface.objects.create(device=self.device, name="Gi9/9")
        r = self.client.post(
            f"/api/devices/{self.device.id}/sync-from-type/",
            {"apply": True, "remove_extra": True},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self._names(), {"Gi0/0/1", "Gi1/0/1", "Gi1/0/2"})
        self.assertTrue(Module.objects.exists())

    def test_unowned_legacy_module_names_are_not_extras(self):
        # Before ownership was recorded (or an ambiguous backfill): the name
        # still matches the installed module, so sync leaves it alone.
        Interface.objects.filter(module__isnull=False).update(module=None)
        sync_device_components(self.device, remove_extra=True)
        self.assertEqual(self._names(), {"Gi0/0/1", "Gi1/0/1", "Gi1/0/2"})


class BackfillTests(_Base):
    """api 0196: mark existing module interfaces as owned, conservatively."""

    def _run(self):
        mig = import_module("api.migrations.0198_interface_module")
        mig.backfill_module_ownership(django_apps, None)

    def _legacy_module(self, module_type, bay=None):
        module = Module.objects.create(
            device=self.device, module_bay=bay or self.bay, module_type=module_type
        )
        # What the old install did: plain interfaces, no owner.
        for t in module_type.interface_templates.all():
            Interface.objects.create(
                device=self.device,
                name=t.name.replace("{module}", (bay or self.bay).position),
            )
        return module

    def test_claims_unambiguous_module_interfaces(self):
        module = self._legacy_module(self.nm8x)
        self._run()
        self.assertEqual(
            set(module.interfaces.values_list("name", flat=True)),
            {"Te1/1/1", "Te1/1/2"},
        )
        self.assertIsNone(self.device.interfaces.get(name="Gi0/0/1").module_id)

    def test_skips_device_type_names(self):
        InterfaceTemplate.objects.create(
            device_type=self.dt, name="Te1/1/1", type="10gbase-x-sfpp"
        )
        module = self._legacy_module(self.nm8x)
        self._run()
        self.assertEqual(
            set(module.interfaces.values_list("name", flat=True)), {"Te1/1/2"}
        )

    def test_skips_interface_older_than_module(self):
        Interface.objects.create(device=self.device, name="Te1/1/1")
        Interface.objects.filter(name="Te1/1/1").update(
            created_at=datetime.datetime(2020, 1, 1, tzinfo=datetime.UTC)
        )
        module = Module.objects.create(
            device=self.device, module_bay=self.bay, module_type=self.nm8x
        )
        Interface.objects.create(device=self.device, name="Te1/1/2")
        self._run()
        self.assertEqual(
            set(module.interfaces.values_list("name", flat=True)), {"Te1/1/2"}
        )

    def test_skips_name_claimed_by_two_modules(self):
        ModuleBayTemplate.objects.create(
            device_type=self.dt, name="Slot1b", position="1"
        )
        materialize_device_components(self.device)
        a = self._legacy_module(self.nm8x)
        b = Module.objects.create(
            device=self.device,
            module_bay=self.device.module_bays.get(name="Slot1b"),
            module_type=self.nm8x,
        )
        self._run()
        self.assertFalse(a.interfaces.exists())
        self.assertFalse(b.interfaces.exists())

    def test_skips_photo_marker_names(self):
        self.dt.image_ports = {
            "front": [{"kind": "interface", "name": "Te1/1/2", "x": 0, "y": 0}]
        }
        self.dt.save()
        module = self._legacy_module(self.nm8x)
        self._run()
        self.assertEqual(
            set(module.interfaces.values_list("name", flat=True)), {"Te1/1/1"}
        )
