"""A re-import that changes a template field carries it to the components
the template made (api.model_pack_components): the C9200-NM-4X's
interfaces corrected from 10gbase-t to 10gbase-x-sfpp reach the installed
modules' ports, a hand-edited one is kept; a device type's field reaches
its devices, stack members by their ``{position}`` names. Also the
catch-up command for templates an earlier import already changed."""
from __future__ import annotations

import io

from django.core.management import call_command

from audit.models import ChangeLogEntry

from .models import (
    Device,
    FrontPort,
    Interface,
    Module,
    ModuleBay,
    ModuleInterfaceTemplate,
    ModuleType,
    PowerPort,
    Site,
    VirtualChassis,
    install_module,
    materialize_device_components,
)
from .tests_model_pack_update import _Base, iface, real

NM = "C9200-NM-4X"


def nm(ptype: str) -> dict:
    return {"manufacturer": "Cisco", "model": NM, "part_number": NM,
            "interfaces": [{"name": f"TenGigabitEthernet1/{{module}}/{i}", "type": ptype}
                           for i in (1, 2, 3, 4)]}


def te(n: int, member: int = 1) -> str:
    return f"TenGigabitEthernet{member}/1/{n}"


class _ModuleBase(_Base):
    def setUp(self):
        super().setUp()
        self.run_pack({"C9200-24T": real("C9200-24T")}, modules={NM: nm("10gbase-t")})
        self.dt0 = self.dt("C9200-24T")
        self.mt = ModuleType.objects.get(tenant=self.tenant, part_number=NM)
        self.site = Site.objects.create(tenant=self.tenant, name="S")

    def device(self, name, tenant=None, dt=None, mt=None, **kw):
        tenant = tenant or self.tenant
        site = self.site if tenant == self.tenant else Site.objects.get_or_create(
            tenant=tenant, name="S")[0]
        d = Device.objects.create(tenant=tenant, name=name, site=site,
                                  device_type=dt or self.dt0, **kw)
        materialize_device_components(d)
        bay = ModuleBay.objects.get(device=d, name="Network Module")
        install_module(Module.objects.create(device=d, module_bay=bay, module_type=mt or self.mt))
        return d

    def port(self, d, name):
        return Interface.objects.get(device=d, name=name)

    def upgrade(self, ptype="10gbase-x-sfpp", *, dry_run=False, version="2.0.0"):
        result = self.run_pack({"C9200-24T": real("C9200-24T")}, modules={NM: nm(ptype)},
                               dry_run=dry_run, version=version)
        return self.row(result, NM)


