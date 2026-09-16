"""MAC vendor lookup (#141): prefix resolution, the registry import, custom
ranges, and the vendor surfaced on the MAC pages."""
from __future__ import annotations

from io import BytesIO
from unittest import mock

from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import Device, DeviceType, Interface, MACAddress, Manufacturer, OuiPrefix
from .oui import (
    LOCAL_LABEL,
    OuiError,
    is_locally_administered,
    parse_prefix,
    parse_registry_csv,
    sync_registry,
    vendor_for,
    vendors_for,
)

User = get_user_model()

MACLOOKUP_CSV = """Mac Prefix,Vendor Name,Private,Block Type,Last Update
00:1B:44,SanDisk Corporation,false,MA-L,2015/11/17
70:B3:D5:00:1,Example Small Block,false,MA-S,2020/01/01
28:6F:B9:0,Nokia Shanghai Bell Co. Ltd.,false,MA-M,2023/05/04
"""

IEEE_CSV = """Registry,Assignment,Organization Name,Organization Address
MA-L,001B44,SanDisk Corporation,951 SanDisk Drive Milpitas CA US
MA-L,00000C,Cisco Systems Inc,170 West Tasman Dr. San Jose CA US
"""


class ParseTests(APITestCase):
    def test_prefix_forms(self):
        self.assertEqual(parse_prefix("02:00:AA"), "0200aa")
        self.assertEqual(parse_prefix("02-00-aa-0"), "0200aa0")
        self.assertEqual(parse_prefix("0200aa"), "0200aa")
        with self.assertRaises(OuiError):
            parse_prefix("0")
        with self.assertRaises(OuiError):
            parse_prefix("00:11:22:33:44:55")

    def test_locally_administered_bit(self):
        self.assertTrue(is_locally_administered("02:11:22:33:44:55"))
        self.assertTrue(is_locally_administered("06:11:22:33:44:55"))
        self.assertFalse(is_locally_administered("00:1b:44:11:3a:b7"))

    def test_registry_csv_both_dialects(self):
        got = parse_registry_csv(MACLOOKUP_CSV)
        self.assertEqual(got["001b44"], "SanDisk Corporation")
        self.assertEqual(got["70b3d5001"], "Example Small Block")
        self.assertEqual(got["286fb90"], "Nokia Shanghai Bell Co. Ltd.")
        got = parse_registry_csv(IEEE_CSV)
        self.assertEqual(got["00000c"], "Cisco Systems Inc")
        with self.assertRaises(OuiError):
            parse_registry_csv("just,noise\n")


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.other = Tenant.objects.create(org=org, name="U", slug="u")
        self.admin = User.objects.create_superuser("admin", "a@e.com", "x")
        self.client.force_login(self.admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()
        OuiPrefix.objects.create(prefix="001b44", vendor="SanDisk", source="ieee")
        OuiPrefix.objects.create(prefix="70b3d5001", vendor="Small Block", source="ieee")
        OuiPrefix.objects.create(prefix="70b3d5", vendor="IEEE Registration Authority", source="ieee")
        self.custom = OuiPrefix.objects.create(
            tenant=self.tenant, prefix="0200aa", vendor="Lab VMs", source="custom"
        )
        OuiPrefix.objects.create(
            tenant=self.other, prefix="0200bb", vendor="Their VMs", source="custom"
        )


class ResolveTests(_Base):
    def test_longest_prefix_wins(self):
        self.assertEqual(vendor_for("70:b3:d5:00:1f:ff", self.tenant)["name"], "Small Block")
        self.assertEqual(
            vendor_for("70:b3:d5:ff:00:00", self.tenant)["name"], "IEEE Registration Authority"
        )

    def test_custom_range_and_local_bit(self):
        got = vendors_for(
            ["02:00:aa:00:00:01", "02:00:bb:00:00:01", "02:11:22:33:44:55", "a8:bb:cc:00:00:00"],
            self.tenant,
        )
        self.assertEqual(got["0200aa000001"], {"name": "Lab VMs", "source": "custom"})
        # the other tenant's range does not apply here; the bit still explains it
        self.assertEqual(got["0200bb000001"]["name"], LOCAL_LABEL)
        self.assertEqual(got["021122334455"]["source"], "local")
        self.assertIsNone(got["a8bbcc000000"])

    def test_custom_beats_registry_at_equal_length(self):
        OuiPrefix.objects.create(
            tenant=self.tenant, prefix="001b44", vendor="Our SanDisk", source="custom"
        )
        self.assertEqual(vendor_for("00:1b:44:00:00:01", self.tenant)["source"], "custom")

    def test_mac_pages_carry_the_vendor(self):
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="M", slug="m")
        dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="X")
        dev = Device.objects.create(tenant=self.tenant, name="sw1", device_type=dt)
        Interface.objects.create(device=dev, name="eth0", mac_address="00:1b:44:11:3a:b7")
        MACAddress.objects.create(
            tenant=self.tenant, mac_address="02:11:22:33:44:55", vendor_override="Hand-built"
        )
        rows = {r["mac"]: r for r in self.client.get("/api/macs/").json()["results"]}
        self.assertEqual(rows["00:1b:44:11:3a:b7"]["vendor"]["name"], "SanDisk")
        self.assertEqual(rows["02:11:22:33:44:55"]["vendor"], {"name": "Hand-built", "source": "override"})
        d = self.client.get("/api/macs/00:1b:44:11:3a:b7/").json()
        self.assertEqual(d["vendor"]["source"], "ieee")
        o = self.client.get("/api/macs/02:11:22:33:44:55/").json()
        self.assertEqual(o["vendor"]["source"], "override")
        self.assertEqual(o["objects"][0]["vendor_override"], "Hand-built")


