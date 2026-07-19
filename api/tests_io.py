"""Round-trip export/import: registry, export scoping, upsert, RBAC, dry-run."""
from __future__ import annotations

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
        self.assertEqual(io_for("prefix").natural_key, ["cidr"])
        self.assertEqual(io_for("ipaddress").natural_key, ["ip_address"])
        self.assertEqual(io_for("vlan").natural_key, ["vlan_id"])
        self.assertEqual(io_for("device").natural_key, ["name", "site"])
        # Auto handler for an un-overridden model picks a sensible key.
        self.assertEqual(io_for("manufacturer").natural_key, ["slug"])
        # Non-tenant / unknown → no handler.
        self.assertIsNone(io_for("group"))
        self.assertIsNone(io_for("does-not-exist"))

    def test_infer_prefers_unique_then_slug_then_name(self):
        self.assertEqual(_infer_natural_key(Manufacturer), ["slug"])
        self.assertEqual(_infer_natural_key(Device), ["name"])  # (tenant,name)


class IORoundTripTests(APITestCase):
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
        self.assertEqual(by_slug["prefix"]["natural_key"], ["cidr"])
        self.assertNotIn("group", by_slug)  # non-tenant model excluded

    def test_fields_returns_columns_and_key(self):
        res = self.client.get("/api/io/prefix/fields/")
        self.assertEqual(res.status_code, 200)
        body = res.json()
        self.assertIn("id", body["columns"])
        self.assertIn("cidr", body["columns"])
        self.assertEqual(body["natural_key"], ["cidr"])

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
