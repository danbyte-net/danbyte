"""The MAC list from its stored summary (#527).

``GET /api/macs/`` pages, searches, sorts and counts its facets in SQL from
``api.MacSummary``. These check that a page walk returns every MAC exactly
once and the rows the old whole-tenant gathering did, that the facet counts
are a brute-force count of the rows for each kind of caller, that the
queries do not grow with the rows, that the summary follows every kind of
write, and that the reconcile puts injected drift right.
"""
from __future__ import annotations

from collections import Counter
from datetime import timedelta
from unittest import mock

from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from rest_framework.test import APITestCase

from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tag, Tenant
from monitoring.models import MacSighting

from . import list_summaries, mac_summary
from .models import (
    Cluster,
    ClusterType,
    Device,
    Interface,
    IPAddress,
    ListSummaryDirty,
    ListSummaryState,
    MACAddress,
    MacSummary,
    OuiPrefix,
    Prefix,
    Site,
    VirtualMachine,
    VMInterface,
)

User = get_user_model()
TYPES = ["device", "interface", "ipaddress", "macaddress", "virtualmachine", "vminterface"]


def _mac(n: int) -> str:
    return f"02:00:00:00:{n // 256:02x}:{n % 256:02x}"


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = t = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.site_a = Site.objects.create(tenant=t, name="A")
        self.site_b = Site.objects.create(tenant=t, name="B")
        self.prefix = Prefix.objects.create(tenant=t, cidr="10.0.0.0/16")
        self.sw_a = Device.objects.create(tenant=t, name="sw-a", site=self.site_a)
        self.sw_b = Device.objects.create(tenant=t, name="sw-b", site=self.site_b)
        self.loose = Device.objects.create(tenant=t, name="loose")
        ctype = ClusterType.objects.create(tenant=t, name="kvm", slug="kvm")
        cluster = Cluster.objects.create(tenant=t, name="c1", type=ctype)
        self.vm = VirtualMachine.objects.create(tenant=t, name="vm1", cluster=cluster,
                                                site=self.site_a)
        self.red = Tag.objects.create(tenant=t, name="Red", slug="red", color="ff0000")
        self.blue = Tag.objects.create(tenant=t, name="Blue", slug="blue", color="0000ff")
        OuiPrefix.objects.create(tenant=t, prefix="020000", bits=24, vendor="Acme NIC",
                                 source="custom")
        other_org = Organization.objects.create(name="Other", slug="other")
        self.other = Tenant.objects.create(org=other_org, name="Other", slug="other")
        odev = Device.objects.create(tenant=self.other, name="theirs")
        Interface.objects.create(device=odev, name="x", mac_address=_mac(1))
        Interface.objects.create(device=odev, name="y", mac_address="0a:0a:0a:0a:0a:0a")
        self.now = timezone.now()

    def _fill(self, n: int = 24):
        """``n`` MACs spread over every source, both sites and the extras
        the rail counts (tags, overrides, learned places)."""
        t = self.tenant
        for i in range(n):
            mac = _mac(i)
            kind = i % 4
            dev = self.sw_a if i % 3 else self.sw_b
            if kind == 0:
                Interface.objects.create(device=dev, name=f"eth{i}", mac_address=mac.upper())
            elif kind == 1:
                VMInterface.objects.create(vm=self.vm, name=f"nic{i}", mac_address=mac)
            elif kind == 2:
                IPAddress.objects.create(tenant=t, prefix=self.prefix,
                                         ip_address=f"10.0.{i}.1",
                                         site=dev.site, mac_address=mac)
            obj = None
            if kind == 3 or i % 5 == 0:
                obj = MACAddress.objects.create(
                    tenant=t, mac_address=mac, description=f"desc {i}",
                    vendor_override="Custom Co" if i % 7 == 0 else "")
                if i % 2:
                    obj.tags.add(self.red)
                if i % 3 == 0:
                    obj.tags.add(self.blue)
            if i % 4 == 0 and i < 16:
                port = Interface.objects.create(device=dev, name=f"ge{i}")
                MacSighting.objects.create(
                    tenant=t, polled_device=dev, device=dev, interface=port,
                    port_key=f"ge{i}", port_name=f"ge{i}", mac=mac,
                    first_seen=self.now - timedelta(hours=1), last_seen=self.now)
        # A MAC on a port of a device without a site, learned there.
        port = Interface.objects.create(device=self.loose, name="p1",
                                        mac_address="0c:00:00:00:00:01")
        MacSighting.objects.create(
            tenant=t, polled_device=self.loose, device=self.loose, interface=port,
            port_key="p1", port_name="p1", mac="0c:00:00:00:00:01",
            first_seen=self.now - timedelta(hours=1), last_seen=self.now)

    def _login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _user(self, types=TYPES, sites=(), constraints=None):
        user = User.objects.create_user(f"u{User.objects.count()}", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name=f"p{user.pk}", object_types=types, actions=["view"],
            constraints=constraints)
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        if sites:
            perm.sites.set(sites)
        return user

    def _get(self, url):
        r = self.client.get(url)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def _walk(self, params: str = "", size: int = 7) -> list[dict]:
        out, page = [], 1
        while True:
            body = self._get(f"/api/macs/?page={page}&page_size={size}&{params}")
            out += body["results"]
            if not body["next"]:
                return out
            page += 1


