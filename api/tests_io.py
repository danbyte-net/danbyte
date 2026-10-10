"""Round-trip export/import: registry, export scoping, upsert, RBAC, dry-run."""
from __future__ import annotations

import json

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.io import _infer_natural_key, io_for
from api.models import (
    Device, DeviceType, IPAddress, Manufacturer, Prefix, Site,
)
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant


from api.test_utils import status_for


def _csv(resp) -> str:
    return b"".join(resp.streaming_content).decode("utf-8")


class IORegistryTests(APITestCase):
    def test_builtin_overrides_and_inference(self):
        self.assertEqual(io_for("prefix").natural_key, ["cidr", "vrf"])
        self.assertEqual(io_for("ipaddress").natural_key, ["ip_address", "vrf"])
        self.assertEqual(io_for("vlan").natural_key, ["vlan_id", "site", "group"])
        self.assertEqual(io_for("device").natural_key, ["name", "site"])
        # Auto handler for an un-overridden model picks a sensible key.
        self.assertEqual(io_for("manufacturer").natural_key, ["slug"])
        # Non-tenant / unknown → no handler.
        self.assertIsNone(io_for("group"))
        self.assertIsNone(io_for("does-not-exist"))

    def test_infer_prefers_unique_then_slug_then_name(self):
        from api.models import Location, Rack

        self.assertEqual(_infer_natural_key(Manufacturer), ["slug"])
        self.assertEqual(_infer_natural_key(Device), ["name"])  # (tenant,name)
        # A name unique only per site is matched with its site (#352).
        self.assertEqual(_infer_natural_key(Rack), ["site", "name"])
        self.assertEqual(_infer_natural_key(Location), ["site", "slug"])


class _IOCase(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.ams = Site.objects.create(tenant=self.tenant, name="AMS")
        self.p1 = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/24", status=status_for(self.tenant),
            description="orig", site=self.ams,
        )
        self.admin = User.objects.create_user("a", password="x", is_superuser=True)
        UserProfile.objects.create(user=self.admin).tenants.add(self.tenant)
        self.client.force_login(self.admin)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")

    def _export(self, fmt="csv"):
        return self.client.get(f"/api/io/prefix/export/?fmt={fmt}")

    def _import(self, content, dry_run=False, fmt="csv"):
        return self.client.post(
            "/api/io/prefix/import/",
            {"format": fmt, "content": content, "dry_run": dry_run},
            format="json",
        )


class IORoundTripTests(_IOCase):
    def test_export_header_and_rows(self):
        resp = self._export()
        self.assertEqual(resp.status_code, 200)
        text = _csv(resp)
        header = text.splitlines()[0]
        self.assertIn("id", header)
        self.assertIn("cidr", header)
        self.assertIn("10.0.0.0/24", text)

    def test_export_reimport_is_zero_change(self):
        text = _csv(self._export())
        res = self._import(text)
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertEqual(body["created"], 0)
        self.assertEqual(body["updated"], 1)
        self.assertEqual(body["errors"], [])

    def test_update_by_id(self):
        text = _csv(self._export()).replace("orig", "edited")
        res = self._import(text)
        self.assertEqual(res.json()["updated"], 1)
        self.p1.refresh_from_db()
        self.assertEqual(self.p1.description, "edited")

    def test_create_new_by_natural_key(self):
        # A row with blank id + a new cidr → create.
        content = "id,cidr,status,description\n,10.9.9.0/24,active,fresh\n"
        res = self._import(content)
        self.assertEqual(res.json()["created"], 1)
        self.assertTrue(
            Prefix.objects.filter(tenant=self.tenant, cidr="10.9.9.0/24").exists()
        )

    def test_dry_run_previews_without_writing(self):
        content = "id,cidr,status,description\n,10.8.8.0/24,active,x\n"
        res = self._import(content, dry_run=True)
        body = res.json()
        self.assertTrue(body["dry_run"])
        self.assertEqual(body["created"], 1)
        self.assertEqual(body["preview"][0]["action"], "create")
        self.assertFalse(
            Prefix.objects.filter(cidr="10.8.8.0/24").exists()  # nothing persisted
        )

    def test_tags_and_custom_fields_roundtrip(self):
        self.p1.tags.add("prod", "core")
        self.p1.custom_fields = {"owner": "neteng"}
        self.p1.save()
        text = _csv(self._export())
        # Wipe then reimport to prove tags/cf restore.
        self.p1.tags.clear()
        self.p1.custom_fields = {}
        self.p1.save()
        self._import(text)
        self.p1.refresh_from_db()
        self.assertEqual(set(self.p1.tags.names()), {"prod", "core"})
        self.assertEqual(self.p1.custom_fields, {"owner": "neteng"})


class IOImportRBACTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.ams = Site.objects.create(tenant=self.tenant, name="AMS")
        self.lon = Site.objects.create(tenant=self.tenant, name="LON")
        self.p_ams = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/24", status=status_for(self.tenant), site=self.ams
        )
        self.p_lon = Prefix.objects.create(
            tenant=self.tenant, cidr="10.1.0.0/24", status=status_for(self.tenant), site=self.lon
        )

    def _user(self, actions, sites=None):
        u = User.objects.create_user(f"u{actions}", password="x")
        UserProfile.objects.create(user=u).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="p", object_types=["prefix"], actions=list(actions)
        )
        perm.users.add(u)
        if sites:
            perm.sites.set(sites)
        return u

    def _login(self, u):
        self.client.force_login(u)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")

    def _import(self, content, dry_run=False):
        return self.client.post(
            "/api/io/prefix/import/",
            {"format": "csv", "content": content, "dry_run": dry_run},
            format="json",
        )

    def test_add_only_cannot_update(self):
        self._login(self._user(["view", "add"]))
        content = f"id,cidr,status,description\n{self.p_ams.id},10.0.0.0/24,active,x\n"
        res = self._import(content)
        self.assertEqual(res.json()["updated"], 0)
        self.assertTrue(res.json()["errors"])

    def test_change_only_cannot_create(self):
        self._login(self._user(["view", "change"]))
        content = "id,cidr,status,description\n,10.5.5.0/24,active,x\n"
        res = self._import(content)
        self.assertEqual(res.json()["created"], 0)
        self.assertTrue(res.json()["errors"])

    def test_site_scoped_cannot_update_other_site(self):
        # Editor of AMS only; try to update the LON prefix by id.
        self._login(self._user(["view", "add", "change"], sites=[self.ams]))
        content = (
            f"id,cidr,status,description\n{self.p_lon.id},10.1.0.0/24,active,hack\n"
        )
        res = self._import(content)
        self.assertEqual(res.json()["updated"], 0)
        self.assertTrue(res.json()["errors"])
        self.p_lon.refresh_from_db()
        self.assertNotEqual(self.p_lon.description, "hack")


class IOEndpointTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.ams = Site.objects.create(tenant=self.tenant, name="AMS")
        self.p1 = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/24", status=status_for(self.tenant),
            description="orig", site=self.ams,
        )
        self.admin = User.objects.create_user("a", password="x", is_superuser=True)
        UserProfile.objects.create(user=self.admin).tenants.add(self.tenant)
        self.client.force_login(self.admin)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")

    def test_types_lists_prefix_with_capabilities(self):
        res = self.client.get("/api/io/types/")
        self.assertEqual(res.status_code, 200)
        by_slug = {t["slug"]: t for t in res.json()["object_types"]}
        self.assertIn("prefix", by_slug)
        self.assertTrue(by_slug["prefix"]["can_export"])
        self.assertTrue(by_slug["prefix"]["can_import"])
        self.assertEqual(by_slug["prefix"]["natural_key"], ["cidr", "vrf"])
        self.assertNotIn("group", by_slug)  # non-tenant model excluded

    def test_fields_returns_columns_and_key(self):
        res = self.client.get("/api/io/prefix/fields/")
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertIn("id", body["columns"])
        self.assertIn("cidr", body["columns"])
        self.assertEqual(body["natural_key"], ["cidr", "vrf"])

    def test_xlsx_export_then_reimport_via_multipart(self):
        import io as _io

        from openpyxl import load_workbook

        resp = self.client.get("/api/io/prefix/export/?fmt=xlsx")
        self.assertEqual(resp.status_code, 200)
        content = b"".join(resp.streaming_content) if hasattr(
            resp, "streaming_content"
        ) else resp.content
        wb = load_workbook(_io.BytesIO(content))
        header = [c.value for c in wb.active[1]]
        self.assertEqual(header[0], "id")
        self.assertIn("cidr", header)
        # Re-upload the same xlsx as a multipart file → updates, no creates.
        upload = _io.BytesIO(content)
        upload.name = "prefix.xlsx"
        res = self.client.post(
            "/api/io/prefix/import/", {"file": upload, "dry_run": "false"}
        )
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["created"], 0)
        self.assertEqual(res.json()["updated"], 1)

    def _sheet(self, n_rows, blank_every=0):
        import io as _io

        from openpyxl import Workbook

        wb = Workbook(write_only=True)
        ws = wb.create_sheet()
        ws.append(["name", "slug"])
        for i in range(n_rows):
            if blank_every and i % blank_every == 0:
                ws.append([None, None])
            else:
                ws.append([f"site-{i}", f"site-{i}"])
        buf = _io.BytesIO()
        wb.save(buf)
        buf.seek(0)
        buf.name = "sites.xlsx"
        return buf

    def test_an_oversized_sheet_is_refused_without_reading_it_all(self):
        """The cap used to be checked after the whole sheet was in memory, so
        a small compressed file held a worker for most of a minute (#225)."""
        from unittest import mock

        from api import io_views

        seen = {"n": 0}
        real = io_views.TooManyRows

        with mock.patch.object(io_views, "MAX_IMPORT_ROWS", 50), \
                mock.patch.object(io_views, "MAX_IMPORT_SCANNED_ROWS", 200):
            from openpyxl.worksheet._read_only import ReadOnlyWorksheet

            original = ReadOnlyWorksheet._cells_by_row

            def counting(self, *a, **kw):
                for row in original(self, *a, **kw):
                    seen["n"] += 1
                    yield row

            with mock.patch.object(ReadOnlyWorksheet, "_cells_by_row", counting):
                res = self.client.post(
                    "/api/io/site/import/", {"file": self._sheet(5000), "dry_run": "1"}
                )
        self.assertEqual(res.status_code, 400, res.content)
        self.assertIn("Too many rows", res.json()["detail"])
        self.assertGreater(seen["n"], 0, "the row counter did not see the reader")
        self.assertLess(seen["n"], 100, "the reader kept going past the cap")
        self.assertIs(real, io_views.TooManyRows)

    def test_blank_rows_do_not_count_against_the_cap(self):
        from unittest import mock

        from api import io_views

        with mock.patch.object(io_views, "MAX_IMPORT_ROWS", 50), \
                mock.patch.object(io_views, "MAX_IMPORT_SCANNED_ROWS", 200):
            res = self.client.post(
                "/api/io/site/import/",
                {"file": self._sheet(80, blank_every=2), "dry_run": "1"},
            )
        # 40 real rows among 80: under the cap of 50.
        self.assertNotEqual(res.json().get("detail", ""), "Too many rows (max 50).")

    def test_a_file_over_the_size_limit_is_refused_unread(self):
        from unittest import mock

        from api import io_views

        with mock.patch.object(io_views, "MAX_IMPORT_BYTES", 100):
            res = self.client.post(
                "/api/io/site/import/", {"file": self._sheet(50), "dry_run": "1"}
            )
        self.assertEqual(res.status_code, 400)
        self.assertIn("larger than", res.json()["detail"])

    def _bomb(self, *, strings=0, cells=0, string=b"<si><t>a</t></si>"):
        """A workbook that is small on disk and huge once unpacked: a
        shared-strings table of ``strings`` entries and/or one sheet row of
        ``cells`` cells, written in chunks so the test never holds it."""
        import io as _io
        import zipfile

        buf = _io.BytesIO()
        ns = b'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
        rel = b"http://schemas.openxmlformats.org/officeDocument/2006/relationships"
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
            z.writestr("[Content_Types].xml", (
                b'<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/'
                b'package/2006/content-types"><Default Extension="rels" ContentType='
                b'"application/vnd.openxmlformats-package.relationships+xml"/><Default '
                b'Extension="xml" ContentType="application/xml"/><Override PartName='
                b'"/xl/workbook.xml" ContentType="application/vnd.openxmlformats-'
                b'officedocument.spreadsheetml.sheet.main+xml"/><Override PartName='
                b'"/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats'
                b'-officedocument.spreadsheetml.worksheet+xml"/><Override PartName='
                b'"/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-'
                b'officedocument.spreadsheetml.sharedStrings+xml"/></Types>'))
            z.writestr("_rels/.rels", (
                b'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats'
                b'.org/package/2006/relationships"><Relationship Id="rId1" Type="' + rel
                + b'/officeDocument" Target="xl/workbook.xml"/></Relationships>'))
            z.writestr("xl/workbook.xml", (
                b'<?xml version="1.0"?><workbook ' + ns + b' xmlns:r="' + rel
                + b'"><sheets><sheet name="s" sheetId="1" r:id="rId1"/></sheets></workbook>'))
            z.writestr("xl/_rels/workbook.xml.rels", (
                b'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats'
                b'.org/package/2006/relationships"><Relationship Id="rId1" Type="' + rel
                + b'/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" '
                b'Type="' + rel + b'/sharedStrings" Target="sharedStrings.xml"/>'
                b'</Relationships>'))
            with z.open("xl/sharedStrings.xml", "w") as f:
                f.write(b'<?xml version="1.0"?><sst ' + ns + b'><si><t>name</t></si>')
                chunk = string * 10000
                for _ in range(strings // 10000):
                    f.write(chunk)
                f.write(b"</sst>")
            with z.open("xl/worksheets/sheet1.xml", "w") as f:
                f.write(b'<?xml version="1.0"?><worksheet ' + ns + b'><sheetData>'
                        b'<row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2">')
                chunk = b'<c t="s"><v>0</v></c>' * 10000
                for _ in range(cells // 10000):
                    f.write(chunk)
                f.write(b"</row></sheetData></worksheet>")
        buf.seek(0)
        buf.name = "bomb.xlsx"
        return buf

    def test_a_shared_strings_bomb_is_refused_before_it_is_loaded(self):
        """#374 - a 4,000,000-string table is under 1 MB on disk."""
        from unittest import mock

        from openpyxl.reader import strings

        bomb = self._bomb(strings=4_000_000)
        self.assertLess(len(bomb.getvalue()), 1024 * 1024)
        with mock.patch.object(strings, "read_string_table",
                               side_effect=AssertionError("table was loaded")):
            res = self.client.post("/api/io/site/import/", {"file": bomb, "dry_run": "1"})
        self.assertEqual(res.status_code, 400, res.content)
        self.assertIn("too large", res.json()["detail"])

    def test_many_short_shared_strings_are_refused(self):
        # Under the unpacked-size cap, over the string-count cap.
        from unittest import mock

        from api import io_views

        with mock.patch.object(io_views, "MAX_XLSX_SHARED_STRINGS", 50_000):
            res = self.client.post("/api/io/site/import/",
                                   {"file": self._bomb(strings=60_000), "dry_run": "1"})
        self.assertEqual(res.status_code, 400, res.content)
        self.assertIn("too many distinct", res.json()["detail"])

    def test_a_sheet_xml_bomb_is_refused(self):
        bomb = self._bomb(cells=3_000_000)
        self.assertLess(len(bomb.getvalue()), 1024 * 1024)
        res = self.client.post("/api/io/site/import/", {"file": bomb, "dry_run": "1"})
        self.assertEqual(res.status_code, 400, res.content)
        self.assertIn("too large", res.json()["detail"])

    def test_a_wide_row_is_cut_at_the_column_cap(self):
        from unittest import mock

        from api import io_views

        with mock.patch.object(io_views, "MAX_IMPORT_COLUMNS", 100):
            res = self.client.post("/api/io/site/import/",
                                   {"file": self._bomb(cells=20_000), "dry_run": "1"})
        self.assertEqual(res.status_code, 400, res.content)
        self.assertIn("columns", res.json()["detail"])

    def test_not_a_workbook_is_a_plain_400(self):
        import io as _io

        junk = _io.BytesIO(b"not a zip at all")
        junk.name = "x.xlsx"
        res = self.client.post("/api/io/site/import/", {"file": junk, "dry_run": "1"})
        self.assertEqual(res.status_code, 400)

    def test_register_object_type_is_discoverable(self):
        from auth_api.object_types import is_registered, registry_payload

        before = is_registered("widgetzzz")
        # Re-registering an existing path is a no-op; just assert the helper runs
        # and the registry still resolves prefix.
        self.assertFalse(before)
        self.assertTrue(any(e["slug"] == "prefix" for e in registry_payload()))


class IOHumanReadableTests(APITestCase):
    def setUp(self):
        from api.models import IPRange

        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.ams = Site.objects.create(tenant=self.tenant, name="AMS")
        self.p = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.10.0/24", status=status_for(self.tenant), site=self.ams
        )
        self.rng = IPRange.objects.create(
            tenant=self.tenant, prefix=self.p, status=status_for(self.tenant),
            start_address="10.0.10.10", end_address="10.0.10.20",
        )
        self.admin = User.objects.create_user("a", password="x", is_superuser=True)
        UserProfile.objects.create(user=self.admin).tenants.add(self.tenant)
        self.client.force_login(self.admin)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")

    def test_iprange_handler_keys(self):
        self.assertEqual(
            io_for("iprange").natural_key, ["start_address", "end_address"]
        )

    def test_export_renders_prefix_as_cidr_not_uuid(self):
        resp = self.client.get("/api/io/iprange/export/?fmt=csv")
        text = _csv(resp)
        # The prefix FK must be the human CIDR, never the opaque UUID.
        self.assertIn("10.0.10.0/24", text)
        self.assertNotIn(str(self.p.id), text.split("\n", 1)[1])  # not in data row

    def test_iprange_roundtrip(self):
        text = _csv(self.client.get("/api/io/iprange/export/?fmt=csv"))
        res = self.client.post(
            "/api/io/iprange/import/",
            {"format": "csv", "content": text, "dry_run": False},
            format="json",
        )
        body = res.json()
        self.assertEqual(body["created"], 0)
        self.assertEqual(body["updated"], 1)
        self.assertEqual(body["errors"], [])

    def test_prefix_export_vlan_site_human(self):
        from api.models import VLAN

        v = VLAN.objects.create(tenant=self.tenant, vlan_id=42, name="net")
        self.p.vlan = v
        self.p.save()
        text = _csv(self.client.get("/api/io/prefix/export/?fmt=csv"))
        self.assertIn("AMS", text)  # site name, not uuid
        self.assertIn("42", text)  # vlan number, not uuid

    def test_global_vrf_import(self):
        # A "Global" value in the vrf column imports as no VRF.
        content = (
            "id,cidr,status,vrf,description\n"
            f"{self.p.id},10.0.10.0/24,active,Global,x\n"
        )
        res = self.client.post(
            "/api/io/prefix/import/",
            {"format": "csv", "content": content, "dry_run": False},
            format="json",
        )
        self.assertEqual(res.json()["updated"], 1)
        self.p.refresh_from_db()
        self.assertIsNone(self.p.vrf)


class IOExportFilterTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.pa = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/24", status=status_for(self.tenant))
        self.pb = Prefix.objects.create(tenant=self.tenant, cidr="10.1.0.0/24", status=status_for(self.tenant))
        self.ip_a = IPAddress.objects.create(tenant=self.tenant, ip_address="10.0.0.5", prefix=self.pa)
        self.ip_b = IPAddress.objects.create(tenant=self.tenant, ip_address="10.1.0.5", prefix=self.pb)
        self.admin = User.objects.create_user("a", password="x", is_superuser=True)
        UserProfile.objects.create(user=self.admin).tenants.add(self.tenant)
        self.client.force_login(self.admin)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")

    def test_export_scoped_to_prefix_field(self):
        text = _csv(self.client.get(f"/api/io/ipaddress/export/?fmt=csv&prefix={self.pa.id}"))
        self.assertIn("10.0.0.5", text)
        self.assertNotIn("10.1.0.5", text)  # other prefix's IP excluded

    def test_unknown_filter_param_ignored(self):
        # A bogus field doesn't error or filter everything out.
        text = _csv(self.client.get("/api/io/ipaddress/export/?fmt=csv&nonsense=zzz"))
        self.assertIn("10.0.0.5", text)
        self.assertIn("10.1.0.5", text)


class IOExportPostTests(APITestCase):
    """A bulk bar exports its selection by POSTing the ids: a few hundred
    UUIDs in a GET's query string pass the proxy's 8 KB line limit."""

    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        self.ams = Site.objects.create(tenant=self.tenant, name="AMS")
        self.lon = Site.objects.create(tenant=self.tenant, name="LON")
        self.pa = Prefix.objects.create(
            tenant=self.tenant, cidr="10.0.0.0/24", status=status_for(self.tenant), site=self.ams)
        self.pb = Prefix.objects.create(
            tenant=self.tenant, cidr="10.1.0.0/24", status=status_for(self.tenant), site=self.lon)
        self.theirs = Prefix.objects.create(
            tenant=self.other, cidr="10.2.0.0/24", status=status_for(self.other))
        self.admin = User.objects.create_user("a", password="x", is_superuser=True)
        UserProfile.objects.create(user=self.admin).tenants.add(self.tenant)
        self._login(self.admin)

    def _login(self, user):
        self.client.force_login(user)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")

    def _post(self, ids, fmt="csv"):
        return self.client.post(
            "/api/io/prefix/export/", {"fmt": fmt, "ids": [str(i) for i in ids]},
            format="json",
        )

    def test_exports_only_the_posted_ids(self):
        resp = self._post([self.pa.id])
        self.assertEqual(resp.status_code, 200)
        text = _csv(resp)
        self.assertIn("10.0.0.0/24", text)
        self.assertNotIn("10.1.0.0/24", text)

    def test_a_selection_too_long_for_a_url(self):
        import uuid

        ids = [uuid.uuid4() for _ in range(400)] + [self.pa.id, self.pb.id]
        resp = self._post(ids, fmt="json")
        self.assertEqual(resp.status_code, 200)
        rows = json.loads(b"".join(resp.streaming_content))
        self.assertEqual({r["cidr"] for r in rows}, {"10.0.0.0/24", "10.1.0.0/24"})

    def test_another_tenants_id_is_left_out(self):
        text = _csv(self._post([self.pa.id, self.theirs.id]))
        self.assertIn("10.0.0.0/24", text)
        self.assertNotIn("10.2.0.0/24", text)

    def test_site_scope_still_applies(self):
        u = User.objects.create_user("ams", password="x")
        UserProfile.objects.create(user=u).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="ams", object_types=["prefix"], actions=["view"])
        perm.users.add(u)
        perm.sites.set([self.ams])
        self._login(u)
        text = _csv(self._post([self.pa.id, self.pb.id]))
        self.assertIn("10.0.0.0/24", text)
        self.assertNotIn("10.1.0.0/24", text)

    def test_needs_view_permission(self):
        u = User.objects.create_user("none", password="x")
        UserProfile.objects.create(user=u).tenants.add(self.tenant)
        self._login(u)
        self.assertEqual(self._post([self.pa.id]).status_code, 403)

    def test_malformed_and_oversized_lists_are_refused(self):
        from api.io_views import MAX_EXPORT_IDS

        self.assertEqual(self._post(["not-a-uuid"]).status_code, 400)
        resp = self.client.post(
            "/api/io/prefix/export/", {"ids": "x" * 10}, format="json")
        self.assertEqual(resp.status_code, 400)
        resp = self._post([self.pa.id] * (MAX_EXPORT_IDS + 1))
        self.assertEqual(resp.status_code, 400)
        self.assertIn("ids", resp.json())
        # The GET path answers a bad id the same way, not with a 500.
        resp = self.client.get("/api/io/prefix/export/?ids=nope")
        self.assertEqual(resp.status_code, 400)


