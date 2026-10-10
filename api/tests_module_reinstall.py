"""Editing an installed module keeps the interfaces that still correspond
(#366), and copies of a module's interface never inherit its ownership (#367).

A bay move or type change renames corresponding interfaces in place - same
id, cable, IPs, VLANs, LAG membership, MACs, tags, custom fields and
description - removes only the ports the new type no longer has, and creates
only the new ones. Removing an interface that carries a cable or an IP needs
``confirm_remove``.
"""
from __future__ import annotations

from importlib import import_module

from django.apps import apps as django_apps

from api.tests import status_for
from core.models import Tag

from .models import (
    VLAN,
    Cable,
    CableTermination,
    Device,
    Interface,
    IPAddress,
    MACAddress,
    Module,
    ModuleBayTemplate,
    ModuleInterfaceTemplate,
    ModuleType,
    Prefix,
    materialize_device_components,
)
from .tests_module_ownership import _Base


class _Reinstall(_Base):
    def setUp(self):
        super().setUp()
        ModuleBayTemplate.objects.create(
            device_type=self.dt, name="Slot2", position="2"
        )
        materialize_device_components(self.device)
        self.slot2 = self.device.module_bays.get(name="Slot2")
        self.module_id = self._install(self.nm8x).json()["id"]
        self.te1 = self.device.interfaces.get(name="Te1/1/1")
        self.peer_dev = Device.objects.create(tenant=self.tenant, name="peer")
        self.peer = Interface.objects.create(device=self.peer_dev, name="eth0")

    def _patch(self, **body):
        return self.client.patch(
            f"/api/modules/{self.module_id}/", body, format="json"
        )

    def _cable(self, iface):
        cable = Cable.objects.create(tenant=self.tenant, label="C1")
        CableTermination.objects.create(cable=cable, end="A", interface=iface)
        CableTermination.objects.create(cable=cable, end="B", interface=self.peer)
        return cable

    def _ip(self, iface, addr="10.8.8.1"):
        prefix, _ = Prefix.objects.get_or_create(
            tenant=self.tenant, cidr="10.8.8.0/24",
            defaults={"status": status_for(self.tenant)},
        )
        return IPAddress.objects.create(
            tenant=self.tenant, ip_address=addr, prefix=prefix,
            assigned_device=self.device, assigned_interface=iface,
        )

    def _type(self, name, names, media="10gbase-x-sfpp"):
        mt = ModuleType.objects.create(tenant=self.tenant, name=name)
        for n in names:
            ModuleInterfaceTemplate.objects.create(
                module_type=mt, name=n, type=media
            )
        return mt


