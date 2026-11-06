"""Server-paged lists (#482, #487, #483): one page per request, sorted,
filtered and faceted on the server, scoped like the list, and the slim
``view=table`` row."""
from __future__ import annotations

import json

from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APITestCase

from core.models import Organization, Tag, Tenant
from customization.models import CustomField

from .list_specs import CABLE_TABLE, DEVICE_TABLE, INTERFACE_TABLE, VM_TABLE
from .models import (
    VLAN,
    Cable,
    CableTermination,
    Cluster,
    ClusterType,
    Device,
    DeviceRole,
    DeviceType,
    Interface,
    IPAddress,
    Manufacturer,
    Prefix,
    Region,
    Site,
    VirtualMachine,
)
from .test_utils import status_for
from .tests_site_scope_gaps import _TwoSites

User = get_user_model()


def _rows(r):
    body = r.json()
    return body["results"] if isinstance(body, dict) and "results" in body else body


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        t = self.tenant
        self.active = status_for(t)
        self.planned = status_for(t, "planned")
        self.planned.color = "#f59e0b"
        self.planned.save()
        self.region = Region.objects.create(tenant=t, name="North", slug="north")
        self.site_a = Site.objects.create(tenant=t, name="Alpha", region=self.region)
        self.site_b = Site.objects.create(tenant=t, name="Beta")
        mfr = Manufacturer.objects.create(tenant=t, name="Acme Networks", slug="acme-n")
        self.dtype = DeviceType.objects.create(tenant=t, name="X1", manufacturer=mfr)
        self.role = DeviceRole.objects.create(tenant=t, name="Leaf", slug="leaf",
                                              color="#10b981")
        self.core = Tag.objects.create(tenant=t, name="core", slug="core", color="#ef4444")
        CustomField.objects.create(tenant=t, key="rank", label="Rank", type="integer",
                                   applies_to=["device"])
        # dev-1 … dev-12: natural order differs from the plain one.
        self.devices = []
        for i in range(1, 13):
            d = Device.objects.create(
                tenant=t, name=f"dev-{i}", device_type=self.dtype,
                site=self.site_a if i % 2 else self.site_b,
                status=self.planned if i % 3 == 0 else self.active,
                role=self.role if i <= 4 else None,
                serial_number=f"S{13 - i:02d}",
                custom_fields={"rank": 100 - i},
            )
            self.devices.append(d)
        self.devices[0].tags.add(self.core)
        self.devices[1].tags.add(self.core)
        # Another tenant's device never shows, counts or sorts.
        Device.objects.create(tenant=self.other, name="dev-0")

    def get(self, url, status=200):
        r = self.client.get(url)
        self.assertEqual(r.status_code, status, r.content)
        return r.json()


class DevicePagingTests(_Base):
    def test_one_page_in_natural_order(self):
        body = self.get("/api/devices/?view=table&page=2&page_size=5&ordering=name")
        self.assertEqual(body["count"], 12)
        self.assertEqual([r["name"] for r in body["results"]],
                         ["dev-6", "dev-7", "dev-8", "dev-9", "dev-10"])

    def test_descending_and_stable(self):
        body = self.get("/api/devices/?view=table&page_size=3&ordering=-name")
        self.assertEqual([r["name"] for r in body["results"]], ["dev-12", "dev-11", "dev-10"])

    def test_every_sortable_column_sorts_both_ways(self):
        for column in DEVICE_TABLE.sorts:
            for sign in ("", "-"):
                with self.subTest(column=f"{sign}{column}"):
                    body = self.get(f"/api/devices/?view=table&page_size=50&ordering={sign}{column}")
                    self.assertEqual(body["count"], 12)

    def test_sort_by_status_site_and_serial(self):
        names = lambda o: [r["name"] for r in self.get(  # noqa: E731
            f"/api/devices/?view=table&page_size=50&ordering={o}")["results"]]
        by_status = self.get("/api/devices/?view=table&page_size=50&ordering=status")["results"]
        self.assertEqual([r["status"]["name"] for r in by_status],
                         sorted(r["status"]["name"] for r in by_status))
        by_site = self.get("/api/devices/?view=table&page_size=50&ordering=-site")["results"]
        self.assertEqual(by_site[0]["site"]["name"], "Beta")
        # A catalog column (#243): the serial, a nested region, a custom field.
        self.assertEqual(names("serial_number")[0], "dev-12")
        self.assertEqual(names("-custom_fields.rank")[0], "dev-1")
        self.assertEqual(set(names("site.region")[:6]),
                         {d.name for d in self.devices if d.site_id == self.site_a.id})

    def test_unknown_column_is_refused(self):
        # A figure built per row, a model field the rows leave out, junk.
        self.get("/api/devices/?ordering=interface_count", status=400)
        self.get("/api/devices/?ordering=tenant", status=400)
        self.get("/api/devices/?ordering=nonsense", status=400)
        self.get("/api/devices/?ordering=custom_fields.bad key", status=400)

    def test_no_cap_message_needed(self):
        body = self.get("/api/devices/?view=table&page_size=5")
        self.assertEqual(body["count"], 12)
        self.assertIsNotNone(body["next"])


