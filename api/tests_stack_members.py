"""Stack member types (api.stack_members, docs/dcim/model-packs.md → Stack
members): which types Danbyte stacks, the pack import giving them the
stack-member token and re-rendering their stacked devices, installed
modules' ports following the host's member number, and a stack kit's
ports reaching the stack's auto-connect cables."""
from __future__ import annotations

import copy

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from audit.models import ChangeLogEntry
from auth_api.models import UserProfile

from .anchor_names import chassis_interface, module_interface, module_port
from .models import (
    Cable,
    CableTermination,
    Device,
    DeviceType,
    Interface,
    InventoryItem,
    Module,
    ModuleBay,
    ModuleType,
    Site,
    VirtualChassis,
    materialize_device_components,
    render_module_component,
)
from .port_state import module_interfaces
from .stack_cables import reconcile
from .stack_members import stackable
from .tests_model_pack_update import _Base

KIT = {"manufacturer": "Cisco", "model": "C9300L-STACK-KIT", "part_number": "C9300L-STACK-KIT",
       "interfaces": [{"name": "StackPort{module}", "type": "cisco-stackwise-320"}]}
NM = {"manufacturer": "Cisco", "model": "C9300-NM-4X", "part_number": "C9300-NM-4X",
      "interfaces": [{"name": f"TenGigabitEthernet1/{{module}}/{i}", "type": "10gbase-x-sfpp"}
                     for i in range(1, 5)]}
MODULES = {"C9300L-STACK-KIT": KIT, "C9300-NM-4X": NM}


def chassis(**extra) -> dict:
    """A kit-stacked switch as the device library writes it: member 1's
    names, stack ports only through the kits in its two adapter bays."""
    doc = {
        "manufacturer": "Cisco", "model": "Catalyst Kit-24", "part_number": "KIT-24",
        "u_height": 1,
        "console-ports": [{"name": "con 0", "type": "rj-45"}],
        "interfaces": [*({"name": f"GigabitEthernet1/0/{i}", "type": "1000base-t"}
                         for i in range(1, 5)),
                       {"name": "GigabitEthernet0/0", "type": "1000base-t", "mgmt_only": True}],
        "module-bays": [
            {"name": "StackPort1/1", "position": "1/1", "modules": ["C9300L-STACK-KIT"]},
            {"name": "StackPort1/2", "position": "1/2", "modules": ["C9300L-STACK-KIT"]},
            {"name": "Network Module", "position": "1", "modules": ["C9300-NM-4X"]},
        ],
    }
    doc.update(extra)
    return doc


def plain(**extra) -> dict:
    """A switch with no stacking at all."""
    doc = chassis(**{"model": "Catalyst Solo", "part_number": "SOLO-24", **extra})
    doc["module-bays"] = [b for b in doc["module-bays"] if b["name"] == "Network Module"]
    return doc


