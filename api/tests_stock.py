"""The stock pool (docs/dcim/stock.md): an inventory item's one home (a
device or a stock place), moving parts between devices and stock, a module
out of its bay into stock and back with its serial and history, the
Inventory list over items and modules, and the reader's and writer's
scope - tenant and site - on every path."""
from __future__ import annotations

from django.contrib.auth.models import User
from django.core.exceptions import ValidationError as DjangoValidationError
from django.db import IntegrityError, transaction
from rest_framework.test import APITestCase

from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from .models import (
    AccessoryType,
    Device,
    DeviceRole,
    DeviceType,
    Interface,
    InventoryEntry,
    InventoryItem,
    Location,
    Manufacturer,
    Module,
    ModuleBay,
    ModuleInterfaceTemplate,
    ModuleType,
    Site,
    Status,
)
from .status_registry import seed_builtin_statuses

ITEMS = "/api/inventory-items/"
INV = "/api/inventory/"


def _tenant(slug):
    org = Organization.objects.create(name=slug.upper(), slug=f"o-{slug}")
    t = Tenant.objects.create(org=org, name=slug.upper(), slug=slug)
    seed_builtin_statuses(t)
    return t


class _Base(APITestCase):
    def setUp(self):
        self.tenant = _tenant("t")
        self.ams = Site.objects.create(tenant=self.tenant, name="AMS")
        self.lon = Site.objects.create(tenant=self.tenant, name="LON")
        self.box = Location.objects.create(tenant=self.tenant, site=self.ams, name="Box",
                                           slug="box")
        self.lon_room = Location.objects.create(tenant=self.tenant, site=self.lon,
                                                name="Room", slug="room")
        self.mfr = Manufacturer.objects.create(tenant=self.tenant, name="Cisco", slug="cisco")
        self.dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=self.mfr,
                                            model="C9300")
        self.role = DeviceRole.objects.create(tenant=self.tenant, name="Switch", slug="sw")
        self.sw1 = self._device("sw1", self.ams)
        self.sw2 = self._device("sw2", self.lon)
        self.te1 = Interface.objects.create(device=self.sw1, name="Te1/0/1",
                                            type="10gbase-x-sfpp")
        self.te2 = Interface.objects.create(device=self.sw2, name="Te1/0/1",
                                            type="10gbase-x-sfpp")
        self.su = User.objects.create_user("su", password="x", is_superuser=True)
        self._login(self.su)

    def _device(self, name, site, tenant=None):
        return Device.objects.create(tenant=tenant or self.tenant, name=name, site=site,
                                     device_type=self.dt, role=self.role)

    def _login(self, user, tenant=None):
        prof, _ = UserProfile.objects.get_or_create(user=user)
        prof.tenants.add(tenant or self.tenant)
        prof.current_tenant = tenant or self.tenant
        prof.save()
        self.client.force_login(user)

    def _status(self, slug, tenant=None):
        return Status.objects.get(tenant=tenant or self.tenant, slug=slug)

    def _optic(self, dev=None, **kw):
        kw.setdefault("name", "SFP 1")
        kw.setdefault("kind", "transceiver")
        kw.setdefault("part_id", "SFP-10G-SR")
        return InventoryItem.objects.create(device=dev, **kw)

    def _move(self, item, **body):
        return self.client.post(f"{ITEMS}{item.id}/move/",
                                {k: str(v.id) if hasattr(v, "id") else v
                                 for k, v in body.items()}, format="json")


# ── one home ────────────────────────────────────────────────────────────────

