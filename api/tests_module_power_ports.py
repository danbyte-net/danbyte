"""Module types carry power ports (a PSU's inlet), and a module install can
adopt same-named components the device already has.

Power port templates on a module type stamp onto the host device as
``PowerPort`` rows owned by the module (``{module}`` → bay position,
``{position}`` → stack member), are re-stamped and removed exactly like a
module's interfaces, cable like any power port, and are matched by a model's
``port:`` anchors (spec 1.6). ``adopt_components`` hands clashing device
components to the module instead of refusing the install.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase

from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from .anchor_names import module_port
from .devicetype_import import import_moduletype_yaml
from .model_anchors import interface_matcher, mismatches, port_doc
from .model_pack_check import check_pack
from .models import (
    Cable,
    CableTermination,
    Device,
    Interface,
    IPAddress,
    Module,
    ModuleBayTemplate,
    ModuleInterfaceTemplate,
    ModulePowerPortTemplate,
    ModuleType,
    PowerOutlet,
    PowerPort,
    PowerPortTemplate,
    Prefix,
    VirtualChassis,
    diff_device_components,
    materialize_device_components,
)
from .tests import status_for
from .tests_module_ownership import _Base

User = get_user_model()

PSU_YAML = """
manufacturer: Cisco
model: C9K-PWR-650WAC-R
part_number: C9K-PWR-650WAC-R
power-ports:
  - name: PSU{module}
    type: iec-60320-c16
    maximum_draw: 650
  - name: bad-draw
    maximum_draw: lots
