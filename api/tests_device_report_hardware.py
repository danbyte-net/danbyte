"""The device report's Hardware section, and the spec sheets it shares its
parts with: off by default, the spec boxes, faceplates, details and part
tables when ticked, one line for a device with no parts, the reader's view
on inventory items and modules, one Hardware block per device in a report
of several, and the spec sheets' HTML unchanged by the sharing (golden
pages in ``api/tests_golden/``)."""

from __future__ import annotations

import datetime as dt
import io
import os
import re
import shutil
import tempfile
from pathlib import Path
from unittest import mock

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import override_settings

from . import object_report as rep
from .models import InventoryItem, Manufacturer, Module, ModuleBay, ModuleType
from .spec_sheets import render_spec_html
from .tests_object_report import _Report

GOLDEN = Path(__file__).resolve().parent / "tests_golden"
FIXED = dt.datetime(2026, 11, 2, 9, 30, tzinfo=dt.UTC)
MEDIA = tempfile.mkdtemp(prefix="danbyte-hw-report-")

_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
_DATA = re.compile(r"data:([a-z/+.-]+);base64,[A-Za-z0-9+/=]+")
_UPLOAD = re.compile(r"(front|rear)[A-Za-z0-9_]*\.png")


def _png() -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (40, 4), (80, 80, 80)).save(buf, "PNG")
    return buf.getvalue()


def normalise(html: str) -> str:
    """Ids, inline images and upload names out; whitespace between tags is
    not a change."""
    html = _DATA.sub(lambda m: f"data:{m.group(1)};base64,DATA", html)
    html = _UUID.sub("UUID", html)
    html = _UPLOAD.sub(lambda m: f"{m.group(1)}.png", html)
    html = re.sub(r">\s+<", "><", html)
    html = re.sub(r"\s+", " ", html)
    return html.replace("><", ">\n<")


def tearDownModule():
    shutil.rmtree(MEDIA, ignore_errors=True)


@override_settings(MEDIA_ROOT=MEDIA)
class _Hardware(_Report):
    """sw-a gets a faceplate, two CPUs, two DIMMs, a disk, a PSU and a
    module; sw-b has no parts."""

    def setUp(self):
        super().setUp()
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="Dell", slug="dell")
        self.dtype.manufacturer = mfr
        self.dtype.model = "R640"
        self.dtype.part_number = "PE-R640"
        self.dtype.front_image = SimpleUploadedFile("front.png", _png(), "image/png")
        self.dtype.rear_image = SimpleUploadedFile("rear.png", _png(), "image/png")
        self.dtype.save()
        mk = InventoryItem.objects.create
        for n, slot in (("CPU1", "Socket 1"), ("CPU2", "Socket 2")):
            mk(
                device=self.dev_a,
                name=n,
                kind="cpu",
                slot=slot,
                speed="3.0 GHz",
                cores=18,
                description="Intel Xeon Gold 6154",
                serial_number=f"CPU-SN-{n}",
            )
        for n, slot in (("RAM1", "DIMM A1"), ("RAM2", "DIMM B1")):
            mk(
                device=self.dev_a,
                name=n,
                kind="ram",
                slot=slot,
                speed="DDR4-2666",
                capacity_bytes=32 * 1024**3,
                serial_number=f"RAM-SN-{n}",
            )
        mk(
            device=self.dev_a,
            name="Disk 0",
            kind="disk",
            slot="Bay 0",
            media="ssd",
            capacity_bytes=960_000_000_000,
            speed="SATA 6Gb/s",
            serial_number="DISK-SN-0",
        )
        mk(
            device=self.dev_a,
            name="PSU1",
            kind="psu",
            slot="PSU 1",
            description="750W Platinum",
            serial_number="PSU-SN-1",
        )
        bay = ModuleBay.objects.create(device=self.dev_a, name="Slot 1")
        mt = ModuleType.objects.create(tenant=self.tenant, name="X710 NIC")
        Module.objects.create(
            device=self.dev_a, module_bay=bay, module_type=mt, serial_number="MOD-SN-1"
        )