class HomeRuleTests(_Base):
    def test_existing_shape_is_valid(self):
        item = self._optic(self.sw1)
        item.full_clean()

    def test_database_refuses_no_home_and_two_homes(self):
        with self.assertRaises(IntegrityError), transaction.atomic():
            InventoryItem.objects.create(name="x")
        with self.assertRaises(IntegrityError), transaction.atomic():
            InventoryItem.objects.create(name="x", device=self.sw1, site=self.ams)
        with self.assertRaises(IntegrityError), transaction.atomic():
            InventoryItem.objects.create(name="x", device=self.sw1, location=self.box)

    def test_clean_names_the_problem(self):
        item = InventoryItem(name="x", site=self.ams, location=self.lon_room)
        with self.assertRaises(DjangoValidationError) as ctx:
            item.full_clean()
        self.assertIn("location", ctx.exception.message_dict)
        item = InventoryItem(name="x", site=self.ams, interface=self.te1, kind="transceiver")
        with self.assertRaises(DjangoValidationError) as ctx:
            item.full_clean()
        self.assertIn("interface", ctx.exception.message_dict)

    def test_create_in_stock_through_the_api(self):
        res = self.client.post(ITEMS, {"site_id": str(self.ams.id), "location_id":
                                       str(self.box.id), "name": "SFP", "kind": "transceiver",
                                       "serial_number": "S1"}, format="json")
        self.assertEqual(res.status_code, 201, res.content)
        body = res.json()
        self.assertEqual((body["home"], body["site"]["name"], body["location"]["name"],
                          body["device"]), ("stock", "AMS", "Box", None))
        res = self.client.post(ITEMS, {"name": "SFP", "kind": "transceiver"}, format="json")
        self.assertEqual(res.status_code, 400)
        self.assertIn("device_id", res.json())

    def test_location_must_be_at_the_site(self):
        res = self.client.post(ITEMS, {"site_id": str(self.ams.id), "location_id":
                                       str(self.lon_room.id), "name": "SFP"}, format="json")
        self.assertEqual(res.status_code, 400)
        self.assertIn("location_id", res.json())

    def test_patch_site_moves_off_the_device(self):
        item = self._optic(self.sw1, interface=self.te1)
        res = self.client.patch(f"{ITEMS}{item.id}/", {"site_id": str(self.ams.id)},
                                format="json")
        self.assertEqual(res.status_code, 200, res.content)
        item.refresh_from_db()
        self.assertEqual((item.device_id, item.interface_id, item.site_id),
                         (None, None, self.ams.id))


# ── moves ───────────────────────────────────────────────────────────────────

