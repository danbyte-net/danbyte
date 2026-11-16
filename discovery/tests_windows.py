"""Windows inventory (#451 B2-win): the fixed script and its parser, telling
Windows from Linux over SSH, the transport switches and their order, WinRM
over HTTPS with a client certificate only, storage, and that Windows
programs never reach vulnerability matching.

The fixtures in ``testdata/windows2022-*`` were written by hand in the
shape the script prints; none came from a live host."""
from __future__ import annotations

import asyncio
import base64
import json
import re
from pathlib import Path
from unittest import mock

from django.test import SimpleTestCase, override_settings

from danbyte_checks import inventory as inv
from danbyte_checks import inventory_windows as win
from monitoring.models import DeviceCredential, SharedCredential

from . import packages, runner, scope
from .models import DiscoverySettings, HostOsFact, HostPackage, InventoryHostResult
from .tests_discovery import SECRET, ApiBase, Base, FakeCollector, result
from .tests_inventory import _Conn

DATA = Path(__file__).resolve().parent / "testdata"
CERT = "-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n"
KEY_PEM = "-----BEGIN PRIVATE KEY-----\nWINRM-KEY-SECRET\n-----END PRIVATE KEY-----\n"


def text(name):
    return (DATA / name).read_text()


class ScriptTests(SimpleTestCase):
    def test_the_command_is_constant_and_inert(self):
        self.assertTrue(win.POWERSHELL.startswith(
            "powershell -NoProfile -NonInteractive -EncodedCommand "))
        # Nothing a cmd.exe or PowerShell shell would expand.
        self.assertTrue(re.fullmatch(r"[A-Za-z0-9+/= -]+", win.POWERSHELL))
        self.assertLess(len(win.POWERSHELL), 8000)  # cmd.exe's command line
        decoded = base64.b64decode(win.ENCODED).decode("utf-16-le")
        self.assertEqual(decoded, win.SCRIPT)
        for needle in ("CurrentVersion", "UBR", "Win32_QuickFixEngineering",
                       "WOW6432Node", "Win32_ServerFeature", "ConvertTo-Json"):
            self.assertIn(needle, win.SCRIPT)
        for forbidden in ("Invoke-Expression", "iex ", "Start-Process", "Set-", "New-Item",
                          "Remove-"):
            self.assertNotIn(forbidden, win.SCRIPT)

    def test_ver(self):
        self.assertEqual(win.parse_ver(text("windows2022-ver.txt")), "10.0.20348.2849")
        self.assertIsNone(win.parse_ver("bash: cmd: command not found"))
        self.assertIsNone(win.parse_ver(""))