class SpecSheetGoldenTests(_Hardware):
    """The spec sheets read the shared partials; their HTML is what it was."""

    def check(self, name, html):
        path = GOLDEN / f"{name}.html"
        if os.environ.get("DANBYTE_UPDATE_GOLDEN") == "1":
            path.write_text(html)
        self.assertEqual(html, path.read_text(), f"{name} differs from its golden page")

    def sheet(self, kind):
        req, _ = rep.job_request(self.admin.pk, self.tenant.pk, None, "testserver", False)
        with mock.patch("django.utils.timezone.now", return_value=FIXED):
            return normalise(render_spec_html(kind, self.dev_a, req))

    def test_hardware_sheet(self):
        self.check("spec-device-hardware", self.sheet("device_hardware"))

    def test_full_sheet(self):
        self.check("spec-device-full", self.sheet("device_full"))

    def test_datasheet(self):
        self.check("spec-device", self.sheet("device"))


class HardwareSectionTests(_Hardware):
    def test_off_by_default_and_listed(self):
        body = self.client.get("/api/devices/report/").json()
        keys = [s["key"] for s in body["sections"]]
        hw = next(s for s in body["sections"] if s["key"] == "hardware")
        self.assertFalse(hw["default"])
        self.assertTrue(hw["available"])
        self.assertEqual(hw["columns"], [])
        # After Overview and Photo, before Interfaces.
        self.assertEqual(keys.index("hardware"), keys.index("photo") + 1)
        self.assertLess(keys.index("hardware"), keys.index("interfaces"))
        html = self.ok("devices", {"ids": [str(self.dev_a.pk)]})
        self.assertNotIn("hwsec", html)
        self.assertNotIn("CPU-SN-CPU1", html)

    def test_ticked_prints_the_sheets_parts(self):
        html = self.ok("devices", {"ids": [str(self.dev_a.pk)], "sections": ["hardware"]})
        self.assertIn("<h3>Hardware</h3>", html)
        self.assertIn('class="hwsec"', html)
        # The spec boxes.
        self.assertIn("36 cores", html)
        self.assertIn("2 × 32 GB · DDR4-2666", html)
        self.assertIn("960 GB", html)
        # The faceplates, fetched by the report's own fetcher.
        self.assertIn("media/device-type-images/", html)
        self.assertIn("Front · R640", html)
        self.assertIn("Rear · R640", html)
        # The details the sheet keeps.
        self.assertIn("<h4>Details</h4>", html)
        self.assertIn("PE-R640", html)
        # Every table with rows, and its serials.
        for heading in ("Processors", "Memory", "Storage", "Other parts", "Modules"):
            self.assertIn(f"<h4>{heading}</h4>", html)
        for serial in ("CPU-SN-CPU1", "RAM-SN-RAM2", "DISK-SN-0", "PSU-SN-1", "MOD-SN-1"):
            self.assertIn(serial, html)
        self.assertIn("750W Platinum", html)
        self.assertIn('class="hw"', html)
        self.assertIn("table.hw", html)  # its CSS rides along

    def test_not_repeated_after_overview_and_photo(self):
        html = self.ok(
            "devices",
            {"ids": [str(self.dev_a.pk)], "sections": ["overview", "photo", "hardware"]},
        )
        self.assertNotIn("<h4>Details</h4>", html)
        self.assertNotIn("Front · R640", html)
        self.assertIn("36 cores", html)

    def test_a_table_with_no_rows_is_left_out(self):
        InventoryItem.objects.filter(device=self.dev_a, kind__in=("disk", "psu")).delete()
        html = self.ok("devices", {"ids": [str(self.dev_a.pk)], "sections": ["hardware"]})
        self.assertNotIn("<h4>Storage</h4>", html)
        self.assertNotIn("<h4>Other parts</h4>", html)
        self.assertNotIn("No storage recorded", html)
        self.assertIn("<h4>Processors</h4>", html)

    def test_a_device_with_no_parts_gets_one_line(self):
        html = self.ok("devices", {"ids": [str(self.dev_b.pk)], "sections": ["hardware"]})
        self.assertIn("<h3>Hardware</h3><p class='muted'>No hardware recorded.</p>", html)
        self.assertNotIn('class="hwsec"', html)
        self.assertNotIn("CPU</div>", html)

    def test_a_missing_faceplate_is_left_out(self):
        os.remove(self.dtype.rear_image.path)
        html = self.ok("devices", {"ids": [str(self.dev_a.pk)], "sections": ["hardware"]})
        self.assertIn("Front · R640", html)
        self.assertNotIn("Rear · R640", html)

    def test_each_device_of_several_gets_its_block(self):
        InventoryItem.objects.create(
            device=self.dev_b, name="CPU1", kind="cpu", cores=8, serial_number="B-CPU"
        )
        html = self.ok(
            "devices",
            {
                "ids": [str(self.dev_a.pk), str(self.dev_b.pk)],
                "sections": ["hardware"],
                "options": {"per_object": True},
            },
        )
        self.assertEqual(html.count("<h3>Hardware</h3>"), 2)
        self.assertIn("CPU-SN-CPU1", html)
        self.assertIn("B-CPU", html)

    def test_renders_a_pdf(self):
        r = self.client.post(
            "/api/devices/report/",
            {"ids": [str(self.dev_a.pk)], "sections": ["overview", "hardware"]},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content[:300])
        self.assertTrue(r.content.startswith(b"%PDF"))