class RegistrySyncTests(_Base):
    def test_sync_creates_updates_removes_and_is_idempotent(self):
        result = sync_registry({"001b44": "SanDisk Corporation", "00000c": "Cisco"})
        self.assertEqual((result["created"], result["updated"], result["removed"]), (1, 1, 2))
        ieee = dict(OuiPrefix.objects.filter(tenant__isnull=True).values_list("prefix", "vendor"))
        self.assertEqual(ieee, {"001b44": "SanDisk Corporation", "00000c": "Cisco"})
        # custom rows are untouched by a registry sync
        self.assertTrue(OuiPrefix.objects.filter(pk=self.custom.pk).exists())
        again = sync_registry({"001b44": "SanDisk Corporation", "00000c": "Cisco"})
        self.assertEqual((again["created"], again["updated"], again["removed"]), (0, 0, 0))

    def test_upload_import_runs_and_reports(self):
        from .oui_tasks import run_oui_import

        with mock.patch("api.oui_tasks.enqueue_oui_import", side_effect=lambda run: run_oui_import(str(run.id))):
            r = self.client.post(
                "/api/oui/import/",
                {"file": SimpleUploadedFile("oui.csv", MACLOOKUP_CSV.encode())},
                format="multipart",
            )
        self.assertEqual(r.status_code, 201, r.content)
        run = self.client.get(f"/api/oui/import/{r.json()['id']}/").json()
        self.assertEqual(run["status"], "success", run)
        self.assertEqual(run["progress"]["total"], 3)
        status = self.client.get("/api/oui/status/").json()
        self.assertEqual(status["prefixes"], 3)
        self.assertEqual(status["last_import"]["status"], "success")

    def test_import_needs_deployment_admin_and_https(self):
        r = self.client.post("/api/oui/import/", {"url": "http://example.com/x.csv"}, format="json")
        self.assertEqual(r.status_code, 400)
        member = User.objects.create_user("m", password="x")
        self.client.force_login(member)
        r = self.client.post("/api/oui/import/", {"url": "https://example.com/x.csv"}, format="json")
        self.assertEqual(r.status_code, 403)


class RangeApiTests(_Base):
    def test_ranges_are_tenant_scoped_and_validated(self):
        r = self.client.get("/api/oui-ranges/")
        names = [x["vendor"] for x in r.json()["results"]]
        self.assertEqual(names, ["Lab VMs"])
        self.assertEqual(r.json()["results"][0]["prefix"], "02:00:aa")
        r = self.client.post(
            "/api/oui-ranges/", {"prefix": "06:00:CC:0", "vendor": "Cluster B"}, format="json"
        )
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["bits"], 28)
        dup = self.client.post("/api/oui-ranges/", {"prefix": "0200aa", "vendor": "x"}, format="json")
        self.assertEqual(dup.status_code, 400)
        bad = self.client.post("/api/oui-ranges/", {"prefix": "zz", "vendor": "x"}, format="json")
        self.assertEqual(bad.status_code, 400)
        self.assertFalse(OuiPrefix.objects.filter(tenant=self.tenant, source="ieee").exists())

    def test_next_free_skips_used_addresses(self):
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="M", slug="m")
        dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="X")
        dev = Device.objects.create(tenant=self.tenant, name="sw1", device_type=dt)
        Interface.objects.create(device=dev, name="eth0", mac_address="02:00:aa:00:00:00")
        MACAddress.objects.create(tenant=self.tenant, mac_address="02:00:aa:00:00:01")
        r = self.client.get(f"/api/oui-ranges/{self.custom.id}/next/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["mac"], "02:00:aa:00:00:02")
