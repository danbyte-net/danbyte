"""The PRTG client against the fake server, over real HTTP."""
from __future__ import annotations

import tempfile
from datetime import UTC, datetime
from pathlib import Path
from unittest import mock

from django.test import SimpleTestCase, TestCase

from core.models import DeploymentSettings
from prtg import client as client_mod
from prtg import status as st
from prtg.client import (
    PrtgClient,
    PrtgError,
    PrtgUnauthorized,
    PrtgUnreachable,
    loads_lenient,
    ole_to_datetime,
    parse_percent,
    parse_value,
    unquote_raw,
)

from .fake_server import FakePrtg, load_fixture, record_fixture, scrub, sensor_row


class StatusMapTests(SimpleTestCase):
    def test_every_code_has_a_label(self):
        for code in range(15):
            with self.subTest(code=code):
                self.assertIn(code, st.LABELS)
        self.assertEqual(st.label(11), "Not Licensed")
        self.assertEqual(st.label(99), "Status 99")
        self.assertEqual(st.label("x"), "Unknown")

    def test_default_states(self):
        self.assertEqual(st.default_state(3), "up")
        self.assertEqual(st.default_state(4), "degraded")
        self.assertEqual(st.default_state(10), "degraded")
        self.assertEqual(st.default_state(5), "down")
        self.assertEqual(st.default_state(13), "down")
        self.assertEqual(st.default_state(14), "degraded")
        self.assertEqual(st.default_state("5"), "down")

    def test_unmeasured_paused_and_unlicensed_are_never_down(self):
        for code in (0, 1, 2, 6, 7, 8, 9, 11, 12, 42, None):
            with self.subTest(code=code):
                self.assertEqual(st.default_state(code), "unknown")
        self.assertEqual(st.UNKNOWN_REASON[st.NOT_LICENSED], "PRTG licence limit")
        self.assertTrue(st.PAUSED.isdisjoint(st.MAPPABLE))


class ParsingTests(SimpleTestCase):
    def test_values_and_units(self):
        self.assertEqual(parse_value("12 %"), (12.0, "%"))
        self.assertEqual(parse_value("1,234.5 kbit/s"), (1234.5, "kbit/s"))
        self.assertEqual(parse_value("9,5 %"), (9.5, "%"))
        self.assertEqual(parse_value("1 msec"), (1.0, "msec"))
        self.assertEqual(parse_value("< 1 %"), (1.0, "%"))
        self.assertEqual(parse_value("-3 °C"), (-3.0, "°C"))
        self.assertEqual(parse_value("No data"), (None, ""))
        self.assertEqual(parse_value(""), (None, ""))

    def test_percent_falls_back_to_raw_ten_thousandths(self):
        self.assertEqual(parse_percent("99.9871%"), 99.9871)
        self.assertEqual(parse_percent("", 999871), 99.9871)
        self.assertIsNone(parse_percent("", ""))

    def test_ole_dates(self):
        self.assertEqual(
            ole_to_datetime(46320.42636574074),
            datetime(2026, 10, 25, 10, 13, 58, tzinfo=UTC),
        )
        self.assertEqual(
            ole_to_datetime('"46315.125"'), datetime(2026, 10, 20, 3, tzinfo=UTC)
        )
        for never in ("", 0, "0", None, "soon", -1):
            self.assertIsNone(ole_to_datetime(never))

    def test_quoted_raw_strings(self):
        self.assertEqual(unquote_raw('"OK"'), "OK")
        self.assertEqual(unquote_raw("OK"), "OK")
        self.assertEqual(unquote_raw(3), 3)

    def test_lenient_json(self):
        self.assertEqual(loads_lenient('{"a": "C:\\ Free \\x"}'), {"a": "C:\\ Free \\x"})
        # An escaped backslash before a letter stays one backslash.
        self.assertEqual(loads_lenient('{"a": "x\\\\y \\q"}'), {"a": "x\\y \\q"})
        self.assertEqual(loads_lenient('{"a": "tab\there"}'), {"a": "tab\there"})


