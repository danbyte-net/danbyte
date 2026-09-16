"""The status-history list: every filter, the window, facets, buckets, paging
and site-scoped visibility."""
from __future__ import annotations

from datetime import timedelta

from django.contrib.auth.models import User
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import (
    VLAN,
    Device,
    DeviceRole,
    DeviceType,
    Interface,
    IPAddress,
    Prefix,
    Region,
    Site,
)
from api.test_utils import status_for
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tag, Tenant

from .history import window
from .models import CheckKind, CheckState, CheckTemplate, MonitoringEngine, StateTransition


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.north = Region.objects.create(tenant=self.tenant, name="North", slug="north")
        self.jutland = Region.objects.create(
            tenant=self.tenant, name="Jutland", slug="jutland", parent=self.north
        )
        self.site_a = Site.objects.create(tenant=self.tenant, name="Aarhus", region=self.jutland)
        self.site_b = Site.objects.create(tenant=self.tenant, name="Berlin")
        self.vlan = VLAN.objects.create(tenant=self.tenant, vlan_id=10, name="mgmt")
        self.prefix_a = Prefix.objects.create(
            tenant=self.tenant, cidr="10.1.0.0/24", status=status_for(self.tenant), site=self.site_a,
            vlan=self.vlan,
        )
        self.prefix_b = Prefix.objects.create(
            tenant=self.tenant, cidr="10.2.0.0/24", status=status_for(self.tenant), site=self.site_b,
        )
        self.dtype = DeviceType.objects.create(tenant=self.tenant, model="C9300")
        self.role = DeviceRole.objects.create(tenant=self.tenant, name="Access", slug="access")
        self.dev_a = Device.objects.create(
            tenant=self.tenant, name="asw1", site=self.site_a, device_type=self.dtype, role=self.role,
        )
        self.dev_b = Device.objects.create(tenant=self.tenant, name="bsw1", site=self.site_b)
        self.ip_a = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.1.0.1", prefix=self.prefix_a, site=self.site_a,
            assigned_device=self.dev_a, dns_name="asw1.lab",
        )
        self.ip_b = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.2.0.1", prefix=self.prefix_b, site=self.site_b,
            assigned_device=self.dev_b,
        )
        self.ping = CheckTemplate.objects.create(
            tenant=self.tenant, name="Ping", slug="ping", kind=CheckKind.ICMP
        )
        self.https = CheckTemplate.objects.create(
            tenant=self.tenant, name="HTTPS", slug="https", kind=CheckKind.TCP,
            params={"port": 443},
        )
        self.outpost = MonitoringEngine.objects.create(
            tenant=self.tenant, name="Aarhus", slug="aarhus", kind="remote"
        )
        self.now = timezone.now()
        self.admin = User.objects.create_superuser("admin", "a@b.c", "pw")

    def login(self, user=None):
        self.client.force_login(user or self.admin)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def tr(self, ip, template, to, *, ago=timedelta(hours=1), frm="up", engine=None):
        return StateTransition.objects.create(
            tenant=self.tenant, target_ip=ip, template=template, kind=template.kind,
            from_status=frm, to_status=to, at=self.now - ago, engine=engine,
        )

    def get(self, path="/api/monitoring/transitions/", **params):
        r = self.client.get(path, params)
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def ips_of(self, body):
        return sorted(r["target_ip"]["ip_address"] for r in body["results"])