class MoveTests(_Base):
    def test_to_stock_keeps_serial_and_history(self):
        item = self._optic(self.sw1, interface=self.te1, serial_number="FNS1", asset_tag="A1")
        res = self._move(item, site_id=self.ams, location_id=self.box)
        self.assertEqual(res.status_code, 200, res.content)
        item.refresh_from_db()
        self.assertEqual((item.device_id, item.interface_id, item.site_id, item.location_id,
                          item.serial_number, item.asset_tag, item.status.slug),
                         (None, None, self.ams.id, self.box.id, "FNS1", "A1", "in_stock"))
        self.assertTrue(ChangeLogEntry.objects.filter(
            object_type="api.inventoryitem", object_id=str(item.id), action="update").exists())

    def test_named_status_rma(self):
        item = self._optic(self.sw1, interface=self.te1)
        res = self._move(item, site_id=self.ams, status_id=self._status("rma"))
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.json()["status"]["name"], "RMA")

    def test_a_status_not_offered_to_items_is_refused(self):
        cable_only = Status.objects.create(tenant=self.tenant, name="C", slug="c",
                                           available_to=["cable"])
        res = self._move(self._optic(self.sw1), site_id=self.ams, status_id=cable_only)
        self.assertEqual(res.status_code, 400)

    def test_keep_on_device_unseats_as_spare(self):
        item = self._optic(self.sw1, interface=self.te1)
        res = self._move(item, device_id=self.sw1)
        self.assertEqual(res.status_code, 200, res.content)
        item.refresh_from_db()
        self.assertEqual((item.device_id, item.interface_id, item.status.slug),
                         (self.sw1.id, None, "spare"))

    def test_install_from_stock_into_a_port(self):
        item = self._optic(None, site=self.lon, location=self.lon_room, name="SFP 1")
        self._optic(self.sw1, name="SFP 1")  # the name is taken on sw1
        res = self._move(item, interface_id=self.te1)
        self.assertEqual(res.status_code, 200, res.content)
        item.refresh_from_db()
        self.assertEqual((item.device_id, item.interface_id, item.site_id, item.location_id,
                          item.name, item.status.slug),
                         (self.sw1.id, self.te1.id, None, None, "SFP 1 2", "active"))

    def test_occupied_port_is_refused(self):
        self._optic(self.sw1, name="there", interface=self.te1)
        item = self._optic(None, site=self.ams)
        res = self._move(item, interface_id=self.te1)
        self.assertEqual(res.status_code, 400)
        self.assertIn("interface_id", res.json())

    def test_neither_or_both_homes_refused(self):
        item = self._optic(self.sw1)
        self.assertEqual(self._move(item).status_code, 400)
        self.assertEqual(self._move(item, site_id=self.ams, device_id=self.sw1).status_code,
                         400)

    def test_sub_parts_follow(self):
        card = InventoryItem.objects.create(device=self.sw1, name="card", kind="other")
        sub = InventoryItem.objects.create(device=self.sw1, name="sub", parent=card)
        self.assertEqual(self._move(card, site_id=self.ams, location_id=self.box).status_code,
                         200)
        sub.refresh_from_db()
        self.assertEqual((sub.device_id, sub.site_id, sub.location_id, sub.parent_id),
                         (None, self.ams.id, self.box.id, card.id))


class StockListTests(_Base):
    def test_home_and_fits_filters(self):
        AccessoryType.objects.create(tenant=self.tenant, vendor="G", name="SR", kind="transceiver",
                                     fits=["10gbase-x-sfpp"], parts=["SFP-10G-SR"])
        AccessoryType.objects.create(tenant=self.tenant, vendor="G", name="QSFP",
                                     kind="transceiver", fits=["40gbase-x-qsfpp"],
                                     parts=["QSFP-40G-SR4"])
        self._optic(None, site=self.ams, name="fits", part_id="sfp-10g-sr=")
        self._optic(None, site=self.lon, name="unknown", part_id="XYZ")
        self._optic(None, site=self.ams, name="no", part_id="QSFP-40G-SR4")
        self._optic(self.sw1, name="on device")
        res = self.client.get(ITEMS, {"home": "stock", "kind": "transceiver",
                                      "fits": "10gbase-x-sfpp", "near_site": str(self.lon.id)})
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual([r["name"] for r in res.json()["results"]], ["unknown", "fits"])

    def test_site_filter_reads_stock_site(self):
        self._optic(None, site=self.ams, name="a")
        self._optic(self.sw1, name="b")
        self._optic(self.sw2, name="c")
        res = self.client.get(ITEMS, {"site": str(self.ams.id)})
        self.assertEqual(sorted(r["name"] for r in res.json()["results"]), ["a", "b"])

    def test_bad_home_is_400(self):
        self.assertEqual(self.client.get(ITEMS, {"home": "attic"}).status_code, 400)


# ── modules ─────────────────────────────────────────────────────────────────