def _reference(tenant, user):
    """The rows the list gathered before #527: every source cut to the
    caller's scope, grouped by the trimmed lower-case MAC."""
    from auth_api import rbac

    keys: dict = {}
    for slug, model, path, field in (
        ("interface", Interface, "device__tenant", "interfaces"),
        ("vminterface", VMInterface, "vm__tenant", "vm_interfaces"),
        ("ipaddress", IPAddress, "tenant", "ips"),
        ("macaddress", MACAddress, "tenant", "objects"),
    ):
        qs = rbac.restrict_queryset(
            model.objects.filter(**{path: tenant}).exclude(mac_address=""),
            user, tenant, slug, "view")
        for row in qs:
            entry = keys.setdefault(row.mac_address.strip().lower(), Counter())
            entry[field] += 1
    return keys


class PagingTests(_Base):
    def test_a_page_walk_returns_every_mac_once_with_its_rows(self):
        self._fill()
        self._login(User.objects.create_superuser("root", "r@a.c", "x"))
        rows = self._walk()
        macs = [r["id"] for r in rows]
        self.assertEqual(len(macs), len(set(macs)))
        ref = _reference(self.tenant, User.objects.get(username="root"))
        self.assertEqual(sorted(macs), sorted(ref))
        self.assertEqual(macs, sorted(macs))
        for r in rows:
            got = Counter({"interfaces": len(r["interfaces"]),
                           "vm_interfaces": len(r["vm_interfaces"]),
                           "ips": len(r["ips"]), "objects": len(r["objects"])})
            self.assertEqual(+got, +ref[r["id"]], r["id"])
        self.assertNotIn("0a:0a:0a:0a:0a:0a", macs)

    def test_rows_show_vendor_location_and_notation(self):
        self._fill()
        self._login(User.objects.create_superuser("root", "r@a.c", "x"))
        rows = {r["id"]: r for r in self._walk()}
        self.assertEqual(rows[_mac(0)]["mac"], _mac(0).upper())
        self.assertEqual(rows[_mac(0)]["vendor"], {"name": "Custom Co", "source": "override"})
        self.assertEqual(rows[_mac(1)]["vendor"], {"name": "Acme NIC", "source": "custom"})
        self.assertEqual(rows[_mac(4)]["location"]["site"]["name"], "A")
        self.assertEqual(rows[_mac(4)]["location"]["device"]["name"], "sw-a")
        self.assertIsNone(rows[_mac(1)]["location"])

    def test_queries_do_not_grow_with_the_rows(self):
        self._fill(8)
        self._login(User.objects.create_superuser("root", "r@a.c", "x"))
        self._get("/api/macs/?page_size=50")
        with CaptureQueriesContext(connection) as few:
            self._get("/api/macs/?page_size=50")
        self._fill_more(40)
        self._get("/api/macs/?page_size=50")
        with CaptureQueriesContext(connection) as many:
            body = self._get("/api/macs/?page_size=50")
        self.assertEqual(len(body["results"]), 49)
        self.assertEqual(len(few), len(many))

    def _fill_more(self, n):
        for i in range(100, 100 + n):
            Interface.objects.create(device=self.sw_a, name=f"x{i}", mac_address=_mac(i))
            MACAddress.objects.create(tenant=self.tenant, mac_address=_mac(i)).tags.add(self.red)

    def test_sorts_by_mac_and_location(self):
        self._fill()
        self._login(User.objects.create_superuser("root", "r@a.c", "x"))
        rows = self._walk("ordering=location")
        learned = [r for r in rows if r["location"]]
        # A learned place without a site first (an empty name), then A, B.
        sites = [(r["location"]["site"] or {}).get("name", "") for r in learned]
        self.assertEqual(sites, sorted(sites))
        self.assertEqual(sites[0], "")
        self.assertTrue(all(r["location"] for r in rows[:len(learned)]))
        self.assertEqual(len(rows), len({r["id"] for r in rows}))
        desc = self._walk("ordering=-mac")
        self.assertEqual([r["id"] for r in desc], sorted((r["id"] for r in desc), reverse=True))

    def test_search_reads_names_addresses_and_descriptions(self):
        self._fill()
        self._login(User.objects.create_superuser("root", "r@a.c", "x"))
        self.assertEqual([r["id"] for r in self._walk("search=nic5")], [_mac(5)])
        self.assertEqual([r["id"] for r in self._walk("search=10.0.6.1")], [_mac(6)])
        self.assertEqual([r["id"] for r in self._walk("search=desc 11")], [_mac(11)])
        self.assertEqual({r["id"] for r in self._walk("search=sw-b")} >= {_mac(0)}, True)
        self.assertIn(_mac(1), {r["id"] for r in self._walk("search=acme nic")})
        self.assertEqual([r["id"] for r in self._walk("search=00:00:00:05")], [_mac(5)])