class DeviceFacetTests(_Base):
    def test_counts_cover_every_row_and_leave_their_own_filter_out(self):
        body = self.get(f"/api/devices/facets/?f_status={self.planned.id}")
        status = {o["value"]: o["count"] for o in body["facets"]["status"]}
        # The status facet ignores its own selection: both buckets count.
        self.assertEqual(status, {str(self.active.id): 8, str(self.planned.id): 4})
        site = {o["label"]: o["count"] for o in body["facets"]["site"]}
        # Every other facet counts within it: dev-3, 6, 9, 12.
        self.assertEqual(site, {"Alpha": 2, "Beta": 2})
        role = {o["value"]: o["count"] for o in body["facets"]["role"]}
        self.assertEqual(role, {str(self.role.id): 1, "__none__": 3})
        planned = next(o for o in body["facets"]["status"] if o["label"] == "Planned")
        self.assertTrue(planned["text_color"])
        self.assertIn("name", body["sortable"])
        self.assertIn("serial_number", body["sortable"])

    def test_tags_and_none_buckets_filter_the_page(self):
        body = self.get("/api/devices/facets/")
        self.assertEqual(body["facets"]["tags"][0]["value"], "core")
        self.assertEqual(body["facets"]["tags"][0]["count"], 2)
        page = self.get("/api/devices/?view=table&f_tags=core&ordering=name")
        self.assertEqual([r["name"] for r in page["results"]], ["dev-1", "dev-2"])
        page = self.get("/api/devices/?view=table&f_role=__none__&page_size=50")
        self.assertEqual(page["count"], 8)
        both = self.get(f"/api/devices/?view=table&f_role=__none__,{self.role.id}")
        self.assertEqual(both["count"], 12)
        mfr = self.get("/api/devices/?view=table&f_manufacturer=Acme Networks")
        self.assertEqual(mfr["count"], 12)

    def test_unknown_facet_is_refused_and_bad_ids_match_nothing(self):
        self.get("/api/devices/?f_nonsense=1", status=400)
        self.assertEqual(self.get("/api/devices/?f_status=not-a-uuid")["count"], 0)

    def test_the_search_box_narrows_the_facets(self):
        body = self.get("/api/devices/facets/?search=dev-1")
        total = sum(o["count"] for o in body["facets"]["status"])
        self.assertEqual(total, 4)  # dev-1, dev-10, dev-11, dev-12

    def test_ip_range(self):
        dev = self.devices[0]
        pfx = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/24")
        for h in range(1, 4):
            IPAddress.objects.create(tenant=self.tenant, ip_address=f"10.0.0.{h}",
                                     prefix=pfx, assigned_device=dev)
        page = self.get("/api/devices/?view=table&f_ips=2..")
        self.assertEqual([r["name"] for r in page["results"]], ["dev-1"])
        self.assertEqual(page["results"][0]["ip_count"], 3)

    def test_table_ids_cover_every_page(self):
        body = self.get(f"/api/devices/table-ids/?f_status={self.active.id}&ordering=name")
        self.assertEqual(body["count"], 8)
        self.assertEqual(body["results"][0], str(self.devices[0].id))


class ExpressionTests(_Base):
    def ids(self, ast):
        q = json.dumps(ast)
        return {r["name"] for r in self.get(f"/api/devices/?view=table&page_size=50&expr={q}")["results"]}

    def test_compiles_like_the_client(self):
        self.assertEqual(self.ids({"kind": "cmp", "field": "name", "cmp": "=", "value": "DEV-2"}),
                         {"dev-2"})
        self.assertEqual(
            self.ids({"kind": "cmp", "field": "status.name", "cmp": "=", "value": "planned"}),
            {"dev-3", "dev-6", "dev-9", "dev-12"},
        )
        self.assertEqual(
            self.ids({"kind": "group", "op": "and", "terms": [
                {"kind": "cmp", "field": "site", "cmp": "~", "value": "alp"},
                {"kind": "cmp", "field": "tags", "cmp": "in", "values": ["core"]},
            ]}),
            {"dev-1"},
        )
        self.assertEqual(
            self.ids({"kind": "cmp", "field": "custom_fields.rank", "cmp": ">=", "value": "98"}),
            {"dev-1", "dev-2"},
        )
        self.assertEqual(len(self.ids({"kind": "empty", "field": "role", "negated": False})), 8)

    def test_unknown_field_and_junk_are_refused(self):
        self.get('/api/devices/?expr={"kind":"cmp","field":"tenant.slug","cmp":"=","value":"x"}',
                 status=400)
        self.get("/api/devices/?expr=not-json", status=400)
        bad_regex = json.dumps({"kind": "cmp", "field": "name", "cmp": "matches", "value": "("})
        self.get(f"/api/devices/?expr={bad_regex}", status=400)

    def test_dates_compare_as_days(self):
        after = {"kind": "cmp", "field": "updated_at", "cmp": ">", "value": "2000-01-01"}
        self.assertEqual(len(self.ids(after)), 12)
        junk = {"kind": "cmp", "field": "updated_at", "cmp": "<", "value": "soon"}
        self.assertEqual(self.ids(junk), set())