class HardwareRbacTests(_Hardware):
    def test_without_inventory_view_no_parts_or_serials(self):
        self.login(self.member("d", (["device"], ["view"])))
        body = self.client.get("/api/devices/report/").json()
        hw = next(s for s in body["sections"] if s["key"] == "hardware")
        self.assertFalse(hw["available"])
        self.assertEqual(hw["note"], "You may not view inventory items.")
        html = self.ok("devices", {"ids": [str(self.dev_a.pk)], "sections": ["hardware"]})
        self.assertIn("Hardware left out: you may not view inventory items.", html)
        for serial in ("CPU-SN-CPU1", "RAM-SN-RAM1", "DISK-SN-0", "PSU-SN-1", "MOD-SN-1"):
            self.assertNotIn(serial, html)

    def test_without_module_view_no_modules(self):
        self.login(self.member("i", (["device", "inventoryitem"], ["view"])))
        html = self.ok("devices", {"ids": [str(self.dev_a.pk)], "sections": ["hardware"]})
        self.assertIn("CPU-SN-CPU1", html)
        self.assertNotIn("<h4>Modules</h4>", html)
        self.assertNotIn("MOD-SN-1", html)

    def test_site_scoped_parts(self):
        """Parts read as their list: a reader scoped to LON sees sw-b's,
        never sw-a's, whatever the report is asked for."""
        InventoryItem.objects.create(
            device=self.dev_b, name="CPU1", kind="cpu", cores=8, serial_number="B-CPU"
        )
        self.login(
            self.member("s", (["device", "inventoryitem", "module"], ["view"]), sites=[self.lon])
        )
        html = self.ok(
            "devices",
            {
                "ids": [str(self.dev_a.pk), str(self.dev_b.pk)],
                "sections": ["hardware"],
                "options": {"per_object": True},
            },
        )
        self.assertIn("B-CPU", html)
        self.assertNotIn("CPU-SN-CPU1", html)

    def test_the_spec_sheet_follows_the_same_rule(self):
        """The hardware sheet used to list every part to anyone with view on
        the device."""
        from . import spec_sheets

        self.login(self.member("d", (["device"], ["view"])))
        seen = {}
        real = spec_sheets.render_spec_html

        def keep(kind, obj, request=None):
            seen["html"] = real(kind, obj, request)
            return seen["html"]

        with mock.patch.object(spec_sheets, "render_spec_html", side_effect=keep):
            r = self.client.get(f"/api/devices/{self.dev_a.pk}/spec-sheet/?variant=hardware")
        self.assertEqual(r.status_code, 200, r.content[:300])
        self.assertIn("You may not view inventory items.", seen["html"])
        for serial in ("CPU-SN-CPU1", "RAM-SN-RAM1", "MOD-SN-1"):
            self.assertNotIn(serial, seen["html"])

    def test_a_refused_image_leaves_the_render_whole(self):
        """WeasyPrint 69+ asks the fetcher whether a refusal is fatal; a
        missing photo or an outside URL used to crash the whole report."""
        from .drawing_pdf import MEDIA_IMAGES_URL

        html = rep.report_html(
            title="t",
            tenant="T",
            generated=FIXED,
            paper="a4",
            orientation="portrait",
            body=f"<img src='{MEDIA_IMAGES_URL}gone.png'><img src='https://example.com/x.png'>",
        )
        self.assertTrue(rep.render_report_pdf(b"", html=html).startswith(b"%PDF"))