class FilterTests(_Base):
    def setUp(self):
        super().setUp()
        self.login()
        self.tr(self.ip_a, self.ping, "down", engine=self.outpost)
        self.tr(self.ip_a, self.https, "degraded", ago=timedelta(hours=2))
        self.tr(self.ip_b, self.ping, "down", ago=timedelta(hours=3))
        self.tr(self.ip_b, self.ping, "up", frm="down", ago=timedelta(days=10))

    def test_default_window_is_seven_days(self):
        body = self.get()
        self.assertEqual(body["count"], 3)
        self.assertEqual(body["bucket"], "day")
        row = next(r for r in body["results"] if r["target_ip"]["dns_name"] == "asw1.lab")
        self.assertEqual(row["site"]["name"], "Aarhus")
        self.assertEqual(row["device"]["name"], "asw1")
        self.assertEqual(row["source"], "outpost")
        self.assertEqual(row["engine"]["name"], "Aarhus")

    def test_days_and_explicit_stamps(self):
        self.assertEqual(self.get(days=30)["count"], 4)
        since = (self.now - timedelta(hours=2, minutes=30)).isoformat()
        body = self.get(since=since)
        self.assertEqual(body["count"], 2)
        self.assertEqual(body["bucket"], "hour")
        until = (self.now - timedelta(hours=2, minutes=30)).isoformat()
        self.assertEqual(self.get(days=30, until=until)["count"], 2)

    def test_flapping_rows_are_flagged_filterable_and_counted(self):
        from .models import CheckState

        CheckState.objects.create(
            tenant=self.tenant, target_ip=self.ip_a, template=self.ping, kind="icmp",
            status="down", flapping_since=self.now,
        )
        body = self.get(days=30)
        flagged = {r["target_ip"]["ip_address"] for r in body["results"] if r["flapping"]}
        self.assertEqual(flagged, {"10.1.0.1"})
        self.assertEqual(body["facets"]["flapping"], [{"value": "1", "label": "Flapping", "count": 1}])
        body = self.get(days=30, flapping="1")
        self.assertEqual(body["count"], 1)
        self.assertTrue(all(r["flapping"] for r in body["results"]))

    def test_hours_win_over_days(self):
        since, until = window({"hours": "12", "days": "30"}, self.now)
        self.assertEqual(since, self.now - timedelta(hours=12))
        since, _ = window({"hours": "x"}, self.now)
        self.assertEqual(since, self.now - timedelta(days=7))
        since, _ = window({"hours": "99999999"}, self.now)
        self.assertEqual(since, self.now - timedelta(days=365))
        self.assertEqual(self.get(hours=2, until=(self.now - timedelta(minutes=30)).isoformat())["count"], 2)

    def test_naive_stamps_are_refused_not_guessed(self):
        since, until = window({"since": "2026-01-01T00:00:00"}, self.now)
        self.assertEqual(until, self.now)
        self.assertEqual(since, self.now - timedelta(days=7))

    def test_status_kind_template_and_source(self):
        self.assertEqual(self.ips_of(self.get(to_status="down")), ["10.1.0.1", "10.2.0.1"])
        self.assertEqual(self.ips_of(self.get(to_status="degraded")), ["10.1.0.1"])
        self.assertEqual(self.get(to_status="down,degraded")["count"], 3)
        self.assertEqual(self.ips_of(self.get(kind="tcp")), ["10.1.0.1"])
        self.assertEqual(self.get(template=str(self.https.id))["count"], 1)
        self.assertEqual(self.ips_of(self.get(source="outpost")), ["10.1.0.1"])
        self.assertEqual(self.get(source="local")["count"], 2)
        self.assertEqual(self.get(engine=str(self.outpost.id))["count"], 1)
        self.assertEqual(self.get(days=30, from_status="down")["count"], 1)

    def test_site_matches_ip_prefix_or_device(self):
        self.assertEqual(self.ips_of(self.get(site=str(self.site_a.id))), ["10.1.0.1", "10.1.0.1"])
        # An address with no site of its own is still "at" its prefix's site
        # and its device's site.
        loose = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.1.0.9", prefix=self.prefix_a
        )
        self.tr(loose, self.ping, "down")
        self.assertIn("10.1.0.9", self.ips_of(self.get(site=str(self.site_a.id))))
        # A Site-B device's address inside the siteless prefix is "at" Site B.
        shared = Prefix.objects.create(
            tenant=self.tenant, cidr="192.0.2.0/24", status=status_for(self.tenant)
        )
        homeless = IPAddress.objects.create(
            tenant=self.tenant, ip_address="192.0.2.1", prefix=shared, assigned_device=self.dev_b
        )
        self.tr(homeless, self.ping, "down")
        self.assertIn("192.0.2.1", self.ips_of(self.get(site=str(self.site_b.id))))

    def test_region_includes_descendants(self):
        self.assertEqual(set(self.ips_of(self.get(region=str(self.north.id)))), {"10.1.0.1"})
        self.assertEqual(self.get(region=str(self.jutland.id))["count"], 2)

    def test_device_dimensions(self):
        self.assertEqual(self.get(device=str(self.dev_b.id))["count"], 1)
        self.assertEqual(self.get(device_type=str(self.dtype.id))["count"], 2)
        self.assertEqual(self.get(role=str(self.role.id))["count"], 2)
        self.assertEqual(self.get(prefix=str(self.prefix_b.id))["count"], 1)

    def test_vlan_via_prefix_or_interface(self):
        self.assertEqual(self.get(vlan=str(self.vlan.id))["count"], 2)
        access = VLAN.objects.create(tenant=self.tenant, vlan_id=20, name="access")
        iface = Interface.objects.create(device=self.dev_b, name="eth0", vlan=access)
        self.ip_b.assigned_interface = iface
        self.ip_b.save()
        self.assertEqual(self.ips_of(self.get(vlan=str(access.id))), ["10.2.0.1"])

    def test_port_matches_number_or_string(self):
        self.assertEqual(self.ips_of(self.get(port="443")), ["10.1.0.1"])
        self.https.params = {"port": "443"}
        self.https.save()
        self.assertEqual(self.ips_of(self.get(port="443")), ["10.1.0.1"])
        self.assertEqual(self.get(port="22")["count"], 0)

    def test_tags_and_across_slugs_from_ip_or_device(self):
        core = Tag.objects.create(tenant=self.tenant, name="Core", slug="core")
        prod = Tag.objects.create(tenant=self.tenant, name="Prod", slug="prod")
        self.dev_a.tags.add(core)
        self.ip_a.tags.add(prod)
        self.dev_b.tags.add(core)
        self.assertEqual(self.get(tag="core")["count"], 3)
        self.assertEqual(self.get(tag="core,prod")["count"], 2)
        r = self.client.get("/api/monitoring/transitions/?tag=core&tag=prod")
        self.assertEqual(r.json()["count"], 2)

    def test_search(self):
        self.assertEqual(self.get(search="asw1")["count"], 2)
        self.assertEqual(self.get(q="10.2.")["count"], 1)
        self.assertEqual(self.get(search="HTTPS")["count"], 1)