class ModuleTypeCorrectionTests(_ModuleBase):
    def test_the_correction_reaches_installed_modules(self):
        sw1, sw2, sw3 = (self.device(n) for n in ("sw1", "sw2", "sw3"))
        Interface.objects.filter(pk=self.port(sw2, te(2)).pk).update(type="1000base-x-sfp")
        before = {(d.name, i): self.port(d, te(i)).pk for d in (sw1, sw2, sw3)
                  for i in (1, 2, 3, 4)}
        row = self.upgrade()
        self.assertIn("updated 4 interfaces, type 10gbase-t → 10gbase-x-sfpp: "
                      "TenGigabitEthernet1/{module}/1, TenGigabitEthernet1/{module}/2, "
                      "TenGigabitEthernet1/{module}/3, TenGigabitEthernet1/{module}/4",
                      row.notes)
        self.assertIn("devices: updated type on 11 interfaces of 3 modules (10gbase-t → "
                      "10gbase-x-sfpp); kept 1 edited by hand: sw2: TenGigabitEthernet1/1/2",
                      row.notes)
        self.assertFalse([n for n in row.notes if "keep the ports" in n], row.notes)
        for (dn, i), pk in before.items():
            p = Interface.objects.get(pk=pk)
            want = "1000base-x-sfp" if (dn, i) == ("sw2", 2) else "10gbase-x-sfpp"
            self.assertEqual(p.type, want, (dn, i))
            self.assertFalse(p.virtual)

    def test_a_port_stamped_before_modules_recorded_their_template(self):
        sw1 = self.device("sw1")
        Interface.objects.filter(device=sw1, module__isnull=False).update(module_template=None)
        self.upgrade()
        self.assertEqual(set(Interface.objects.filter(device=sw1, module__isnull=False)
                             .values_list("type", flat=True)), {"10gbase-x-sfpp"})

    def test_a_stack_members_module_ports(self):
        # C9200 is a stack member type once its stack kit is known.
        self.run_pack({"C9200-24T": real("C9200-24T")},
                      modules={NM: nm("10gbase-t"),
                               "C9200-STACK-KIT": {
                                   "manufacturer": "Cisco", "model": "C9200-STACK-KIT",
                                   "part_number": "C9200-STACK-KIT",
                                   "interfaces": [{"name": "StackPort{module}",
                                                   "type": "cisco-stackwise-160"}]}})
        vc = VirtualChassis.objects.create(tenant=self.tenant, name="STK")
        self.device("sw1", virtual_chassis=vc, vc_position=1)
        sw2 = self.device("sw2", virtual_chassis=vc, vc_position=2)
        self.assertTrue(Interface.objects.filter(device=sw2, name=te(1, 2)).exists())
        Interface.objects.filter(device=sw2, module__isnull=False).update(module_template=None)
        row = self.upgrade()
        self.assertIn("devices: updated type on 8 interfaces of 2 modules (10gbase-t → "
                      "10gbase-x-sfpp)", row.notes)
        self.assertEqual(self.port(sw2, te(4, 2)).type, "10gbase-x-sfpp")

    def test_a_dry_run_reports_and_changes_nothing(self):
        sw1 = self.device("sw1")
        row = self.upgrade(dry_run=True)
        self.assertIn("devices: updated type on 4 interfaces of 1 module (10gbase-t → "
                      "10gbase-x-sfpp)", row.notes)
        self.assertEqual(self.port(sw1, te(1)).type, "10gbase-t")
        self.assertEqual(set(ModuleInterfaceTemplate.objects.filter(module_type=self.mt)
                             .values_list("type", flat=True)), {"10gbase-t"})

    def test_a_second_import_changes_nothing(self):
        self.device("sw1")
        self.upgrade()
        before = set(ChangeLogEntry.objects.values_list("id", flat=True))
        row = self.upgrade()
        self.assertFalse([n for n in row.notes if n.startswith("devices: ")], row.notes)
        self.assertFalse(ChangeLogEntry.objects.exclude(id__in=before).filter(
            object_type="api.interface").exists())

    def test_audited_with_the_pack_as_cause(self):
        sw1 = self.device("sw1")
        before = set(ChangeLogEntry.objects.values_list("id", flat=True))
        self.upgrade()
        new = ChangeLogEntry.objects.exclude(id__in=before).filter(object_type="api.interface")
        self.assertEqual(new.count(), 4)
        self.assertEqual({e.cause for e in new}, {"Pack import: Catalyst 2.0.0"})
        self.assertEqual(new.first().changes["type"],
                         {"old": "10gbase-t", "new": "10gbase-x-sfpp"})
        self.assertEqual({e.object_id for e in new},
                         {str(p) for p in Interface.objects.filter(
                             device=sw1, module__isnull=False).values_list("pk", flat=True)})

    def test_another_tenants_modules_are_left_alone(self):
        self.run_pack({"C9200-24T": real("C9200-24T")}, modules={NM: nm("10gbase-t")},
                      tenant=self.other)
        theirs = self.device("t1", tenant=self.other, dt=self.dt("C9200-24T", self.other),
                             mt=ModuleType.objects.get(tenant=self.other, part_number=NM))
        mine = self.device("m1")
        self.upgrade()
        self.assertEqual(self.port(mine, te(1)).type, "10gbase-x-sfpp")
        self.assertEqual(self.port(theirs, te(1)).type, "10gbase-t")


