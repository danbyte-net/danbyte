"""The nmap engine (#451 B4): the argument builder has no injection path,
the XML reader refuses entities and reads only what was asked, the runner
refuses root and kills on timeout, and the card and the run gate it."""
from __future__ import annotations

import os
import stat
import tempfile
import time
from pathlib import Path
from unittest import mock

from django.test import SimpleTestCase, override_settings

from danbyte_checks import nmap as nm

from . import nmap as engine
from . import runner
from .models import DiscoverySettings, InventoryProfile, ObservedService
from .tests_discovery import ApiBase

DATA = Path(__file__).resolve().parent / "testdata"
BIN = "/usr/bin/nmap"
HOSTILE = [
    "--script=vulners", "-oN /etc/passwd", "127.0.0.1 -iL /etc/shadow", "; rm -rf /",
    "$(id)", "`id`", "localhost", "db-01.example.com", "10.0.0.1/24", "10.0.0.1 10.0.0.2",
    "-sS", "", " ", "0x7f000001", "::ffff:127.0.0.1\n-O", "10.0.0.1\x00-A",
]


class ArgvTests(SimpleTestCase):
    def test_the_fixed_list(self):
        argv = nm.build_argv(BIN, ["10.0.0.1", "2001:db8::1"], [22, 80, 81, 82, 443],
                             intensity=2, timing=3, max_rate=20, host_timeout=300,
                             max_hostgroup=4)
        self.assertEqual(argv, [
            BIN, "-sT", "-sV", "--version-intensity", "2", "--unprivileged", "-Pn", "-n",
            "-p", "22,80-82,443", "-T3", "--max-rate", "20", "--max-retries", "1",
            "--host-timeout", "300s", "--max-hostgroup", "4", "-oX", "-",
            "10.0.0.1", "2001:db8::1"])
        for banned in ("--script", "-sC", "-O", "-sS", "-A", "-sU", "--privileged"):
            self.assertNotIn(banned, argv)

    def test_hostile_targets_never_reach_argv(self):
        for bad in HOSTILE:
            with self.subTest(bad), self.assertRaises(nm.NmapError):
                nm.build_argv(BIN, [bad], [22])
        # A valid literal is written in its canonical form, nothing else.
        argv = nm.build_argv(BIN, [" 10.000.0.1 ".replace("000", "0")], [22])
        self.assertEqual(argv[-1], "10.0.0.1")

    def test_hostile_numbers_never_reach_argv(self):
        bad = [
            {"intensity": 9}, {"intensity": -1}, {"intensity": "2 --script=x"},
            {"intensity": True}, {"timing": 5}, {"timing": 0}, {"timing": "3"},
            {"max_rate": 0}, {"max_rate": 10**6}, {"host_timeout": 1},
            {"max_hostgroup": 99},
        ]
        for kw in bad:
            with self.subTest(kw), self.assertRaises(nm.NmapError):
                nm.build_argv(BIN, ["10.0.0.1"], [22], **kw)
        for ports in ([0], [70000], ["22"], ["1-100"], [], [True], list(range(1, 1100))):
            with self.subTest(ports=ports[:3]), self.assertRaises(nm.NmapError):
                nm.build_argv(BIN, ["10.0.0.1"], ports)
        with self.assertRaises(nm.NmapError):
            nm.build_argv("nmap", ["10.0.0.1"], [22])  # relative path

    def test_every_value_is_a_known_token(self):
        argv = nm.build_argv(BIN, ["10.0.0.1"], [22], intensity=5, timing=4)
        allowed_flags = {"-sT", "-sV", "--version-intensity", "--unprivileged", "-Pn", "-n",
                         "-p", "-T4", "--max-rate", "--max-retries", "--host-timeout",
                         "--max-hostgroup", "-oX", "-"}
        for tok in argv[1:-1]:
            self.assertTrue(tok in allowed_flags or tok.rstrip("s").replace(",", "")
                            .replace("-", "").isdigit(), tok)