class ModuleRoundTripTests(_Base):
    def setUp(self):
        super().setUp()
        self.mt = ModuleType.objects.create(tenant=self.tenant, name="PSU-1100",
                                            manufacturer=self.mfr, part_number="PWR-C1-1100WAC")
        ModuleInterfaceTemplate.objects.create(module_type=self.mt, name="Mgmt{module}",
                                               type="1000base-t")
        self.bay1 = ModuleBay.objects.create(device=self.sw1, name="PS1", position="1")
        self.bay2 = ModuleBay.objects.create(device=self.sw2, name="PS1", position="1")

    def _install(self):
        res = self.client.post("/api/modules/", {
            "device_id": str(self.sw1.id), "module_bay_id": str(self.bay1.id),
            "module_type_id": str(self.mt.id), "serial_number": "LIT1",
            "asset_tag": "A9"}, format="json")
        self.assertEqual(res.status_code, 201, res.content)
        return Module.objects.get(pk=res.json()["id"])

    def test_module_to_stock_and_back_keeps_id_serial_and_history(self):
        module = self._install()
        self.assertTrue(Interface.objects.filter(device=self.sw1, name="Mgmt1").exists())
        res = self.client.post(f"/api/modules/{module.id}/remove/",
                               {"site_id": str(self.ams.id), "location_id": str(self.box.id)},
                               format="json")
        self.assertEqual(res.status_code, 201, res.content)
        self.assertFalse(Module.objects.filter(pk=module.id).exists())
        self.assertFalse(Interface.objects.filter(device=self.sw1, name="Mgmt1").exists())
        item = InventoryItem.objects.get(pk=module.id)
        self.assertEqual((item.kind, item.module_type_id, item.serial_number, item.asset_tag,
                          item.part_id, item.manufacturer_id, item.site_id, item.status.slug),
                         ("module", self.mt.id, "LIT1", "A9", "PWR-C1-1100WAC", self.mfr.id,
                          self.ams.id, "in_stock"))
        res = self.client.post(f"{ITEMS}{item.id}/install-module/",
                               {"module_bay_id": str(self.bay2.id)}, format="json")
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(res.json()["created_interfaces"], 1)
        back = Module.objects.get(pk=module.id)
        self.assertEqual((back.device_id, back.module_bay_id, back.serial_number,
                          back.asset_tag), (self.sw2.id, self.bay2.id, "LIT1", "A9"))
        self.assertFalse(InventoryItem.objects.filter(pk=module.id).exists())
        # One unit, one history: both forms share the id.
        res = self.client.get("/api/changelog/", {"object_id": str(module.id)})
        self.assertEqual(res.status_code, 200, res.content)
        types = {r["object_type"] for r in res.json()["results"]}
        self.assertEqual(types, {"api.module", "api.inventoryitem"})

    def test_keep_module_on_its_device(self):
        module = self._install()
        res = self.client.post(f"/api/modules/{module.id}/remove/", {"device_id":
                                                                     str(self.sw1.id)},
                               format="json")
        self.assertEqual(res.status_code, 201, res.content)
        item = InventoryItem.objects.get(pk=module.id)
        self.assertEqual((item.device_id, item.status.slug), (self.sw1.id, "spare"))

    def test_busy_bay_is_refused_and_nothing_changes(self):
        self._install()
        item = InventoryItem.objects.create(site=self.ams, name="PSU", kind="module",
                                            module_type=self.mt)
        res = self.client.post(f"{ITEMS}{item.id}/install-module/",
                               {"module_bay_id": str(self.bay1.id)}, format="json")
        self.assertEqual(res.status_code, 400)
        self.assertTrue(InventoryItem.objects.filter(pk=item.pk).exists())

    def test_an_item_without_a_module_type_does_not_install(self):
        item = self._optic(None, site=self.ams)
        res = self.client.post(f"{ITEMS}{item.id}/install-module/",
                               {"module_bay_id": str(self.bay1.id)}, format="json")
        self.assertEqual(res.status_code, 400)


# ── the Inventory list ──────────────────────────────────────────────────────

