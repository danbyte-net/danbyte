"""Transceivers per port (docs/dcim/inventory.md → Transceivers): an
inventory item of kind transceiver linked to its interface - the rules, the
reader's and writer's scope, what deleting the port or its module does, the
interface's ``transceiver``, bulk edit, audit - and the 3D part a
port with a record draws (api.port_plugs: the choice order, ``cabled``, the
facts, the query count)."""
from __future__ import annotations

from django.contrib.auth.models import User
from django.db import connection
from django.test import SimpleTestCase
from django.test.utils import CaptureQueriesContext

from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile

from .models import (
    AccessoryType,
    Device,
    Interface,
    InventoryItem,
    Module,
    ModuleBay,
    ModuleInterfaceTemplate,
    Site,
    uninstall_module,
)
from .port_plugs import part_key, read_accessory
from .tests_port_plugs import SFP, _Base

URL = "/api/inventory-items/"


def _item(dev, name="SFP 1", **kw):
    return InventoryItem.objects.create(device=dev, name=name, kind="transceiver", **kw)


class PartKeyTests(SimpleTestCase):
    def test_part_key(self):
        self.assertEqual(part_key(" sfp-10g-sr= "), "SFP-10G-SR")
        self.assertEqual(part_key("SFP-10G-SR"), part_key("sfp-10g-sr="))

    def test_read_accessory_facts(self):
        doc = {"name": "SFP-10G-SR", "kind": "transceiver", "connector": "lc",
               "fits": ["10gbase-x-sfpp"], "parts": ["SFP-10G-SR", "sfp-10g-sr", "", "X"],
               "standard": "10GBASE-SR", "wavelength_nm": 850,
               "model3d": {"file": "models/Cisco/SFP-10G-SR.glb"}}
        fields, notes = read_accessory("accessory-types/Cisco/SFP-10G-SR.yaml", doc)
        self.assertEqual((fields["parts"], fields["standard"], fields["wavelength_nm"]),
                         (["SFP-10G-SR", "X"], "10GBASE-SR", 850))
        self.assertEqual(notes, ["parts: '' is not a part number - ignored."])
        fields, notes = read_accessory("accessory-types/Cisco/X.yaml",
                                       {**doc, "parts": "SFP-10G-SR", "wavelength_nm": "850"})
        self.assertEqual((fields["parts"], fields["wavelength_nm"]), ([], None))
        self.assertEqual(len(notes), 2)
        fields, _ = read_accessory("accessory-types/Generic/SFP-SR-LC.yaml",
                                   {k: v for k, v in doc.items()
                                    if k not in ("parts", "standard", "wavelength_nm")})
        self.assertEqual((fields["parts"], fields["standard"], fields["wavelength_nm"]),
                         ([], "", None))


# ── the record ──────────────────────────────────────────────────────────────