class FacetAndSeriesTests(_Base):
    def setUp(self):
        super().setUp()
        self.login()
        self.tr(self.ip_a, self.ping, "down", engine=self.outpost)
        self.tr(self.ip_a, self.https, "degraded")
        self.tr(self.ip_b, self.ping, "down")

    def _facet(self, body, dim):
        return {f["value"]: f["count"] for f in body["facets"][dim]}

    def test_facets_count_every_filter_but_their_own(self):
        body = self.get(to_status="degraded")
        # The status facet still offers "down" with its count...
        self.assertEqual(self._facet(body, "to_status"), {"down": 2, "degraded": 1})
        # ...while the other facets are narrowed by the status filter.
        self.assertEqual(self._facet(body, "kind"), {"tcp": 1})
        self.assertEqual(self._facet(body, "site"), {str(self.site_a.id): 1})
        labels = {f["value"]: f["label"] for f in body["facets"]["site"]}
        self.assertEqual(labels[str(self.site_a.id)], "Aarhus")

    def test_site_facet_counts_what_the_site_filter_matches(self):
        """An address with no site of its own is counted under its prefix's
        or its device's - the facet must not say 0 for a filter that finds 2."""
        self.ip_a.site = None
        self.ip_a.save()
        shared = Prefix.objects.create(
            tenant=self.tenant, cidr="10.2.0.0/16", status=status_for(self.tenant)
        )
        self.ip_b.site = None
        self.ip_b.prefix = shared
        self.ip_b.save()
        body = self.get()
        self.assertEqual(
            self._facet(body, "site"), {str(self.site_a.id): 2, str(self.site_b.id): 1}
        )

    def test_engine_and_source_facets(self):
        body = self.get()
        self.assertEqual(self._facet(body, "source"), {"local": 2, "outpost": 1})
        self.assertEqual(self._facet(body, "engine"), {str(self.outpost.id): 1})
        self.assertEqual(body["facets"]["engine"][0]["label"], "Aarhus")

    def test_series_buckets_by_status(self):
        body = self.get(days=1)
        self.assertEqual(body["bucket"], "hour")
        totals = {}
        for b in body["series"]:
            for k, v in b.items():
                if k != "t":
                    totals[k] = totals.get(k, 0) + v
        self.assertEqual(totals["down"], 2)
        self.assertEqual(totals["degraded"], 1)
        self.assertEqual(totals["up"], 0)

    def test_paging_and_cap(self):
        body = self.get(page_size=2)
        self.assertEqual(len(body["results"]), 2)
        self.assertEqual(body["count"], 3)
        self.assertEqual(body["page"], 1)
        self.assertEqual(len(self.get(page=2, page_size=2)["results"]), 1)
        self.assertEqual(self.get(page_size=9999)["page_size"], 200)

    def test_ordering(self):
        first = self.get(ordering="at")["results"][0]
        self.assertEqual(first["to_status"], "down")
        by_ip = self.get(ordering="-ip")["results"]
        self.assertEqual(by_ip[0]["target_ip"]["ip_address"], "10.2.0.1")