class FacetTests(_Base):
    def _brute(self, rows) -> dict:
        out = {k: Counter() for k in ("vendor", "location", "interfaces", "ips",
                                      "description", "tags")}
        for r in rows:
            out["vendor"][r["vendor"]["name"] if r["vendor"] else "__none__"] += 1
            loc = r["location"]
            out["location"][(loc["site"]["name"] if loc["site"] else "__nosite__")
                            if loc else "__none__"] += 1
            has_if = bool(r["interfaces"] or r["vm_interfaces"])
            out["interfaces"]["yes" if has_if else "no"] += 1
            out["ips"]["yes" if r["ips"] else "no"] += 1
            out["description"]["yes" if r["objects"] else "no"] += 1
            for slug in {t["slug"] for o in r["objects"] for t in o["tags"]}:
                out["tags"][slug] += 1
        return out

    def _served(self, params="") -> dict:
        body = self._get(f"/api/macs/facets/?{params}")
        return {fid: Counter({b["value"]: b["count"] for b in buckets})
                for fid, buckets in body["facets"].items()}

    def _check(self, user):
        self._login(user)
        rows = self._walk()
        self.assertEqual(self._served(), self._brute(rows))
        # With a filter on: every other facet counts the filtered rows.
        filtered = self._walk("f_ips=yes")
        served = self._served("f_ips=yes")
        brute = self._brute(filtered)
        for fid in ("vendor", "location", "interfaces", "description", "tags"):
            self.assertEqual(served[fid], brute[fid], fid)
        self.assertEqual(served["ips"], self._brute(rows)["ips"])
        return rows

    def test_tenant_admin(self):
        self._fill()
        rows = self._check(self._user(["*"]))
        self.assertEqual(len(rows), len(_reference(self.tenant, User.objects.last())))

    def test_site_viewer(self):
        self._fill()
        user = self._user(sites=[self.site_a])
        rows = self._check(user)
        self.assertEqual(sorted(r["id"] for r in rows), sorted(_reference(self.tenant, user)))
        for r in rows:
            for i in r["interfaces"]:
                self.assertNotEqual(i["device"]["name"], "sw-b")
            if r["location"]:
                self.assertNotEqual(r["location"]["device"]["name"], "sw-b")

    def test_object_permission_limited_user(self):
        self._fill()
        user = self._user(types=["interface", "macaddress", "device"],
                          constraints={"name__startswith": "eth1"})
        self._login(user)
        rows = self._walk()
        ref = _reference(self.tenant, user)
        self.assertEqual(sorted(r["id"] for r in rows), sorted(ref))
        self.assertEqual(self._served(), self._brute(rows))

    def test_filters_and_export_match_the_list(self):
        self._fill()
        self._login(User.objects.create_superuser("root", "r@a.c", "x"))
        for params, keep in (
            ("f_vendor=Custom Co", lambda r: r["vendor"] and r["vendor"]["name"] == "Custom Co"),
            ("f_location=A", lambda r: r["location"] and r["location"]["site"]
             and r["location"]["site"]["name"] == "A"),
            ("f_location=__none__", lambda r: not r["location"]),
            ("f_location=__nosite__", lambda r: r["location"] and not r["location"]["site"]),
            ("f_tags=red", lambda r: any(t["slug"] == "red" for o in r["objects"]
                                         for t in o["tags"])),
            ("f_description=no", lambda r: not r["objects"]),
            ("f_interfaces=yes&f_ips=no",
             lambda r: (r["interfaces"] or r["vm_interfaces"]) and not r["ips"]),
        ):
            everything = self._walk()
            want = [r["id"] for r in everything if keep(r)]
            self.assertTrue(want, params)
            self.assertEqual([r["id"] for r in self._walk(params)], want, params)
            ids = self._get(f"/api/macs/table-ids/?{params}")["results"]
            self.assertEqual(ids, want, params)