"""


class _Psu(_Base):
    def setUp(self):
        super().setUp()
        ModuleBayTemplate.objects.create(device_type=self.dt, name="PS-0", position="0")
        ModuleBayTemplate.objects.create(device_type=self.dt, name="PS-1", position="1")
        materialize_device_components(self.device)
        self.ps0 = self.device.module_bays.get(name="PS-0")
        self.ps1 = self.device.module_bays.get(name="PS-1")
        self.psu = ModuleType.objects.create(tenant=self.tenant, name="PSU-650")
        ModulePowerPortTemplate.objects.create(
            module_type=self.psu, name="PSU{module}", type="iec-60320-c16",
            maximum_draw=650,
        )

    def _ports(self):
        return set(self.device.power_ports.values_list("name", flat=True))


class TemplateApiTests(_Psu):
    URL = "/api/module-power-port-templates/"

    def test_crud_and_range(self):
        r = self.client.post(self.URL, {
            "module_type_id": str(self.psu.id), "name": "PS{module}-[1-2]",
            "type": "iec-60320-c14", "maximum_draw": 350,
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        listed = self.client.get(f"{self.URL}?module_type={self.psu.id}").json()
        self.assertEqual(
            {t["name"] for t in listed["results"]},
            {"PS{module}-1", "PS{module}-2", "PSU{module}"},
        )
        one = self.psu.power_port_templates.get(name="PS{module}-1")
        r = self.client.patch(f"{self.URL}{one.id}/", {"maximum_draw": 400}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["maximum_draw"], 400)
        self.assertTrue(ChangeLogEntry.objects.filter(
            object_type="api.modulepowerporttemplate", object_id=str(one.id)).exists())
        self.assertEqual(self.client.delete(f"{self.URL}{one.id}/").status_code, 204)

    def test_bad_type_is_refused(self):
        r = self.client.post(self.URL, {
            "module_type_id": str(self.psu.id), "name": "X", "type": "no-such-plug",
        }, format="json")
        self.assertEqual(r.status_code, 400)

    def test_foreign_tenant_type_is_invisible_and_refused(self):
        org = Organization.objects.create(name="Evil", slug="evil")
        other = Tenant.objects.create(org=org, name="Evil", slug="evil")
        foreign = ModuleType.objects.create(tenant=other, name="X-PSU")
        ModulePowerPortTemplate.objects.create(module_type=foreign, name="p1")
        data = self.client.get(f"{self.URL}?module_type={foreign.id}").json()
        self.assertEqual(data["count"], 0)
        r = self.client.post(self.URL, {
            "module_type_id": str(foreign.id), "name": "p2",
        }, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertFalse(foreign.power_port_templates.filter(name="p2").exists())

    def test_rbac_needs_the_object_type(self):
        user = User.objects.create_user("viewer", password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="mt-only", object_types=["moduletype"], actions=["view", "add", "change"])
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        r = self.client.post(self.URL, {
            "module_type_id": str(self.psu.id), "name": "nope",
        }, format="json")
        self.assertEqual(r.status_code, 403)
        perm.object_types = ["moduletype", "modulepowerporttemplate"]
        perm.save()
        r = self.client.post(self.URL, {
            "module_type_id": str(self.psu.id), "name": "yes",
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)


class YamlImportTests(_Psu):
    def test_module_yaml_power_ports(self):
        rep = import_moduletype_yaml(self.tenant, PSU_YAML)
        self.assertTrue(rep["ok"], rep)
        self.assertEqual(rep["created"]["power_ports"], 2)
        self.assertFalse(any("power-ports" in n for n in rep["skipped"]))
        mt = ModuleType.objects.get(pk=rep["id"])
        psu = mt.power_port_templates.get(name="PSU{module}")
        self.assertEqual((psu.type, psu.maximum_draw), ("iec-60320-c16", 650))
        self.assertIsNone(mt.power_port_templates.get(name="bad-draw").maximum_draw)


class InstallTests(_Psu):
    def test_install_stamps_and_remove_deletes(self):
        r = self._install(self.psu, self.ps1)
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["created_power_ports"], 1)
        port = self.device.power_ports.get(name="PSU1")
        self.assertEqual(str(port.module_id), r.json()["id"])
        self.assertEqual((port.type, port.maximum_draw), ("iec-60320-c16", 650))
        row = self.client.get(f"/api/power-ports/{port.id}/").json()
        self.assertEqual(row["module_id"], r.json()["id"])
        # Never a sync-from-type extra.
        self.assertNotIn("power_ports", diff_device_components(self.device))
        self.assertEqual(self.client.delete(f"/api/modules/{r.json()['id']}/").status_code, 204)
        self.assertEqual(self._ports(), set())

    def test_position_token_on_a_stack_member(self):
        ModulePowerPortTemplate.objects.filter(module_type=self.psu).update(
            name="PSU{position}/{module}")
        vc = VirtualChassis.objects.create(tenant=self.tenant, name="stack")
        Device.objects.filter(pk=self.device.pk).update(virtual_chassis=vc, vc_position=2)
        self.device.refresh_from_db()
        self.assertEqual(self._install(self.psu, self.ps0).status_code, 201)
        self.assertEqual(self._ports(), {"PSU2/0"})

    def test_bay_move_renames_and_keeps_the_cable(self):
        mid = self._install(self.psu, self.ps0).json()["id"]
        port = self.device.power_ports.get(name="PSU0")
        pdu = Device.objects.create(tenant=self.tenant, name="pdu1")
        outlet = PowerOutlet.objects.create(device=pdu, name="out1")
        cable = Cable.objects.create(tenant=self.tenant, label="P1")
        CableTermination.objects.create(cable=cable, end="A", power_port=port)
        CableTermination.objects.create(cable=cable, end="B", power_outlet=outlet)
        r = self.client.patch(f"/api/modules/{mid}/", {"module_bay_id": str(self.ps1.id)},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["interfaces"]["power_ports"]["renamed"],
                         [{"from": "PSU0", "to": "PSU1"}])
        port.refresh_from_db()
        self.assertEqual(port.name, "PSU1")
        self.assertTrue(CableTermination.objects.filter(cable=cable, power_port=port).exists())

    def test_replace_dropping_a_cabled_inlet_needs_confirm(self):
        mid = self._install(self.psu, self.ps0).json()["id"]
        port = self.device.power_ports.get(name="PSU0")
        pdu = Device.objects.create(tenant=self.tenant, name="pdu1")
        outlet = PowerOutlet.objects.create(device=pdu, name="out1")
        cable = Cable.objects.create(tenant=self.tenant, label="P1")
        CableTermination.objects.create(cable=cable, end="A", power_port=port)
        CableTermination.objects.create(cable=cable, end="B", power_outlet=outlet)
        fan = ModuleType.objects.create(tenant=self.tenant, name="FAN")
        r = self.client.patch(f"/api/modules/{mid}/", {"module_type_id": str(fan.id)},
                              format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("PSU0 (cable)", r.json()["confirm_remove"])
        r = self.client.patch(f"/api/modules/{mid}/", {
            "module_type_id": str(fan.id), "confirm_remove": True}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["interfaces"]["power_ports"]["removed"], ["PSU0"])
        self.assertEqual(self._ports(), set())

    def test_cable_to_a_pdu_outlet(self):
        self._install(self.psu, self.ps1)
        port = self.device.power_ports.get(name="PSU1")
        pdu = Device.objects.create(tenant=self.tenant, name="pdu1")
        outlet = PowerOutlet.objects.create(device=pdu, name="out7", type="iec-60320-c15")
        r = self.client.post("/api/cables/", {
            "a": [{"kind": "power_port", "id": str(port.id)}],
            "b": [{"kind": "power_outlet", "id": str(outlet.id)}],
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertIsNotNone(self.client.get(f"/api/power-ports/{port.id}/").json()["cable"])


class AdoptTests(_Psu):
    def setUp(self):
        super().setUp()
        self.te1 = Interface.objects.create(
            device=self.device, name="Te1/1/1", type="10gbase-x-sfpp")
        self.te2 = Interface.objects.create(device=self.device, name="Te1/1/2")

    def _adopt_install(self, mt, bay=None, adopt=True):
        return self.client.post("/api/modules/", {
            "device_id": str(self.device.id),
            "module_bay_id": str((bay or self.bay).id),
            "module_type_id": str(mt.id),
            "adopt_components": adopt,
        }, format="json")

    def test_refusal_offers_adopting(self):
        r = self._install(self.nm8x)
        self.assertEqual(r.status_code, 400)
        body = r.json()
        self.assertIn("adopt them into the module", body["module_type_id"])
        self.assertEqual(body["adoptable"], ["Te1/1/1", "Te1/1/2"])
        self.assertFalse(Module.objects.exists())

    def test_adopt_keeps_cable_ip_and_fields(self):
        peer = Interface.objects.create(
            device=Device.objects.create(tenant=self.tenant, name="peer"), name="eth0")
        cable = Cable.objects.create(tenant=self.tenant, label="C1")
        CableTermination.objects.create(cable=cable, end="A", interface=self.te1)
        CableTermination.objects.create(cable=cable, end="B", interface=peer)
        prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.9.9.0/24",
                                       status=status_for(self.tenant))
        ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.9.9.1", prefix=prefix,
            assigned_device=self.device, assigned_interface=self.te1)
        Interface.objects.filter(pk=self.te1.pk).update(
            description="uplink", custom_fields={"circuit": "X1"})

        r = self._adopt_install(self.nm8x)
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["adopted"], ["Te1/1/1", "Te1/1/2"])
        self.assertEqual(r.json()["created_interfaces"], 0)
        te1 = Interface.objects.get(pk=self.te1.pk)
        self.assertEqual(str(te1.module_id), r.json()["id"])
        self.assertIsNotNone(te1.module_template_id)
        self.assertEqual((te1.description, te1.custom_fields), ("uplink", {"circuit": "X1"}))
        self.assertTrue(CableTermination.objects.filter(cable=cable, interface=te1).exists())
        ip.refresh_from_db()
        self.assertEqual(ip.assigned_interface_id, te1.pk)
        # A blank type takes the template's; audited as an update.
        te2 = Interface.objects.get(pk=self.te2.pk)
        self.assertEqual(te2.type, "10gbase-x-sfpp")
        entry = ChangeLogEntry.objects.filter(
            object_type="api.interface", object_id=str(te1.pk), action="update").first()
        self.assertIsNotNone(entry)
        self.assertIn("module", entry.changes)
        # Removing the module now removes what it adopted.
        self.client.delete(f"/api/modules/{r.json()['id']}/")
        self.assertFalse(Interface.objects.filter(pk=self.te1.pk).exists())

    def test_foreign_module_component_is_not_adopted(self):
        ModuleBayTemplate.objects.create(device_type=self.dt, name="Slot1b", position="1")
        materialize_device_components(self.device)
        Interface.objects.filter(pk__in=[self.te1.pk, self.te2.pk]).delete()
        first = self._install(self.nm8x)
        self.assertEqual(first.status_code, 201, first.content)
        r = self._adopt_install(self.nm8x, self.device.module_bays.get(name="Slot1b"))
        self.assertEqual(r.status_code, 400)
        self.assertIn("another module", r.json()["module_type_id"])
        self.assertEqual(Module.objects.count(), 1)

    def test_other_media_type_is_not_adopted(self):
        Interface.objects.filter(pk=self.te2.pk).update(type="1000base-t")
        r = self._adopt_install(self.nm8x)
        self.assertEqual(r.status_code, 400)
        self.assertIn("Te1/1/2", r.json()["module_type_id"])
        self.assertNotIn("Te1/1/1", r.json()["module_type_id"])
        self.assertIsNone(Interface.objects.get(pk=self.te1.pk).module_id)

    def test_adopts_a_device_type_power_port(self):
        PowerPortTemplate.objects.create(device_type=self.dt, name="PSU1")
        materialize_device_components(self.device)
        native = self.device.power_ports.get(name="PSU1")
        self.assertEqual(self._install(self.psu, self.ps1).status_code, 400)
        r = self._adopt_install(self.psu, self.ps1)
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["adopted"], ["PSU1"])
        native.refresh_from_db()
        self.assertEqual(str(native.module_id), r.json()["id"])
        self.assertEqual(native.type, "iec-60320-c16")

    def test_replace_adopts(self):
        Interface.objects.filter(pk__in=[self.te1.pk, self.te2.pk]).delete()
        mid = self._install(self.nm1g).json()["id"]
        Interface.objects.create(device=self.device, name="Te1/1/1", type="10gbase-x-sfpp")
        Interface.objects.create(device=self.device, name="Te1/1/2", type="10gbase-x-sfpp")
        r = self.client.patch(f"/api/modules/{mid}/", {
            "module_type_id": str(self.nm8x.id), "confirm_remove": True}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("adoptable", r.json())
        r = self.client.patch(f"/api/modules/{mid}/", {
            "module_type_id": str(self.nm8x.id), "confirm_remove": True,
            "adopt_components": True}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["interfaces"]["adopted"], ["Te1/1/1", "Te1/1/2"])
        self.assertEqual(
            set(Interface.objects.filter(module_id=mid).values_list("name", flat=True)),
            {"Te1/1/1", "Te1/1/2"})


class AnchorTests(_Psu):
    def test_power_port_anchor_matches_and_kinds(self):
        anchors = {"ports": {"PSU{module}": {"p": [0, 0, 0], "n": [0, 0, 1]}}}
        warnings = mismatches(anchors, None, interface_matcher(self.psu, []))
        self.assertEqual(warnings, [])
        unknown = mismatches({"ports": {"PSX{module}": {}}}, None,
                             interface_matcher(self.psu, []))
        self.assertTrue(any("matches no interface" in w for w in unknown))
        self.assertEqual(module_port(self.device, self.psu, "PSU{module}", "1"),
                         ("power-port", "PSU1"))
        ModuleInterfaceTemplate.objects.create(module_type=self.psu, name="Mgmt{module}")
        self.assertEqual(module_port(self.device, self.psu, "Mgmt{module}", "1"),
                         ("interface", "Mgmt1"))

    def test_console_port_anchor_on_the_chassis(self):
        from .anchor_names import chassis_port
        from .models import ConsolePortTemplate

        ConsolePortTemplate.objects.create(device_type=self.dt, name="con 0")
        self.assertEqual(chassis_port(self.device, "con 0"), ("console-port", "con 0"))
        self.assertEqual(chassis_port(self.device, "Gi0/0/1"), ("interface", "Gi0/0/1"))
        self.assertEqual(chassis_port(self.device, "nothing"), ("interface", "nothing"))
        anchors = {"ports": {"con 0": {}, "Gi0/0/1": {}}}
        self.assertEqual(mismatches(anchors, [], interface_matcher(self.dt, ["Gi0/0/1"])), [])

    def test_port_doc_marks_power_ports(self):
        class Owner:
            model_anchors = {"box": [[0, 0, 0], [1, 1, 1]], "bays": {
                "PS-1": {"m": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]}}}
            model_3d_up, model_3d_front = "y", "+z"

        mod = {"ports": {"PSU{module}": {"p": [0.5, 0.5, 1], "n": [0, 0, 1]}}}
        doc = port_doc(Owner(), [("PS-1", lambda n: ("power-port", n.replace("{module}", "1")),
                                  mod)])
        self.assertEqual([(p["kind"], p["name"]) for p in doc["ports"]],
                         [("power-port", "PSU1")])


class PackCheckTests(SimpleTestCase):
    def test_checker_accepts_a_power_inlet_anchor(self):
        from .model_pack import PackFiles
        from .tests_model_anchors import OUT_FRONT, model
        from .tests_model_pack_install import MODULE, PackDir, module_nodes

        p = PackDir()
        try:
            p.write("module-types/Acme/NM-9.yaml", MODULE.replace(
                "model3d:", "power-ports:\n  - name: PSU{module}\n    type: iec-60320-c14\n"
                            "model3d:"))
            nodes = module_nodes() + [
                {"name": "port:PSU{module}", "translation": [0.03, 0.02, 0], "rotation": OUT_FRONT,
                 "extras": {"danbyte_w": 0.03, "danbyte_h": 0.02}}]
            p.write("models/Acme/NM-9.glb", model(nodes))
            files = PackFiles(p.root)
            try:
                rep = check_pack(files)
            finally:
                files.close()
            errors = [f.message for f in rep.findings if f.level == "error"]
            self.assertEqual(errors, [])
        finally:
            p.cleanup()


class PortCountTests(_Psu):
    def test_power_port_is_a_plain_device_power_port(self):
        self._install(self.psu, self.ps0)
        listed = self.client.get(f"/api/power-ports/?device={self.device.id}").json()
        self.assertEqual([p["name"] for p in listed["results"]], ["PSU0"])
        self.assertTrue(PowerPort.objects.filter(device=self.device, module__isnull=False)
                        .exists())