class InventoryListTests(_Base):
    def setUp(self):
        super().setUp()
        self.mt = ModuleType.objects.create(tenant=self.tenant, name="NM-8X", part_number="NM")
        bay = ModuleBay.objects.create(device=self.sw1, name="Slot 1", position="1")
        self.module = Module.objects.create(device=self.sw1, module_bay=bay,
                                            module_type=self.mt, serial_number="M1")
        self._optic(self.sw1, name="seated", interface=self.te1, serial_number="S1")
        self._optic(self.sw1, name="loose")
        self._optic(None, site=self.ams, location=self.box, name="stock 1",
                    status=self._status("in_stock"))
        self._optic(None, site=self.ams, location=self.box, name="stock 2",
                    status=self._status("in_stock"))

    def test_one_row_per_unit_with_its_home(self):
        res = self.client.get(INV, {"view": "table", "page": 1, "page_size": 250})
        self.assertEqual(res.status_code, 200, res.content)
        rows = {r["name"]: r for r in res.json()["results"]}
        self.assertEqual(res.json()["count"], 5)
        self.assertEqual({n: r["home"] for n, r in rows.items()}, {
            "NM-8X": "bay", "seated": "port", "loose": "device", "stock 1": "stock",
            "stock 2": "stock"})
        self.assertEqual(rows["NM-8X"]["module_bay"]["name"], "Slot 1")
        self.assertEqual(rows["stock 1"]["location"]["name"], "Box")
        self.assertEqual(rows["stock 1"]["status"]["name"], "In Stock")

    def test_facets_filters_ordering_and_counts(self):
        res = self.client.get(INV, {"f_home": "stock", "ordering": "-name"})
        self.assertEqual([r["name"] for r in res.json()["results"]], ["stock 2", "stock 1"])
        facets = self.client.get(f"{INV}facets/").json()["facets"]
        self.assertEqual({b["value"]: b["count"] for b in facets["home"]},
                         {"bay": 1, "port": 1, "device": 1, "stock": 2})
        counts = self.client.get(f"{INV}counts/", {"f_home": "stock", "view": "table",
                                                   "ordering": "-count"}).json()
        for r in counts["results"]:
            r.pop("id")
        self.assertEqual(counts["results"], [{
            "part": "SFP-10G-SR", "kind": "transceiver", "manufacturer": None,
            "site": {"id": str(self.ams.id), "name": "AMS"},
            "location": {"id": str(self.box.id), "name": "Box"}, "count": 2}])
        self.assertEqual(self.client.get(INV, {"ordering": "nope"}).status_code, 400)
        self.assertEqual(self.client.get(f"{INV}counts/", {"ordering": "x"}).status_code, 400)
        counts_rail = self.client.get(f"{INV}counts/facets/").json()["facets"]
        self.assertIn("status", counts_rail)
        self.assertEqual(self.client.get(INV, {"f_nope": "x"}).status_code, 400)

    def test_search(self):
        res = self.client.get(INV, {"search": "M1"})
        self.assertEqual([r["name"] for r in res.json()["results"]], ["NM-8X"])

    def test_the_view_is_one_row_per_id(self):
        ids = list(InventoryEntry.objects.values_list("pk", flat=True))
        self.assertEqual(len(ids), len(set(ids)))


# ── tenant isolation ────────────────────────────────────────────────────────

