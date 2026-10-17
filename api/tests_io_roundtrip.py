"""Round-trip import/export: an unchanged export imports back as a no-op,
references resolve in the row's own scope, and rows are validated the way
the API validates them (#330, #348, #349, #351-#355)."""
from __future__ import annotations

import csv
import io
import json

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.models import (
    VLAN,
    VRF,
    Cable,
    Circuit,
    Contact,
    Device,
    DeviceType,
    Interface,
    InterfaceTemplate,
    IPAddress,
    Location,
    Prefix,
    Provider,
    Rack,
    Site,
    VLANGroup,
)
from api.test_utils import status_for
from auth_api.models import UserProfile
from core.models import Organization, Tag, Tenant
from customization.models import CustomField


def _body(resp) -> str:
    if hasattr(resp, "streaming_content"):
        return b"".join(resp.streaming_content).decode("utf-8")
    return resp.content.decode("utf-8")


class _Case(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        self.status = status_for(self.tenant)
        self.site_a = Site.objects.create(tenant=self.tenant, name="SiteA")
        self.site_b = Site.objects.create(tenant=self.tenant, name="SiteB")
        self.admin = User.objects.create_user("a", password="x", is_superuser=True)
        UserProfile.objects.create(user=self.admin).tenants.add(self.tenant)
        self.client.force_login(self.admin)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")

    def export(self, slug, fmt="csv"):
        resp = self.client.get(f"/api/io/{slug}/export/?fmt={fmt}")
        body = _body(resp)
        self.assertEqual(resp.status_code, 200, body)
        return body

    def load(self, slug, content, dry_run=False, fmt="csv"):
        resp = self.client.post(
            f"/api/io/{slug}/import/",
            {"format": fmt, "content": content, "dry_run": dry_run},
            format="json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        return resp.json()

    def rows(self, slug, **match):
        out = list(csv.DictReader(io.StringIO(self.export(slug))))
        return [r for r in out if all(r.get(k) == v for k, v in match.items())]

    def csv_of(self, rows):
        buf = io.StringIO()
        w = csv.DictWriter(buf, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
        return buf.getvalue()

    def assert_noop(self, slug):
        """Dry run and commit of an unchanged export: no errors, no creates,
        no changes."""
        text = self.export(slug)
        dry = self.load(slug, text, dry_run=True)
        self.assertEqual(dry["errors"], [], slug)
        self.assertEqual(dry["created"], 0, slug)
        self.assertEqual([p for p in dry["preview"] if p["changes"]], [], slug)
        real = self.load(slug, text)
        self.assertEqual(real["errors"], [], slug)
        self.assertEqual(real["created"], 0, slug)


class ScopedReferenceTests(_Case):
    """#330 - a reference resolves within the row's own device, VRF or site,
    and the export never writes one that would read back as another object."""

    def setUp(self):
        super().setUp()
        self.net = Prefix.objects.create(tenant=self.tenant, cidr="10.9.0.0/24",
                                         status=self.status)

    def _device(self, name, site, **kw):
        return Device.objects.create(tenant=self.tenant, name=name, site=site, **kw)

    def test_interface_resolves_on_the_rows_device(self):
        h1, h2 = self._device("host1", self.site_a), self._device("host2", self.site_a)
        e1 = Interface.objects.create(device=h1, name="eth0")
        e2 = Interface.objects.create(device=h2, name="eth0")
        ip1 = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.9.0.1", prefix=self.net, status=self.status,
            assigned_device=h1, assigned_interface=e1)
        ip2 = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.9.0.2", prefix=self.net, status=self.status,
            assigned_device=h2, assigned_interface=e2)
        self.assert_noop("ipaddress")
        ip1.refresh_from_db()
        ip2.refresh_from_db()
        self.assertEqual((ip1.assigned_interface_id, ip2.assigned_interface_id),
                         (e1.id, e2.id))
        # The cell stays the readable name: the row's device says which.
        row = self.rows("ipaddress", ip_address="10.9.0.2")[0]
        self.assertEqual(row["assigned_interface"], "eth0")

    def test_older_file_without_the_device_is_a_row_error(self):
        h1, h2 = self._device("host1", self.site_a), self._device("host2", self.site_a)
        e1 = Interface.objects.create(device=h1, name="eth0")
        Interface.objects.create(device=h2, name="eth0")
        ip = IPAddress.objects.create(tenant=self.tenant, ip_address="10.9.0.1",
                                      prefix=self.net, status=self.status,
                                      assigned_device=h1,
                                      assigned_interface=e1)
        content = f"id,ip_address,assigned_interface\n{ip.id},10.9.0.1,eth0\n"
        # The row's device comes from the object itself on an update.
        self.assertEqual(self.load("ipaddress", content)["errors"], [])
        content = "ip_address,status,prefix,assigned_interface\n10.9.0.77,active,10.9.0.0/24,eth0\n"
        res = self.load("ipaddress", content, dry_run=True)
        self.assertEqual(res["created"], 0)
        self.assertIn("matches more than one interface", res["errors"][0]["error"])

    def test_an_unambiguous_older_file_still_imports(self):
        h1 = self._device("host1", self.site_a)
        e1 = Interface.objects.create(device=h1, name="eth9")
        res = self.load("ipaddress",
                        "ip_address,status,prefix,assigned_interface\n"
                        "10.9.0.9,active,10.9.0.0/24,eth9\n")
        self.assertEqual((res["created"], res["errors"]), (1, []))
        ip = IPAddress.objects.get(tenant=self.tenant, ip_address="10.9.0.9")
        self.assertEqual(ip.assigned_interface_id, e1.id)

    def test_unknown_reference_is_a_plain_row_error(self):
        res = self.load("ipaddress",
                        "ip_address,status,prefix,assigned_interface\n"
                        "10.9.0.9,active,10.9.0.0/24,nope\n")
        self.assertEqual(res["errors"][0]["error"],
                         "assigned_interface: no interface matching 'nope'.")

    def test_prefix_resolves_in_the_rows_vrf(self):
        vrf_a = VRF.objects.create(tenant=self.tenant, name="A")
        vrf_b = VRF.objects.create(tenant=self.tenant, name="B")
        Prefix.objects.create(tenant=self.tenant, cidr="10.8.0.0/24", vrf=vrf_a,
                              status=self.status)
        p_b = Prefix.objects.create(tenant=self.tenant, cidr="10.8.0.0/24", vrf=vrf_b,
                                    status=self.status)
        ip = IPAddress.objects.create(tenant=self.tenant, ip_address="10.8.0.5",
                                      prefix=p_b, vrf=vrf_b, status=self.status)
        self.assert_noop("ipaddress")
        ip.refresh_from_db()
        self.assertEqual((ip.prefix_id, ip.vrf_id), (p_b.id, vrf_b.id))

    def test_rack_resolves_in_the_rows_site(self):
        Rack.objects.create(tenant=self.tenant, site=self.site_a, name="R1")
        r_b = Rack.objects.create(tenant=self.tenant, site=self.site_b, name="R1")
        dev = self._device("srv1", self.site_b, rack=r_b)
        self.assert_noop("device")
        dev.refresh_from_db()
        self.assertEqual(dev.rack_id, r_b.id)

    def test_export_falls_back_to_the_id_when_the_name_is_not_enough(self):
        # Two VLAN 10s in the same site, in different groups: a prefix row has
        # a site but no group, so the number alone can't say which.
        g1 = VLANGroup.objects.create(tenant=self.tenant, name="g1", slug="g1")
        g2 = VLANGroup.objects.create(tenant=self.tenant, name="g2", slug="g2")
        VLAN.objects.create(tenant=self.tenant, vlan_id=10, name="x", group=g1,
                            site=self.site_a)
        v2 = VLAN.objects.create(tenant=self.tenant, vlan_id=10, name="y", group=g2,
                                 site=self.site_a)
        p = Prefix.objects.create(tenant=self.tenant, cidr="10.7.0.0/24",
                                  site=self.site_a, vlan=v2, status=self.status)
        row = self.rows("prefix", cidr="10.7.0.0/24")[0]
        self.assertEqual(row["vlan"], str(v2.id))
        self.assert_noop("prefix")
        p.refresh_from_db()
        self.assertEqual(p.vlan_id, v2.id)


class DeviceCreateTests(_Case):
    """#330 - a device created by import is built like one created through
    POST /api/devices/."""

    def setUp(self):
        super().setUp()
        self.dt = DeviceType.objects.create(tenant=self.tenant, name="sw24", u_height=1)
        for n in ("ge-0/0/0", "ge-0/0/1", "ge-0/0/2", "ge-0/0/3"):
            InterfaceTemplate.objects.create(device_type=self.dt, name=n)

    def test_components_are_materialised(self):
        res = self.load("device", "name,device_type,site\nimp-sw,sw24,SiteA\n")
        self.assertEqual((res["created"], res["errors"]), (1, []))
        dev = Device.objects.get(tenant=self.tenant, name="imp-sw")
        self.assertEqual(dev.interfaces.count(), 4)

    def test_dry_run_creates_nothing(self):
        res = self.load("device", "name,device_type,site\nimp-sw,sw24,SiteA\n",
                        dry_run=True)
        self.assertEqual(res["created"], 1)
        self.assertFalse(Device.objects.filter(name="imp-sw").exists())
        self.assertFalse(Interface.objects.filter(name="ge-0/0/0").exists())

    def test_rack_overlap_is_refused(self):
        rack = Rack.objects.create(tenant=self.tenant, site=self.site_a, name="RX",
                                   u_height=42)
        Device.objects.create(tenant=self.tenant, name="occupant", site=self.site_a,
                              device_type=self.dt, rack=rack, position=10, face="front")
        content = ("name,device_type,site,rack,position,face\n"
                   "imp-clash,sw24,SiteA,RX,10,front\n")
        for dry in (True, False):
            res = self.load("device", content, dry_run=dry)
            self.assertEqual(res["created"], 0)
            self.assertEqual(res["errors"][0]["error"], "position: Overlaps occupant at U10.")
        self.assertFalse(Device.objects.filter(name="imp-clash").exists())


class CustomFieldValidationTests(_Case):
    """#348 - custom fields are checked against their definitions, as the API
    checks them."""

    def setUp(self):
        super().setUp()
        cf = dict(tenant=self.tenant, applies_to=["site"])
        CustomField.objects.create(key="sel", type="select", choices=["a", "b"], **cf)
        CustomField.objects.create(key="num", type="integer", **cf)
        CustomField.objects.create(key="when", type="date", **cf)
        CustomField.objects.create(key="ref", type="object", related_model="site", **cf)
        CustomField.objects.create(key="must", type="text", required=True, **cf)
        self.foreign = Site.objects.create(tenant=self.other, name="Theirs")

    def _row(self, cf):
        return [{"id": str(self.site_a.id), "name": "SiteA",
                 "custom_fields": json.dumps(cf)}]

    def _rows_import(self, rows, dry_run=False):
        resp = self.client.post("/api/io/site/import/",
                                {"rows": rows, "dry_run": dry_run}, format="json")
        return resp.json()

    def test_invalid_values_are_refused_like_the_api(self):
        bad = {"sel": "zzz", "num": "abc", "when": "31-02-2026",
               "ref": str(self.foreign.id)}
        api = self.client.patch(f"/api/sites/{self.site_a.id}/",
                                {"custom_fields": bad}, format="json")
        self.assertEqual(api.status_code, 400)
        for dry in (True, False):
            res = self._rows_import(self._row(bad), dry_run=dry)
            self.assertEqual(res["updated"], 0)
            err = res["errors"][0]["error"]
            for key in ("must", "num", "ref", "sel", "when"):
                self.assertIn(f"{key}: ", err)
        self.site_a.refresh_from_db()
        self.assertEqual(self.site_a.custom_fields or {}, {})

    def test_valid_values_are_stored_coerced(self):
        good = {"sel": "a", "num": "7", "must": "x", "ref": str(self.site_b.id)}
        res = self._rows_import(self._row(good))
        self.assertEqual((res["updated"], res["errors"]), (1, []))
        self.site_a.refresh_from_db()
        self.assertEqual(self.site_a.custom_fields["num"], 7)

    def test_unchanged_values_are_not_rechecked(self):
        # Stored before "must" existed: an unchanged re-import leaves it be.
        Site.objects.filter(pk=self.site_a.pk).update(custom_fields={"sel": "a"})
        self.assert_noop("site")


class NumIdTests(_Case):
    """#349 - numid is export-only."""

    def test_numid_column_is_ignored(self):
        first = self.site_a.numid
        res = self.load("site", f"id,name,numid\n{self.site_b.id},SiteB,{first}\n")
        self.assertEqual(res["errors"], [])
        res = self.load("site", f"name,numid\nSiteC,{first}\n")
        self.assertEqual((res["created"], res["errors"]), (1, []))
        self.assertEqual(Site.objects.filter(tenant=self.tenant, numid=first).count(), 1)
        self.assertIn("numid", self.export("site").splitlines()[0])


class ApiRuleTests(_Case):
    """#351 - rules that live in the serializers apply to imported rows."""

    def test_vlan_outside_its_groups_range(self):
        VLANGroup.objects.create(tenant=self.tenant, name="G1", slug="g1",
                                 min_vid=100, max_vid=199)
        for dry in (True, False):
            res = self.load("vlan", "vlan_id,name,group\n300,v300,g1\n", dry_run=dry)
            self.assertEqual(res["created"], 0)
            self.assertIn("range", res["errors"][0]["error"])
        self.assertFalse(VLAN.objects.filter(vlan_id=300).exists())

    def test_vlan_group_bounds(self):
        content = "name,slug,min_vid,max_vid\ng2,g2,500,100\ng3,g3,0,9999\n"
        res = self.load("vlangroup", content)
        self.assertEqual(res["created"], 0)
        self.assertEqual(len(res["errors"]), 2)

    def test_rack_location_in_another_site(self):
        Location.objects.create(tenant=self.tenant, site=self.site_b, name="L",
                                slug="loc-b")
        res = self.load("rack", "name,site,location\nRZ,SiteA,loc-b\n")
        self.assertEqual(res["created"], 0)
        self.assertTrue(res["errors"])
        self.assertFalse(Rack.objects.filter(name="RZ").exists())

    def test_cable_without_ends(self):
        res = self.load("cable", "type,label\ncat6,orphan\n")
        self.assertEqual(res["created"], 0)
        self.assertEqual(res["errors"][0]["error"], "a: Both ends need at least one port.")
        self.assertFalse(Cable.objects.filter(label="orphan").exists())


class SiteScopedNaturalKeyTests(_Case):
    """#352 - a keyless row for another site creates a new object."""

    def test_vlan(self):
        orig = VLAN.objects.create(tenant=self.tenant, vlan_id=10, name="users-A",
                                   site=self.site_a)
        res = self.load("vlan", "vlan_id,name,site\n10,users-B,SiteB\n")
        self.assertEqual((res["created"], res["errors"]), (1, []))
        orig.refresh_from_db()
        self.assertEqual((orig.site_id, orig.name), (self.site_a.id, "users-A"))

    def test_rack(self):
        orig = Rack.objects.create(tenant=self.tenant, site=self.site_a, name="R1")
        res = self.load("rack", "name,site\nR1,SiteB\n")
        self.assertEqual((res["created"], res["errors"]), (1, []))
        orig.refresh_from_db()
        self.assertEqual(orig.site_id, self.site_a.id)

    def test_location(self):
        orig = Location.objects.create(tenant=self.tenant, site=self.site_a,
                                       name="floor-1", slug="floor-1")
        res = self.load("location", "name,slug,site\nfloor-1,floor-1,SiteB\n")
        self.assertEqual((res["created"], res["errors"]), (1, []))
        orig.refresh_from_db()
        self.assertEqual(orig.site_id, self.site_a.id)

    def test_keyless_row_for_the_same_site_still_updates(self):
        orig = Rack.objects.create(tenant=self.tenant, site=self.site_a, name="R1")
        res = self.load("rack", "name,site,description\nR1,SiteA,edited\n")
        self.assertEqual((res["updated"], res["errors"]), (1, []))
        orig.refresh_from_db()
        self.assertEqual(orig.description, "edited")


class MissingKeyColumnTests(_Case):
    """#370 - a natural-key column absent from the file is not used for
    matching; present but empty, it still matches an empty value."""

    def test_rack_without_a_site_column_updates(self):
        orig = Rack.objects.create(tenant=self.tenant, site=self.site_a, name="R1")
        res = self.load("rack", "name,description\nR1,patched\n")
        self.assertEqual((res["updated"], res["created"], res["errors"]), (1, 0, []))
        orig.refresh_from_db()
        self.assertEqual(orig.description, "patched")

    def test_rack_without_a_site_column_is_ambiguous_across_sites(self):
        Rack.objects.create(tenant=self.tenant, site=self.site_a, name="R1")
        Rack.objects.create(tenant=self.tenant, site=self.site_b, name="R1")
        res = self.load("rack", "name,description\nR1,patched\n")
        self.assertEqual((res["updated"], res["created"]), (0, 0))
        self.assertIn("More than one rack", res["errors"][0]["error"])
        self.assertFalse(Rack.objects.filter(description="patched").exists())

    def test_location_without_a_site_column_updates(self):
        orig = Location.objects.create(tenant=self.tenant, site=self.site_a,
                                       name="floor-1", slug="floor-1")
        res = self.load("location", "slug,description\nfloor-1,first\n")
        self.assertEqual((res["updated"], res["errors"]), (1, []))
        orig.refresh_from_db()
        self.assertEqual(orig.description, "first")

    def test_an_empty_site_cell_still_matches_nothing(self):
        Rack.objects.create(tenant=self.tenant, site=self.site_a, name="R1")
        res = self.load("rack", "name,site,description\nR1,,patched\n")
        self.assertEqual(res["updated"], 0)
        self.assertFalse(Rack.objects.filter(description="patched").exists())


class NoneWordNameTests(_Case):
    """#371 - an object named like an empty cell ("Global", "None", "-")
    survives an unchanged round trip."""

    def test_region_named_global(self):
        from api.models import Region

        for name in ("Global", "None", "-"):
            region = Region.objects.create(tenant=self.tenant, name=name,
                                           slug=f"r-{len(name)}-{name.lower()}")
            Site.objects.filter(pk=self.site_a.pk).update(region=region)
            self.assert_noop("site")
            self.site_a.refresh_from_db()
            self.assertEqual(self.site_a.region_id, region.id, name)
            # Written as the id, which reads back as this very region.
            row = self.rows("site", name="SiteA")[0]
            self.assertEqual(row["region"], str(region.id))

    def test_prefix_in_a_vrf_named_none(self):
        vrf = VRF.objects.create(tenant=self.tenant, name="none")
        p = Prefix.objects.create(tenant=self.tenant, cidr="10.6.0.0/24", vrf=vrf,
                                  status=self.status)
        self.assert_noop("prefix")
        p.refresh_from_db()
        self.assertEqual(p.vrf_id, vrf.id)

    def test_an_empty_cell_still_unlinks(self):
        from api.models import Region

        region = Region.objects.create(tenant=self.tenant, name="EU", slug="eu")
        Site.objects.filter(pk=self.site_a.pk).update(region=region)
        res = self.load("site", f"id,name,region\n{self.site_a.id},SiteA,\n")
        self.assertEqual(res["errors"], [])
        self.site_a.refresh_from_db()
        self.assertIsNone(self.site_a.region_id)


class DryRunMatchesCommitTests(_Case):
    """#353 - a duplicate is a plain-word row error in both modes."""

    def test_duplicate_circuit(self):
        kpn = Provider.objects.create(tenant=self.tenant, name="kpn", slug="kpn")
        Circuit.objects.create(tenant=self.tenant, cid="C-1", provider=kpn)
        content = "cid,provider\nC-1,kpn\n"
        dry = self.load("circuit", content, dry_run=True)
        real = self.load("circuit", content)
        self.assertEqual((dry["created"], real["created"]), (0, 0))
        self.assertEqual(dry["errors"], real["errors"])
        err = real["errors"][0]["error"]
        self.assertNotIn("duplicate key", err)
        self.assertNotIn(str(self.tenant.id), err)
        self.assertEqual(Circuit.objects.filter(cid="C-1").count(), 1)

    def test_database_refusal_is_worded_plainly(self):
        from unittest import mock

        from django.db import IntegrityError

        class _Cause(Exception):
            sqlstate = "23505"

        def boom(*a, **kw):
            try:
                raise _Cause("duplicate key value violates unique constraint x")
            except _Cause as c:
                raise IntegrityError("duplicate key value (tenant_id)=(…)") from c

        with mock.patch.object(Site, "save", boom):
            res = self.load("site", "name\nSiteZ\n")
        self.assertEqual(res["errors"][0]["error"],
                         "This row conflicts with existing data "
                         "(a duplicate value for a unique field).")


class EmptyJsonTests(_Case):
    """#354 - empty JSON lists and objects survive a round trip."""

    def test_custom_field_definitions(self):
        cf = CustomField.objects.create(tenant=self.tenant, key="t", label="T",
                                        type="text", applies_to=["site"])
        self.assertEqual(cf.choices, [])
        for fmt in ("csv", "json"):
            text = self.export("customfield", fmt=fmt)
            self.assertEqual(self.load("customfield", text, fmt=fmt)["errors"], [])
            cf.refresh_from_db()
            self.assertEqual(cf.choices, [])
            self.assertIsInstance(cf.scope_rules, (list, dict))

    def test_cable_provider_contact(self):
        cable = Cable.objects.create(tenant=self.tenant, type="cat6", label="c")
        prov = Provider.objects.create(tenant=self.tenant, name="p", slug="p")
        contact = Contact.objects.create(tenant=self.tenant, name="c")
        before = (cable.strands, prov.business_hours, contact.business_hours)
        for slug in ("cable", "provider", "contact"):
            self.assert_noop(slug)
        cable.refresh_from_db()
        prov.refresh_from_db()
        contact.refresh_from_db()
        self.assertEqual((cable.strands, prov.business_hours, contact.business_hours),
                         before)

    def test_blank_cell_reads_as_the_default(self):
        cf = CustomField.objects.create(tenant=self.tenant, key="t", label="T",
                                        type="text", applies_to=["site"])
        res = self.load("customfield", f"id,key,label,choices\n{cf.id},t,T,\n")
        self.assertEqual(res["errors"], [])
        cf.refresh_from_db()
        self.assertEqual(cf.choices, [])


class TagRoundTripTests(_Case):
    """#355 - tags export, and the tags column round-trips exactly."""

    def test_tag_export(self):
        Tag.objects.create(tenant=self.tenant, name="core", slug="core")
        for fmt in ("csv", "json", "xlsx"):
            resp = self.client.get(f"/api/io/tag/export/?fmt={fmt}")
            self.assertEqual(resp.status_code, 200)
        self.assert_noop("tag")

    def test_semicolon_in_a_tag_name(self):
        t = Tag.objects.create(tenant=self.tenant, name="a;b", slug="a-b")
        self.site_a.tags.add(t)
        self.assert_noop("site")
        self.assertEqual(list(self.site_a.tags.names()), ["a;b"])
        self.assertFalse(Tag.objects.filter(name__in=["a", "b"]).exists())

    def test_old_unquoted_cell_still_splits(self):
        self.load("site", f"id,name,tags\n{self.site_a.id},SiteA,x;y\n")
        self.assertEqual(set(self.site_a.tags.names()), {"x", "y"})

    def test_tenantless_tag_is_reused(self):
        legacy = Tag.objects.create(tenant=None, name="legacy", slug="legacy")
        self.site_a.tags.add(legacy)
        self.assert_noop("site")
        self.assertEqual(Tag.objects.filter(name="legacy").count(), 1)
        self.assertEqual(list(self.site_a.tags.all()), [legacy])


class EveryTypeRoundTripTests(APITestCase):
    """An unchanged export of every exportable type imports back without a
    single change, in CSV and JSON - over the demo seeders' data plus the
    shapes the reports above were about."""

    @classmethod
    def setUpTestData(cls):
        from django.core.management import call_command

        quiet = io.StringIO()
        call_command("seed_demo", stdout=quiet)
        call_command("seed_homelab", tenant="acme", stdout=quiet)
        call_command("seed_fabric", stdout=quiet)
        call_command("seed_multisite", stdout=quiet)
        cls.admin = User.objects.create_user("rt", password="x", is_superuser=True)
        profile = UserProfile.objects.create(user=cls.admin)
        profile.tenants.set(Tenant.objects.all())
        cls._extras(Tenant.objects.get(slug="acme"))

    @classmethod
    def _extras(cls, t):
        st = status_for(t)
        sa = Site.objects.create(tenant=t, name="RT-A")
        sb = Site.objects.create(tenant=t, name="RT-B")
        vrf_a = VRF.objects.create(tenant=t, name="RT-VA")
        vrf_b = VRF.objects.create(tenant=t, name="RT-VB")
        Prefix.objects.create(tenant=t, cidr="10.250.0.0/24", vrf=vrf_a, status=st)
        p_b = Prefix.objects.create(tenant=t, cidr="10.250.0.0/24", vrf=vrf_b, status=st)
        Rack.objects.create(tenant=t, site=sa, name="RT-R1")
        r_b = Rack.objects.create(tenant=t, site=sb, name="RT-R1")
        Location.objects.create(tenant=t, site=sa, name="fl", slug="rt-floor")
        Location.objects.create(tenant=t, site=sb, name="fl", slug="rt-floor")
        h1 = Device.objects.create(tenant=t, name="rt-h1", site=sb, rack=r_b, status=st)
        h2 = Device.objects.create(tenant=t, name="rt-h2", site=sb, status=st)
        e1 = Interface.objects.create(device=h1, name="eth0")
        e2 = Interface.objects.create(device=h2, name="eth0")
        IPAddress.objects.create(tenant=t, ip_address="10.250.0.1", prefix=p_b,
                                 vrf=vrf_b, status=st, assigned_device=h1,
                                 assigned_interface=e1)
        IPAddress.objects.create(tenant=t, ip_address="10.250.0.2", prefix=p_b,
                                 vrf=vrf_b, status=st, assigned_device=h2,
                                 assigned_interface=e2)
        VLAN.objects.create(tenant=t, vlan_id=3999, name="a", site=sa)
        VLAN.objects.create(tenant=t, vlan_id=3999, name="b", site=sb)
        CustomField.objects.create(tenant=t, key="rt-text", label="RT", type="text",
                                   applies_to=["site"])
        Cable.objects.create(tenant=t, type="cat6", label="rt-cable")
        VLANGroup.objects.create(tenant=t, name="rt-g", slug="rt-g", site=sa,
                                 min_vid=100, max_vid=199)
        kpn = Provider.objects.create(tenant=t, name="rt-kpn", slug="rt-kpn")
        Circuit.objects.create(tenant=t, cid="RT-1", provider=kpn)
        Provider.objects.create(tenant=t, name="rt-prov", slug="rt-prov")
        Contact.objects.create(tenant=t, name="rt-contact")
        semi = Tag.objects.create(tenant=t, name="rt;semi", slug="rt-semi")
        legacy = Tag.objects.create(tenant=None, name="rt-legacy", slug="rt-legacy")
        sa.tags.add(semi, legacy)

    def _snapshot(self, model, tenant):
        from api.io import _is_taggable

        fields = [f for f in model._meta.concrete_fields if f.name != "updated_at"]
        out = {}
        for o in model._default_manager.filter(tenant=tenant):
            row = {f.attname: f.value_from_object(o) for f in fields}
            if _is_taggable(model):
                row["__tags"] = sorted(str(pk) for pk in o.tags.values_list("pk", flat=True))
            out[o.pk] = row
        return out

    def test_unchanged_export_is_a_noop_for_every_type(self):
        from api.io import io_for, io_types

        covered = set()
        for tenant in Tenant.objects.all():
            self.client.force_login(self.admin)
            self.client.post(f"/api/tenants/{tenant.id}/switch/")
            for entry in io_types():
                slug = entry["slug"]
                model = io_for(slug).model
                if not model._default_manager.filter(tenant=tenant).exists():
                    continue
                covered.add(slug)
                for fmt in ("csv", "json"):
                    with self.subTest(tenant=tenant.slug, slug=slug, fmt=fmt):
                        before = self._snapshot(model, tenant)
                        tags_before = Tag.objects.count()
                        resp = self.client.get(f"/api/io/{slug}/export/?fmt={fmt}")
                        self.assertEqual(resp.status_code, 200)
                        text = _body(resp)
                        for dry in (True, False):
                            res = self.client.post(
                                f"/api/io/{slug}/import/",
                                {"format": fmt, "content": text, "dry_run": dry},
                                format="json",
                            ).json()
                            self.assertEqual(res["errors"], [])
                            self.assertEqual(res["created"], 0)
                            self.assertEqual(res["updated"], len(before))
                            if dry:
                                self.assertEqual(
                                    [p for p in res["preview"] if p["changes"]], []
                                )
                        self.assertEqual(self._snapshot(model, tenant), before)
                        self.assertEqual(Tag.objects.count(), tags_before)
        # The seeders reach most of the catalog; keep it that way.
        self.assertGreaterEqual(len(covered), 35, sorted(covered))