class ScopedListsTests(_Base):
    def setUp(self):
        super().setUp()
        self.login()
        self.tr(self.ip_a, self.ping, "down")
        self.tr(self.ip_a, self.https, "degraded")
        self.tr(self.ip_b, self.ping, "down")

    def test_per_object_lists(self):
        self.assertEqual(
            self.get(f"/api/monitoring/ips/{self.ip_a.id}/transitions/")["count"], 2
        )
        self.assertEqual(
            self.get(f"/api/monitoring/devices/{self.dev_b.id}/transitions/")["count"], 1
        )
        self.assertEqual(
            self.get(f"/api/monitoring/prefixes/{self.prefix_a.id}/transitions/")["count"], 2
        )
        r = self.client.get(f"/api/monitoring/ips/{self.dev_a.id}/transitions/")
        self.assertEqual(r.status_code, 404)

    def test_timelines(self):
        CheckState.objects.create(
            tenant=self.tenant, target_ip=self.ip_a, template=self.ping, kind="icmp",
            status="down",
        )
        st = CheckState.objects.create(
            tenant=self.tenant, target_ip=self.ip_a, template=self.https, kind="tcp",
            status="degraded",
        )
        body = self.get(f"/api/monitoring/ips/{self.ip_a.id}/timeline/", days=1)
        self.assertEqual(len(body["checks"]), 2)
        self.assertEqual([s["status"] for s in body["rollup"]], ["unknown", "down"])
        # The window's figures ride along, for the whole address and per check.
        self.assertEqual(
            set(body["summary"]), {"uptime_pct", "incidents", "down_seconds", "mttr_seconds"}
        )
        self.assertEqual(body["summary"]["uptime_pct"], 0.0)
        self.assertTrue(all("uptime_pct" in c for c in body["checks"]))
        body = self.get(f"/api/monitoring/devices/{self.dev_a.id}/timeline/", days=1)
        self.assertEqual(len(body["ips"]), 1)
        self.assertEqual(body["ips"][0]["rollup"][-1]["status"], "down")
        self.assertIn("uptime_pct", body["ips"][0])
        self.assertIn("summary", body)
        r = self.client.post(
            "/api/monitoring/timeline/", {"states": [str(st.id)], "days": 1}, format="json"
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["segments"][str(st.id)][-1]["status"], "degraded")
        r = self.client.post(
            "/api/monitoring/timeline/", {"states": ["x"] * 201}, format="json"
        )
        self.assertEqual(r.status_code, 400)