class ParserTests(SimpleTestCase):
    def test_server_2022(self):
        f = win.parse_inventory(text("windows2022-inventory.json"))
        self.assertEqual((f.build, f.ubr, f.full_build), ("20348", 2849, "10.0.20348.2849"))
        self.assertEqual(f.edition, "ServerStandard")
        self.assertEqual(f.display_version, "21H2")
        self.assertEqual(f.caption, "Microsoft Windows Server 2022 Standard")
        self.assertEqual((f.installation_type, f.architecture), ("Server", "64-bit"))
        self.assertEqual([h["id"] for h in f.hotfixes], ["KB5044024", "KB5012170", "KB5044281"])
        self.assertIn("Windows PowerShell 5.1", f.features)
        names = [(p.name, p.arch) for p in f.programs]
        # Duplicates collapse, empty names and non-objects are dropped,
        # control characters stripped, 32- and 64-bit views kept apart.
        self.assertEqual(names.count(("Google Chrome", "x64")), 1)
        self.assertIn(("OpenSSH Server", "x64"), names)
        self.assertIn(("PRTG Network Monitor", "x86"), names)
        self.assertEqual(len(f.programs), 11)
        prtg = next(p for p in f.programs if p.name == "PRTG Network Monitor")
        self.assertEqual((prtg.version, prtg.publisher), ("24.3.100.1361", "Paessler AG"))

    def test_server_2012_keeps_its_nt_version(self):
        from types import SimpleNamespace

        from vulnerabilities import evaluate
        from vulnerabilities.msrc_products import resolve_fact

        from .os_platform import version_of

        base = {"schema": 1, "current_build": "9600", "ubr": 21620,
                "caption": "Microsoft Windows Server 2012 R2 Standard",
                "edition_id": "ServerStandard", "installation_type": "Server"}
        for version in ("6.3.9600", ""):
            with self.subTest(version=version):
                f = win.parse_inventory(json.dumps({**base, "version": version}))
                self.assertEqual(f.full_build, "6.3.9600.21620")
        f = win.parse_inventory(json.dumps({**base, "current_build": "9200", "ubr": 25000,
                                            "caption": "Microsoft Windows Server 2012"}))
        self.assertEqual(f.full_build, "6.2.9200.25000")
        self.assertEqual(win.nt_version("", "20348"), "10.0")
        self.assertEqual(win.nt_version("", "7601"), "")
        facts = win.os_facts(win.parse_inventory(json.dumps({**base, "version": "6.3.9600"})))
        fact = SimpleNamespace(
            os_id="windows", version_id=facts["version_id"], build="9600", ubr=21620,
            pretty_name=facts["pretty_name"], edition="ServerStandard",
            display_version="", installation_type="Server", architecture="64-bit")
        self.assertEqual(version_of(fact), "6.3.9600.21620")
        # Microsoft's fixed builds for 2012 R2 are on 6.3.9600 (msrc_2025_oct.json).
        hp = resolve_fact(fact)
        self.assertEqual((hp.keys, hp.line, hp.flag), (("windows_server_2012_r2",),
                                                       "6.3.9600", ""))
        msrc = {"2025-Oct": {"products": {"windows_server_2012_r2": {
            "fixed": ["6.3.9600.22824"]}}}}
        self.assertEqual(evaluate.match_msrc(msrc, hp.keys, hp.line, hp.ubr)[0], "range")
        self.assertIsNone(evaluate.match_msrc(msrc, hp.keys, hp.line, 22824)[0])

    def test_one_program_is_a_bare_object(self):
        doc = {"schema": 1, "current_build": "26100", "ubr": None, "version": "10.0.26100",
               "programs": {"name": "Only", "version": "1", "arch": "x64"},
               "hotfixes": {"id": "KB1234567"}, "features": None}
        f = win.parse_inventory(json.dumps(doc))
        self.assertEqual([p.name for p in f.programs], ["Only"])
        self.assertEqual(f.full_build, "10.0.26100")
        self.assertEqual(f.hotfixes[0]["id"], "KB1234567")

    def test_refuses_what_is_not_the_document(self):
        for bad in ("", "not json", "[]", json.dumps({"schema": 2, "current_build": "1"}),
                    json.dumps({"schema": 1, "current_build": "20348; rm"})):
            with self.subTest(bad=bad), self.assertRaises(win.WindowsParseError):
                win.parse_inventory(bad)

    def test_caps(self):
        doc = {"schema": 1, "current_build": "20348",
               "programs": [{"name": f"p{i}", "arch": "x64"} for i in range(30)]}
        with mock.patch.object(win, "MAX_PROGRAMS", 10):
            f = win.parse_inventory(json.dumps(doc))
        self.assertEqual(len(f.programs), 10)
        self.assertTrue(f.truncated)


