"""PRTG Mode 2: sensors on the device and VM pages.

Channel mapping on the channels recorded from PRTG 26.3 (2091 SSL
certificate: lookups and limits; 2089 Ping v2; 1004 disk free: a percentage
with limits; 1005 network card: a scaled unit), the per-interval cache, the
history ranges and point cap, VM linking and its ambiguity, and the sensors
API with its tenant and site scoping.
"""
from __future__ import annotations

from datetime import UTC, datetime, timedelta
from unittest import mock

from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import SimpleTestCase
from rest_framework.test import APITestCase

from api.models import (
    Cluster,
    ClusterType,
    Device,
    IPAddress,
    Prefix,
    Site,
    VirtualMachine,
)
from auth_api.models import ObjectPermission, UserProfile
from core.models import DeploymentSettings, Organization, Tenant
from integrations.models import IntegrationSettings
from prtg import channels as ch
from prtg import status as st
from prtg.driver import answer
from prtg.models import PrtgChange, PrtgConnection, PrtgDeviceLink, PrtgSensor
from prtg.reader import read_status

from .fake_server import FakePrtg, load_fixture

MAP = st.clean_map({})


def _rows(objid):
    return ch.map_channels(load_fixture(f"table_channels_{objid}.json")["channels"], MAP)


def _by_name(rows, name):
    return next(r for r in rows if r["name"] == name)


class ChannelMappingTests(SimpleTestCase):
    def test_lookup_channel(self):
        row = _by_name(_rows(2091), "Root Authority Trusted")
        self.assertEqual(row["kind"], "lookup")
        self.assertEqual((row["value"], row["value_raw"], row["lookup_label"]), ("No", 1.0, "No"))
        self.assertEqual(
            [(s["value"], s["label"], s["state"]) for s in row["lookup_states"]],
            [(0.0, "Yes", "ok"), (1.0, "No", "warning")],
        )
        self.assertEqual(row["state"], "degraded")  # the channel is in Warning
        self.assertEqual(row["status"], "Warning")

    def test_range_lookup_names_the_current_band(self):
        row = _by_name(_rows(2091), "Public Key Length")
        self.assertEqual(row["kind"], "lookup")
        self.assertEqual(row["value_raw"], 2048.0)
        self.assertEqual(row["lookup_label"], "Good")
        good = next(s for s in row["lookup_states"] if s["label"] == "Good")
        self.assertEqual((good["value"], good["to"], good["state"]), (1025.0, 2048.0, "ok"))
        unsafe = next(s for s in row["lookup_states"] if s["label"] == "Unsafe")
        self.assertEqual(unsafe["state"], "error")

    def test_numeric_channel_with_limits(self):
        row = _by_name(_rows(2091), "Days to Expiration")
        self.assertEqual((row["kind"], row["value_raw"], row["unit"]), ("number", 781.0, "#"))
        self.assertEqual(row["limits"], {
            "warn_min": 28.0, "warn_max": None, "error_min": 7.0, "error_max": None,
        })
        self.assertTrue(row["primary"])
        self.assertLessEqual(row["min"], 0)
        self.assertGreaterEqual(row["max"], 781)

    def test_percent_channel(self):
        row = _by_name(_rows(1004), "Free Space C:")
        self.assertEqual((row["kind"], row["value_raw"], row["unit"]), ("percent", 81.0, "%"))
        self.assertEqual((row["min"], row["max"]), (0.0, 100.0))
        self.assertEqual((row["limits"]["warn_min"], row["limits"]["error_min"]), (25.0, 10.0))

    def test_no_limits_when_limits_are_off(self):
        row = _by_name(_rows(2089), "Response Time")
        self.assertEqual((row["kind"], row["unit"]), ("number", "msec"))
        self.assertEqual(set(row["limits"].values()), {None})

    def test_scaled_units_use_the_displayed_unit(self):
        row = _by_name(_rows(1005), "Traffic In")
        self.assertEqual((row["value_raw"], row["unit"]), (0.03, "Mbit/s"))
        self.assertEqual(_by_name(_rows(1005), "Traffic Out")["value_raw"], 0.01)

    def test_downtime_last_and_empty(self):
        rows = _rows(2089)
        self.assertEqual(rows[-1]["id"], "-4")
        self.assertEqual((rows[-1]["value"], rows[-1]["value_raw"], rows[-1]["kind"]),
                         ("", None, "percent"))

    def test_scaled(self):
        self.assertEqual(ch.scaled("0 msec", 0.06), 0.06)        # rounding only
        self.assertEqual(ch.scaled("0.03 Mbit/s", 214315), 0.03)  # another unit
        self.assertEqual(ch.scaled("No data", 3.0), 3.0)
        self.assertIsNone(ch.scaled("", None))

    def test_cap(self):
        self.assertEqual(len(ch._cap(list(range(1000)))), ch.MAX_POINTS)
        self.assertEqual(ch._cap([1, 2, 3]), [1, 2, 3])