class _Stack(APITestCase, _Base):
    def setUp(self):
        _Base.setUp(self)
        self.user = User.objects.create_superuser("root", "r@x", "x")
        UserProfile.objects.create(user=self.user, role="admin").tenants.add(self.tenant)
        self.client.force_login(self.user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        self.site = Site.objects.create(tenant=self.tenant, name="S")

    def device(self, name, dt):
        d = Device.objects.create(tenant=self.tenant, name=name, site=self.site,
                                  device_type=dt)
        materialize_device_components(d)
        return d

    def stack(self, *devs, auto=True, power=False, join=True):
        vc = VirtualChassis.objects.create(tenant=self.tenant, name="STK",
                                           auto_connect_stack=auto, auto_connect_power=power)
        for i, d in enumerate(devs, 1):
            if join:  # through the API: the rename-on-join
                res = self.client.patch(f"/api/devices/{d.pk}/", {
                    "virtual_chassis_id": str(vc.pk), "vc_position": i}, format="json")
                self.assertEqual(res.status_code, 200, res.content)
            else:
                Device.objects.filter(pk=d.pk).update(virtual_chassis=vc, vc_position=i)
            d.refresh_from_db()
        return vc

    def install(self, dev, bay_name, part):
        bay = ModuleBay.objects.get(device=dev, name=bay_name)
        mt = ModuleType.objects.get(tenant=self.tenant, part_number=part)
        with self.captureOnCommitCallbacks(execute=True):
            res = self.client.post("/api/modules/", {
                "device_id": str(dev.pk), "module_bay_id": str(bay.pk),
                "module_type_id": str(mt.pk)}, format="json")
        self.assertEqual(res.status_code, 201, res.content)
        return Module.objects.get(pk=res.json()["id"])

    def names(self, dev, prefix=""):
        return sorted(dev.interfaces.filter(name__startswith=prefix)
                      .values_list("name", flat=True))

    def auto(self, vc, source="stack"):
        out = []
        for c in Cable.objects.filter(auto_chassis=vc, auto_source=source):
            ends = {t.end: t.interface or t.power_port for t in c.terminations.all()}
            out.append((f"{ends['A'].device.name}:{ends['A'].name}",
                        f"{ends['B'].device.name}:{ends['B'].name}"))
        return sorted(out)


class StackableRuleTests(_Stack):
    def test_what_makes_a_type_a_stack_member(self):
        self.run_pack({"KIT-24": chassis(), "SOLO-24": plain()}, modules=MODULES)
        self.assertTrue(stackable(self.dt("KIT-24"), {}))         # a stack-kit bay
        self.assertFalse(stackable(self.dt("SOLO-24"), {}))
        self.assertTrue(stackable(self.dt("SOLO-24"), {"meta": {"stackable": True}}))
        self.assertTrue(stackable(self.dt("SOLO-24"), {"interfaces": [
            {"name": "StackPort1/1", "type": "cisco-stackwise-480"}]}))
        self.assertTrue(stackable(self.dt("SOLO-24"), {"power-ports": [
            {"name": "StackPower1/A", "type": "cisco-stackpower"}]}))
        self.assertTrue(stackable(self.dt("SOLO-24"), {"interfaces": [
            {"name": "Port 9", "type": "other", "stack": True}]}))
        # The meta's no wins over the ports.
        self.assertFalse(stackable(self.dt("KIT-24"), {"meta": {"stackable": False}}))
        row = self.row(self.run_pack({"SOLO-24": plain(meta={"stackable": "yes"})},
                                     modules=MODULES), "SOLO-24")
        self.assertIn("meta.stackable: not true or false - ignored.", row.notes)
        # Another tenant's kit makes nothing stackable here.
        ModuleType.objects.filter(tenant=self.tenant).update(tenant=self.other)
        self.assertFalse(stackable(self.dt("KIT-24"), {}))

    def test_the_import_tokenizes_stack_members_only(self):
        result = self.run_pack({"KIT-24": chassis(), "SOLO-24": plain(),
                                "SVL-24": plain(model="Catalyst SVL", part_number="SVL-24",
                                                meta={"stackable": True})},
                               modules=MODULES)
        kit = sorted(self.dt("KIT-24").interface_templates.values_list("name", flat=True))
        self.assertEqual(kit, ["GigabitEthernet0/0", *(f"GigabitEthernet{{position}}/0/{i}"
                                                       for i in range(1, 5))])
        # The bays keep their names: a model's bay: anchors match them.
        self.assertEqual(sorted(self.dt("KIT-24").module_bay_templates.values_list(
            "name", flat=True)), ["Network Module", "StackPort1/1", "StackPort1/2"])
        self.assertIn("GigabitEthernet{position}/0/1", set(
            self.dt("SVL-24").interface_templates.values_list("name", flat=True)))
        self.assertIn("GigabitEthernet1/0/1", set(
            self.dt("SOLO-24").interface_templates.values_list("name", flat=True)))
        row = self.row(result, "KIT-24")
        self.assertIn("stack members: 4 templates take the stack-member token.", row.notes)
        self.assertFalse(any(n.startswith("stack members") for n in
                             self.row(result, "SOLO-24").notes))
        # The YAML's names keep matching: nothing added or removed after.
        self.assertFalse(any(n.startswith(("added", "removed")) for n in row.notes), row.notes)
        again = self.row(self.run_pack({"KIT-24": chassis()}, modules=MODULES), "KIT-24")
        self.assertFalse(any(n.startswith(("stack members", "added", "removed"))
                             for n in again.notes), again.notes)


class KitStackEndToEndTests(_Stack):
    """Import → three members → each its own names → the kits' ports cabled."""

    def test_three_member_kit_stack(self):
        self.run_pack({"KIT-24": chassis()}, modules=MODULES)
        dt = self.dt("KIT-24")
        sws = [self.device(f"sw{i}", dt) for i in (1, 2, 3)]
        with self.captureOnCommitCallbacks(execute=True):
            vc = self.stack(*sws)
        for sw in sws:
            self.install(sw, "Network Module", "C9300-NM-4X")
            for b in ("StackPort1/1", "StackPort1/2"):
                self.install(sw, b, "C9300L-STACK-KIT")
        for i, sw in enumerate(sws, 1):
            self.assertIn(f"GigabitEthernet{i}/0/1", self.names(sw))
            self.assertIn("GigabitEthernet0/0", self.names(sw))
            self.assertEqual(self.names(sw, "TenGig"),
                             [f"TenGigabitEthernet{i}/1/{p}" for p in range(1, 5)])
            self.assertEqual(self.names(sw, "Stack"), [f"StackPort{i}/1", f"StackPort{i}/2"])
        self.assertEqual(self.auto(vc), [
            ("sw1:StackPort1/1", "sw2:StackPort2/2"),
            ("sw2:StackPort2/1", "sw3:StackPort3/2"),
            ("sw3:StackPort3/1", "sw1:StackPort1/2"),
        ])

    def test_the_3d_names_resolve_to_the_members_own(self):
        self.run_pack({"KIT-24": chassis()}, modules=MODULES)
        dt = self.dt("KIT-24")
        sw1, sw2 = self.device("sw1", dt), self.device("sw2", dt)
        self.stack(sw1, sw2)
        nm = self.install(sw2, "Network Module", "C9300-NM-4X")
        kit = self.install(sw2, "StackPort1/1", "C9300L-STACK-KIT")
        sw2 = Device.objects.get(pk=sw2.pk)
        # Anchors, LEDs and plugs authored as member 1 (api.anchor_names).
        self.assertEqual(chassis_interface(sw2, "GigabitEthernet1/0/1"), "GigabitEthernet2/0/1")
        self.assertEqual(chassis_interface(sw2, "GigabitEthernet0/0"), "GigabitEthernet0/0")
        self.assertEqual(module_interface(sw2, nm.module_type, "TenGigabitEthernet1/{module}/1",
                                          "1"), "TenGigabitEthernet2/1/1")
        self.assertEqual(module_port(sw2, kit.module_type, "StackPort{module}", "1/1"),
                         ("interface", "StackPort2/1"))
        self.assertEqual([(r["name"], r["template"]) for r in module_interfaces(kit)],
                         [("StackPort2/1", "StackPort{module}")])
        for name in ("GigabitEthernet2/0/1", "TenGigabitEthernet2/1/1", "StackPort2/1"):
            self.assertTrue(Interface.objects.filter(device=sw2, name=name).exists(), name)

    def test_standalone_and_unstacked_types_keep_member_1(self):
        self.run_pack({"KIT-24": chassis(), "SOLO-24": plain()}, modules=MODULES)
        alone = self.device("alone", self.dt("KIT-24"))
        solo1, solo2 = self.device("solo1", self.dt("SOLO-24")), self.device(
            "solo2", self.dt("SOLO-24"))
        self.stack(solo1, solo2)
        self.install(alone, "StackPort1/1", "C9300L-STACK-KIT")
        self.install(solo2, "Network Module", "C9300-NM-4X")
        self.assertIn("GigabitEthernet1/0/1", self.names(alone))
        self.assertEqual(self.names(alone, "Stack"), ["StackPort1/1"])
        # A type that is no stack member renders its modules as written.
        self.assertEqual(self.names(solo2, "TenGig")[0], "TenGigabitEthernet1/1/1")

    def test_rendering(self):
        self.assertEqual(render_module_component("StackPort{module}", "1/2", 3, "{position}"),
                         "StackPort3/2")
        self.assertEqual(render_module_component("TenGigabitEthernet1/{module}/4", "1", 2,
                                                 "{position}"), "TenGigabitEthernet2/1/4")
        self.assertEqual(render_module_component("TenGigabitEthernet1/{module}/4", "1", 2),
                         "TenGigabitEthernet1/1/4")
        self.assertEqual(render_module_component("PS-{module}", "A", 2, "{position}"), "PS-A")
        self.assertEqual(render_module_component("xe-0/{module}/0", "1", 2, "{position:0}"),
                         "xe-2/1/0")
        self.assertEqual(render_module_component("xe-0/{module}/0", "1", 2, "{position}"),
                         "xe-0/1/0")


class ExistingDataTests(_Stack):
    """Types imported before Danbyte stacked them convert on the next import."""

    def old(self):
        """The first import as an earlier Danbyte made it: member 1's names."""
        self.run_pack({"KIT-24": chassis(meta={"stackable": False})}, modules=MODULES)
        dt = self.dt("KIT-24")
        self.assertIn("GigabitEthernet1/0/1",
                      set(dt.interface_templates.values_list("name", flat=True)))
        sws = [self.device(f"sw{i}", dt) for i in (1, 2, 3)]
        vc = self.stack(*sws, join=False)
        for sw in sws:
            self.install(sw, "Network Module", "C9300-NM-4X")
            self.install(sw, "StackPort1/1", "C9300L-STACK-KIT")
        return dt, sws, vc

    def test_a_re_import_converts_the_type_and_its_members(self):
        dt, (sw1, sw2, sw3), vc = self.old()
        # What the members carry before: member 1's names everywhere.
        self.assertIn("GigabitEthernet1/0/1", self.names(sw2))
        self.assertEqual(self.names(sw3, "Stack"), ["StackPort1/1"])
        ids = {n: Interface.objects.get(device=sw2, name=n).pk
               for n in ("GigabitEthernet1/0/1", "TenGigabitEthernet1/1/1", "StackPort1/1")}
        taken = Interface.objects.create(device=sw3, name="GigabitEthernet3/0/4",
                                         type="virtual")
        with self.captureOnCommitCallbacks(execute=True):
            dry = self.row(self.run_pack({"KIT-24": chassis()}, modules=MODULES,
                                         dry_run=True, version="2.0.0"), "KIT-24")
        self.assertIn("stack members: 4 templates take the stack-member token; 17 interfaces "
                      "renamed on 2 stack members.", dry.notes)
        self.assertIn("stack members: kept 1 port under member 1's name, the member's own "
                      "name is taken: sw3: GigabitEthernet1/0/4", dry.notes)
        self.assertIn("GigabitEthernet1/0/1", self.names(sw2))   # rolled back
        with self.captureOnCommitCallbacks(execute=True):
            row = self.row(self.run_pack({"KIT-24": chassis()}, modules=MODULES,
                                         version="2.0.0"), "KIT-24")
        self.assertEqual([n for n in row.notes if n.startswith("stack")],
                         [n for n in dry.notes if n.startswith("stack")])
        self.assertEqual(self.names(sw1, "GigabitEthernet1/"), [
            f"GigabitEthernet1/0/{i}" for i in range(1, 5)])
        self.assertEqual(self.names(sw2, "GigabitEthernet2/"), [
            f"GigabitEthernet2/0/{i}" for i in range(1, 5)])
        self.assertEqual(self.names(sw2, "TenGig"),
                         [f"TenGigabitEthernet2/1/{p}" for p in range(1, 5)])
        self.assertEqual(self.names(sw2, "Stack"), ["StackPort2/1"])
        # Same rows, so cables, IPs and history stay.
        for old, new in (("GigabitEthernet1/0/1", "GigabitEthernet2/0/1"),
                         ("TenGigabitEthernet1/1/1", "TenGigabitEthernet2/1/1"),
                         ("StackPort1/1", "StackPort2/1")):
            self.assertEqual(Interface.objects.get(device=sw2, name=new).pk, ids[old])
        # Never clobbered: sw3 keeps member 1's name where its own is taken.
        self.assertIn("GigabitEthernet1/0/4", self.names(sw3))
        self.assertEqual(Interface.objects.get(pk=taken.pk).name, "GigabitEthernet3/0/4")
        self.assertIn("GigabitEthernet0/0", self.names(sw2))
        # Audited with the pack as the cause.
        entry = ChangeLogEntry.objects.filter(object_id=str(ids["GigabitEthernet1/0/1"])
                                              ).order_by("-timestamp").first()
        self.assertEqual(entry.cause, "Pack import: Catalyst 2.0.0")
        # And idempotent.
        again = self.row(self.run_pack({"KIT-24": chassis()}, modules=MODULES,
                                       version="2.0.0"), "KIT-24")
        self.assertEqual([n for n in again.notes if n.startswith("stack members:") and
                          "renamed" in n], [])

    def test_the_pack_record_follows_the_rename(self):
        dt, _sws, _vc = self.old()
        self.run_pack({"KIT-24": chassis()}, modules=MODULES, version="2.0.0")
        dt.refresh_from_db()
        names = set(dt.pack_state["templates"]["interfaces"])
        self.assertIn("GigabitEthernet{position}/0/1", names)
        self.assertNotIn("GigabitEthernet1/0/1", names)
        self.assertIn("GigabitEthernet{position}/0/1", dt.pack_state["pack_names"]["interfaces"])

    def test_photo_markers_follow_the_rename(self):
        dt, _sws, _vc = self.old()
        DeviceType.objects.filter(pk=dt.pk).update(image_ports={"front": [
            {"kind": "interface", "name": "GigabitEthernet1/0/1", "x": 0, "y": 0},
            {"kind": "interface", "name": "GigabitEthernet0/0", "x": 1, "y": 0}]})
        self.run_pack({"KIT-24": chassis()}, modules=MODULES, version="2.0.0")
        dt.refresh_from_db()
        self.assertEqual([m["name"] for m in dt.image_ports["front"]],
                         ["GigabitEthernet{position}/0/1", "GigabitEthernet0/0"])


class StackKitCableTests(_Stack):
    """Bug: a stack kit's ports arrive in bulk and the auto cables missed them."""

    def setUp(self):
        super().setUp()
        self.run_pack({"KIT-24": chassis()}, modules=MODULES)
        self.dt0 = self.dt("KIT-24")

    def members(self, auto=True):
        sws = [self.device(f"sw{i}", self.dt0) for i in (1, 2, 3)]
        with self.captureOnCommitCallbacks(execute=True):
            vc = self.stack(*sws, auto=auto)
        return sws, vc

    def test_kit_install_and_removal(self):
        sws, vc = self.members()
        mods = {}
        for sw in sws:
            for b in ("StackPort1/1", "StackPort1/2"):
                mods[(sw.name, b)] = self.install(sw, b, "C9300L-STACK-KIT")
        self.assertEqual(len(self.auto(vc)), 3)
        # A recorded cable elsewhere is left alone by the removal.
        a, b = (Interface.objects.create(device=sws[0], name="x", type="1000base-t"),
                Interface.objects.create(device=sws[1], name="x", type="1000base-t"))
        mine = Cable.objects.create(tenant=self.tenant, label="MINE")
        CableTermination.objects.create(cable=mine, end="A", interface=a)
        CableTermination.objects.create(cable=mine, end="B", interface=b)
        with self.captureOnCommitCallbacks(execute=True):
            res = self.client.delete(f"/api/modules/{mods[('sw2', 'StackPort1/1')].pk}/")
        self.assertEqual(res.status_code, 204, res.content)
        # sw2 has one stack port left: the ring is drawn again over the
        # ports there are, and the cables follow it.
        self.assertEqual(len(self.auto(vc)), 2)
        self.assertNotIn("sw2:StackPort2/1", str(self.auto(vc)))
        vc.refresh_from_db()
        self.assertEqual(reconcile(vc), {"created": 0, "deleted": 0})
        self.assertTrue(Cable.objects.filter(pk=mine.pk, label="MINE").exists())

    def test_remove_to_stock_and_install_from_stock(self):
        sws, vc = self.members()
        for sw in sws:
            for b in ("StackPort1/1", "StackPort1/2"):
                self.install(sw, b, "C9300L-STACK-KIT")
        module = Module.objects.get(device=sws[0], module_bay__name="StackPort1/1")
        with self.captureOnCommitCallbacks(execute=True):
            res = self.client.post(f"/api/modules/{module.pk}/remove/",
                                   {"site_id": str(self.site.pk)}, format="json")
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(len(self.auto(vc)), 2)
        self.assertNotIn("sw1:StackPort1/1", str(self.auto(vc)))
        vc.refresh_from_db()
        self.assertEqual(reconcile(vc), {"created": 0, "deleted": 0})
        item = InventoryItem.objects.get(pk=module.pk)
        bay = ModuleBay.objects.get(device=sws[0], name="StackPort1/1")
        with self.captureOnCommitCallbacks(execute=True):
            res = self.client.post(f"/api/inventory-items/{item.pk}/install-module/",
                                   {"module_bay_id": str(bay.pk)}, format="json")
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(len(self.auto(vc)), 3)
        self.assertIn("sw1:StackPort1/1", str(self.auto(vc)))

    def test_auto_connect_off_makes_nothing(self):
        sws, vc = self.members(auto=False)
        for sw in sws:
            self.install(sw, "StackPort1/1", "C9300L-STACK-KIT")
        self.assertFalse(Cable.objects.exists())

    def test_stackpower_on_a_kit_chassis(self):
        doc = chassis(**{"power-ports": [
            {"name": "StackPower1/A", "type": "cisco-stackpower"},
            {"name": "StackPower1/B", "type": "cisco-stackpower"}]})
        self.run_pack({"KIT-24": doc}, modules=MODULES, version="2.0.0")
        self.assertEqual(sorted(self.dt0.power_port_templates.values_list("name", flat=True)),
                         ["StackPower{position}/A", "StackPower{position}/B"])
        sws = [self.device(f"sw{i}", self.dt0) for i in (1, 2, 3)]
        with self.captureOnCommitCallbacks(execute=True):
            vc = self.stack(*sws, power=True)
        self.assertEqual(len(self.auto(vc, "stack-power")), 3)
        self.assertIn(("sw1:StackPower1/B", "sw2:StackPower2/A"), self.auto(vc, "stack-power"))
        for sw in sws:
            self.install(sw, "StackPort1/1", "C9300L-STACK-KIT")
            self.install(sw, "StackPort1/2", "C9300L-STACK-KIT")
        self.assertEqual(len(self.auto(vc)), 3)


class JoinRenameTests(_Stack):
    def test_joining_and_moving_renames_module_ports(self):
        self.run_pack({"KIT-24": chassis()}, modules=MODULES)
        dt = self.dt("KIT-24")
        sw1, sw2 = self.device("sw1", dt), self.device("sw2", dt)
        self.install(sw2, "StackPort1/1", "C9300L-STACK-KIT")
        self.install(sw2, "Network Module", "C9300-NM-4X")
        self.assertEqual(self.names(sw2, "Stack"), ["StackPort1/1"])
        self.stack(sw1, sw2)
        self.assertEqual(self.names(sw2, "Stack"), ["StackPort2/1"])
        self.assertEqual(self.names(sw2, "TenGig")[0], "TenGigabitEthernet2/1/1")
        self.assertIn("GigabitEthernet2/0/1", self.names(sw2))
        res = self.client.patch(f"/api/devices/{sw2.pk}/", {"vc_position": 4}, format="json")
        self.assertEqual(res.status_code, 200, res.content)
        # Four chassis ports, four module ports, the kit's stack port.
        self.assertEqual(res.json()["vc_renamed_interfaces"], 9)
        self.assertEqual(self.names(sw2, "Stack"), ["StackPort4/1"])
        res = self.client.patch(f"/api/devices/{sw2.pk}/", {"virtual_chassis_id": None,
                                                            "vc_position": None},
                                format="json")
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(self.names(sw2, "Stack"), ["StackPort1/1"])
        self.assertEqual(self.names(sw2, "TenGig")[0], "TenGigabitEthernet1/1/1")

    def test_a_manual_import_with_stack_positions_still_works(self):
        import yaml

        from .devicetype_import import import_devicetype_yaml

        doc = copy.deepcopy(plain(model="Manual", part_number="MAN-1"))
        doc["module-bays"] = []
        rep = import_devicetype_yaml(self.tenant, yaml.safe_dump(doc), stack_positions=True)
        self.assertTrue(rep["ok"], rep)
        dt = DeviceType.objects.get(pk=rep["id"])
        self.assertIn("GigabitEthernet{position}/0/1",
                      set(dt.interface_templates.values_list("name", flat=True)))