class SshDetectionTests(SimpleTestCase):
    def test_windows_over_ssh(self):
        conn = _Conn({win.COMMANDS["ver"]: (text("windows2022-ver.txt").encode(), 0),
                      win.COMMANDS["powershell"]: (text("windows2022-inventory.json").encode(),
                                                   0)})
        r = asyncio.run(inv.read_host(conn, 10))
        self.assertEqual(r.status, inv.OK)
        self.assertEqual(r.manager, "windows")
        self.assertEqual(r.os["id"], "windows")
        self.assertEqual(r.os["windows"]["build"], "20348")
        self.assertEqual({p.type for p in r.packages}, {"generic"})
        self.assertEqual(conn.ran, [inv.COMMANDS["os_release"],
                                    inv.COMMANDS["os_release_fallback"],
                                    win.COMMANDS["ver"], win.COMMANDS["powershell"]])

    def test_linux_never_gets_the_windows_probe(self):
        conn = _Conn({inv.COMMANDS["os_release"]: (text("debian12-os-release.txt").encode(), 0),
                      inv.COMMANDS["dpkg"]: (text("debian12-dpkg.txt").encode(), 0)})
        asyncio.run(inv.read_host(conn, 10))
        self.assertNotIn(win.COMMANDS["ver"], conn.ran)

    def test_an_answer_that_is_not_windows_runs_no_powershell(self):
        conn = _Conn({win.COMMANDS["ver"]: (b"something else\n", 0)})
        with self.assertRaises(inv.InventoryError):
            asyncio.run(inv.read_host(conn, 10))
        self.assertNotIn(win.COMMANDS["powershell"], conn.ran)


class TryNextTests(SimpleTestCase):
    def login(self, kind, fall=False):
        cred = mock.Mock(kind=kind, fall_through=fall)
        from monitoring.credentials import Login

        return Login(cred, "host")

    def test_rules(self):
        key, pw, wr = self.login("ssh_key"), self.login("ssh_password"), \
            self.login("winrm_cert")
        self.assertTrue(runner.try_next(key, "auth_failed", pw))   # no password sent yet
        self.assertFalse(runner.try_next(pw, "auth_failed", wr))   # lockout risk
        self.assertTrue(runner.try_next(self.login("ssh_password", True), "auth_failed", wr))
        self.assertTrue(runner.try_next(pw, "unreachable", wr))    # SSH down -> WinRM
        self.assertFalse(runner.try_next(key, "unreachable", pw))  # same transport, down
        self.assertFalse(runner.try_next(key, "host_key_refused", wr))
        self.assertFalse(runner.try_next(key, "ok", pw))


class FakeWinRM:
    def __init__(self, answer):
        self.answer = answer
        self.calls = []

    async def collect(self, address, **kw):
        self.calls.append((address, kw))
        return self.answer() if callable(self.answer) else self.answer


def winrm_ok():
    return inv.windows_result(text("windows2022-inventory.json"))


def secrets(self):
    if self.kind == "winrm_cert":
        return {"certificate": CERT, "private_key": KEY_PEM}
    return {"password": SECRET}