class _Lab(APITestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.fake = FakePrtg().start()

    @classmethod
    def tearDownClass(cls):
        cls.fake.stop()
        super().tearDownClass()

    def setUp(self):
        cache.clear()
        self.fake.reset()
        ds = DeploymentSettings.load()
        ds.ssrf_allowlist = ["127.0.0.1/32"]
        ds.save()
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.other = Tenant.objects.create(org=org, name="U", slug="u")
        for t in (self.tenant, self.other):
            IntegrationSettings.objects.update_or_create(tenant=t, defaults={"prtg_enabled": True})
        self.site = Site.objects.create(tenant=self.tenant, name="Lab")
        self.site_b = Site.objects.create(tenant=self.tenant, name="Other")
        self.prefix = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/24")
        self.conn = PrtgConnection.objects.create(
            tenant=self.tenant, name="lab", url=self.fake.url,
            api_v2_url=self.fake.v2_url, credentials={"api_key": self.fake.api_key},
            version="26.3.124.1727", server_utc_offset_minutes=60,
        )
        ct = ClusterType.objects.create(tenant=self.tenant, name="PVE", slug="pve")
        self.cluster = Cluster.objects.create(tenant=self.tenant, name="C", type=ct)
        self.admin = get_user_model().objects.create_superuser("root", "r@x.io", "pw")

    def device(self, name, *addresses, site=None):
        d = Device.objects.create(tenant=self.tenant, name=name, site=site or self.site)
        for addr in addresses:
            IPAddress.objects.create(
                tenant=self.tenant, ip_address=f"{addr}/24", prefix=self.prefix,
                assigned_device=d,
            )
        return d

    def vm(self, name, address=None, *, primary_only=False, site=None):
        vm = VirtualMachine.objects.create(
            tenant=self.tenant, name=name, cluster=self.cluster, site=site or self.site,
        )
        if address:
            ip = IPAddress.objects.create(
                tenant=self.tenant, ip_address=f"{address}/24", prefix=self.prefix,
                assigned_vm=None if primary_only else vm,
            )
            vm.primary_ip = ip
            vm.save(update_fields=["primary_ip"])
        return vm

    def read(self):
        with mock.patch("prtg.client.PAGE_GAP_SECONDS", 0):
            return read_status(self.conn)

    def login(self, user=None):
        self.client.force_login(user or self.admin)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()


class StatusReadRecordTests(_Lab):
    def test_the_record_lands_on_the_row(self):
        self.device("db-dev01", "10.0.0.41")
        self.read()
        ssl = PrtgSensor.objects.get(objid="2091")
        self.assertEqual((ssl.last_value, ssl.last_value_raw, ssl.unit), ("781 #", 781.0, "#"))
        self.assertEqual((ssl.interval_seconds, ssl.priority), (60, 3))
        self.assertEqual(ssl.uptime_pct, 100.0)
        self.assertEqual((ssl.probe_name, ssl.group_path), ("Local Probe", "Local Probe"))
        self.assertIsNotNone(ssl.last_up_at)

    def test_a_read_keeps_the_channel_cache(self):
        self.device("db-dev01", "10.0.0.41")
        self.read()
        PrtgSensor.objects.filter(objid="2091").update(channels={"rows": [], "fetched_at": "x"})
        self.read()
        self.assertEqual(PrtgSensor.objects.get(objid="2091").channels["fetched_at"], "x")


class VmLinkingTests(_Lab):
    def test_an_assigned_address_links_the_vm(self):
        vm = self.vm("zabbix-vm", "10.0.0.53")
        counts = self.read()
        self.assertEqual(counts["linked"], 1)
        link = PrtgDeviceLink.objects.get(virtual_machine=vm)
        self.assertIsNone(link.device_id)
        self.assertEqual((link.objid, link.matched_by), ("2082", "address"))
        sensors = PrtgSensor.objects.filter(virtual_machine=vm)
        self.assertEqual(sensors.count(), 2)
        self.assertFalse(sensors.filter(device__isnull=False).exists())
        self.assertEqual(link.state, "up")

    def test_a_primary_address_links_the_vm(self):
        vm = self.vm("zabbix-vm", "10.0.0.53", primary_only=True)
        self.read()
        self.assertTrue(PrtgDeviceLink.objects.filter(virtual_machine=vm).exists())

    def test_a_vm_is_not_matched_by_name_alone(self):
        self.vm("db-zabbix")
        self.read()
        self.assertFalse(PrtgDeviceLink.objects.exists())

    def test_a_vm_and_a_device_on_one_address_is_ambiguous_for_both(self):
        host = self.device("host", "10.0.0.53")
        vm = self.vm("zabbix-vm")
        # The VM names the host's address as its primary - the usual way a
        # VM and its hypervisor end up on one address.
        vm.primary_ip = IPAddress.objects.get(assigned_device=host)
        vm.save(update_fields=["primary_ip"])
        self.read()
        self.assertFalse(PrtgDeviceLink.objects.exists())
        rows = PrtgChange.objects.filter(kind=PrtgChange.AMBIGUOUS)
        self.assertEqual(rows.count(), 2)
        vm_row = rows.get(virtual_machine=vm)
        self.assertIsNone(vm_row.device_id)
        self.assertIn("VM zabbix-vm", vm_row.detail["reason"])

    def test_review_mode_proposes_and_apply_links_the_vm(self):
        self.conn.link_mode = PrtgConnection.LINK_REVIEW
        self.conn.save()
        vm = self.vm("zabbix-vm", "10.0.0.53")
        self.read()
        change = PrtgChange.objects.get(kind=PrtgChange.LINK)
        self.assertEqual(change.virtual_machine_id, vm.id)
        self.login()
        resp = self.client.post(f"/api/prtg/changes/{change.id}/apply/")
        self.assertEqual(resp.status_code, 200, resp.content)
        self.assertTrue(PrtgDeviceLink.objects.filter(virtual_machine=vm, objid="2082").exists())

    def test_the_check_answers_for_a_vm_address(self):
        from monitoring.models import CheckState, CheckTemplate, MonitoringEngine

        vm = self.vm("zabbix-vm", "10.0.0.53")
        self.read()
        self.conn.last_status_at = datetime.now(UTC)
        self.conn.save()
        engine = MonitoringEngine.objects.create(tenant=self.tenant, name="P", kind="prtg")
        tpl = CheckTemplate.objects.create(
            tenant=self.tenant, name="PRTG", slug="prtg", kind="prtg", interval_seconds=120,
        )
        state = CheckState.objects.create(
            tenant=self.tenant, engine=engine, kind="prtg", template=tpl,
            target_ip=vm.primary_ip,
        )
        out, fresh = answer(self.conn, [CheckState.objects.select_related(
            "target_ip", "template").get(pk=state.pk)])
        self.assertTrue(fresh)
        self.assertEqual(out[str(state.id)].status, "up")

    def test_vm_states_and_device_status(self):
        vm = self.vm("zabbix-vm", "10.0.0.53")
        self.read()
        self.login()
        states = self.client.get("/api/prtg/vm-states/").json()
        self.assertEqual(states[str(vm.id)]["state"], "up")
        rows = self.client.get(f"/api/prtg/device-status/?virtual_machine={vm.id}").json()
        self.assertEqual(rows[0]["device"]["objid"], "2082")


class ChannelReadTests(_Lab):
    def setUp(self):
        super().setUp()
        self.dev = self.device("db-dev01", "10.0.0.41")
        self.read()
        self.ssl = PrtgSensor.objects.get(objid="2091")
        self.ping = PrtgSensor.objects.get(objid="2089")
        self.login()

    def _channel_calls(self):
        return [r for r in self.fake.calls("/api/table.json")
                if r["params"].get("content") == "channels"]

    def test_endpoint_maps_and_caches_per_interval(self):
        resp = self.client.get(f"/api/prtg/sensors/{self.ssl.id}/channels/")
        self.assertEqual(resp.status_code, 200, resp.content)
        body = resp.json()
        self.assertEqual(_by_name(body["rows"], "Revoked")["lookup_label"],
                         "Unable to check revocation status")
        self.assertIn("Root Authority Trusted", body["summary"]["message"])
        self.assertEqual(len(self._channel_calls()), 1)
        self.assertEqual(len(self.fake.calls("/api/getsensordetails.json")), 1)
        # A second look inside the interval asks PRTG nothing.
        self.client.get(f"/api/prtg/sensors/{self.ssl.id}/channels/")
        self.assertEqual(len(self._channel_calls()), 1)
        self.assertEqual(len(self.fake.calls("/api/getsensordetails.json")), 1)

    def test_a_new_interval_reads_again(self):
        ch.read_channels(self.ssl)
        later = datetime.now(UTC) + timedelta(seconds=self.conn.cache_seconds + 1)
        ch.read_channels(PrtgSensor.objects.get(pk=self.ssl.pk), now=later)
        self.assertEqual(len(self._channel_calls()), 2)

    def test_a_failed_read_serves_the_cache_marked_stale(self):
        ch.read_channels(self.ssl)
        self.fake.fail = (500, "boom")
        later = datetime.now(UTC) + timedelta(hours=1)
        out = ch.read_channels(PrtgSensor.objects.get(pk=self.ssl.pk), now=later)
        self.assertTrue(out["stale"])
        self.assertTrue(out["rows"])

    def test_a_failed_first_read_is_502(self):
        self.fake.fail = (500, "boom")
        resp = self.client.get(f"/api/prtg/sensors/{self.ssl.id}/channels/")
        self.assertEqual(resp.status_code, 502)

    def test_history_window_points_and_cache(self):
        now = datetime(2026, 10, 26, 8, 5, 30, tzinfo=UTC)
        self.ping.interval_seconds = 30
        out = ch.read_history(self.ping, "1h", now=now)
        self.assertEqual(out["avg"], 60)
        call = self.fake.calls("/api/historicdata.xml")[0]["params"]
        # The window is asked for in the server's local time (UTC+1), padded
        # by one average.
        self.assertEqual((call["sdate"], call["edate"], call["avg"]),
                         ("2026-10-26-08-04-30", "2026-10-26-09-06-30", "60"))
        rt = out["series"]["0"]
        self.assertEqual((rt["name"], rt["unit"]), ("Response Time", "msec"))
        self.assertTrue(0 < len(rt["points"]) <= 61)
        for p in rt["points"]:
            at = datetime.fromisoformat(p["t"])
            self.assertTrue(now - timedelta(hours=1, minutes=1) <= at <= now)
        ch.read_history(PrtgSensor.objects.get(pk=self.ping.pk), "1h", now=now)
        self.assertEqual(len(self.fake.calls("/api/historicdata.xml")), 1)

    def test_ssl_history_matches_channels_by_id_in_their_own_unit(self):
        """The SSL sensor's recorded history: Days to Expiration is channel 2
        in both the channels table and the history, in "#", with a value on
        every interval PRTG measured; the lookup channels come back as the
        share of time in one named state, in "%"."""
        now = datetime(2026, 10, 26, 8, 6, tzinfo=UTC)
        self.ssl.interval_seconds = 300
        out = ch.read_history(self.ssl, "1h", now=now)
        rows = {r["id"]: r for r in ch.read_channels(self.ssl)["rows"]}
        days = out["series"]["2"]
        self.assertEqual(rows["2"]["name"], "Days to Expiration")
        self.assertEqual((days["name"], days["unit"]), ("Days to Expiration", "#"))
        values = [p["v"] for p in days["points"] if p["v"] is not None]
        self.assertGreaterEqual(len(values), 2)
        self.assertEqual(set(values), {781.0})
        self.assertEqual(rows["2"]["unit"], "#")
        trusted = out["series"]["3"]
        self.assertEqual(trusted["name"], "Root Authority Trusted (Yes)")
        self.assertEqual(trusted["unit"], "%")
        self.assertEqual(rows["3"]["kind"], "lookup")
        self.assertEqual(
            {p["v"] for p in trusted["points"] if p["v"] is not None}, {0.0})

    def test_history_ranges_pick_their_average(self):
        for rng, avg in (("24h", 900), ("7d", 3600)):
            with self.subTest(rng=rng):
                out = ch.read_history(self.ping, rng)
                self.assertEqual(out["avg"], avg)
        with self.assertRaises(ValueError):
            ch.read_history(self.ping, "1y")

    def test_history_point_cap(self):
        with mock.patch.object(ch, "MAX_POINTS", 10):
            out = ch.read_history(self.ping, "1h", now=datetime(2026, 10, 26, 8, 5, tzinfo=UTC))
        self.assertEqual(len(out["series"]["0"]["points"]), 10)

    def test_history_endpoint_filters_a_channel(self):
        resp = self.client.get(f"/api/prtg/sensors/{self.ping.id}/history/?range=7d&channel=4")
        self.assertEqual(resp.status_code, 200, resp.content)
        body = resp.json()
        self.assertEqual([c["id"] for c in body["channels"]], ["4"])
        self.assertEqual(self.client.get(
            f"/api/prtg/sensors/{self.ping.id}/history/?range=2y").status_code, 400)

    def test_unknown_offset_is_learned_from_the_clock(self):
        self.conn.server_utc_offset_minutes = None
        self.conn.save()
        clock = (datetime.now(UTC) + timedelta(hours=2)).strftime("%m/%d/%Y %I:%M:%S %p")
        self.fake.status["Clock"] = clock
        ch.read_history(PrtgSensor.objects.get(pk=self.ping.pk), "1h")
        self.conn.refresh_from_db()
        self.assertEqual(self.conn.server_utc_offset_minutes, 120)


class SensorApiTests(_Lab):
    def setUp(self):
        super().setUp()
        self.dev = self.device("db-dev01", "10.0.0.41")
        self.zbx = self.device("db-zabbix", "10.0.0.53", site=self.site_b)
        self.fake.set_status(2092, st.DOWN, "Destination unreachable")
        self.fake.set_status(2100, st.PAUSED_USER)
        self.read()
        # Another tenant's sensor on another connection.
        other_site = Site.objects.create(tenant=self.other, name="X")
        other_dev = Device.objects.create(tenant=self.other, name="x", site=other_site)
        other_conn = PrtgConnection.objects.create(
            tenant=self.other, name="o", url="https://p.example.com", credentials={"api_key": "k"},
        )
        link = PrtgDeviceLink.objects.create(
            tenant=self.other, connection=other_conn, device=other_dev, objid="9", name="x",
        )
        self.foreign = PrtgSensor.objects.create(
            tenant=self.other, connection=other_conn, link=link, device=other_dev,
            objid="99", name="Foreign", state="down", status_raw=5,
        )

    def _list(self, query=""):
        resp = self.client.get(f"/api/prtg/sensors/?page_size=500{query}")
        self.assertEqual(resp.status_code, 200, resp.content)
        body = resp.json()
        return body.get("results", body) if isinstance(body, dict) else body

    def test_list_is_tenant_scoped(self):
        self.login()
        names = {r["objid"] for r in self._list()}
        self.assertEqual(len(names), 7)
        self.assertNotIn("99", names)
        self.assertEqual(
            self.client.get(f"/api/prtg/sensors/{self.foreign.id}/").status_code, 404)
        self.assertEqual(
            self.client.get(f"/api/prtg/sensors/{self.foreign.id}/channels/").status_code, 404)

    def test_filters(self):
        self.login()
        alarms = self._list("&alarms=1&ordering=alarms")
        self.assertEqual([r["objid"] for r in alarms], ["2092", "2091"])
        self.assertEqual(alarms[0]["message"], "Destination unreachable")
        self.assertEqual(len(self._list("&hide_paused=1")), 6)
        self.assertEqual([r["objid"] for r in self._list("&state=paused")], ["2100"])
        self.assertEqual(len(self._list(f"&device={self.zbx.id}")), 2)
        self.assertEqual(len(self._list("&kind=Ping v2")), 2)
        self.assertEqual(len(self._list("&probe=Local Probe")), 7)
        self.assertEqual({r["objid"] for r in self._list("&search=unreachable")}, {"2092"})
        row = next(r for r in self._list() if r["objid"] == "2091")
        self.assertEqual(row["device"]["name"], "db-dev01")
        self.assertTrue(row["url"].endswith("/sensor.htm?id=2091"))

    def test_summary_counts(self):
        self.login()
        body = self.client.get("/api/prtg/sensors/summary/").json()
        self.assertEqual(
            {k: body[k] for k in ("total", "down", "degraded", "up", "unknown", "paused")},
            {"total": 7, "down": 1, "degraded": 1, "up": 4, "unknown": 0, "paused": 1},
        )
        one = self.client.get(f"/api/prtg/sensors/summary/?device={self.dev.id}").json()
        self.assertEqual(one["total"], 5)

    def test_off_integration_is_404(self):
        self.login()
        IntegrationSettings.objects.filter(tenant=self.tenant).update(prtg_enabled=False)
        self.assertEqual(self.client.get("/api/prtg/sensors/").status_code, 404)

    def _user(self, types, sites=None):
        user = get_user_model().objects.create_user("site", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(name="g", object_types=types, actions=["view"])
        perm.tenants.set([self.tenant])
        if sites:
            perm.sites.set(sites)
        perm.users.set([user])
        return user

    def test_a_site_scoped_user_sees_only_their_sites(self):
        self.login(self._user(["prtgsensor", "device"], sites=[self.site_b]))
        self.assertEqual({r["objid"] for r in self._list()}, {"2092", "2100"})
        body = self.client.get("/api/prtg/sensors/summary/").json()
        self.assertEqual((body["total"], body["down"]), (2, 1))
        ssl = PrtgSensor.objects.get(objid="2091")
        self.assertEqual(self.client.get(f"/api/prtg/sensors/{ssl.id}/").status_code, 404)

    def test_channels_need_view_on_the_device(self):
        self.login(self._user(["prtgsensor"]))
        ssl = PrtgSensor.objects.get(objid="2091")
        self.assertEqual(self.client.get(f"/api/prtg/sensors/{ssl.id}/").status_code, 200)
        self.assertEqual(
            self.client.get(f"/api/prtg/sensors/{ssl.id}/channels/").status_code, 404)
        self.assertEqual(
            self.client.get(f"/api/prtg/sensors/{ssl.id}/history/").status_code, 404)
        self.assertFalse([r for r in self.fake.requests if r["params"].get("content") == "channels"])