class SpecSheetInterfaceRbacTests(_Report):
    """The datasheets read interfaces through the interface list as the
    reader, as the device report's Interfaces section does: its permission,
    row constraints and site rules. They used to list every interface to
    anyone with view on the device."""

    def sheet(self, url):
        from . import spec_sheets

        seen = {}
        real = spec_sheets.render_spec_html

        def keep(kind, obj, request=None):
            seen["html"] = real(kind, obj, request)
            return seen["html"]

        with mock.patch.object(spec_sheets, "render_spec_html", side_effect=keep):
            r = self.client.get(url)
        self.assertEqual(r.status_code, 200, r.content[:300])
        return seen["html"]

    def device_sheet(self, variant=""):
        query = f"?variant={variant}" if variant else ""
        return self.sheet(f"/api/devices/{self.dev_a.pk}/spec-sheet/{query}")

    def grant(self, user, types, *, constraints=None, sites=()):
        from auth_api.models import ObjectPermission

        p = ObjectPermission.objects.create(
            name=f"{user.username}-{'-'.join(types)}",
            object_types=list(types),
            actions=["view"],
            constraints=constraints,
        )
        p.users.add(user)
        p.tenants.add(self.tenant)
        if sites:
            p.sites.set(sites)

    def test_without_interface_view_the_table_is_left_out(self):
        self.login(self.member("d", (["device"], ["view"])))
        for variant in ("", "full"):
            with self.subTest(variant=variant):
                html = self.device_sheet(variant)
                self.assertIn("You may not view interfaces.", html)
                self.assertNotIn("eth-uplink", html)
                self.assertNotIn("eth-spare", html)
                # The stat box does not count what the reader may not see.
                self.assertRegex(html, r'Interfaces</div>\s*<div class="value">—<')

    def test_with_interface_view_every_interface(self):
        self.login(self.member("i", (["device", "interface"], ["view"])))
        html = self.device_sheet()
        self.assertIn("eth-uplink", html)
        self.assertIn("eth-spare", html)
        self.assertNotIn("You may not view interfaces.", html)

    def test_row_constraints_apply(self):
        user = self.member("c", (["device"], ["view"]))
        self.grant(user, ["interface"], constraints={"name": "eth-uplink"})
        self.login(user)
        html = self.device_sheet()
        self.assertIn("eth-uplink", html)
        self.assertNotIn("eth-spare", html)

    def test_site_scoped_interfaces(self):
        """Interface view scoped to LON: sw-a (AMS) lists none of its own."""
        user = self.member("s", (["device"], ["view"]))
        self.grant(user, ["interface"], sites=[self.lon])
        self.login(user)
        html = self.device_sheet()
        self.assertNotIn("eth-uplink", html)
        self.assertIn("No interfaces.", html)

    def test_the_stack_sheet_follows_the_same_rule(self):
        from .models import Device, VirtualChassis

        vc = VirtualChassis.objects.create(tenant=self.tenant, name="stack-1", master=self.dev_a)
        Device.objects.filter(pk=self.dev_a.pk).update(virtual_chassis=vc, vc_position=1)
        self.login(self.member("v", (["virtualchassis", "device"], ["view"])))
        html = self.sheet(f"/api/virtual-chassis/{vc.pk}/spec-sheet/")
        self.assertIn("You may not view interfaces.", html)
        self.assertNotIn("eth-uplink", html)