@mock.patch.object(DeviceCredential, "resolve_secret", secrets)
@mock.patch.object(SharedCredential, "resolve_secret", secrets)
class TransportTests(Base):
    def setUp(self):
        self.a = self.host("a", "10.0.0.1", site=self.site)                 # ssh_password
        self.p = self.profile()
        self.p.sites.add(self.site)
        self.settings_row = DiscoverySettings.for_tenant(self.tenant)

    def go(self, results=None, winrm=None):
        with mock.patch.object(runner, "enqueue"):
            run = runner.start(self.p, user=self.su)
        fake = FakeCollector(results or {})
        fw = winrm or FakeWinRM(winrm_ok)
        runner.execute(str(run.pk), collect=fake.collect, observe=fake.observe,
                       collect_winrm=fw.collect)
        run.refresh_from_db()
        return run, fake, fw

    def test_defaults(self):
        self.assertTrue(self.settings_row.ssh_key_enabled)
        self.assertTrue(self.settings_row.ssh_password_enabled)
        self.assertFalse(self.settings_row.winrm_enabled)

    def test_password_switch_governs_linux_too(self):
        DiscoverySettings.objects.filter(pk=self.settings_row.pk).update(
            ssh_password_enabled=False)
        (t,) = scope.resolve(self.p)
        self.assertEqual(t.skip, "no_credential")
        self.assertIn({"transport": "ssh_password", "outcome": "skipped",
                       "reason": "Switched off"}, t.extra["skipped"])
        run, fake, _ = self.go({"10.0.0.1": result})
        self.assertEqual(fake.calls, [])
        self.assertEqual(run.status, "nothing_read")

    def test_key_before_password_and_the_transport_is_recorded(self):
        DeviceCredential.objects.create(tenant=self.tenant, device=self.a, name="key",
                                        kind="ssh_key", username="k", secret_managed=False,
                                        secret_path="x/k")
        (t,) = scope.resolve(self.p)
        self.assertEqual([x.kind for x in t.logins], ["ssh_key", "ssh_password"])
        run, fake, _ = self.go({"10.0.0.1": result})
        row = InventoryHostResult.objects.get(run=run)
        self.assertEqual(row.transport, "ssh_key")
        self.assertEqual(len(fake.calls), 1)

    def test_winrm_is_off_by_default_and_never_tried(self):
        DeviceCredential.objects.create(tenant=self.tenant, device=self.a, name="cert",
                                        kind="winrm_cert", secret_managed=False,
                                        secret_path="x/c")
        down = inv.InventoryResult(inv.UNREACHABLE, "OSError")
        run, _fake, fw = self.go({"10.0.0.1": down})
        self.assertEqual(fw.calls, [])
        row = InventoryHostResult.objects.get(run=run)
        self.assertIn({"transport": "winrm", "outcome": "skipped", "reason": "Switched off"},
                      row.attempts)

    def test_ssh_down_falls_to_winrm_and_windows_is_stored(self):
        DeviceCredential.objects.create(tenant=self.tenant, device=self.a, name="cert",
                                        kind="winrm_cert", secret_managed=False,
                                        secret_path="x/c")
        DiscoverySettings.objects.filter(pk=self.settings_row.pk).update(winrm_enabled=True)
        down = inv.InventoryResult(inv.UNREACHABLE, "OSError")
        run, fake, fw = self.go({"10.0.0.1": down})
        self.assertEqual(len(fake.calls), 1)
        self.assertEqual(len(fw.calls), 1)
        _address, kw = fw.calls[0]
        self.assertEqual((kw["certificate"], kw["private_key"]), (CERT, KEY_PEM))
        row = InventoryHostResult.objects.get(run=run)
        self.assertEqual((row.status, row.transport), ("ok", "winrm"))
        self.assertEqual([a["transport"] for a in row.attempts if a["outcome"] != "skipped"],
                         ["ssh_password", "winrm"])
        fact = HostOsFact.objects.get(device=self.a)
        self.assertEqual((fact.os_id, fact.build, fact.ubr, fact.transport),
                         ("windows", "20348", 2849, "winrm"))
        self.assertEqual(fact.version_id, "10.0.20348.2849")
        # Stored in the product table's spelling; resolves to Desktop only.
        self.assertEqual((fact.installation_type, fact.architecture), ("Server", "x64"))
        from vulnerabilities.msrc_products import resolve_fact

        self.assertEqual(resolve_fact(fact).keys, ("windows_server_2022",))
        self.assertEqual(len(fact.hotfixes), 3)
        prtg = HostPackage.objects.get(device=self.a, name="PRTG Network Monitor")
        self.assertEqual((prtg.purl_type, prtg.arch, prtg.publisher, prtg.ecosystem),
                         ("generic", "x86", "Paessler AG", ""))
        self.assertTrue(prtg.purl.startswith("pkg:generic/windows/PRTG%20Network%20Monitor@"))
        blob = json.dumps(list(InventoryHostResult.objects.values()), default=str)
        self.assertNotIn("WINRM-KEY-SECRET", blob)
        self.assertNotIn(SECRET, blob)

    def test_winrm_reads_a_host_with_no_accepted_ssh_key(self):
        from monitoring.models import SSHHostKey

        SSHHostKey.objects.filter(device=self.a).delete()
        DeviceCredential.objects.create(tenant=self.tenant, device=self.a, name="cert",
                                        kind="winrm_cert", secret_managed=False,
                                        secret_path="x/c")
        DiscoverySettings.objects.filter(pk=self.settings_row.pk).update(winrm_enabled=True)
        run, fake, fw = self.go({})
        self.assertEqual(fake.calls, [])
        self.assertEqual(len(fw.calls), 1)
        row = InventoryHostResult.objects.get(run=run)
        self.assertIn({"transport": "ssh_password", "outcome": "skipped",
                       "reason": "No accepted SSH host key"}, row.attempts)

    @override_settings(DISCOVERY_WINRM_ALLOWED=False)
    def test_the_deployment_can_forbid_winrm(self):
        DeviceCredential.objects.create(tenant=self.tenant, device=self.a, name="cert",
                                        kind="winrm_cert", secret_managed=False,
                                        secret_path="x/c")
        DiscoverySettings.objects.filter(pk=self.settings_row.pk).update(winrm_enabled=True)
        down = inv.InventoryResult(inv.UNREACHABLE, "OSError")
        _run, _fake, fw = self.go({"10.0.0.1": down})
        self.assertEqual(fw.calls, [])

    @override_settings(CACHES={"default": {
        "BACKEND": "django.core.cache.backends.locmem.LocMemCache",
        "LOCATION": "discovery-msrc-now"}})
    def test_a_new_windows_release_fetches_microsofts_data_once(self):
        from django.core.cache import cache

        from vulnerabilities import fetch
        from vulnerabilities.models import MsrcMonth, VulnerabilitySettings

        cache.clear()
        self.host("b", "10.0.0.2", site=self.site)
        VulnerabilitySettings.objects.update_or_create(
            pk=1, defaults={"enabled": True, "update_source": "upload", "sync_msrc": True})
        answers = {"10.0.0.1": winrm_ok(), "10.0.0.2": winrm_ok()}
        with mock.patch.object(fetch, "enqueue_products", return_value=True) as q:
            self.go(answers)
        q.assert_not_called()                                  # upload mode: nothing
        VulnerabilitySettings.objects.filter(pk=1).update(update_source="server",
                                                          sync_msrc=False)
        with mock.patch.object(fetch, "enqueue_products", return_value=True) as q:
            self.go(answers)
        q.assert_not_called()                                  # Microsoft's data off
        VulnerabilitySettings.objects.filter(pk=1).update(sync_msrc=True)
        with mock.patch.object(fetch, "enqueue_products", return_value=True) as q:
            run, _fake, _fw = self.go(answers)
        self.assertEqual(run.status, "ok")
        # Two Windows hosts, one release: one job for the run.
        q.assert_called_once_with([("msrc", "", "microsoft", "windows_server_2022")])
        cache.clear()
        MsrcMonth.objects.create(month="2026-Nov", starts_on="2026-11-01",
                                 read_at="2026-11-11T00:00:00Z", via="server",
                                 products=["windows_server_2022"])
        with mock.patch.object(fetch, "enqueue_products", return_value=True) as q:
            self.go(answers)
        q.assert_not_called()                                  # already tracked

    def test_windows_programs_never_reach_matching(self):
        packages.store(self.tenant, self.a, None, winrm_ok())
        self.assertTrue(HostPackage.objects.filter(device=self.a, purl_type="generic").exists())
        self.assertFalse(any(k[2] == "generic" for k in packages.tracked_keys()))
        self.assertEqual(packages.tracked_releases(), {})


