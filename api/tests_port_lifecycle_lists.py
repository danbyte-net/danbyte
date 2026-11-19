"""Port utilization and Lifecycle, paged on the server (#535).

Port utilization reads the stored per-device counts (``api.port_stats``):
its rows equal the live roll-up for every device, a page walk returns every
device once, the facets are a brute-force count of the rows for each kind of
caller, the queries do not grow with the devices, the counts follow every
kind of write, and the reconcile puts injected drift right. Lifecycle reads
a view: its facets and page walks are checked the same way (the row rules
are ``tests_lifecycle_overview``'s).
"""
from __future__ import annotations

from collections import Counter
from datetime import date, timedelta
from unittest import mock

from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APITestCase

from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tag, Tenant

from . import list_summaries, port_stats
from .models import (
    Cable,
    CableTermination,
    Device,
    DevicePortStat,
    DeviceRole,
    DeviceType,
    FrontPort,
    Interface,
    InterfaceTemplate,
    ListSummaryDirty,
    Manufacturer,
    PortReservation,
    Rack,
    RearPort,
    Site,
    Status,
)

User = get_user_model()
TODAY = date(2026, 6, 15)


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = t = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.planned = Status.objects.create(tenant=t, name="Planned", slug="planned",
                                             available_to=["cable"])
        self.gone = Status.objects.create(tenant=t, name="Not present", slug="np",
                                          available_to=["interface"])
        self.site_a = Site.objects.create(tenant=t, name="A")
        self.site_b = Site.objects.create(tenant=t, name="B")
        self.rack = Rack.objects.create(tenant=t, name="R1", site=self.site_a)
        self.role = DeviceRole.objects.create(tenant=t, name="Access", slug="access",
                                              color="00ff00")
        mfr = Manufacturer.objects.create(tenant=t, name="Acme", slug="acme")
        self.dtype = DeviceType.objects.create(tenant=t, name="SW48", manufacturer=mfr,
                                               end_of_support=TODAY + timedelta(days=40))
        other_org = Organization.objects.create(name="Other", slug="other")
        self.other = Tenant.objects.create(org=other_org, name="Other", slug="other")
        theirs = Device.objects.create(tenant=self.other, name="theirs")
        Interface.objects.create(device=theirs, name="x")

    def _fill(self, n=12):
        devs = []
        for i in range(n):
            site = self.site_a if i % 2 else self.site_b
            d = Device.objects.create(
                tenant=self.tenant, name=f"sw{i:02d}", site=site,
                rack=self.rack if site == self.site_a and i % 3 else None,
                role=self.role if i % 4 else None, device_type=self.dtype if i % 5 else None)
            for j in range(i % 6 + 1):
                iface = Interface.objects.create(device=d, name=f"eth{j}")
                if j % 3 == 1:
                    self._cable(iface, planned=j % 2 == 0)
                elif j == 2:
                    PortReservation.objects.create(tenant=self.tenant, interface=iface)
            if i % 4 == 0:
                rp = RearPort.objects.create(device=d, name="rp", positions=4)
                fp = FrontPort.objects.create(device=d, name="fp1", rear_port=rp,
                                              rear_port_position=1)
                self._cable(fp=fp)
            devs.append(d)
        return devs

    def _cable(self, iface=None, planned=False, fp=None):
        c = Cable.objects.create(tenant=self.tenant, status=self.planned if planned else None)
        CableTermination.objects.create(cable=c, end="A", interface=iface, front_port=fp)
        return c

    def _login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _user(self, types=("device",), sites=(), constraints=None):
        user = User.objects.create_user(f"u{User.objects.count()}", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name=f"p{user.pk}", object_types=list(types), actions=["view"],
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

    def _walk(self, base, params="", size=5):
        out, page = [], 1
        while True:
            body = self._get(f"{base}?page={page}&page_size={size}&{params}")
            out += body["results"]
            if not body["next"]:
                return out
            page += 1

    def _served(self, base, params=""):
        body = self._get(f"{base}facets/?{params}")
        return {fid: Counter({b["value"]: b["count"] for b in buckets})
                for fid, buckets in body["facets"].items()}


PU = "/api/port-utilization/"


class PortUtilizationListTests(_Base):
    def _rollup(self):
        return {r["id"]: r for r in self._get("/api/devices/port-utilization/")["results"]}

    def test_rows_equal_the_live_roll_up_and_walk_once(self):
        self._fill()
        self._login(User.objects.create_superuser("root", "r@a.c", "x"))
        rows = self._walk(PU)
        ids = [r["id"] for r in rows]
        self.assertEqual(len(ids), len(set(ids)))
        live = self._rollup()
        self.assertEqual(set(ids), set(live))
        for r in rows:
            want = {k: v for k, v in live[r["id"]].items()}
            self.assertEqual(r, want)
        pcts = [r["pct"] for r in rows]
        self.assertEqual(pcts, sorted(pcts, reverse=True))

    def test_sorts_and_search(self):
        self._fill()
        self._login(User.objects.create_superuser("root", "r@a.c", "x"))
        for col, key in (("free", lambda r: r["free"]), ("used",
                                                         lambda r: r["connected"] + r["reserved"]),
                         ("reserved", lambda r: r["reserved"])):
            rows = self._walk(PU, f"ordering=-{col}")
            self.assertEqual([key(r) for r in rows], sorted((key(r) for r in rows), reverse=True))
            self.assertEqual(len(rows), len({r["id"] for r in rows}))
        self.assertEqual([r["name"] for r in self._walk(PU, "search=sw03")], ["sw03"])

    def _brute(self, rows):
        out = {k: Counter() for k in ("site", "rack", "role", "type")}
        for r in rows:
            out["site"][r["site"]["id"] if r["site"] else "__none__"] += 1
            out["rack"][r["rack"]["id"] if r["rack"] else "__none__"] += 1
            out["role"][r["role"]["name"] if r["role"] else "__none__"] += 1
            out["type"][r["device_type"] or "__none__"] += 1
        return out

    def _check(self, user):
        self._login(user)
        rows = self._walk(PU)
        self.assertEqual(self._served(PU), self._brute(rows))
        site = f"f_site={self.site_a.pk}"
        filtered = self._walk(PU, site)
        self.assertTrue(all(r["site"]["name"] == "A" for r in filtered))
        served, brute = self._served(PU, site), self._brute(filtered)
        for fid in ("rack", "role", "type"):
            self.assertEqual(served[fid], brute[fid], fid)
        ids = self._get(f"{PU}table-ids/?{site}")["results"]
        self.assertEqual(ids, [r["id"] for r in filtered])
        return rows

    def test_facets_for_each_kind_of_caller(self):
        self._fill()
        everyone = self._check(self._user(types=["*"]))
        site_rows = self._check(self._user(sites=[self.site_a]))
        self.assertEqual({r["site"]["name"] for r in site_rows}, {"A"})
        limited = self._check(self._user(constraints={"name__in": ["sw01", "sw02", "sw05"]}))
        self.assertEqual({r["name"] for r in limited} <= {"sw01", "sw02", "sw05"}, True)
        self.assertNotIn("theirs", {r["name"] for r in everyone})

    def test_queries_do_not_grow_with_the_devices(self):
        self._fill(3)
        self._login(User.objects.create_superuser("root", "r@a.c", "x"))
        self._get(f"{PU}?page_size=50")
        with CaptureQueriesContext(connection) as few:
            self._get(f"{PU}?page_size=50")
        self._fill_more(30)
        self._get(f"{PU}?page_size=50")
        with CaptureQueriesContext(connection) as many:
            body = self._get(f"{PU}?page_size=50")
        self.assertEqual(body["count"], 33)
        self.assertEqual(len(few), len(many))

    def _fill_more(self, n):
        for i in range(n):
            d = Device.objects.create(tenant=self.tenant, name=f"x{i}", site=self.site_b)
            Interface.objects.create(device=d, name="e0")

    def test_the_virtual_setting_reads_without_a_rebuild(self):
        from core.models import DeploymentSettings

        d = Device.objects.create(tenant=self.tenant, name="v")
        Interface.objects.create(device=d, name="e0")
        Interface.objects.create(device=d, name="Vlan1", virtual=True)
        self._login(User.objects.create_superuser("root", "r@a.c", "x"))
        (row,) = self._walk(PU)
        self.assertEqual(row["total"], 1)
        ds = DeploymentSettings.load()
        ds.port_count_virtual = True
        ds.save()
        (row,) = self._walk(PU)
        self.assertEqual(row["total"], 2)
        self.assertEqual(row, self._rollup()[str(d.pk)])


class PortStatsFollowWritesTests(_Base):
    def setUp(self):
        super().setUp()
        self.devs = self._fill(6)
        self._login(User.objects.create_superuser("root", "r@a.c", "x"))
        self._get(PU)

    def _assert_true(self):
        self._get(PU)  # works the marks off
        self.assertFalse(ListSummaryDirty.objects.filter(tenant=self.tenant).exists())
        self.assertEqual(port_stats.check(self.tenant), 0)

    def test_every_kind_of_write(self):
        d = self.devs[1]
        iface = Interface.objects.create(device=d, name="new")
        self._assert_true()
        iface.type = "lag"
        iface.save()
        self._assert_true()
        iface.status = self.gone
        iface.save()
        self._assert_true()
        self.gone.excludes_capacity = True
        self.gone.save()
        self._assert_true()
        cable = self._cable(Interface.objects.create(device=d, name="c1"))
        self._assert_true()
        cable.status = self.planned
        cable.save()
        self._assert_true()
        cable.delete()
        self._assert_true()
        resv = PortReservation.objects.create(
            tenant=self.tenant, interface=Interface.objects.get(device=d, name="c1"))
        self._assert_true()
        resv.delete()
        iface.mark_connected = True
        iface.save()
        self._assert_true()
        iface.device = self.devs[2]
        iface.save()
        self._assert_true()
        iface.delete()
        self._assert_true()
        self.devs[3].delete()
        self._assert_true()

    def test_bulk_update_and_template_instantiation(self):
        from audit.bulk import log_bulk_update

        rows = list(Interface.objects.filter(device=self.devs[5]))
        Interface.objects.filter(device=self.devs[5]).update(mark_connected=True)
        log_bulk_update(rows, {"mark_connected": True})
        self._assert_true()
        InterfaceTemplate.objects.create(device_type=self.dtype, name="Gi1")
        InterfaceTemplate.objects.create(device_type=self.dtype, name="Gi2")
        from .models import materialize_device_components

        new = Device.objects.create(tenant=self.tenant, name="stamped", device_type=self.dtype)
        materialize_device_components(new)
        self.assertEqual(Interface.objects.filter(device=new).count(), 2)
        self._assert_true()
        self.assertEqual(DevicePortStat.objects.get(device=new).if_total, 2)

    def test_reconcile_puts_injected_drift_right(self):
        DevicePortStat.objects.filter(device=self.devs[1]).update(if_total=99)
        DevicePortStat.objects.filter(device=self.devs[2]).delete()
        Interface.objects.filter(device=self.devs[4]).update(virtual=True)
        ListSummaryDirty.objects.all().delete()
        self.assertEqual(list_summaries.reconcile(port_stats.KIND, self.tenant, fix=False), 3)
        list_summaries.reconcile(port_stats.KIND, self.tenant)
        self.assertEqual(port_stats.check(self.tenant), 0)
        self.assertFalse(DevicePortStat.objects.filter(tenant=self.other).exclude(
            device__tenant=self.other).exists())

    def test_a_big_tenant_is_built_by_the_job_and_says_so(self):
        list_summaries.state(port_stats.KIND, self.tenant).delete()
        with mock.patch.object(port_stats, "SMALL", 0), \
                mock.patch.object(list_summaries, "enqueue_build") as job:
            body = self._get(PU)
        self.assertTrue(body["summary"]["building"])
        job.assert_called_once()


LC = "/api/lifecycle/"


class LifecycleListTests(_Base):
    def setUp(self):
        super().setUp()
        frozen = mock.patch("django.utils.timezone.localdate", return_value=TODAY)
        frozen.start()
        self.addCleanup(frozen.stop)
        devs = self._fill(10)
        tag = Tag.objects.create(tenant=self.tenant, name="Prod", slug="prod")
        for d in devs[::3]:
            d.tags.add(tag)
            d.warranty_end = TODAY + timedelta(days=200)
            d.save()

    def _brute(self, rows):
        out = {k: Counter() for k in ("kind", "source", "status", "window", "site", "role",
                                      "manufacturer", "tags")}
        params = {"past": "past", "d90": "90", "d180": "180", "y1": "365", "later": "later",
                  "none": "none"}
        for r in rows:
            out["kind"][r["object"]["kind"]] += 1
            out["source"][r["source"]] += 1
            out["status"][r["status"]] += 1
            out["window"][params[r["window"]]] += 1
            out["site"][r["site"]["id"] if r["site"] else "__none__"] += 1
            out["role"][r["role"]["id"] if r["role"] else "__none__"] += 1
            out["manufacturer"][r["manufacturer"]["id"] if r["manufacturer"] else "__none__"] += 1
            for t in r["tags"]:
                out["tags"][t["slug"]] += 1
        return out

    def _check(self, user):
        self._login(user)
        rows = self._walk(LC, "undated=1")
        self.assertEqual(len(rows), len({r["id"] for r in rows}))
        served = self._served(LC, "undated=1")
        served.pop("application", None)
        self.assertEqual(served, self._brute(rows))
        filtered = self._walk(LC, "undated=1&f_source=hardware")
        self.assertTrue(filtered and all(r["source"] == "hardware" for r in filtered))
        counts = self._get(f"{LC}summary/")["counts"]
        self.assertEqual(sum(counts.values()), len(rows))
        return rows

    def test_facets_for_each_kind_of_caller(self):
        everyone = self._check(self._user(types=["*"]))
        site = self._check(self._user(sites=[self.site_a]))
        self.assertLess(len(site), len(everyone))
        self.assertEqual({r["site"]["name"] for r in site if r["site"]}, {"A"})
        self._check(self._user(constraints={"name__in": ["sw01", "sw04"]}))

    def test_queries_do_not_grow_with_the_rows(self):
        self._login(User.objects.create_superuser("root", "r@a.c", "x"))
        self._get(f"{LC}?page_size=50")
        with CaptureQueriesContext(connection) as few:
            self._get(f"{LC}?page_size=50")
        for i in range(20):
            Device.objects.create(tenant=self.tenant, name=f"y{i}", device_type=self.dtype,
                                  warranty_end=TODAY)
        self._get(f"{LC}?page_size=50")
        with CaptureQueriesContext(connection) as many:
            self._get(f"{LC}?page_size=50")
        self.assertEqual(len(few), len(many))