class CsvDialectTests(APITestCase):
    """A CSV the way Excel writes it in a Dutch or German locale, and the
    errors a row gets when a required column is empty."""

    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.admin = User.objects.create_user("a", password="x", is_superuser=True)
        UserProfile.objects.create(user=self.admin).tenants.add(self.tenant)
        self.client.force_login(self.admin)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")

    def _import(self, content, dry_run=False):
        return self.client.post(
            "/api/io/site/import/",
            {"format": "csv", "content": content, "dry_run": dry_run},
            format="json",
        ).json()

    def test_semicolon_csv_and_blank_default_cells(self):
        res = self._import(
            "﻿name;region;time_zone;gateway_policy\n"
            "IND-KK1;;Asia/Kolkata;last\n"
            "IND-MA1;;Asia/Kolkata;\n"
        )
        self.assertEqual((res["created"], res["errors"]), (2, []))
        sites = {s.name: s for s in Site.objects.filter(tenant=self.tenant)}
        self.assertEqual(sites["IND-KK1"].gateway_policy, "last")
        self.assertEqual(sites["IND-MA1"].gateway_policy, "first")  # the default

    def test_errors_name_the_field(self):
        res = self._import("name,time_zone\n,Asia/Kolkata\n")
        self.assertEqual(res["created"], 0)
        self.assertEqual(res["errors"][0]["error"], "name: This field cannot be blank.")