class XmlTests(SimpleTestCase):
    def test_recorded_localhost_run(self):
        """Real nmap 7.98 output, recorded against two test sockets on
        127.0.0.1 with the argument list above."""
        raw = (DATA / "nmap-7.98-localhost.xml").read_bytes()
        [host] = nm.parse_xml(raw, ["127.0.0.1"])
        by = {p.port: p for p in host.open}
        ssh, web = by[55991], by[40605]
        self.assertEqual((ssh.service, ssh.product, ssh.source), ("ssh", "OpenSSH", "nmap"))
        self.assertTrue(ssh.version.startswith("9.6p1"))
        self.assertEqual(ssh.cpe, "cpe:2.3:a:openbsd:openssh:9.6p1:*:*:*:*:*:*:*")
        self.assertEqual(ssh.confidence, "high")
        self.assertEqual((web.product, web.version), ("nginx", "1.24.0"))
        self.assertEqual(web.cpe, "cpe:2.3:a:igor_sysoev:nginx:1.24.0:*:*:*:*:*:*:*")

    def test_only_asked_addresses_and_open_ports(self):
        raw = (DATA / "nmap-two-hosts.xml").read_bytes()
        hosts = nm.parse_xml(raw, ["192.0.2.10", "2001:db8::5", "192.0.2.11"])
        a, b, missing = hosts
        self.assertEqual(sorted(p.port for p in a.open), [22, 443])
        self.assertEqual(next(p for p in a.open if p.port == 443).confidence, "low")
        self.assertEqual([p.product for p in b.open], ["Apache httpd"])
        self.assertEqual(missing.status, "failed")
        # 198.51.100.99 was not asked for and is ignored.
        self.assertNotIn("198.51.100.99", [h.address for h in hosts])

    def test_entities_and_foreign_doctypes_are_refused(self):
        lol = (b'<?xml version="1.0"?><!DOCTYPE nmaprun [<!ENTITY a "aaaa">'
               b'<!ENTITY b "&a;&a;&a;&a;">]><nmaprun>&b;</nmaprun>')
        ext = (b'<?xml version="1.0"?><!DOCTYPE nmaprun SYSTEM "file:///etc/passwd">'
               b"<nmaprun/>")
        sneaky = b'<!DOCTYPE nmaprun>\n<!ENTITY x "y"><nmaprun/>'
        for raw in (lol, ext, sneaky):
            with self.subTest(raw[:40]), self.assertRaises(nm.NmapError):
                nm.parse_xml(raw, ["10.0.0.1"])
        for raw in (b"not xml", b"<other/>", b"x" * (nm.OUTPUT_MAX + 1)):
            with self.subTest(raw[:10]), self.assertRaises(nm.NmapError):
                nm.parse_xml(raw, ["10.0.0.1"])

    def test_hostile_attribute_text_is_inert(self):
        raw = (b'<nmaprun><host><address addr="10.0.0.1" addrtype="ipv4"/><ports>'
               b'<port protocol="tcp" portid="21"><state state="open"/>'
               b'<service name="ftp" product="evil&#9;&#10;&#13;&lt;script&gt;" version="'
               + b"9" * 500 + b'" method="probed" conf="10"/></port></ports></host>'
               b"</nmaprun>")
        [h] = nm.parse_xml(raw, ["10.0.0.1"])
        p = h.open[0]
        self.assertNotIn("\t", p.product)
        self.assertIn("<script>", p.product)  # text; the UI escapes it
        with self.assertRaises(nm.NmapError):  # raw control bytes: not XML
            nm.parse_xml(raw.replace(b"&#9;", b"\x1b"), ["10.0.0.1"])
        self.assertNotIn("\n", p.product)
        self.assertLessEqual(len(p.version), 64)


def _script(body: str) -> str:
    fd, path = tempfile.mkstemp(prefix="fake-nmap-", suffix=".sh")
    os.write(fd, body.encode())
    os.close(fd)
    os.chmod(path, stat.S_IRWXU)
    return path