class RecordTests(_Base):
    def setUp(self):
        super().setUp()
        self.te1 = self._iface(self.dev, "Te1/0/1")
        self.te2 = self._iface(self.dev, "Te1/0/2")

    def _post(self, **body):
        return self.client.post(URL, {"device_id": str(self.dev.id), "name": "SFP 1",
                                      "kind": "transceiver", **body}, format="json")

    def test_seat_a_transceiver(self):
        res = self._post(interface_id=str(self.te1.id), part_id="SFP-10G-SR",
                         standard="10GBASE-SR", wavelength_nm=850, reach_m=300,
                         connector="lc", accessory_type_id=str(self.sr.id))
        self.assertEqual(res.status_code, 201, res.content)
        body = res.json()
        self.assertEqual(body["interface"], {"id": str(self.te1.id), "name": "Te1/0/1"})
        self.assertEqual(body["accessory_type"]["name"], "SFP-SR-LC")
        self.assertEqual((body["standard"], body["wavelength_nm"], body["reach_m"],
                          body["connector"]), ("10GBASE-SR", 850, 300, "lc"))
        iface = self.client.get(f"/api/interfaces/{self.te1.id}/").json()
        self.assertEqual(iface["transceiver"]["part_id"], "SFP-10G-SR")

    def test_rules(self):
        res = self._post(interface_id=str(self.te1.id), kind="disk")
        self.assertEqual(res.status_code, 400)
        self.assertIn("Only a transceiver", res.json()["interface_id"][0])
        other = self._device("sw2")
        res = self._post(interface_id=str(self._iface(other, "Te1/0/1").id))
        self.assertIn("same device", res.json()["interface_id"][0])
        Interface.objects.filter(pk=self.te2.pk).update(type="1000base-t")
        res = self._post(interface_id=str(self.te2.id))
        self.assertIn("takes no transceiver", res.json()["interface_id"][0])
        _item(self.dev, "SFP 0", interface=self.te1)
        res = self._post(interface_id=str(self.te1.id))
        self.assertIn("SFP 0 already sits", res.json()["interface_id"][0])

    def test_type_other_and_module_ports_take_one(self):
        Interface.objects.filter(pk=self.te2.pk).update(type="other")
        self.assertEqual(self._post(interface_id=str(self.te2.id)).status_code, 201)
        bay = ModuleBay.objects.get(device=self.dev, name="PS-1")
        mod = Module.objects.get(module_bay=bay)
        port = Interface.objects.create(device=self.dev, module=mod, name="Te1/1/1",
                                        type="25gbase-x-sfp28")
        res = self._post(name="SFP 2", interface_id=str(port.id))
        self.assertEqual(res.status_code, 201, res.content)

    def test_kind_and_device_changes_keep_the_rules(self):
        it = _item(self.dev, interface=self.te1)
        res = self.client.patch(f"{URL}{it.id}/", {"kind": "other"}, format="json")
        self.assertEqual(res.status_code, 400)
        other = self._device("sw2")
        res = self.client.patch(f"{URL}{it.id}/", {"device_id": str(other.id)}, format="json")
        self.assertEqual(res.status_code, 400)
        res = self.client.patch(f"{URL}{it.id}/", {"interface_id": None}, format="json")
        self.assertEqual(res.status_code, 200, res.content)
        self.assertIsNone(res.json()["interface"])

    def test_another_tenants_ids_are_refused(self):
        site = Site.objects.create(tenant=self.other, name="B")
        dev = Device.objects.create(tenant=self.other, name="far", device_type=self.dt,
                                    site=site)
        far = Interface.objects.create(device=dev, name="Te9", type="10gbase-x-sfpp")
        res = self._post(interface_id=str(far.id))
        self.assertEqual(res.status_code, 400)
        self.assertIn("interface_id", res.json())
        acc = self._acc("FAR", "lc", SFP, tenant=self.other)
        res = self._post(accessory_type_id=str(acc.id))
        self.assertEqual(res.status_code, 400)
        self.assertIn("accessory_type_id", res.json())

    def test_deleting_the_port_or_its_module_keeps_the_item(self):
        it = _item(self.dev, interface=self.te1)
        self.te1.delete()
        it.refresh_from_db()
        self.assertIsNone(it.interface_id)
        mod = Module.objects.get(module_bay__device=self.dev, module_bay__name="PS-1")
        ModuleInterfaceTemplate.objects.create(module_type=self.psu, name="Te1/{module}/5",
                                               type="10gbase-x-sfpp")
        from .models import install_module

        install_module(mod)
        port = Interface.objects.get(device=self.dev, name="Te1/1/5")
        it2 = _item(self.dev, "SFP 2", interface=port)
        uninstall_module(mod)
        it2.refresh_from_db()
        self.assertIsNone(it2.interface_id)
        mod.delete()
        self.assertTrue(InventoryItem.objects.filter(pk=it2.pk).exists())

    def test_free_items_filter(self):
        _item(self.dev, "SFP 0", interface=self.te1)
        _item(self.dev, "SFP 1")
        InventoryItem.objects.create(device=self.dev, name="Disk", kind="disk")
        res = self.client.get(URL, {"device": str(self.dev.id), "kind": "transceiver",
                                    "in_port": "false"})
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual([r["name"] for r in res.json()["results"]], ["SFP 1"])

    def test_bulk_kind_change_is_refused_for_seated_items(self):
        it = _item(self.dev, interface=self.te1)
        free = _item(self.dev, "SFP 2")
        res = self.client.post(f"{URL}bulk-update/", {"ids": [str(it.id), str(free.id)],
                                                       "fields": {"kind": "other"}},
                               format="json")
        self.assertEqual(res.status_code, 400, res.content)
        self.assertIn("SFP 1", str(res.json()))
        res = self.client.post(f"{URL}bulk-update/", {"ids": [str(it.id), str(free.id)],
                                                       "fields": {"standard": "10GBASE-LR",
                                                                  "wavelength_nm": 1310}},
                               format="json")
        self.assertEqual(res.status_code, 200, res.content)
        it.refresh_from_db()
        self.assertEqual((it.standard, it.wavelength_nm), ("10GBASE-LR", 1310))

    def test_changes_are_audited(self):
        it = _item(self.dev)
        res = self.client.patch(f"{URL}{it.id}/", {"interface_id": str(self.te1.id),
                                                   "standard": "10GBASE-SR"}, format="json")
        self.assertEqual(res.status_code, 200, res.content)
        entry = ChangeLogEntry.objects.filter(object_id=str(it.id), action="update").first()
        self.assertIsNotNone(entry)
        self.assertIn("interface", entry.changes)
        self.assertIn("standard", entry.changes)


