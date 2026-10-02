"""Photo calibration (#277): two guides on a device type's photo with the real
distance between them give the photo's true width; the rail line says where
the DIN rail runs. Checked on write, inherited by devices, dropped when the
photo is replaced, and read by the cabinet drawing and the Diagram."""

from __future__ import annotations

from django.core.files.uploadedfile import SimpleUploadedFile

from .face_ports import calibration, effective_calibration
from .models import Device, DeviceType
from .tests_cabinets import CabinetTestCase

CAL = {"left": 0.1, "right": 0.9, "span_mm": 48.0, "rail": 0.55}


def png() -> bytes:
    import io

    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (120, 300), "white").save(buf, "PNG")
    return buf.getvalue()


class PhotoCalibrationTests(CabinetTestCase):
    def setUp(self):
        super().setUp()
        self.dt = DeviceType.objects.create(tenant=self.tenant, name="XC206", width_mm=60,
                                            height_mm=147, din_profiles=["ts35"])
        self.url = f"/api/device-types/{self.dt.id}/"

    def put(self, doc, url=None):
        return self.client.patch(url or self.url, {"image_ports": doc}, format="json")

    def test_a_calibration_is_saved_and_gives_the_true_width(self):
        r = self.put({"front": [], "view": {"front": {"scale": 1, "cal": CAL}}})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(calibration(self.dt.__class__.objects.get(pk=self.dt.pk).image_ports),
                         {**CAL, "photo_mm": 60.0})

    def test_bad_calibrations_are_refused(self):
        for cal in ({"left": 0.5, "right": 0.5, "span_mm": 10},
                    {"left": -0.1, "right": 0.9, "span_mm": 10},
                    {"left": 0.1, "right": 0.9},
                    {"left": 0.1, "right": 0.9, "span_mm": 0},
                    {"left": 0.1, "right": 0.9, "span_mm": 10, "rail": 1.5},
                    {"left": True, "right": 0.9, "span_mm": 10},
                    "wide"):
            with self.subTest(cal=cal):
                r = self.put({"front": [], "view": {"front": {"cal": cal}}})
                self.assertEqual(r.status_code, 400, r.content)
                self.assertIn("image_ports", r.json())

    def test_a_devices_override_is_checked_and_its_calibration_wins(self):
        self.put({"front": [], "view": {"front": {"cal": CAL}}})
        self.dt.refresh_from_db()
        d = Device.objects.create(tenant=self.tenant, name="sw-1", site=self.site,
                                  device_type=self.dt)
        self.assertEqual(effective_calibration(d)["photo_mm"], 60.0)
        url = f"/api/devices/{d.id}/"
        r = self.put({"front": [{"name": "P1", "x": 2, "y": 0, "w": 0, "h": 0}]}, url)
        self.assertEqual(r.status_code, 400)
        mine = {**CAL, "span_mm": 24.0}
        r = self.put({"front": [], "view": {"front": {"cal": mine}}}, url)
        self.assertEqual(r.status_code, 200, r.content)
        d.refresh_from_db()
        self.assertEqual(effective_calibration(d)["photo_mm"], 30.0)
        # An override without a calibration inherits the type's.
        self.put({"front": []}, url)
        d.refresh_from_db()
        self.assertEqual(effective_calibration(d)["photo_mm"], 60.0)

    def test_a_replaced_photo_drops_its_calibration_and_a_resize_keeps_it(self):
        self.put({"front": [], "view": {"front": {"scale": 1, "cal": CAL},
                                        "rear": {"cal": CAL}}})
        img = SimpleUploadedFile("f.png", png(), content_type="image/png")
        r = self.client.post(f"{self.url}images/", {"front_image": img})
        self.assertEqual(r.status_code, 200, r.content)
        self.dt.refresh_from_db()
        self.assertEqual(self.dt.image_ports["view"]["front"], {"scale": 1})
        self.assertEqual(self.dt.image_ports["view"]["rear"], {"cal": CAL})
        r = self.client.post(f"{self.url}images/", {"clear_rear": "1"})
        self.dt.refresh_from_db()
        self.assertEqual(self.dt.image_ports["view"]["rear"], {})

    def test_the_compact_type_carries_the_front_calibration(self):
        self.put({"front": [], "view": {"front": {"cal": CAL}}})
        d = Device.objects.create(tenant=self.tenant, name="sw-1", site=self.site,
                                  device_type=self.dt)
        row = self.client.get(f"/api/devices/{d.id}/").json()
        self.assertEqual(row["device_type"]["front_cal"], {**CAL, "photo_mm": 60.0})

    def test_a_bundle_with_a_bad_calibration_is_refused(self):
        from .device_library import BundleError, export_bundle, import_bundle

        bundle = export_bundle(self.dt)
        bundle.update(name="Copy", image_ports={"front": [], "view": {"front": {"cal": "x"}}})
        with self.assertRaises(BundleError):
            import_bundle(bundle, self.tenant)