class SlimRowTests(_Base):
    def test_the_slim_row_holds_the_table_and_include_adds(self):
        row = self.get("/api/devices/?view=table&page_size=1")["results"][0]
        self.assertEqual(set(row), set(DEVICE_TABLE.fields))
        full = self.get("/api/devices/?page_size=1")["results"][0]
        self.assertIn("model_3d", full)
        self.assertGreater(len(full), len(row) * 2)
        row = self.get("/api/devices/?view=table&page_size=1&include=location,config_template")[
            "results"][0]
        self.assertIn("location", row)
        self.assertIn("config_template", row)
        # Detail views keep the whole serializer.
        one = self.get(f"/api/devices/{self.devices[0].id}/?view=table")
        self.assertIn("model_3d", one)

    def test_page_cost_is_flat(self):
        def count(url):
            self.client.get(url)
            with CaptureQueriesContext(connection) as ctx:
                r = self.client.get(url)
            self.assertEqual(r.status_code, 200, r.content)
            return len(ctx.captured_queries)

        for d in self.devices:
            d.tags.add(self.core)
        small = count("/api/devices/?view=table&page_size=2&ordering=tags")
        big = count("/api/devices/?view=table&page_size=12&ordering=tags")
        self.assertEqual(small, big)
        self.assertEqual(count("/api/devices/facets/"), count("/api/devices/facets/?search=dev"))


class InterfaceTests(_Base):
    def setUp(self):
        super().setUp()
        self.vlan = VLAN.objects.create(tenant=self.tenant, vlan_id=20, name="v20")
        for d in self.devices[:3]:
            for n in (1, 2, 10):
                Interface.objects.create(device=d, name=f"eth{n}",
                                         status=self.planned if n == 10 else None,
                                         vlan=self.vlan if n == 1 else None)

    def test_paging_sorting_and_facets(self):
        body = self.get("/api/interfaces/?view=table&page_size=3&ordering=device")
        self.assertEqual(body["count"], 9)
        self.assertEqual([(r["device"]["name"], r["name"]) for r in body["results"]],
                         [("dev-1", "eth1"), ("dev-1", "eth2"), ("dev-1", "eth10")])
        for column in INTERFACE_TABLE.sorts:
            with self.subTest(column=column):
                self.get(f"/api/interfaces/?view=table&ordering=-{column}")
        facets = self.get("/api/interfaces/facets/")["facets"]
        status = {o["value"]: (o["label"], o["count"]) for o in facets["status"]}
        self.assertEqual(status["none"], ("Active", 6))
        self.assertEqual(len(facets["device"]), 3)
        page = self.get("/api/interfaces/?view=table&f_status=none")
        self.assertEqual(page["count"], 6)

    def test_slim_row_leaves_out_far_ends_and_addresses(self):
        row = self.get("/api/interfaces/?view=table&page_size=1")["results"][0]
        self.assertEqual(set(row), set(INTERFACE_TABLE.fields))
        self.assertNotIn("link_peer", row)
        full = self.get("/api/interfaces/?page_size=1")["results"][0]
        self.assertIn("link_peer", full)
        self.assertIn("ip_addresses", full)

    def test_full_list_reads_plain_lists_at_a_flat_cost(self):
        a, b = Interface.objects.filter(device=self.devices[0])[:2]
        cable = Cable.objects.create(tenant=self.tenant)
        CableTermination.objects.create(cable=cable, end="A", interface=a)
        CableTermination.objects.create(cable=cable, end="B", interface=b)
        lag = Interface.objects.create(device=self.devices[0], name="ae0", type="lag")
        Interface.objects.filter(pk=a.pk).update(lag=lag)
        a.tagged_vlans.add(self.vlan)

        def count(url):
            self.client.get(url)
            with CaptureQueriesContext(connection) as ctx:
                r = self.client.get(url)
            self.assertEqual(r.status_code, 200, r.content)
            return len(ctx.captured_queries), _rows(r)

        small, _ = count("/api/interfaces/?page_size=2")
        big, rows = count("/api/interfaces/?page_size=20")
        self.assertEqual(small, big)
        by_name = {(r["device"]["name"], r["name"]): r for r in rows}
        self.assertEqual(by_name[("dev-1", "ae0")]["lag_member_count"], 1)
        self.assertEqual(by_name[("dev-1", a.name)]["cable_count"], 1)
        self.assertEqual(by_name[("dev-1", a.name)]["link_peer"]["port"], b.name)
        self.assertEqual([v["vlan_id"] for v in by_name[("dev-1", a.name)]["tagged_vlans"]], [20])
        # A write still answers with what it saved, not the list's lists.
        r = self.client.patch(f"/api/interfaces/{a.id}/", {"tagged_vlan_ids": []}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["tagged_vlans"], [])