# ── the reader's and writer's scope ─────────────────────────────────────────

class ScopeTests(_Base):
    def setUp(self):
        super().setUp()
        self.lon = Site.objects.create(tenant=self.tenant, name="LON")
        self.far = self._device("sw2")
        Device.objects.filter(pk=self.far.pk).update(site=self.lon)
        self.it_ams = _item(self.dev, interface=self._iface(self.dev, "Te1/0/1"),
                            part_id="SFP-10G-SR", serial_number="AMS1")
        self.it_lon = _item(self.far, interface=self._iface(self.far, "Te1/0/1"),
                            part_id="SFP-10G-LR", serial_number="LON1")
        self.user = User.objects.create_user("u", password="x")
        UserProfile.objects.create(user=self.user).tenants.add(self.tenant)

    def _grant(self, types, actions, sites=None):
        p = ObjectPermission.objects.create(name="+".join(types) + "-".join(actions),
                                            object_types=types, actions=actions)
        p.users.add(self.user)
        p.tenants.add(self.tenant)
        if sites:
            p.sites.set(sites)

    def _transceivers(self):
        res = self.client.get("/api/interfaces/", {"page_size": 100})
        self.assertEqual(res.status_code, 200, res.content)
        return {r["device"]["name"]: (r["transceiver"] or {}).get("serial_number")
                for r in res.json()["results"] if r["name"] == "Te1/0/1"}

    def test_interface_transceiver_follows_inventory_view(self):
        self._grant(["device", "interface"], ["view"])
        self._login(self.user)
        self.assertEqual(self._transceivers(), {"sw1": None, "sw2": None})
        self._grant(["inventoryitem"], ["view"], sites=[self.site])
        self.assertEqual(self._transceivers(), {"sw1": "AMS1", "sw2": None})

    def test_site_scoped_writer_cannot_seat_in_another_site(self):
        self._grant(["device", "interface", "inventoryitem"], ["view"])
        self._grant(["inventoryitem"], ["add", "change"], sites=[self.site])
        self._login(self.user)
        res = self.client.patch(f"{URL}{self.it_lon.id}/", {"interface_id": None},
                                format="json")
        self.assertIn(res.status_code, (403, 404))
        self.it_lon.refresh_from_db()
        self.assertIsNotNone(self.it_lon.interface_id)
        free = _item(self.far, "SFP 9")
        res = self.client.patch(
            f"{URL}{free.id}/", {"interface_id": str(self._iface(self.far, "Te1/0/2").id)},
            format="json")
        self.assertIn(res.status_code, (400, 403, 404))
        free.refresh_from_db()
        self.assertIsNone(free.interface_id)
        res = self.client.patch(f"{URL}{self.it_ams.id}/", {"interface_id": None},
                                format="json")
        self.assertEqual(res.status_code, 200, res.content)