class SummaryFollowsWritesTests(_Base):
    def setUp(self):
        super().setUp()
        self._fill(12)
        self._login(User.objects.create_superuser("root", "r@a.c", "x"))
        self._get("/api/macs/")

    def _assert_true(self):
        self._get("/api/macs/")  # works the marks off
        self.assertEqual(ListSummaryDirty.objects.filter(tenant=self.tenant).count(), 0)
        self.assertEqual(mac_summary.check(self.tenant), 0)

    def _row(self, mac):
        return MacSummary.objects.filter(tenant=self.tenant, key=mac).first()

    def test_interface_create_change_delete(self):
        i = Interface.objects.create(device=self.sw_a, name="new", mac_address=_mac(200))
        self._assert_true()
        self.assertEqual(self._row(_mac(200)).interfaces, 1)
        i = Interface.objects.get(pk=i.pk)
        i.mac_address = _mac(201)
        i.save()
        self._assert_true()
        self.assertIsNone(self._row(_mac(200)))
        Interface.objects.get(pk=i.pk).delete()
        self._assert_true()
        self.assertIsNone(self._row(_mac(201)))

    def test_a_save_of_a_row_read_without_its_mac(self):
        i = Interface.objects.create(device=self.sw_a, name="new", mac_address=_mac(210))
        self._assert_true()
        i = Interface.objects.only("id", "device_id", "name").get(pk=i.pk)
        i.mac_address = _mac(211)
        i.save()
        self._assert_true()

    def test_ip_pairing_and_mac_object_override(self):
        ip = IPAddress.objects.create(tenant=self.tenant, prefix=self.prefix,
                                      ip_address="10.0.99.1", mac_address=_mac(300))
        self._assert_true()
        obj = MACAddress.objects.create(tenant=self.tenant, mac_address=_mac(300),
                                        vendor_override="Box")
        self._assert_true()
        self.assertEqual(self._row(_mac(300)).vendor_override, "Box")
        ip.delete()
        obj.delete()
        self._assert_true()
        self.assertIsNone(self._row(_mac(300)))

    def test_bulk_remove(self):
        r = self.client.post("/api/macs/bulk-remove/", {
            "values": [_mac(0), _mac(1), _mac(2)], "remove_objects": True,
            "clear_interfaces": True, "unpair_ips": True}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self._assert_true()
        self.assertIsNone(self._row(_mac(0)))

    def test_bulk_edit_through_the_audited_update(self):
        from audit.bulk import log_bulk_update

        rows = list(VMInterface.objects.filter(vm=self.vm))
        VMInterface.objects.filter(vm=self.vm).update(mac_address="0e:00:00:00:00:01")
        log_bulk_update(rows, {"mac_address": "0e:00:00:00:00:01"})
        self._assert_true()
        self.assertEqual(self._row("0e:00:00:00:00:01").vm_interfaces, len(rows))

    def test_import(self):
        r = self.client.post(
            "/api/io/macaddress/import/",
            {"rows": [{"mac_address": "0e:00:00:00:00:09", "description": "imported"}]},
            format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self._assert_true()
        self.assertEqual(self._row("0e:00:00:00:00:09").mac_objects, 1)

    def test_learned_sighting_and_oui_change(self):
        port = Interface.objects.create(device=self.sw_b, name="ge99")
        MacSighting.objects.create(
            tenant=self.tenant, polled_device=self.sw_b, device=self.sw_b, interface=port,
            port_key="ge99", port_name="ge99", mac=_mac(1),
            first_seen=self.now, last_seen=self.now)
        from monitoring.mac_tables import _touch_mac_list

        _touch_mac_list(self.tenant.pk, self.sw_b.pk, self.now)
        self._assert_true()
        self.assertEqual(self._row(_mac(1)).learned_device_id, self.sw_b.pk)
        OuiPrefix.objects.filter(tenant=self.tenant).update(vendor="Renamed")
        OuiPrefix.objects.get(tenant=self.tenant).save()
        self._assert_true()
        self.assertEqual(self._row(_mac(1)).oui_vendor, "Renamed")

    def test_device_delete_moves_the_learned_place(self):
        self.assertTrue(MacSummary.objects.filter(learned_device=self.sw_a).exists())
        self.sw_a.delete()
        self._assert_true()

    def test_a_rolled_back_write_leaves_no_mark(self):
        from django.db import transaction

        try:
            with transaction.atomic():
                Interface.objects.create(device=self.sw_a, name="tmp", mac_address=_mac(400))
                raise RuntimeError
        except RuntimeError:
            pass
        self.assertFalse(ListSummaryDirty.objects.filter(key=_mac(400)).exists())


class ReconcileTests(_Base):
    def test_reconcile_puts_injected_drift_right(self):
        self._fill(12)
        list_summaries.build(mac_summary.KIND, self.tenant, restart=True)
        self.assertEqual(mac_summary.check(self.tenant), 0)
        MacSummary.objects.filter(tenant=self.tenant, key=_mac(1)).update(ips=9)
        MacSummary.objects.filter(tenant=self.tenant, key=_mac(2)).delete()
        MacSummary.objects.create(tenant=self.tenant, key="ff:ff:ff:00:00:00", interfaces=1)
        # A write nobody marked.
        Interface.objects.filter(device=self.sw_b).exclude(mac_address="").update(
            mac_address="0d:00:00:00:00:01")
        ListSummaryDirty.objects.all().delete()
        self.assertEqual(mac_summary.check(self.tenant), 4 + 1)
        self.assertEqual(list_summaries.reconcile(mac_summary.KIND, self.tenant, fix=False), 5)
        list_summaries.reconcile(mac_summary.KIND, self.tenant)
        self.assertEqual(mac_summary.check(self.tenant), 0)
        # Never another tenant's rows.
        self.assertFalse(MacSummary.objects.filter(tenant=self.other).exists())

    def test_build_is_batched_and_resumable(self):
        self._fill(20)
        st = list_summaries.state(mac_summary.KIND, self.tenant)
        calls = []
        real = mac_summary.build_batch

        def once(tenant, cursor, limit):
            calls.append(cursor)
            if len(calls) == 2:
                raise RuntimeError("interrupted")
            return real(tenant, cursor, limit)

        from dataclasses import replace

        kind = replace(list_summaries._KINDS[mac_summary.KIND], build_batch=once)
        with mock.patch.dict(list_summaries._KINDS, {mac_summary.KIND: kind}), \
                self.assertRaises(RuntimeError):
            list_summaries.build(mac_summary.KIND, self.tenant, batch=5)
        st.refresh_from_db()
        self.assertIsNone(st.built_at)
        self.assertTrue(st.cursor)
        list_summaries.build(mac_summary.KIND, self.tenant, batch=5)
        st.refresh_from_db()
        self.assertIsNotNone(st.built_at)
        self.assertEqual(mac_summary.check(self.tenant), 0)

    def test_command(self):
        from io import StringIO

        from django.core.management import call_command

        self._fill(6)
        out = StringIO()
        call_command("list_summaries", "--kind", "mac", stdout=out)
        self.assertIn("mac built", out.getvalue())
        call_command("list_summaries", "--kind", "mac", "--check", stdout=out)
        self.assertIn("0 rows differ", out.getvalue())


class BuildingStateTests(_Base):
    def test_a_small_tenant_is_built_on_first_read(self):
        self._fill(4)
        self._login(User.objects.create_superuser("root", "r@a.c", "x"))
        body = self._get("/api/macs/")
        self.assertEqual(body["summary"], {"building": False, "updating": False})
        self.assertTrue(ListSummaryState.objects.filter(
            tenant=self.tenant, built_at__isnull=False).exists())

    def test_a_big_tenant_is_built_by_the_job_and_says_so(self):
        self._fill(4)
        self._login(User.objects.create_superuser("root", "r@a.c", "x"))
        with mock.patch.object(mac_summary, "SMALL", 0), \
                mock.patch.object(list_summaries, "enqueue_build") as job:
            body = self._get("/api/macs/")
        self.assertTrue(body["summary"]["building"])
        job.assert_called_once()

    def test_no_access_is_refused(self):
        self._login(self._user(types=["device"]))
        self.assertEqual(self.client.get("/api/macs/").status_code, 403)