class WinRMTests(SimpleTestCase):
    def test_only_https_and_certificate_auth(self):
        from . import winrm

        with winrm._memfiles(CERT.encode(), b"key") as (c, k):
            p = winrm.protocol_for("10.0.0.5", port=5986, server_name="win1.example.net",
                                   cert_path=c, key_path=k, timeout=30)
            t = p.transport
            self.assertEqual(t.endpoint, "https://10.0.0.5:5986/wsman")
            self.assertEqual(t.auth_method, "certificate")
            self.assertEqual(t.server_cert_validation, "validate")
            session = t.build_session()
            self.assertFalse(session.trust_env)
            self.assertEqual(session.max_redirects, 0)
            self.assertTrue(session.verify)
            adapter = session.get_adapter("https://10.0.0.5:5986/wsman")
            self.assertEqual(getattr(adapter, "_sni", None), "win1.example.net")
        source = (Path(winrm.__file__)).read_text()
        for forbidden in ('"ntlm"', '"basic"', '"credssp"', '"plaintext"', '"ignore"',
                          "http://"):
            self.assertNotIn(forbidden, source)

    def test_memfiles_hold_the_key_in_memory_only(self):
        import os

        from . import winrm

        with winrm._memfiles(b"secret-bytes") as (path,):
            self.assertTrue(path.startswith("/proc/self/fd/"))
            with open(path, "rb") as fh:
                self.assertEqual(fh.read(), b"secret-bytes")
            fd = int(path.rsplit("/", 1)[1])
        with self.assertRaises(OSError):
            os.fstat(fd)

    def test_refused_and_untrusted(self):
        import requests
        from winrm import exceptions as wexc

        from . import winrm

        for exc, status in ((wexc.InvalidCredentialsError("401"), inv.AUTH_FAILED),
                            (requests.exceptions.SSLError("bad cert"), winrm.TLS_REFUSED),
                            (requests.exceptions.ConnectionError("down"), inv.UNREACHABLE)):
            with self.subTest(status=status), \
                    mock.patch.object(winrm, "_plain_key", return_value=b"k"), \
                    mock.patch.object(winrm, "_run", side_effect=exc):
                r = winrm.collect_sync("10.0.0.5", certificate=CERT, private_key=KEY_PEM)
            self.assertEqual(r.status, status)
            self.assertNotIn("WINRM-KEY-SECRET", r.message)

    def test_ok(self):
        from . import winrm

        out = text("windows2022-inventory.json").encode()
        with mock.patch.object(winrm, "_plain_key", return_value=b"k"), \
                mock.patch.object(winrm, "_run", return_value=(0, out)):
            r = winrm.collect_sync("10.0.0.5", certificate=CERT, private_key=KEY_PEM)
        self.assertEqual(r.status, inv.OK)
        self.assertEqual(r.os["windows"]["ubr"], 2849)

    def test_kerberos_is_not_in_this_build(self):
        from . import winrm

        self.assertFalse(winrm.kerberos_available())