# ── the 3D part ─────────────────────────────────────────────────────────────

class PlugTests(_Base):
    def setUp(self):
        super().setUp()
        self.te1 = self._iface(self.dev, "Te1/0/1")
        self.lr = self._acc("SFP-10G-LR", "lc", ["10gbase-x-sfpp"])
        AccessoryType.objects.filter(pk=self.lr.pk).update(
            kind="transceiver", vendor="Cisco", parts=["SFP-10G-LR", "SFP-10G-LR-S"])
        self.lr.refresh_from_db()

    def _by_port(self, dev=None):
        return {p["port"]: p for p in self._plugs(dev)}

    def test_an_uncabled_port_with_a_record_shows_its_part(self):
        _item(self.dev, interface=self.te1, part_id="sfp-10g-lr-s=", serial_number="FNS1")
        p = self._by_port()["Te1/0/1"]
        self.assertEqual((p["url"], p["cabled"], p["transceiver"]),
                         (self._url(self.lr), False,
                          {"part_id": "sfp-10g-lr-s=", "serial": "FNS1"}))
        self.assertNotIn("Te1/0/2", self._by_port())

    def test_choice_order(self):
        it = _item(self.dev, interface=self.te1, part_id="SFP-10G-LR")
        self._cable(self.te1, type="dac-passive")
        # The part ID beats the cable rule.
        p = self._by_port()["Te1/0/1"]
        self.assertEqual((p["url"], p["cabled"]), (self._url(self.lr), True))
        # The hand-set part beats the part ID.
        InventoryItem.objects.filter(pk=it.pk).update(accessory_type=self.sr)
        self.assertEqual(self._by_port()["Te1/0/1"]["url"], self._url(self.sr))
        # No match: the cable rule.
        InventoryItem.objects.filter(pk=it.pk).update(accessory_type=None, part_id="NOPE")
        self.assertEqual(self._by_port()["Te1/0/1"]["url"], self._url(self.dac))

    def test_cabled_port_without_a_record(self):
        self._cable(self.te1, type="mmf-om4")
        p = self._by_port()["Te1/0/1"]
        self.assertEqual((p["cabled"], p["transceiver"]), (True, None))

    def test_a_reader_who_may_not_view_inventory_gets_no_record(self):
        _item(self.dev, interface=self.te1, part_id="SFP-10G-LR", serial_number="S1")
        self._cable(self._iface(self.dev, "Te1/0/2"), type="mmf-om4")
        user = User.objects.create_user("u", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        grant = ObjectPermission.objects.create(
            name="r", object_types=["device", "devicetype", "moduletype", "interface",
                                    "cable"], actions=["view"])
        grant.users.add(user)
        grant.tenants.add(self.tenant)
        self._login(user)
        ports = self._by_port()
        self.assertEqual(list(ports), ["Te1/0/2"])
        self.assertIsNone(ports["Te1/0/2"]["transceiver"])
        grant.object_types = [*grant.object_types, "inventoryitem"]
        grant.save()
        self.assertEqual(self._by_port()["Te1/0/1"]["transceiver"]["serial"], "S1")

    def test_query_count_does_not_grow_with_records(self):
        _item(self.dev, interface=self.te1, part_id="SFP-10G-LR")
        with CaptureQueriesContext(connection) as one:
            self._leds(self.dev)
        more = [self._device(f"sw{i}") for i in range(2, 7)]
        for d in more:
            self._typed(d)
            _item(d, interface=self._iface(d, "Te1/0/2"), part_id="SFP-10G-LR")
            self._cable(self._iface(d, "Te1/0/1"), type="dac-active")
        with CaptureQueriesContext(connection) as six:
            out = self._leds(self.dev, *more)
        self.assertEqual(len(six), len(one))
        for d in more:
            ports = {p["port"]: p["url"] for p in out[str(d.id)]["plugs"]}
            self.assertEqual(ports, {"Te1/0/1": self._url(self.dac),
                                     "Te1/0/2": self._url(self.lr)})