class BayMoveKeepsInterfacesTests(_Reinstall):
    def test_move_renames_in_place_and_keeps_references(self):
        """The report's case: cable, IP and description survive a bay move."""
        cable = self._cable(self.te1)
        ip = self._ip(self.te1)
        vlan = VLAN.objects.create(tenant=self.tenant, vlan_id=10, name="v10")
        lag = Interface.objects.create(device=self.device, name="Po1", type="lag")
        tag = Tag.objects.create(tenant=self.tenant, name="core", slug="core")
        mac = MACAddress.objects.create(
            tenant=self.tenant, mac_address="00:11:22:33:44:55",
            assigned_interface=self.te1,
        )
        Interface.objects.filter(pk=self.te1.pk).update(
            description="to core", vlan=vlan, lag=lag,
            custom_fields={"circuit": "X1"},
        )
        self.te1.tags.add(tag)

        r = self._patch(module_bay_id=str(self.slot2.id))
        self.assertEqual(r.status_code, 200, r.content)

        self.assertEqual(self._names(), {"Gi0/0/1", "Te1/2/1", "Te1/2/2", "Po1"})
        moved = Interface.objects.get(pk=self.te1.pk)
        self.assertEqual(moved.name, "Te1/2/1")
        self.assertEqual(str(moved.module_id), self.module_id)
        self.assertEqual(moved.description, "to core")
        self.assertEqual(moved.vlan_id, vlan.pk)
        self.assertEqual(moved.lag_id, lag.pk)
        self.assertEqual(moved.custom_fields, {"circuit": "X1"})
        self.assertEqual(list(moved.tags.all()), [tag])
        self.assertEqual(
            set(cable.terminations.values_list("interface_id", flat=True)),
            {self.te1.pk, self.peer.pk},
        )
        ip.refresh_from_db()
        self.assertEqual(ip.assigned_interface_id, self.te1.pk)
        mac.refresh_from_db()
        self.assertEqual(mac.assigned_interface_id, self.te1.pk)

    def test_move_reports_renames(self):
        r = self._patch(module_bay_id=str(self.slot2.id))
        report = r.json()["interfaces"]
        self.assertEqual(
            sorted((x["from"], x["to"]) for x in report["renamed"]),
            [("Te1/1/1", "Te1/2/1"), ("Te1/1/2", "Te1/2/2")],
        )
        self.assertEqual(report["created"], [])
        self.assertEqual(report["removed"], [])

    def test_operator_renamed_interface_keeps_its_name(self):
        Interface.objects.filter(pk=self.te1.pk).update(name="uplink-a")
        r = self._patch(module_bay_id=str(self.slot2.id))
        self.assertEqual(r.status_code, 200, r.content)
        # Followed by template identity: no duplicate Te1/2/1 appears.
        self.assertEqual(self._names(), {"Gi0/0/1", "uplink-a", "Te1/2/2"})
        self.assertTrue(Interface.objects.filter(pk=self.te1.pk).exists())

    def test_move_and_back_round_trips(self):
        self._patch(module_bay_id=str(self.slot2.id))
        r = self._patch(module_bay_id=str(self.bay.id))
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(
            self.device.interfaces.get(name="Te1/1/1").pk, self.te1.pk
        )

    def test_move_clash_with_native_interface_rolls_back(self):
        Interface.objects.create(device=self.device, name="Te1/2/2")
        r = self._patch(module_bay_id=str(self.slot2.id))
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("Te1/2/2", r.json()["module_type_id"])
        module = Module.objects.get(pk=self.module_id)
        self.assertEqual(module.module_bay_id, self.bay.id)
        self.te1.refresh_from_db()
        self.assertEqual(self.te1.name, "Te1/1/1")

    def test_legacy_interface_without_template_link_matches_by_name(self):
        # Owned before template identity was recorded (0203 found no match,
        # or the link was lost): the rendered name still identifies it.
        Interface.objects.filter(module_id=self.module_id).update(module_template=None)
        r = self._patch(module_bay_id=str(self.slot2.id))
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.device.interfaces.get(name="Te1/2/1").pk, self.te1.pk)
        self.assertEqual(self._names(), {"Gi0/0/1", "Te1/2/1", "Te1/2/2"})