class CableAndVmTests(_Base):
    def setUp(self):
        super().setUp()
        for i, (typ, st) in enumerate((("cat6", self.active), ("cat6", self.planned),
                                       ("smf", None))):
            a = Interface.objects.create(device=self.devices[i], name="c")
            b = Interface.objects.create(device=self.devices[i + 3], name="c")
            cable = Cable.objects.create(tenant=self.tenant, type=typ, status=st,
                                         label=f"C{i + 1}")
            CableTermination.objects.create(cable=cable, end="A", interface=a)
            CableTermination.objects.create(cable=cable, end="B", interface=b)
        ct = ClusterType.objects.create(tenant=self.tenant, name="CT", slug="ct")
        self.cl1 = Cluster.objects.create(tenant=self.tenant, name="C1", type=ct)
        self.cl2 = Cluster.objects.create(tenant=self.tenant, name="C2", type=ct)
        for i in range(1, 6):
            VirtualMachine.objects.create(tenant=self.tenant, name=f"vm-{i}",
                                          cluster=self.cl1 if i < 4 else self.cl2,
                                          vcpus=i, status=self.active)

    def test_cables(self):
        for column in CABLE_TABLE.sorts:
            with self.subTest(column=column):
                self.get(f"/api/cables/?view=table&ordering={column}")
        facets = self.get("/api/cables/facets/")["facets"]
        types = {o["value"]: o for o in facets["type"]}
        self.assertEqual(types["cat6"]["count"], 2)
        self.assertEqual(types["cat6"]["label"], "CAT6")
        page = self.get("/api/cables/?view=table&f_type=cat6&ordering=-status")
        self.assertEqual(page["count"], 2)
        self.assertEqual(set(page["results"][0]), set(CABLE_TABLE.fields))
        none = self.get("/api/cables/?view=table&f_status=__none__")
        self.assertEqual([r["label"] for r in none["results"]], ["C3"])

    def test_vms(self):
        for column in VM_TABLE.sorts:
            with self.subTest(column=column):
                self.get(f"/api/virtual-machines/?view=table&ordering={column}")
        body = self.get("/api/virtual-machines/?view=table&ordering=-vcpus&page_size=2")
        self.assertEqual([r["name"] for r in body["results"]], ["vm-5", "vm-4"])
        self.assertEqual(set(body["results"][0]), set(VM_TABLE.fields))
        facets = self.get("/api/virtual-machines/facets/?f_cluster=C1")["facets"]
        self.assertEqual({o["value"]: o["count"] for o in facets["cluster"]}, {"C1": 3, "C2": 2})
        self.assertEqual(self.get("/api/virtual-machines/?f_cluster=C2")["count"], 2)


class ScopeTests(_TwoSites):
    """The page, the rail and Select all see what the list sees: a Site A
    viewer never counts, sorts or ticks a Site B device."""

    def setUp(self):
        super().setUp()
        t = self.tenant
        st = status_for(t)
        for i in range(3):
            Device.objects.create(tenant=t, name=f"a-{i}", site=self.site_a, status=st)
        for i in range(2):
            Device.objects.create(tenant=t, name=f"b-{i}", site=self.site_b, status=st)
        self._grant(["device", "site", "cable"])
        self._login()

    def test_site_viewer(self):
        page = self.client.get("/api/devices/?view=table&ordering=-name").json()
        self.assertEqual(page["count"], 3)
        facets = self.client.get("/api/devices/facets/").json()["facets"]
        self.assertEqual([(o["label"], o["count"]) for o in facets["site"]], [("SiteA", 3)])
        ids = self.client.get("/api/devices/table-ids/").json()
        self.assertEqual(ids["count"], 3)
        self.assertEqual(self.client.get("/api/cables/facets/").status_code, 200)