class TenantIsolationTests(_Base):
    def setUp(self):
        super().setUp()
        self.other = _tenant("x")
        self.x_site = Site.objects.create(tenant=self.other, name="X")
        self.x_loc = Location.objects.create(tenant=self.other, site=self.x_site, name="XB",
                                             slug="xb")
        self.x_item = InventoryItem.objects.create(site=self.x_site, name="theirs")
        dtx = DeviceType.objects.create(tenant=self.other, model="X")
        self.x_dev = Device.objects.create(tenant=self.other, name="xdev", site=self.x_site,
                                           device_type=dtx)
        self.x_iface = Interface.objects.create(device=self.x_dev, name="Te1",
                                                type="10gbase-x-sfpp")
        self.x_bay = ModuleBay.objects.create(device=self.x_dev, name="B", position="1")
        self.x_status = self._status("in_stock", self.other)

    def test_foreign_rows_are_invisible(self):
        self.assertEqual(self.client.get(f"{ITEMS}{self.x_item.id}/").status_code, 404)
        self.assertNotIn("theirs", [r["name"] for r in self.client.get(INV).json()["results"]])
        self.assertEqual(self._move(self.x_item, site_id=self.ams).status_code, 404)

    def test_foreign_ids_in_move_payloads_are_refused(self):
        item = self._optic(self.sw1)
        for body in ({"site_id": self.x_site}, {"site_id": self.ams, "location_id": self.x_loc},
                     {"device_id": self.x_dev}, {"interface_id": self.x_iface},
                     {"site_id": self.ams, "status_id": self.x_status}):
            with self.subTest(body=list(body)):
                res = self._move(item, **body)
                self.assertEqual(res.status_code, 400, res.content)
        item.refresh_from_db()
        self.assertEqual(item.device_id, self.sw1.id)

    def test_foreign_ids_in_create_and_install_are_refused(self):
        res = self.client.post(ITEMS, {"site_id": str(self.x_site.id), "name": "n"},
                               format="json")
        self.assertEqual(res.status_code, 400)
        mt = ModuleType.objects.create(tenant=self.tenant, name="M")
        item = InventoryItem.objects.create(site=self.ams, name="M", kind="module",
                                            module_type=mt)
        res = self.client.post(f"{ITEMS}{item.id}/install-module/",
                               {"module_bay_id": str(self.x_bay.id)}, format="json")
        self.assertEqual(res.status_code, 400)
        self.assertFalse(Module.objects.filter(pk=item.pk).exists())

    def test_foreign_parent_is_refused(self):
        res = self.client.post(ITEMS, {"site_id": str(self.ams.id), "name": "n",
                                       "parent_id": str(self.x_item.id)}, format="json")
        self.assertEqual(res.status_code, 400)


# ── site scope ──────────────────────────────────────────────────────────────

class SiteScopeTests(_Base):
    def setUp(self):
        super().setUp()
        self.user = User.objects.create_user("u", password="x")
        self.ams_stock = self._optic(None, site=self.ams, name="ams stock")
        self.lon_stock = self._optic(None, site=self.lon, name="lon stock")
        self.ams_dev = self._optic(self.sw1, name="ams dev")

    def _grant(self, types, actions, sites=None):
        p = ObjectPermission.objects.create(name="+".join(types) + "-".join(actions),
                                            object_types=types, actions=actions)
        p.users.add(self.user)
        p.tenants.add(self.tenant)
        if sites:
            p.sites.set(sites)

    def test_a_stock_items_site_decides_who_sees_it(self):
        self._grant(["inventoryitem", "module"], ["view"], sites=[self.ams])
        self._login(self.user)
        names = {r["name"] for r in self.client.get(ITEMS).json()["results"]}
        self.assertEqual(names, {"ams stock", "ams dev"})
        names = {r["name"] for r in self.client.get(INV).json()["results"]}
        self.assertEqual(names, {"ams stock", "ams dev"})

    def test_no_view_no_rows(self):
        self._grant(["device"], ["view"])
        self._login(self.user)
        self.assertEqual(self.client.get(INV).json()["count"], 0)

    def test_site_writer_cannot_move_into_or_out_of_another_site(self):
        self._grant(["inventoryitem", "device", "interface", "site", "location"], ["view"])
        self._grant(["inventoryitem"], ["change"], sites=[self.ams])
        self._login(self.user)
        # Out of LON: not theirs to change.
        res = self._move(self.lon_stock, site_id=self.ams)
        self.assertIn(res.status_code, (403, 404))
        # Into LON: refused where it lands, nothing changes.
        res = self._move(self.ams_stock, site_id=self.lon)
        self.assertEqual(res.status_code, 403, res.content)
        self.ams_stock.refresh_from_db()
        self.assertEqual(self.ams_stock.site_id, self.ams.id)
        res = self._move(self.ams_stock, interface_id=self.te2)
        self.assertEqual(res.status_code, 403, res.content)
        # Within AMS: fine.
        res = self._move(self.ams_stock, interface_id=self.te1)
        self.assertEqual(res.status_code, 200, res.content)

    def test_removing_a_module_needs_delete(self):
        mt = ModuleType.objects.create(tenant=self.tenant, name="M")
        bay = ModuleBay.objects.create(device=self.sw1, name="B", position="1")
        module = Module.objects.create(device=self.sw1, module_bay=bay, module_type=mt)
        self._grant(["module", "inventoryitem"], ["view", "change", "add"])
        self._login(self.user)
        res = self.client.post(f"/api/modules/{module.id}/remove/",
                               {"site_id": str(self.ams.id)}, format="json")
        self.assertEqual(res.status_code, 403)
        self.assertTrue(Module.objects.filter(pk=module.pk).exists())