class TypeChangeKeepsInterfacesTests(_Reinstall):
    def test_same_layout_type_keeps_interfaces(self):
        """The report's second case: NM-8X → NM-8X-v2 with identical ports."""
        v2 = self._type("NM-8X-v2", ["Te1/{module}/1", "Te1/{module}/2"])
        cable = self._cable(self.te1)
        ip = self._ip(self.te1)
        Interface.objects.filter(pk=self.te1.pk).update(description="to core")

        r = self._patch(module_type_id=str(v2.id))
        self.assertEqual(r.status_code, 200, r.content)
        kept = Interface.objects.get(pk=self.te1.pk)
        self.assertEqual(kept.name, "Te1/1/1")
        self.assertEqual(kept.description, "to core")
        self.assertEqual(kept.module_template.module_type_id, v2.id)
        ip.refresh_from_db()
        self.assertEqual(ip.assigned_interface_id, self.te1.pk)
        self.assertEqual(cable.terminations.count(), 2)
        self.assertEqual(sorted(r.json()["interfaces"]["kept"]), ["Te1/1/1", "Te1/1/2"])

    def test_renamed_scheme_pairs_by_position(self):
        other = self._type("NM-8X-R", ["Ten{module}/1", "Ten{module}/2"])
        r = self._patch(module_type_id=str(other.id))
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.device.interfaces.get(name="Ten1/1").pk, self.te1.pk)
        self.assertEqual(self._names(), {"Gi0/0/1", "Ten1/1", "Ten1/2"})

    def test_media_change_with_same_name_updates_type(self):
        other = self._type(
            "NM-8X-1G", ["Te1/{module}/1", "Te1/{module}/2"], media="1000base-x-sfp"
        )
        self._patch(module_type_id=str(other.id))
        self.te1.refresh_from_db()
        self.assertEqual(self.te1.type, "1000base-x-sfp")

    def test_bigger_type_creates_only_new_ports(self):
        big = self._type(
            "NM-8X-4", ["Te1/{module}/1", "Te1/{module}/2", "Te1/{module}/3"]
        )
        r = self._patch(module_type_id=str(big.id))
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["interfaces"]["created"], ["Te1/1/3"])
        self.assertEqual(self.device.interfaces.get(name="Te1/1/1").pk, self.te1.pk)
        self.assertEqual(Module.objects.get(pk=self.module_id).interfaces.count(), 3)

    def test_smaller_type_removes_only_missing_ports(self):
        small = self._type("NM-1X", ["Te1/{module}/1"])
        r = self._patch(module_type_id=str(small.id))
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["interfaces"]["removed"], ["Te1/1/2"])
        self.assertEqual(self._names(), {"Gi0/0/1", "Te1/1/1"})
        self.assertEqual(self.device.interfaces.get(name="Te1/1/1").pk, self.te1.pk)

    def test_different_media_without_connections_swaps(self):
        r = self._patch(module_type_id=str(self.nm1g.id))
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self._names(), {"Gi0/0/1", "Gi1/1/1", "Gi1/1/2"})
        self.assertFalse(Interface.objects.filter(pk=self.te1.pk).exists())

    def test_removing_cabled_interface_needs_confirmation(self):
        cable = self._cable(self.te1)
        ip = self._ip(self.te1)
        r = self._patch(module_type_id=str(self.nm1g.id))
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("Te1/1/1", r.json()["confirm_remove"])
        # Nothing changed.
        self.assertEqual(
            Module.objects.get(pk=self.module_id).module_type_id, self.nm8x.id
        )
        self.assertTrue(Interface.objects.filter(pk=self.te1.pk).exists())
        self.assertEqual(cable.terminations.count(), 2)

        r = self._patch(module_type_id=str(self.nm1g.id), confirm_remove=True)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIn("Te1/1/1", r.json()["interfaces"]["removed"])
        # The documented interface delete rules: a cable left with no port
        # on one end goes with it (#378).
        self.assertFalse(Cable.objects.filter(pk=cable.pk).exists())
        ip.refresh_from_db()
        self.assertIsNone(ip.assigned_interface_id)

    def test_removing_unconnected_interface_needs_no_confirmation(self):
        Interface.objects.filter(pk=self.te1.pk).update(description="spare")
        small = self._type("NM-1X", ["Te1/{module}/2"])
        r = self._patch(module_type_id=str(small.id))
        self.assertEqual(r.status_code, 200, r.content)

    def test_type_and_bay_change_together(self):
        v2 = self._type("NM-8X-v2", ["Te1/{module}/1", "Te1/{module}/2"])
        ip = self._ip(self.te1)
        r = self._patch(module_type_id=str(v2.id), module_bay_id=str(self.slot2.id))
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.device.interfaces.get(name="Te1/2/1").pk, self.te1.pk)
        ip.refresh_from_db()
        self.assertEqual(ip.assigned_interface_id, self.te1.pk)

    def test_rename_is_audited(self):
        from audit.models import ChangeLogEntry

        self._patch(module_bay_id=str(self.slot2.id))
        entry = ChangeLogEntry.objects.filter(object_id=str(self.te1.pk)).latest("timestamp")
        self.assertEqual(entry.changes["name"]["new"], "Te1/2/1")