class SiteScopeTests(_Base):
    """A viewer granted Site A only sees Site A's history - in the list, the
    facets, the series and the per-object endpoints."""

    def setUp(self):
        super().setUp()
        self.viewer = User.objects.create_user("viewer", password="x")
        UserProfile.objects.create(user=self.viewer, role="custom").tenants.add(self.tenant)
        for slug in ("ipaddress", "device", "prefix"):
            perm = ObjectPermission.objects.create(
                name=f"a-{slug}", object_types=[slug], actions=["view"]
            )
            perm.users.add(self.viewer)
            perm.tenants.add(self.tenant)
            perm.sites.add(self.site_a)
        self.login(self.viewer)
        self.tr(self.ip_a, self.ping, "down")
        self.tr(self.ip_b, self.ping, "down")
        self.state_b = CheckState.objects.create(
            tenant=self.tenant, target_ip=self.ip_b, template=self.ping, kind="icmp",
            status="down",
        )

    def test_list_facets_and_series(self):
        body = self.get()
        self.assertEqual(self.ips_of(body), ["10.1.0.1"])
        self.assertEqual(
            {f["value"] for f in body["facets"]["site"]}, {str(self.site_a.id)}
        )
        self.assertEqual(sum(b["down"] for b in body["series"]), 1)

    def test_other_sites_objects_are_not_found(self):
        for path in (
            f"/api/monitoring/ips/{self.ip_b.id}/transitions/",
            f"/api/monitoring/ips/{self.ip_b.id}/timeline/",
            f"/api/monitoring/devices/{self.dev_b.id}/transitions/",
            f"/api/monitoring/devices/{self.dev_b.id}/timeline/",
            f"/api/monitoring/prefixes/{self.prefix_b.id}/transitions/",
        ):
            self.assertEqual(self.client.get(path).status_code, 404, path)

    def test_batch_timeline_drops_unviewable_states(self):
        r = self.client.post(
            "/api/monitoring/timeline/", {"states": [str(self.state_b.id)]}, format="json"
        )
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json()["segments"], {})


class StatsWindowTests(_Base):
    def test_hours_switches_the_bucket(self):
        self.login()
        body = self.get("/api/monitoring/stats/")
        self.assertEqual(body["series_hours"], 24)
        self.assertEqual(body["series_bucket"], "hour")
        body = self.get("/api/monitoring/stats/", hours=720)
        self.assertEqual(body["series_hours"], 720)
        self.assertEqual(body["series_bucket"], "day")
        self.assertEqual(self.get("/api/monitoring/stats/", hours=5)["series_hours"], 24)