# ── the inventory report ────────────────────────────────────────────────────

class InventoryReportTests(_Base):
    URL = "/api/inventory/report/"

    def setUp(self):
        super().setUp()
        self._optic(None, site=self.ams, location=self.box, name="a",
                    serial_number="SER-A", status=self._status("in_stock"))
        self._optic(None, site=self.ams, location=self.box, name="b",
                    serial_number="SER-B", status=self._status("in_stock"))
        self._optic(self.sw2, name="c", serial_number="SER-C")

    def _build(self, **body):
        from types import SimpleNamespace

        from .reports.kinds import inventory as inv

        ser = inv.InventoryReportRequestSerializer(data=body)
        ser.is_valid(raise_exception=True)
        data = dict(ser.validated_data)
        data["options"] = dict(data["options"])
        request = SimpleNamespace(user=self.su, query_params={})
        report = inv.build(request, data, self.tenant)
        return report, inv.page_html(request, data, self.tenant, report)

    def test_describe_and_estimate(self):
        res = self.client.get(self.URL)
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual([s["key"] for s in res.json()["sections"]],
                         ["totals", "counts", "items"])
        res = self.client.post(f"{self.URL}?estimate=1", {"filters": {"f_home": "stock"}},
                               format="json")
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual((res.json()["rows"], res.json()["mode"]), (2, "now"))

    def test_scope_counts_and_appendix(self):
        report, html = self._build(filters={"f_site": str(self.ams.id)})
        self.assertEqual(report["total"], 2)
        self.assertIn("SER-A", html)
        self.assertNotIn("SER-C", html)
        self.assertIn("In Stock", html)
        self.assertIn("Counts per part", html)
        # The header names the filter, not its id.
        self.assertIn("AMS", html)
        self.assertNotIn(str(self.ams.id), html)
        _report, html = self._build(filters={}, sections=["totals"])
        self.assertNotIn("SER-A", html)

    def test_unknown_filter_is_400(self):
        res = self.client.post(f"{self.URL}?estimate=1", {"filters": {"device": "x"}},
                               format="json")
        self.assertEqual(res.status_code, 400)

    def test_reader_scope(self):
        user = User.objects.create_user("r", password="x")
        self._login(user)
        self.assertEqual(self.client.get(self.URL).status_code, 403)
        p = ObjectPermission.objects.create(name="v", object_types=["inventoryitem"],
                                            actions=["view"])
        p.users.add(user)
        p.tenants.add(self.tenant)
        p.sites.set([self.lon])
        res = self.client.post(f"{self.URL}?estimate=1", {}, format="json")
        self.assertEqual(res.json()["rows"], 1)

    def test_pdf(self):
        res = self.client.post(self.URL, {"options": {"cover": True}}, format="json")
        self.assertEqual(res.status_code, 200, getattr(res, "data", res.content[:200]))
        self.assertEqual(res["Content-Type"], "application/pdf")
        self.assertTrue(res.content.startswith(b"%PDF"))