class IOImportStatusTests(_IOCase):
    """A status goes only on the kinds of object its catalog entry offers it
    to - through either import, as through the API (#292)."""

    def setUp(self):
        super().setUp()
        from api.models import Status

        self.cable_only = Status.objects.create(
            tenant=self.tenant, name="Cable only", slug="cable-only", available_to=["cable"]
        )

    def test_a_status_not_offered_to_the_kind_is_refused(self):
        body = self._import("id,cidr,status,description\n,10.7.7.0/24,cable-only,x\n").json()
        self.assertEqual(body["created"], 0)
        self.assertIn("“Cable only” isn't a status for prefixes.",
                      json.dumps(body["errors"], ensure_ascii=False))
        from api.bulk_import import import_rows

        result = import_rows(Prefix, self.tenant, [{"cidr": "10.6.6.0/24", "status": "cable-only"}],
                             user=self.admin)
        self.assertEqual(result["created"], 0)
        self.assertIn("isn't a status for prefixes", result["errors"][0]["error"])

    def test_a_row_already_wearing_it_imports_back_unchanged(self):
        Prefix.objects.filter(pk=self.p1.pk).update(status=self.cable_only)
        body = self._import(_csv(self._export())).json()
        self.assertEqual((body["updated"], body["errors"]), (1, []))
        self.p1.refresh_from_db()
        self.assertEqual(self.p1.status_id, self.cable_only.id)