class DeviceTypeCorrectionTests(_Base):
    def setUp(self):
        super().setUp()
        self.run_pack({"C9300-48P": real("C9300-48P")})
        self.dt0 = self.dt("C9300-48P")
        self.site = Site.objects.create(tenant=self.tenant, name="S")

    def device(self, name, **kw):
        d = Device.objects.create(tenant=self.tenant, name=name, site=self.site,
                                  device_type=self.dt0, **kw)
        materialize_device_components(d)
        return d

    def test_a_field_correction_reaches_devices_and_stack_members(self):
        vc = VirtualChassis.objects.create(tenant=self.tenant, name="STK")
        sw1 = self.device("sw1")
        sw2 = self.device("sw2", virtual_chassis=vc, vc_position=1)
        sw3 = self.device("sw3", virtual_chassis=vc, vc_position=2)
        self.assertTrue(Interface.objects.filter(device=sw3, name="GigabitEthernet2/0/1")
                        .exists())
        Interface.objects.filter(device=sw3, name="GigabitEthernet2/0/1").update(
            poe_type="passive-24v-2pair")
        doc = real("C9300-48P")
        iface(doc, "GigabitEthernet1/0/1")["poe_type"] = "type3-ieee802.3bt"
        iface(doc, "GigabitEthernet1/0/2")["type"] = "2.5gbase-t"
        row = self.row(self.run_pack({"C9300-48P": doc}, version="2.0.0"), "C9300-48P")
        self.assertIn("devices: updated PoE type on 2 interfaces of 2 devices "
                      "(type2-ieee802.3at → type3-ieee802.3bt); kept 1 edited by hand: "
                      "sw3: GigabitEthernet2/0/1", row.notes)
        self.assertIn("devices: updated type on 3 interfaces of 3 devices (1000base-t → "
                      "2.5gbase-t)", row.notes)
        self.assertEqual(Interface.objects.get(device=sw1, name="GigabitEthernet1/0/1")
                         .poe_type, "type3-ieee802.3bt")
        self.assertEqual(Interface.objects.get(device=sw3, name="GigabitEthernet2/0/1")
                         .poe_type, "passive-24v-2pair")
        for d, m in ((sw1, 1), (sw2, 1), (sw3, 2)):
            self.assertEqual(Interface.objects.get(device=d, name=f"GigabitEthernet{m}/0/2")
                             .type, "2.5gbase-t")
            self.assertEqual(Interface.objects.get(device=d, name=f"GigabitEthernet{m}/0/3")
                             .type, "1000base-t")

    def test_front_rear_and_power_ports(self):
        doc = {"manufacturer": "Acme", "model": "PP-2", "part_number": "PP-2", "u_height": 1,
               "power-ports": [{"name": "PSU", "type": "iec-60320-c14", "maximum_draw": 20}],
               "rear-ports": [{"name": "R1", "type": "8p8c", "positions": 2}],
               "front-ports": [{"name": "F1", "type": "8p8c", "rear_port": "R1",
                                "rear_port_position": 1}]}
        self.run_pack({"PP-2": doc})
        dt = self.dt("PP-2")
        d = Device.objects.create(tenant=self.tenant, name="pp1", site=self.site, device_type=dt)
        materialize_device_components(d)
        doc["front-ports"][0].update(type="lc", rear_port_position=2)
        doc["power-ports"][0]["maximum_draw"] = 35
        row = self.row(self.run_pack({"PP-2": doc}, version="2.0.0"), "PP-2")
        f = FrontPort.objects.get(device=d, name="F1")
        self.assertEqual((f.type, f.rear_port_position), ("lc", 2))
        self.assertEqual(PowerPort.objects.get(device=d, name="PSU").maximum_draw, 35)
        self.assertIn("devices: updated max draw on 1 power port of 1 device (20 → 35)",
                      row.notes)
        # A rear position the rear port doesn't have is kept.
        doc["front-ports"][0]["rear_port_position"] = 3
        row = self.row(self.run_pack({"PP-2": doc}, version="3.0.0"), "PP-2")
        self.assertEqual(FrontPort.objects.get(device=d, name="F1").rear_port_position, 2)
        self.assertIn("devices: kept rear position on 1 front port (the template has 3), its "
                      "rear port has 2 positions: pp1: F1", row.notes)


class CatchUpTests(_ModuleBase):
    """Templates an earlier import corrected before it carried the change."""

    def command(self, *args):
        out = io.StringIO()
        call_command("sync_type_components", "--tenant", self.tenant.slug, *args, stdout=out)
        return out.getvalue()

    def lagging(self):
        sw1, sw2 = self.device("sw1"), self.device("sw2")
        self.upgrade()
        # As an import before this change left them.
        Interface.objects.filter(module__module_type=self.mt).update(type="10gbase-t")
        Interface.objects.filter(pk=self.port(sw2, te(3)).pk).update(type="1000base-x-sfp")
        return sw1, sw2

    def test_a_dry_run_lists_and_changes_nothing(self):
        sw1, _sw2 = self.lagging()
        out = self.command("--type", NM)
        self.assertIn("module type C9200-NM-4X:", out)
        self.assertIn("devices: updated type on 7 interfaces of 2 modules (10gbase-t → "
                      "10gbase-x-sfpp); kept 1 edited by hand: sw2: TenGigabitEthernet1/1/3",
                      out)
        self.assertIn("Dry run: 7 component(s) would change.", out)
        self.assertEqual(self.port(sw1, te(1)).type, "10gbase-t")

    def test_apply_updates_the_ones_holding_an_earlier_value(self):
        sw1, sw2 = self.lagging()
        before = set(ChangeLogEntry.objects.values_list("id", flat=True))
        out = self.command("--type", NM, "--apply")
        self.assertIn("Updated 7 component(s).", out)
        self.assertEqual(self.port(sw1, te(1)).type, "10gbase-x-sfpp")
        self.assertEqual(self.port(sw2, te(3)).type, "1000base-x-sfp")
        new = ChangeLogEntry.objects.exclude(id__in=before).filter(object_type="api.interface")
        self.assertEqual({e.cause for e in new}, {"Sync type components"})
        self.assertIn("Dry run: 0 component(s)", self.command("--type", NM))

    def test_no_earlier_value_needs_force(self):
        sw1 = self.device("sw1")
        # Changed without a trace in the change log.
        ModuleInterfaceTemplate.objects.filter(module_type=self.mt).update(
            type="10gbase-x-sfpp")
        out = self.command("--type", NM, "--apply")
        self.assertIn("devices: 4 interfaces differ in type (the template has 10gbase-x-sfpp), "
                      "no earlier value known", out)
        self.assertIn("--force also updates", out)
        self.assertEqual(self.port(sw1, te(1)).type, "10gbase-t")
        self.command("--type", NM, "--apply", "--force")
        self.assertEqual(self.port(sw1, te(1)).type, "10gbase-x-sfpp")