class TransportApiTests(ApiBase):
    URL = "/api/discovery/settings/"

    def test_read_and_switch(self):
        self.login(self.su)
        body = self.client.get(self.URL).json()
        self.assertEqual(body["transports"],
                         {"ssh_key": True, "ssh_password": True, "winrm": False})
        self.assertTrue(body["winrm"]["available"])
        r = self.client.patch(self.URL, {"transports": {"ssh_password": False, "winrm": True}},
                              format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["transports"],
                         {"ssh_key": True, "ssh_password": False, "winrm": True})
        from audit.models import ChangeLogEntry

        self.assertTrue(ChangeLogEntry.objects.filter(
            object_type="discovery.discoverysettings",
            changes__has_key="ssh_password_enabled").exists())

    def test_validation(self):
        self.login(self.su)
        for bad in ({"transports": {"telnet": True}}, {"transports": {"winrm": "yes"}},
                    {"transports": []}):
            self.assertEqual(self.client.patch(self.URL, bad, format="json").status_code, 400)

    @override_settings(DISCOVERY_WINRM_ALLOWED=False)
    def test_forbidden_winrm_cannot_be_switched_on(self):
        self.login(self.su)
        body = self.client.get(self.URL).json()
        self.assertEqual(body["winrm"]["label"], "Forbidden by the deployment")
        r = self.client.patch(self.URL, {"transports": {"winrm": True}}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_only_tenant_admins_change_them(self):
        self.member("viewer", {"inventoryprofile": ["view"]})
        self.assertEqual(self.client.get(self.URL).status_code, 200)
        r = self.client.patch(self.URL, {"transports": {"ssh_password": False}}, format="json")
        self.assertEqual(r.status_code, 403)

    def test_tenant_isolation(self):
        self.login(self.su, self.other)
        self.client.patch(self.URL, {"transports": {"ssh_password": False}}, format="json")
        self.assertTrue(DiscoverySettings.for_tenant(self.tenant).ssh_password_enabled)
        self.assertFalse(DiscoverySettings.for_tenant(self.other).ssh_password_enabled)
