"""A re-import that turns a fixed port into a module bay (api.model_pack_bays):
the C9200-24T's StackPort interfaces becoming stack adapter bays that take
C9200-STACK-KIT. Devices of the type get the bays; a stack port in use moves
onto a kit installed in its bay, one not in use is kept and reported."""
from __future__ import annotations

import copy

from audit.models import ChangeLogEntry

from .models import (
    Cable,
    CableTermination,
    Device,
    DeviceRole,
    Interface,
    IPAddress,
    Module,
    ModuleBay,
    ModuleType,
    Prefix,
    Site,
    VirtualChassis,
    materialize_device_components,
)
from .tests_model_pack_update import _Base, bay, old_c9200, real

KIT = {"manufacturer": "Cisco", "model": "C9200-STACK-KIT", "part_number": "C9200-STACK-KIT",
       "interfaces": [{"name": "StackPort{module}", "type": "cisco-stackwise-160"}]}


def kit(part, ptype):
    return {**copy.deepcopy(KIT), "model": part, "part_number": part,
            "interfaces": [{"name": "StackPort{module}", "type": ptype}]}


class PortToBayTests(_Base):
    def setUp(self):
        super().setUp()
        self.run_pack({"C9200-24T": old_c9200()})
        self.dt0 = self.dt("C9200-24T")
        self.site = Site.objects.create(tenant=self.tenant, name="S")
        self.role = DeviceRole.objects.create(tenant=self.tenant, name="Access", slug="access")
        self.n = 0

    def device(self, name, tenant=None, dt=None):
        tenant = tenant or self.tenant
        site = self.site if tenant == self.tenant else Site.objects.get_or_create(
            tenant=tenant, name="S")[0]
        d = Device.objects.create(tenant=tenant, name=name, site=site,
                                  device_type=dt or self.dt0)
        materialize_device_components(d)
        return d

    def port(self, dev, name="StackPort1/1"):
        return Interface.objects.get(device=dev, name=name)

    def cable(self, a, b, **kw):
        c = Cable.objects.create(tenant=self.tenant, **kw)
        CableTermination.objects.create(cable=c, end="A", interface=a)
        CableTermination.objects.create(cable=c, end="B", interface=b)
        return c

    def stack(self, *devs, auto=True):
        vc = VirtualChassis.objects.create(tenant=self.tenant, name="STK",
                                           auto_connect_stack=auto)
        for i, d in enumerate(devs, 1):
            Device.objects.filter(pk=d.pk).update(virtual_chassis=vc, vc_position=i)
            d.refresh_from_db()
        return vc

    def upgrade(self, *, dry_run=False, doc=None, modules=None, version="2.0.0"):
        result = self.run_pack({"C9200-24T": doc or real("C9200-24T")}, dry_run=dry_run,
                               modules=modules or {"C9200-STACK-KIT": KIT}, version=version)
        return self.row(result, "C9200-24T")

    def test_a_port_in_use_moves_onto_a_kit_in_its_bay(self):
        sw1, sw2, sw3 = self.device("sw1"), self.device("sw2"), self.device("sw3")
        vc = self.stack(sw1, sw2)
        # The ring an auto-connect stack records.
        c1 = self.cable(self.port(sw1, "StackPort1/1"), self.port(sw2, "StackPort1/2"),
                        auto_source="stack", auto_chassis=vc, type="stack")
        before = {d.name: (self.port(d).pk, self.port(d, "StackPort1/2").pk)
                  for d in (sw1, sw2, sw3)}
        row = self.upgrade()
        self.assertIn("removed 2 interfaces: StackPort1/1, StackPort1/2", row.notes)
        self.assertIn("devices: added module bays StackPort1/1, StackPort1/2 to 3 devices: "
                      "sw1, sw2, sw3",
                      row.notes)
        self.assertIn("devices: installed 4 C9200-STACK-KIT modules in StackPort1/1, "
                      "StackPort1/2 on 2 devices, each holding the existing port it replaces: "
                      "sw1, sw2", row.notes)
        self.assertIn("devices: moved 4 interfaces onto the modules - cables, stack links "
                      "and history stay", row.notes)
        self.assertIn("devices: kept 2 interfaces StackPort1/1, StackPort1/2 on 1 device, not "
                      "in use - install a module in the bay or delete them: sw3", row.notes)
        for d in (sw1, sw2):
            for i, name in enumerate(("StackPort1/1", "StackPort1/2")):
                p = self.port(d, name)
                self.assertEqual(p.pk, before[d.name][i])
                self.assertIsNotNone(p.module_id)
                self.assertEqual(p.module.module_bay.name, name)
                self.assertEqual(p.module.module_type.part_number, "C9200-STACK-KIT")
                self.assertEqual(p.module_template.name, "StackPort{module}")
                # Untouched since its template made it: the kit's type.
                self.assertEqual(p.type, "cisco-stackwise-160")
                self.assertIn("Added by pack import Catalyst 2.0.0", p.module.description)
            self.assertEqual(d.interfaces.filter(name__startswith="StackPort").count(), 2)
        c1.refresh_from_db()
        self.assertEqual((c1.auto_source, c1.auto_chassis_id), ("stack", vc.pk))
        self.assertEqual(sorted(CableTermination.objects.filter(cable=c1).values_list(
            "interface_id", flat=True)), sorted([before["sw1"][0], before["sw2"][1]]))
        # Not in use: left as it was, the bays empty.
        self.assertIsNone(self.port(sw3).module_id)
        self.assertEqual(sorted(sw3.module_bays.filter(name__startswith="Stack")
                                .values_list("name", flat=True)),
                         ["StackPort1/1", "StackPort1/2"])
        self.assertFalse(Module.objects.filter(device=sw3).exists())

    def test_what_counts_as_in_use(self):
        devs = {n: self.device(n) for n in ("ip", "desc", "label", "mark", "plain")}
        prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/24")
        IPAddress.objects.create(tenant=self.tenant, ip_address="10.0.0.1", prefix=prefix,
                                 assigned_interface=self.port(devs["ip"]))
        Interface.objects.filter(pk=self.port(devs["desc"]).pk).update(description="to sw9")
        Interface.objects.filter(pk=self.port(devs["label"]).pk).update(label="S1")
        Interface.objects.filter(pk=self.port(devs["mark"]).pk).update(mark_connected=True)
        self.upgrade()
        moved = {n for n, d in devs.items() if self.port(d).module_id}
        self.assertEqual(moved, {"ip", "desc", "label", "mark"})
        # Only the port in use: its sibling stays the device's own.
        self.assertIsNone(self.port(devs["ip"], "StackPort1/2").module_id)
        # A hand edit wins: the description stays.
        self.assertEqual(self.port(devs["desc"]).description, "to sw9")

    def test_a_hand_edited_type_is_kept(self):
        sw1, sw2 = self.device("sw1"), self.device("sw2")
        Interface.objects.filter(device__in=[sw1, sw2], name__startswith="StackPort").update(
            type="cisco-stackwise-80")
        self.cable(self.port(sw1), self.port(sw2, "StackPort1/2"))
        self.upgrade()
        p = self.port(sw1)
        self.assertIsNotNone(p.module_id)
        self.assertEqual(p.type, "cisco-stackwise-80")

    def test_two_kits_the_one_that_fits_the_port(self):
        doc = real("C9200-24T")
        for b in ("StackPort1/1", "StackPort1/2"):
            bay(doc, b)["modules"] = ["KIT-80", "KIT-480"]
        modules = {"KIT-80": kit("KIT-80", "cisco-stackwise-80"),
                   "KIT-480": kit("KIT-480", "cisco-stackwise-480")}
        a, b, c, d = (self.device(n) for n in ("a", "b", "c", "d"))
        # a: hand-typed 480 - its own type decides. b: generic, cabled to a's
        # 480 - the far end decides. c, d: generic, cabled to each other -
        # both kits are of the family: the bay's first.
        Interface.objects.filter(device=a, name__startswith="StackPort").update(
            type="cisco-stackwise-480")
        self.cable(self.port(a), self.port(b))
        self.cable(self.port(c), self.port(d))
        self.upgrade(doc=doc, modules=modules)
        got = {x.name: self.port(x).module.module_type.part_number for x in (a, b, c, d)}
        self.assertEqual(got, {"a": "KIT-480", "b": "KIT-480", "c": "KIT-80", "d": "KIT-80"})
        # b's port was untouched: it takes its kit's type.
        self.assertEqual(self.port(b).type, "cisco-stackwise-480")

    def test_a_dry_run_reports_and_changes_nothing(self):
        sw1, sw2 = self.device("sw1"), self.device("sw2")
        self.stack(sw1, sw2)
        bays = ModuleBay.objects.count()
        row = self.upgrade(dry_run=True)
        self.assertIn("devices: installed 4 C9200-STACK-KIT modules in StackPort1/1, "
                      "StackPort1/2 on 2 devices, each holding the existing port it replaces: "
                      "sw1, sw2", row.notes)
        self.assertEqual(ModuleBay.objects.count(), bays)
        self.assertFalse(Module.objects.exists())
        self.assertIsNone(self.port(sw1).module_id)
        self.assertEqual(self.port(sw1).type, "cisco-stackwise")

    def test_a_second_import_changes_nothing(self):
        sw1, sw2 = self.device("sw1"), self.device("sw2")
        self.stack(sw1, sw2)
        self.device("sw3")
        self.upgrade()
        before = set(ChangeLogEntry.objects.values_list("id", flat=True))
        row = self.upgrade(version="2.0.0")
        self.assertFalse([n for n in row.notes if n.startswith("devices: ")], row.notes)
        self.assertEqual(row.changes, {"added": 0, "updated": 0, "removed": 0, "kept": 0})
        self.assertFalse(ChangeLogEntry.objects.exclude(id__in=before).filter(
            object_type__in=["api.module", "api.modulebay", "api.interface"]).exists())
        self.assertEqual(Module.objects.count(), 4)

    def test_the_changes_are_audited_with_the_pack_as_cause(self):
        sw1, sw2 = self.device("sw1"), self.device("sw2")
        self.stack(sw1, sw2)
        before = set(ChangeLogEntry.objects.values_list("id", flat=True))
        self.upgrade()
        new = ChangeLogEntry.objects.exclude(id__in=before)
        self.assertEqual(new.filter(object_type="api.module", action="create").count(), 4)
        self.assertEqual(new.filter(object_type="api.modulebay", action="create").count(), 4)
        self.assertEqual(new.filter(object_type="api.interface", action="update").count(), 4)
        self.assertEqual({e.cause for e in new}, {"Pack import: Catalyst 2.0.0"})

    def test_a_bay_that_holds_a_module_is_left_alone(self):
        sw1, sw2 = self.device("sw1"), self.device("sw2")
        self.cable(self.port(sw1), self.port(sw2))
        # A bay made by hand already, with something else in it.
        mt = ModuleType.objects.create(tenant=self.tenant, name="Blank",
                                       manufacturer=self.dt0.manufacturer)
        b = ModuleBay.objects.create(device=sw1, name="StackPort1/1", position="1/1")
        Module.objects.create(device=sw1, module_bay=b, module_type=mt)
        row = self.upgrade()
        self.assertIsNone(self.port(sw1).module_id)
        self.assertIn("devices: kept 1 interface StackPort1/1 on 1 device, the bay holds a "
                      "module: sw1", row.notes)
        self.assertIsNotNone(self.port(sw2).module_id)

    def test_another_tenants_devices_are_left_alone(self):
        self.run_pack({"C9200-24T": old_c9200()}, tenant=self.other)
        theirs_dt = self.dt("C9200-24T", self.other)
        t1, t2 = (self.device(n, tenant=self.other, dt=theirs_dt) for n in ("t1", "t2"))
        self.cable(self.port(t1), self.port(t2))
        mine = self.device("m1")
        self.upgrade()
        self.assertTrue(ModuleBay.objects.filter(device=mine, name="StackPort1/1").exists())
        self.assertFalse(ModuleBay.objects.filter(device__in=[t1, t2],
                                                  name__startswith="Stack").exists())
        self.assertIsNone(self.port(t1).module_id)
        self.assertFalse(Module.objects.filter(device__tenant=self.other).exists())

    def test_no_module_type_no_conversion(self):
        sw1, sw2 = self.device("sw1"), self.device("sw2")
        self.cable(self.port(sw1), self.port(sw2))
        row = self.run_pack({"C9200-24T": real("C9200-24T")}, version="2.0.0")
        row = self.row(row, "C9200-24T")
        self.assertFalse([n for n in row.notes if n.startswith("devices: added")], row.notes)
        self.assertIsNone(self.port(sw1).module_id)


class LinkKindTests(_Base):
    def test_a_white_paper_link(self):
        from .models import Document

        doc = real("C9300-48P")
        doc["meta"]["links"].append({"kind": "white-paper", "url": "https://example.com/wp"})
        self.run_pack({"C9300-48P": doc})
        d = Document.objects.get(tenant=self.tenant, url="https://example.com/wp")
        self.assertEqual((d.name, d.category.name), ("White paper", "White paper"))