class RunTests(SimpleTestCase):
    def test_refuses_root(self):
        with mock.patch.object(os, "geteuid", return_value=0), \
                self.assertRaises(nm.NmapError):
            nm.run(["/bin/true"], timeout=5)

    def test_kills_on_timeout(self):
        path = _script("#!/bin/sh\nsleep 30\n")
        try:
            t = time.monotonic()
            with self.assertRaises(nm.NmapError):
                nm.run([path], timeout=1)
            self.assertLess(time.monotonic() - t, 5)
        finally:
            os.unlink(path)

    def test_caps_output(self):
        path = _script("#!/bin/sh\nhead -c 3000000 /dev/zero\n")
        try:
            with self.assertRaises(nm.NmapError):
                nm.run([path], timeout=10, output_max=100_000)
        finally:
            os.unlink(path)

    def test_scrubbed_env_no_shell_temp_cwd(self):
        path = _script("#!/bin/sh\necho \"$PWD|$HOME|$DJANGO_SETTINGS_MODULE|$1\"\n")
        try:
            out = nm.run([path, "$(id)"], timeout=10).decode()
        finally:
            os.unlink(path)
        cwd, home, dsm, arg = out.strip().split("|")
        self.assertIn("danbyte-nmap-", cwd)
        self.assertEqual((home, dsm), ("", ""))
        self.assertEqual(arg, "$(id)")  # passed as data, never expanded

    def test_locate_and_version(self):
        self.assertEqual(nm.locate("/nonexistent/nmap"), "")
        self.assertEqual(nm.locate("relative/nmap"), "")
        fake = _script("#!/bin/sh\necho 'Nmap version 7.95 ( https://nmap.org )'\n")
        try:
            self.assertEqual(nm.locate(fake), fake)
            self.assertEqual(nm.version(fake), "7.95")
        finally:
            os.unlink(fake)