class _Live(TestCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.fake = FakePrtg().start()

    @classmethod
    def tearDownClass(cls):
        cls.fake.stop()
        super().tearDownClass()

    def setUp(self):
        self.fake.reset()
        ds = DeploymentSettings.load()
        ds.ssrf_allowlist = ["127.0.0.1/32"]
        ds.save()

    def client_for(self, **kw) -> PrtgClient:
        kw.setdefault("page_gap", 0)
        return PrtgClient(
            self.fake.url, kw.pop("api_key", self.fake.api_key),
            v2_url=self.fake.v2_url, **kw,
        )


class AuthTests(_Live):
    def test_the_classic_key_goes_in_apitoken_and_no_header(self):
        # PRTG 26.3 answers a Bearer header on the classic API with 401
        # "Unsupported authorization scheme."
        self.assertEqual(self.client_for().version(), "26.3.124.1727")
        call = self.fake.calls("/api/getstatus.htm")[-1]
        self.assertEqual(call["auth"], "query")
        self.assertEqual(call["params"]["apitoken"], self.fake.api_key)

    def test_v2_takes_a_bearer_header_and_no_apitoken(self):
        self.client_for().probe_v2()
        call = [r for r in self.fake.requests if r["path"].startswith("/api/v2/")][-1]
        self.assertEqual(call["auth"], "bearer")
        self.assertNotIn("apitoken", call["params"])

    def test_errors_never_carry_the_key(self):
        client = PrtgClient("http://127.0.0.1:1", "s3cret-key", timeout=2)
        with self.assertRaises(PrtgUnreachable) as ctx:
            client.version()
        self.assertNotIn("s3cret-key", str(ctx.exception))
        self.assertIsNone(ctx.exception.__cause__)
        self.assertEqual(
            client.redact("GET /api/x?id=1&apitoken=other&b=2"),
            "GET /api/x?id=1&apitoken=REDACTED&b=2",
        )

    def test_a_wrong_key_is_unauthorized(self):
        with self.assertRaises(PrtgUnauthorized) as ctx:
            self.client_for(api_key="nope").version()
        self.assertIn("Unauthorized", str(ctx.exception))

    def test_every_call_goes_through_the_guard(self):
        with mock.patch.object(
            client_mod, "safe_request", wraps=client_mod.safe_request
        ) as guarded:
            self.client_for().sensors()
        self.assertTrue(guarded.called)

    def test_the_guard_refuses_a_private_address(self):
        ds = DeploymentSettings.load()
        ds.ssrf_allowlist = []
        ds.save()
        before = len(self.fake.requests)
        with self.assertRaises(PrtgUnreachable):
            self.client_for().version()
        self.assertEqual(len(self.fake.requests), before)

    def test_unreachable(self):
        with self.assertRaises(PrtgUnreachable):
            PrtgClient("http://127.0.0.1:1", "k", timeout=2).version()


class ReadTests(_Live):
    def test_sensors_are_normalised(self):
        table = self.client_for().sensors()
        self.assertEqual(table.version, "26.3.124.1727")
        # Recorded from the PRTG 26.3 lab: 17 sensors on the local probe.
        self.assertEqual(table.total, 17)
        self.assertEqual(table.skipped, 0)
        rows = {r["objid"]: r for r in table.rows}
        ping = rows[2089]
        # A v2 sensor kind, and its tags comma-separated.
        self.assertEqual(ping["kind"], "paessler.icmp.ping_sensor.48")
        self.assertEqual(ping["type"], "Ping v2")
        self.assertEqual(ping["status_raw"], st.UP)
        self.assertEqual(ping["message"], "OK")
        self.assertEqual(ping["last_value"], "0 msec")
        self.assertEqual((ping["last_value_raw"], ping["unit"]), (0.0, "msec"))
        self.assertEqual(ping["tags"], ["icmp", "ping", "pingsensor"])
        self.assertEqual(
            ping["last_check_at"], ole_to_datetime(self.fake.sensor(2089)["lastcheck_raw"]))
        self.assertEqual(ping["uptime_pct"], 100.0)
        self.assertEqual(ping["parent_id"], 2081)
        self.assertEqual(ping["interval_seconds"], 30)
        self.assertTrue(ping["active"])

        cert = rows[2091]
        self.assertEqual(cert["status_raw"], st.WARNING)
        self.assertTrue(cert["message"].startswith(
            "Warning caused by lookup value 'No' in channel 'Root Authority Trusted'"))
        self.assertEqual((cert["last_value_raw"], cert["unit"]), (781.0, "#"))
        self.assertIsNone(cert["last_down_at"])
        # The raw value is in the base unit, not the display one.
        nic = rows[1005]
        self.assertEqual((nic["last_value"], nic["unit"]), ("0.04 Mbit/s", "Mbit/s"))
        self.assertEqual(nic["last_value_raw"], 5048.4414)
        self.assertEqual(rows[2100]["uptime_pct"], 82.2506)
        self.assertEqual(rows[2096]["tags"], ["icmp", "ping", "pingsensor"])

    def test_quoted_raw_and_unrecorded_states(self):
        row = sensor_row(9001, status=st.NOT_LICENSED, value="No data")
        row["message_raw"] = '"Connection refused (code: PE104)"'
        row["active_raw"] = 0
        row["lastvalue_raw"] = ""
        self.fake.tables["sensors"] = [row]
        read = self.client_for().sensors().rows[0]
        self.assertEqual(read["message"], "Connection refused (code: PE104)")
        self.assertIsNone(read["last_value_raw"])
        self.assertFalse(read["active"])
        self.assertEqual(read["status_raw"], st.NOT_LICENSED)
        self.assertEqual(st.default_state(read["status_raw"]), "unknown")

    def test_only_the_requested_columns_are_asked_for(self):
        self.client_for().sensors()
        params = self.fake.calls("/api/table.json")[-1]["params"]
        self.assertEqual(params["content"], "sensors")
        self.assertIn("lastvalue", params["columns"].split(","))
        self.assertEqual(params["count"], "5000")

    def test_paging_reads_until_a_short_page(self):
        self.fake.tables["sensors"] = [sensor_row(5000 + i) for i in range(12)]
        table = self.client_for(page_size=5).sensors()
        self.assertEqual(len(table.rows), 12)
        self.assertEqual(table.pages, 3)
        starts = [c["params"]["start"] for c in self.fake.calls("/api/table.json")]
        self.assertEqual(starts, ["0", "5", "10"])

    def test_paging_stops_at_the_tree_size_on_an_exact_multiple(self):
        self.fake.tables["sensors"] = [sensor_row(6000 + i) for i in range(10)]
        table = self.client_for(page_size=5).sensors()
        self.assertEqual(len(table.rows), 10)
        self.assertEqual(table.pages, 2)

    def test_filters_are_passed_as_filter_params(self):
        self.fake.set_status(2093, st.DOWN)
        self.fake.set_status(2094, st.DOWN_PARTIAL)
        table = self.client_for().sensors(filters={"status": [5, 14]})
        self.assertEqual([r["objid"] for r in table.rows], [2093, 2094])
        table = self.client_for().sensors(filters={"tags": "@tag(pingsensor)"})
        self.assertEqual([r["objid"] for r in table.rows], [2089, 2092, 2096])
        table = self.client_for().sensors(filters={"parentid": 2082})
        self.assertEqual([r["objid"] for r in table.rows], [2092, 2100])

    def test_quirky_json_skips_only_the_bad_row(self):
        self.fake.raw_tables["sensors"] = load_fixture("table_sensors_quirks.txt", raw=True)
        table = self.client_for().sensors()
        self.assertEqual(table.skipped, 1)
        self.assertEqual([r["objid"] for r in table.rows], [3101, 3103])
        disk = table.rows[0]
        self.assertEqual(disk["name"], "Disk C:\\ Free")
        self.assertEqual(disk["message"], "Free space below 10 & falling \\x")
        self.assertEqual(disk["unit"], "%")
        self.assertEqual(disk["last_value_raw"], 9.5)
        self.assertEqual(disk["last_check_at"].date().isoformat(), "2026-10-25")
        self.assertEqual(table.rows[1]["name"], "WMI CPU\tLoad")

    def test_devices_and_counts(self):
        client = self.client_for()
        self.assertEqual(
            [d["name"] for d in client.devices().rows],
            ["Probe Device", "Internet", "PRTG Core Server", "sw-01", "db-dev01",
             "db-zabbix", "gw 10.0.0.0"],
        )
        self.assertEqual(client.count("sensors"), 17)
        # Unfiltered, probenode lists more than probes (here the autonomous
        # core device); the type filter narrows it to the probes.
        self.assertEqual(client.count("probenode"), 2)
        self.assertEqual(client.count("probenode", {"type": "probenode"}), 1)
        self.assertEqual(self.fake.calls("/api/table.json")[-1]["params"]["count"], "1")

    def test_sensor_details(self):
        details = self.client_for().sensor_details(2091)
        self.assertEqual(details["status_raw"], st.WARNING)
        # Entities escaped twice in the recording come out as plain text.
        self.assertTrue(details["lastmessage"].startswith(
            "Warning caused by lookup value 'No' in channel"))
        self.assertEqual(details["parentdevicename"], "db-dev01")
        with self.assertRaises(PrtgError):
            self.client_for().sensor_details(1)

    def test_a_400_keeps_prtgs_sentence(self):
        with self.assertRaises(PrtgError) as ctx:
            self.client_for().table("nonsense", ("objid",))
        self.assertIn("The content type nonsense is not supported.", str(ctx.exception))

    def test_html_where_json_was_expected(self):
        self.fake.fail = (200, "<html><body>Welcome to PRTG</body></html>")
        with self.assertRaises(PrtgError) as ctx:
            self.client_for().status()
        self.assertIn("did not return PRTG JSON", str(ctx.exception))

    def test_a_server_error(self):
        self.fake.fail = (500, '<div class="errormsg">Internal error</div>')
        with self.assertRaises(PrtgError) as ctx:
            self.client_for().version()
        self.assertEqual(str(ctx.exception), "HTTP 500: Internal error")


class WriteTests(_Live):
    def test_acknowledge_a_down_sensor(self):
        self.fake.set_status(2093, st.DOWN)
        self.client_for().acknowledge(2093, "[Danbyte] on it")
        row = self.fake.sensor(2093)
        self.assertEqual(row["status_raw"], st.DOWN_ACKNOWLEDGED)
        self.assertEqual(row["message_raw"], "[Danbyte] on it")

    def test_acknowledging_an_up_sensor_reports_prtgs_refusal(self):
        with self.assertRaises(PrtgError) as ctx:
            self.client_for().acknowledge(2089, "x")
        self.assertIn("cannot be acknowledged", str(ctx.exception))

    def test_pause_resume_and_pause_for(self):
        client = self.client_for()
        client.pause(2089, "maintenance")
        self.assertEqual(self.fake.sensor(2089)["status_raw"], st.PAUSED_USER)
        self.assertEqual(self.fake.writes[-1][1]["action"], "0")
        client.resume(2089)
        self.assertEqual(self.fake.sensor(2089)["status_raw"], st.UP)
        client.pause(2089, "an hour", minutes=60)
        self.assertEqual(self.fake.writes[-1][0], "pauseobjectfor.htm")
        self.assertEqual(self.fake.writes[-1][1]["duration"], "60")
        self.assertEqual(self.fake.sensor(2089)["status_raw"], st.PAUSED_UNTIL)

    def test_properties_round_trip(self):
        client = self.client_for()
        client.set_property(2100, "tags", "danbyte danbyte-abc")
        self.assertEqual(client.get_property(2100, "tags"), "danbyte danbyte-abc")
        with self.assertRaises(PrtgError):
            client.get_property(2100, "nonexistent")

    def test_delete_and_scan_now(self):
        client = self.client_for()
        client.scan_now(2093)
        self.assertEqual(self.fake.writes[-1][0], "scannow.htm")
        client.delete(2093)
        self.assertEqual(self.fake.writes[-1][1]["approve"], "1")
        self.assertIsNone(self.fake.sensor(2093))

    def test_an_unknown_object_is_refused(self):
        with self.assertRaises(PrtgError):
            self.client_for().pause(99999)


class ApiV2ProbeTests(_Live):
    def test_v2_answers(self):
        self.assertEqual(self.client_for().probe_v2(), (True, "API v2 answers."))
        call = self.fake.requests[-1]
        self.assertEqual(call["path"], "/api/v2/experimental/sensors")
        self.assertEqual(call["auth"], "bearer")

    def test_v2_missing(self):
        self.fake.v2 = False
        available, detail = self.client_for().probe_v2()
        self.assertFalse(available)
        self.assertIn("404", detail)

    def test_v2_refuses_the_key(self):
        available, detail = self.client_for(api_key="nope").probe_v2()
        self.assertTrue(available)
        self.assertIn("refused", detail)

    def test_v2_unreachable(self):
        client = PrtgClient(self.fake.url, "k", v2_url="http://127.0.0.1:1/api/v2", timeout=2)
        available, detail = client.probe_v2()
        self.assertFalse(available)
        self.assertIn("did not answer", detail)


class RecordingTests(_Live):
    def test_record_fixture_strips_secrets(self):
        self.fake.status = {**self.fake.status, "Note": f"key {self.fake.api_key}",
                            "passhash": "12345"}
        with tempfile.TemporaryDirectory() as tmp:
            path = record_fixture(
                self.client_for(), "/api/getstatus.htm", {"id": 0}, "status.json",
                directory=Path(tmp),
            )
            text = path.read_text()
        self.assertNotIn(self.fake.api_key, text)
        self.assertNotIn("12345", text)
        self.assertIn("26.3.124.1727", text)

    def test_scrub(self):
        self.assertEqual(
            scrub("x?apitoken=abc&id=1 <password>p</password>"),
            "x?apitoken=REDACTED&id=1 <password>REDACTED</password>",
        )
        self.assertEqual(
            scrub('{"snmpcommunity": "public", "name": "a"}'),
            '{"snmpcommunity": "REDACTED", "name": "a"}',
        )