class ChecksListTests(_Base):
    """The Checks list on the same rail: every target dimension, facets that
    leave their own filter out, server ordering, strips per row."""

    def setUp(self):
        super().setUp()
        self.login()
        self.zabbix = MonitoringEngine.objects.create(
            tenant=self.tenant, name="db-zabbix", slug="zbx", kind="zabbix"
        )
        self.st_a = CheckState.objects.create(
            tenant=self.tenant, target_ip=self.ip_a, template=self.ping, kind="icmp",
            status="down", engine=self.outpost, last_latency_ms=3.0,
        )
        self.st_a2 = CheckState.objects.create(
            tenant=self.tenant, target_ip=self.ip_a, template=self.https, kind="tcp",
            status="up", last_latency_ms=9.0,
        )
        self.st_b = CheckState.objects.create(
            tenant=self.tenant, target_ip=self.ip_b, template=self.ping, kind="icmp",
            status="up", engine=self.zabbix, last_latency_ms=1.0,
        )
        self.tr(self.ip_a, self.ping, "down")

    def checks(self, **params):
        return self.get("/api/monitoring/checks/", **params)

    def test_rows_carry_site_device_prefix_and_dns(self):
        body = self.checks(ordering="ip")
        self.assertEqual(body["count"], 3)
        row = body["results"][0]
        self.assertEqual(row["target_ip"]["dns_name"], "asw1.lab")
        self.assertEqual(row["site"]["name"], "Aarhus")
        self.assertEqual(row["device"]["name"], "asw1")
        self.assertEqual(row["prefix"]["cidr"], "10.1.0.0/24")
        self.assertEqual(body["status_counts"], {"down": 1, "up": 2, "all": 3})

    def test_status_is_a_list_and_the_tab_shape_still_works(self):
        self.assertEqual(self.checks(status="down")["count"], 1)
        self.assertEqual(self.checks(status="down,up")["count"], 3)
        self.assertEqual(self.checks(status="all")["count"], 3)

    def test_target_dimensions(self):
        self.assertEqual(self.checks(site=str(self.site_b.id))["count"], 1)
        self.assertEqual(self.checks(region=str(self.north.id))["count"], 2)
        self.assertEqual(self.checks(device_type=str(self.dtype.id))["count"], 2)
        self.assertEqual(self.checks(role=str(self.role.id))["count"], 2)
        self.assertEqual(self.checks(vlan=str(self.vlan.id))["count"], 2)
        self.assertEqual(self.checks(port="443")["count"], 1)
        self.assertEqual(self.checks(search="asw1")["count"], 2)
        self.assertEqual(self.checks(kind="tcp")["count"], 1)
        self.assertEqual(self.checks(source="outpost")["count"], 1)
        self.assertEqual(self.checks(source="local,zabbix")["count"], 2)
        # A ping bound to Zabbix is run locally: it is a *local* row.
        self.assertEqual(self.checks(engine=str(self.zabbix.id), source="local")["count"], 1)

    def test_facets_leave_their_own_filter_out(self):
        body = self.checks(status="down")
        f = {d: {b["value"]: b["count"] for b in body["facets"][d]} for d in body["facets"]}
        self.assertEqual(f["status"], {"down": 1, "up": 2})
        self.assertEqual(f["kind"], {"icmp": 1})
        self.assertEqual(f["source"], {"outpost": 1})
        self.assertEqual(f["site"], {str(self.site_a.id): 1})

    def test_ordering_by_site_device_and_latency(self):
        by_site = [r["site"]["name"] for r in self.checks(ordering="-site")["results"]]
        self.assertEqual(by_site, ["Berlin", "Aarhus", "Aarhus"])
        by_dev = [r["device"]["name"] for r in self.checks(ordering="device")["results"]]
        self.assertEqual(by_dev, ["asw1", "asw1", "bsw1"])
        lat = [r["last_latency_ms"] for r in self.checks(ordering="-latency")["results"]]
        self.assertEqual(lat, [9.0, 3.0, 1.0])

    def test_strip_adds_segments_per_row(self):
        body = self.checks(strip=7, ordering="ip")
        self.assertIn("since", body)
        segs = {r["template"]["name"]: r["segments"] for r in body["results"][:2]}
        self.assertEqual(segs["Ping"][-1]["status"], "down")
        self.assertEqual(segs["HTTPS"][-1]["status"], "unknown")
        self.assertNotIn("segments", self.checks()["results"][0])

    def test_page_cap(self):
        self.assertEqual(self.checks(page_size=999)["page_size"], 200)

    def test_site_scoped_viewer_sees_only_their_site(self):
        viewer = User.objects.create_user("v2", password="x")
        UserProfile.objects.create(user=viewer, role="custom").tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="a-ip", object_types=["ipaddress"], actions=["view"]
        )
        perm.users.add(viewer)
        perm.tenants.add(self.tenant)
        perm.sites.add(self.site_a)
        self.login(viewer)
        body = self.checks()
        self.assertEqual(body["count"], 2)
        self.assertEqual(body["status_counts"]["all"], 2)
        self.assertEqual({b["value"] for b in body["facets"]["site"]}, {str(self.site_a.id)})