@override_settings(DISCOVERY_ENABLED=True)
class EngineGateTests(ApiBase):
    def setUp(self):
        super().setUp()
        engine.detect(fresh=True)
        self.addCleanup(engine._detect.cache_clear)
        self.fake = _script("#!/bin/sh\necho 'Nmap version 7.95 ( https://nmap.org )'\n")
        self.addCleanup(os.unlink, self.fake)

    def card(self):
        return self.client.get("/api/discovery/settings/").data["nmap"]

    def test_card_shows_what_was_found(self):
        self.login(self.su)
        with override_settings(NMAP_BINARY="/nonexistent/nmap"):
            engine.detect(fresh=True)
            with mock.patch("shutil.which", return_value=None):
                engine.detect(fresh=True)
                s = self.card()
        self.assertEqual((s["available"], s["label"]), (False, "Not found"))
        r = self.client.patch("/api/discovery/settings/", {"nmap": True}, format="json")
        self.assertEqual(r.status_code, 400)
        with override_settings(NMAP_BINARY=self.fake):
            engine.detect(fresh=True)
            s = self.card()
            self.assertEqual(s["label"], f"nmap 7.95 at {self.fake}")
            r = self.client.patch("/api/discovery/settings/", {"nmap": True}, format="json")
            self.assertEqual(r.status_code, 200, r.data)
            self.assertTrue(r.data["nmap"]["enabled"])
            with override_settings(DISCOVERY_NMAP_ALLOWED=False):
                s = self.card()
                self.assertEqual(s["label"], "Forbidden by the deployment")

    def test_tenant_admin_only(self):
        self.member("viewer", {"inventoryprofile": ["view"]})
        r = self.client.patch("/api/discovery/settings/", {"nmap": True}, format="json")
        self.assertEqual(r.status_code, 403)

    def test_profile_engine_needs_the_switch(self):
        self.login(self.su)
        body = {"name": "n", "kind": "service_scan", "scan_engine": "nmap"}
        r = self.client.post("/api/discovery/profiles/", body, format="json")
        self.assertEqual(r.status_code, 400)
        with override_settings(NMAP_BINARY=self.fake):
            engine.detect(fresh=True)
            DiscoverySettings.objects.update_or_create(tenant=self.tenant,
                                                       defaults={"nmap_enabled": True})
            for bad in ({"nmap_version_intensity": 9}, {"nmap_timing": 5},
                        {"nmap_timing": "3; id"}):
                r = self.client.post("/api/discovery/profiles/", {**body, **bad},
                                     format="json")
                self.assertEqual(r.status_code, 400, bad)
            r = self.client.post("/api/discovery/profiles/", body, format="json")
            self.assertEqual(r.status_code, 201, r.data)
            self.assertEqual(r.data["scan_engine"], "nmap")
        # An inventory profile has no engine to choose.
        r = self.client.post("/api/discovery/profiles/",
                             {"name": "i", "kind": "inventory", "scan_engine": "nmap"},
                             format="json")
        self.assertEqual(r.status_code, 400)

    def test_engine_change_and_harder_nmap_clear_the_authorisation(self):
        self.login(self.su)
        url = "/api/discovery/profiles/"
        with override_settings(NMAP_BINARY=self.fake):
            engine.detect(fresh=True)
            DiscoverySettings.objects.update_or_create(tenant=self.tenant,
                                                       defaults={"nmap_enabled": True})
            r = self.client.post(url, {"name": "n", "kind": "service_scan",
                                       "authorisation": "CAB-1"}, format="json")
            self.assertEqual(r.status_code, 201, r.data)
            pid = r.data["id"]

            def again():
                self.client.patch(f"{url}{pid}/", {"authorisation": "CAB-2"}, format="json")

            r = self.client.patch(f"{url}{pid}/", {"scan_engine": "nmap"}, format="json")
            self.assertFalse(r.data["authorised"])
            again()
            # Lower is gentler: still authorised.
            r = self.client.patch(f"{url}{pid}/", {"nmap_timing": 2,
                                                   "nmap_version_intensity": 1},
                                  format="json")
            self.assertTrue(r.data["authorised"])
            r = self.client.patch(f"{url}{pid}/", {"nmap_timing": 4}, format="json")
            self.assertFalse(r.data["authorised"])
            again()
            r = self.client.patch(f"{url}{pid}/", {"nmap_version_intensity": 5},
                                  format="json")
            self.assertFalse(r.data["authorised"])
            again()
            # Back to the built-in engine is another change of what is sent.
            r = self.client.patch(f"{url}{pid}/", {"scan_engine": "builtin"}, format="json")
            self.assertFalse(r.data["authorised"])

    def test_run_rechecks_and_parses_into_observed_services(self):
        dev = self.host("a", "192.0.2.10", cred=None, key=False,
                        prefix=self._prefix("192.0.2.0/24"))
        p = InventoryProfile.objects.create(
            tenant=self.tenant, name="n", kind="service_scan", scan_engine="nmap",
            enabled=True, authorisation="ok", authorised_at=dev.created_at)
        p.devices.set([dev])
        raw = (DATA / "nmap-two-hosts.xml").read_bytes()
        DiscoverySettings.objects.update_or_create(tenant=self.tenant,
                                                   defaults={"nmap_enabled": True})
        seen = []

        def fake_run(argv, timeout):
            seen.append(argv)
            return raw

        with override_settings(NMAP_BINARY=self.fake), \
                mock.patch.object(nm, "run", fake_run):
            engine.detect(fresh=True)
            run = runner.start(p, user=self.su)
            runner.execute(str(run.pk))
        run.refresh_from_db()
        self.assertEqual(run.status, "ok", run.errors)
        self.assertEqual(seen[0][-1], "192.0.2.10")
        self.assertEqual(seen[0][0], self.fake)
        rows = {o.port: o for o in ObservedService.objects.filter(device=dev)}
        self.assertEqual(sorted(rows), [22, 443])
        self.assertEqual(rows[22].source, "nmap")
        # Switched off on the card: the next run does not start nmap.
        DiscoverySettings.objects.filter(tenant=self.tenant).update(nmap_enabled=False)
        seen.clear()
        with override_settings(NMAP_BINARY=self.fake), \
                mock.patch.object(nm, "run", fake_run):
            engine.detect(fresh=True)
            run = runner.start(p, user=self.su)
            runner.execute(str(run.pk))
        run.refresh_from_db()
        self.assertEqual(run.status, "failed")
        self.assertEqual(seen, [])
        self.assertIn("switched off", run.errors[0])

    def _prefix(self, cidr):
        from api.models import Prefix

        return Prefix.objects.create(tenant=self.tenant, cidr=cidr)