class DeviceMoveTests(_Reinstall):
    def setUp(self):
        super().setUp()
        self.other = Device.objects.create(
            tenant=self.tenant, name="sw2", device_type=self.dt
        )
        materialize_device_components(self.other)
        self.other_bay = self.other.module_bays.get(name="Slot1")

    def test_device_move_recreates_on_the_new_device(self):
        r = self._patch(
            device_id=str(self.other.id), module_bay_id=str(self.other_bay.id)
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self._names(), {"Gi0/0/1"})
        self.assertEqual(
            set(self.other.interfaces.values_list("name", flat=True)),
            {"Gi0/0/1", "Te1/1/1", "Te1/1/2"},
        )

    def test_device_move_with_cable_needs_confirmation(self):
        self._cable(self.te1)
        r = self._patch(
            device_id=str(self.other.id), module_bay_id=str(self.other_bay.id)
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertTrue(Interface.objects.filter(pk=self.te1.pk).exists())


class TemplateLinkBackfillTests(_Base):
    """api 0203: link owned interfaces to the template they render from."""

    def test_links_by_rendered_name(self):
        module_id = self._install(self.nm8x).json()["id"]
        Interface.objects.filter(module_id=module_id).update(module_template=None)
        Interface.objects.filter(name="Te1/1/2").update(name="renamed")
        mig = import_module("api.migrations.0203_interface_module_template")
        mig.backfill_module_template(django_apps, None)
        t1 = self.nm8x.interface_templates.get(name="Te1/{module}/1")
        self.assertEqual(self.device.interfaces.get(name="Te1/1/1").module_template_id, t1.pk)
        self.assertIsNone(self.device.interfaces.get(name="renamed").module_template_id)


class CloneDropsModuleTests(_Base):
    """#367: a copy of a module's interface is the device's own."""

    def setUp(self):
        super().setUp()
        self.module_id = self._install(self.nm8x).json()["id"]
        self.te1 = self.device.interfaces.get(name="Te1/1/1")

    def test_bulk_clone_is_not_module_owned(self):
        r = self.client.post(
            "/api/interfaces/bulk-clone/",
            {"ids": [str(self.te1.id)], "find": "Te1/1/1", "replace": "Te1/1/1.100"},
            format="json",
        )
        self.assertEqual(r.status_code, 201, r.content)
        clone = self.device.interfaces.get(name="Te1/1/1.100")
        self.assertIsNone(clone.module_id)
        self.assertIsNone(clone.module_template_id)
        self.assertEqual(clone.type, self.te1.type)

    def test_clone_survives_module_removal(self):
        self.client.post(
            "/api/interfaces/bulk-clone/",
            {"ids": [str(self.te1.id)], "find": "Te1/1/1", "replace": "Te1/1/1.100"},
            format="json",
        )
        r = self.client.delete(f"/api/modules/{self.module_id}/")
        self.assertEqual(r.status_code, 204)
        self.assertEqual(self._names(), {"Gi0/0/1", "Te1/1/1.100"})

    def test_clone_survives_module_move(self):
        ModuleBayTemplate.objects.create(
            device_type=self.dt, name="Slot2", position="2"
        )
        materialize_device_components(self.device)
        self.client.post(
            "/api/interfaces/bulk-clone/",
            {"ids": [str(self.te1.id)], "find": "Te1/1/1", "replace": "Te1/1/1.100"},
            format="json",
        )
        slot2 = self.device.module_bays.get(name="Slot2")
        r = self.client.patch(
            f"/api/modules/{self.module_id}/",
            {"module_bay_id": str(slot2.id)}, format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertIn("Te1/1/1.100", self._names())

    def test_module_is_not_an_import_column(self):
        # Interfaces have no import endpoint today; ownership stays out of
        # any generic import or form built from the model.
        from .bulk_import import importable_field_names

        names = {f["name"] for f in importable_field_names(Interface)}
        self.assertNotIn("module", names)
        self.assertNotIn("module_template", names)
