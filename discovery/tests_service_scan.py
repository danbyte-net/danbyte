"""Service scan (#451 B3): the engine against hostile local peers (127.0.0.1
only), the fingerprints, the scope rules, the run, the stored rows and the
review queue - tenant isolation and RBAC on every endpoint."""
from __future__ import annotations

import asyncio
import datetime as dt
import ipaddress
import json
import socket
import ssl
import tempfile
import threading
import time
from pathlib import Path
from unittest import mock

from django.test import SimpleTestCase, override_settings
from django.utils import timezone

from api.models import Application, InstalledSoftware, IPAddress, Prefix, Service, Status
from audit.models import ChangeLogEntry
from danbyte_checks import fingerprints, netguard
from danbyte_checks import service_scan as ss
from monitoring.models import (
    EventImpact,
    MaintenanceEvent,
    MonitoringDenySubnet,
    SSHHostKey,
)
from vulnerabilities.models import VulnerabilityMatch, VulnerabilitySettings

from . import runner, services
from .models import (
    DiscoverySettings,
    FindingDecision,
    InventoryHostResult,
    InventoryProfile,
    InventoryRun,
    ObservedService,
)
from .tests_discovery import ApiBase, Base

DATA = Path(__file__).resolve().parent / "testdata"
LOCAL = "127.0.0.1"


# ─── local peers ─────────────────────────────────────────────────────────────


class Peer:
    """A TCP server on 127.0.0.1 in a thread, running ``handler(conn)`` per
    connection. Counts connections."""

    def __init__(self, handler, *, tls: ssl.SSLContext | None = None):
        self.handler = handler
        self.tls = tls
        self.sock = socket.socket()
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind((LOCAL, 0))
        self.sock.listen(16)
        self.port = self.sock.getsockname()[1]
        self.connections = 0
        self.received: list[bytes] = []
        self._stop = False
        self.thread = threading.Thread(target=self._loop, daemon=True)
        self.thread.start()

    def _loop(self):
        self.sock.settimeout(0.2)
        while not self._stop:
            try:
                conn, _ = self.sock.accept()
            except (TimeoutError, OSError):
                continue
            self.connections += 1
            threading.Thread(target=self._serve, args=(conn,), daemon=True).start()

    def _serve(self, conn):
        try:
            if self.tls is not None:
                conn = self.tls.wrap_socket(conn, server_side=True)
            conn.settimeout(5)
            self.handler(conn, self)
        except (OSError, ssl.SSLError):
            pass
        finally:
            try:
                conn.close()
            except OSError:
                pass

    def close(self):
        self._stop = True
        self.sock.close()
        self.thread.join(2)


def greeting(data: bytes):
    def handler(conn, peer):
        conn.sendall(data)
        time.sleep(0.2)
    return handler


def trickle(conn, peer):
    """Slow-loris: one byte every 0.2 s, forever (until the client leaves)."""
    for _ in range(200):
        conn.sendall(b"A")
        time.sleep(0.2)


def flood(conn, peer):
    """A huge banner: 20 MB of junk."""
    chunk = bytes(range(256)) * 256
    for _ in range(320):
        conn.sendall(chunk)


def http_redirect(conn, peer):
    peer.received.append(conn.recv(4096))
    conn.sendall(b"HTTP/1.1 302 Found\r\nServer: nginx/1.24.0\r\n"
                 b"Location: http://203.0.113.9/elsewhere\r\nContent-Length: 0\r\n\r\n")


def http_endless(conn, peer):
    peer.received.append(conn.recv(4096))
    conn.sendall(b"HTTP/1.1 200 OK\r\nServer: Apache/2.4.58 (Ubuntu)\r\n\r\n"
                 b"<html><head><title>Main \x01\x02 page</title></head><body>")
    for _ in range(2000):
        conn.sendall(b"x" * 4096)


def _self_signed(tmp: Path) -> ssl.SSLContext:
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "scan-test.local")])
    now = dt.datetime.now(dt.UTC)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name)
            .public_key(key.public_key()).serial_number(7)
            .not_valid_before(now - dt.timedelta(days=1))
            .not_valid_after(now + dt.timedelta(days=30)).sign(key, hashes.SHA256()))
    (tmp / "c.pem").write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    (tmp / "k.pem").write_bytes(key.private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption()))
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(tmp / "c.pem", tmp / "k.pem")
    return ctx


def probe(port, **kw):
    return asyncio.run(ss.probe_port(LOCAL, port, ss.RateLimiter(1000), **kw))


# ─── the engine ──────────────────────────────────────────────────────────────


class EngineTests(SimpleTestCase):
    def setUp(self):
        self.peers = []

    def tearDown(self):
        for p in self.peers:
            p.close()

    def peer(self, handler, **kw):
        p = Peer(handler, **kw)
        self.peers.append(p)
        return p

    def test_closed_port_is_not_open(self):
        s = socket.socket()
        s.bind((LOCAL, 0))
        port = s.getsockname()[1]
        s.close()
        self.assertIsNone(probe(port))

    def test_ssh_greeting_and_host_key(self):
        p = self.peer(greeting(b"SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13.5\r\n"))
        seen = []

        async def observe(addr, port, timeout):
            seen.append((addr, port))
            return {"key_type": "ssh-ed25519", "public_key": "AAAA", "fingerprint": "SHA256:x"}

        r = probe(p.port, observe_key=observe)
        self.assertEqual((r.service, r.product, r.version), ("ssh", "OpenSSH", "9.6p1"))
        self.assertEqual(r.cpe, "cpe:2.3:a:openbsd:openssh:9.6p1:*:*:*:*:*:*:*")
        self.assertEqual((r.source, r.confidence), ("danbyte", "high"))
        self.assertEqual(seen, [(LOCAL, p.port)])
        self.assertEqual(r.host_key["fingerprint"], "SHA256:x")
        # Nothing was sent to the greeting port.
        self.assertEqual(p.received, [])

    def test_mysql_handshake(self):
        pkt = b"\x4a\x00\x00\x00\x0a" + b"10.11.6-MariaDB-0+deb12u1\x00" + b"\x00" * 20
        r = probe(self.peer(greeting(pkt)).port)
        self.assertEqual((r.product, r.version, r.service), ("MariaDB", "10.11.6", "mysql"))

    def test_slow_loris_is_cut_at_the_deadline(self):
        p = self.peer(trickle)
        t = time.monotonic()
        r = probe(p.port, greeting_seconds=0.6)
        took = time.monotonic() - t
        self.assertLess(took, 2.5)
        self.assertLessEqual(len(r.banner), 10)
        self.assertTrue(set(r.banner) <= {"A"})

    def test_huge_banner_is_capped(self):
        p = self.peer(flood)
        t = time.monotonic()
        r = probe(p.port)
        self.assertLess(time.monotonic() - t, ss.GREETING_SECONDS + 2)
        self.assertLessEqual(len(r.banner), ss.BANNER_KEEP)

    def test_binary_junk_is_stored_inert(self):
        junk = b"\x00\x01\x1b[31m<script>alert(1)</script>\x7f\xff\xfe\r\n"
        r = probe(self.peer(greeting(junk)).port)
        self.assertNotRegex(r.banner, r"[\x00-\x08\x0b-\x1f\x7f]")
        self.assertIn("<script>", r.banner)  # text, never markup: the UI escapes it
        self.assertEqual(r.confidence, "low")

    def test_http_redirect_is_recorded_not_followed(self):
        p = self.peer(http_redirect)
        with mock.patch.object(ss, "HTTP_PORTS", frozenset({p.port})):
            r = probe(p.port)
        self.assertEqual(p.connections, 1)
        self.assertEqual(r.http["status"], 302)
        self.assertEqual(r.http["location"], "http://203.0.113.9/elsewhere")
        self.assertEqual((r.product, r.version), ("nginx", "1.24.0"))
        req = p.received[0].decode()
        self.assertTrue(req.startswith("GET / HTTP/1.1\r\n"))
        self.assertIn(f"User-Agent: {ss.USER_AGENT}\r\n", req)
        self.assertIn("Host: 127.0.0.1\r\n", req)
        self.assertNotIn("Authorization", req)

    def test_endless_http_body_is_capped(self):
        p = self.peer(http_endless)
        t = time.monotonic()
        with mock.patch.object(ss, "HTTP_PORTS", frozenset({p.port})):
            r = probe(p.port, http_seconds=2)
        self.assertLess(time.monotonic() - t, 4)
        self.assertEqual(r.http["title"], "Main page")
        self.assertEqual(r.product, "HTTP Server")

    def test_tls_certificate_is_read(self):
        with tempfile.TemporaryDirectory() as tmp:
            ctx = _self_signed(Path(tmp))
        p = self.peer(greeting(b""), tls=ctx)
        with mock.patch.object(ss, "TLS_PORTS", frozenset({p.port})):
            r = probe(p.port)
        self.assertEqual(r.tls["subject_cn"], "scan-test.local")
        self.assertTrue(r.tls["self_signed"])
        self.assertEqual(len(r.tls["fingerprint_sha256"]), 64)

    def test_blocked_target_is_never_contacted(self):
        p = self.peer(greeting(b"SSH-2.0-x\r\n"))
        netguard.configure(block_internal=True)
        try:
            r = asyncio.run(ss.scan_host(LOCAL, [p.port], ss.RateLimiter(100)))
        finally:
            netguard.configure(block_internal=False)
        self.assertEqual(r.status, "blocked")
        time.sleep(0.3)
        self.assertEqual(p.connections, 0)
        self.assertEqual(asyncio.run(ss.scan_host("db-01", [22], ss.RateLimiter(1))).status,
                         "blocked")

    def test_rate_limiter_paces_connects(self):
        async def go():
            lim = ss.RateLimiter(50)
            t = time.monotonic()
            await asyncio.gather(*(lim.acquire() for _ in range(21)))
            return time.monotonic() - t, lim.count

        took, n = asyncio.run(go())
        self.assertEqual(n, 21)
        self.assertGreaterEqual(took, 0.38)

    def test_port_concurrency_and_count(self):
        p = self.peer(greeting(b"220 ftp ready\r\n"))
        r = asyncio.run(ss.scan_host(LOCAL, [p.port, 1], ss.RateLimiter(500)))
        self.assertEqual([x.port for x in r.open], [p.port])
        self.assertEqual(r.connects, 2)

    def test_parse_ports(self):
        self.assertEqual(ss.parse_ports([]), [p for p, _ in ss.DEFAULT_PORTS])
        self.assertEqual(ss.parse_ports([22, "8000-8002"]), [22, 8000, 8001, 8002])
        for bad in (["1-70000"], [0], ["22; rm -rf /"], [True], "22", ["1-2000"]):
            with self.assertRaises(ValueError, msg=bad):
                ss.parse_ports(bad)
        self.assertGreaterEqual(len(ss.DEFAULT_PORTS), 40)


# ─── fingerprints ────────────────────────────────────────────────────────────


class FingerprintTests(SimpleTestCase):
    def test_recorded_banners(self):
        cases = json.loads((DATA / "service-banners.json").read_text())
        for case in cases:
            hit = fingerprints.match(case["kind"], case["text"])
            want = case["expect"]
            if want is None:
                self.assertIsNone(hit, case["text"])
                continue
            self.assertIsNotNone(hit, case["text"])
            for k, v in want.items():
                self.assertEqual(hit[k], v, f"{case['text']}: {k}")

    def test_cpe_22_to_23(self):
        self.assertEqual(fingerprints.cpe23("cpe:/a:microsoft:iis:7.5"),
                         "cpe:2.3:a:microsoft:iis:7.5:*:*:*:*:*:*:*")
        self.assertEqual(fingerprints.cpe23("cpe:/o:hp:integrated_lights-out_firmware:-", "2"),
                         "cpe:2.3:o:hp:integrated_lights-out_firmware:2:*:*:*:*:*:*:*")
        self.assertEqual(fingerprints.cpe23("cpe:/x:a:b"), "")
        self.assertEqual(fingerprints.cpe23("nonsense"), "")

    def test_vendored_data_is_pinned(self):
        meta = fingerprints.recog_meta()
        self.assertEqual(meta["tag"], "v3.3.2")
        self.assertEqual(meta["commit"], "1714aaed118861b4567bb6754920b4b929f59380")
        self.assertEqual(meta["license"], "BSD-2-Clause")
        self.assertEqual(len(meta["files"]), 9)
        notice = (Path(fingerprints.__file__).parent / "data" / "RECOG-NOTICE").read_text()
        for name, sha in meta["files"].items():
            self.assertIn(f"{sha}  {name}", notice)

    def test_every_pattern_is_fast_on_hostile_input(self):
        """Banners are attacker-controlled and ``re`` has no timeout: every
        vendored pattern stays fast on the longest text it is ever given."""
        hostile = ["a" * 512, "1." * 256, " " * 512, "(" * 512, "A1-_" * 128,
                   "SSH-2.0-" + "OpenSSH_" * 63]
        worst = 0.0
        for kind in fingerprints.KINDS:
            for rx, _params, _d in fingerprints._recog().get(kind, []):
                for s in hostile:
                    t = time.perf_counter()
                    rx.search(s)
                    worst = max(worst, time.perf_counter() - t)
        self.assertLess(worst, 0.05)

    def test_input_is_capped(self):
        with mock.patch.object(fingerprints, "RULES", []):
            calls = []
            real = fingerprints._recog

            class Spy:
                def __init__(self, rx):
                    self.rx = rx

                def search(self, text):
                    calls.append(len(text))
                    return self.rx.search(text)

            data = {k: [(Spy(rx), p, d) for rx, p, d in v] for k, v in real().items()}
            with mock.patch.object(fingerprints, "_recog", lambda: data):
                fingerprints.match("ssh.banner", "x" * 5000)
        self.assertTrue(calls)
        self.assertEqual(max(calls), fingerprints.INPUT_CAP)


# ─── the server side ─────────────────────────────────────────────────────────


def port(n, **kw) -> ss.PortResult:
    defaults = {"service": "ssh", "banner": "SSH-2.0-OpenSSH_9.6p1", "product": "OpenSSH",
                "vendor": "OpenBSD", "version": "9.6p1",
                "cpe": "cpe:2.3:a:openbsd:openssh:9.6p1:*:*:*:*:*:*:*",
                "source": "danbyte", "confidence": "high"}
    defaults.update(kw)
    return ss.PortResult(port=n, **defaults)


class Fake:
    """A scanner that records what it was asked and answers ``found``."""

    def __init__(self, found=None):
        self.found = found or {}
        self.calls = []

    def __call__(self, addresses, plan):
        self.calls.append((list(addresses), plan))
        return [ss.HostResult(a, open=list(self.found.get(a, [])), connects=len(plan["ports"]))
                for a in addresses]


class ScanBase(Base):
    def scan_profile(self, **kw):
        defaults = {"name": "scan", "kind": "service_scan"}
        defaults.update(kw)
        p = self.profile(**defaults)
        return p

    def go(self, profile, fake, user=None):
        run = runner.start(profile, user=user or self.su)
        with self.captureOnCommitCallbacks(execute=False):
            pass
        runner.execute(str(run.pk), scanner=fake)
        run.refresh_from_db()
        return run


@override_settings(DISCOVERY_ENABLED=True)
class ScopeAndRunTests(ScanBase):
    def setUp(self):
        self.a = self.host("a", "10.0.0.1", site=self.site, cred=None, key=False)
        self.b = self.host("b", "10.0.0.2", cred=None, key=False)
        self.loose = IPAddress.objects.create(tenant=self.tenant, ip_address="10.0.0.9",
                                              prefix=self.prefix)
        self.p = self.scan_profile()
        self.p.prefixes.set([self.prefix])

    def statuses(self, user=None):
        return {t.address: t.skip or "ready" for t in services.resolve(self.p, user=user)}

    def test_scope_is_ipam_addresses_only(self):
        self.host("theirs", "10.0.0.3", tenant=self.other, cred=None, key=False)
        self.assertEqual(self.statuses(), {"10.0.0.1": "ready", "10.0.0.2": "ready",
                                           "10.0.0.9": "ready"})
        # A site names its addresses; a device its own.
        self.p.prefixes.clear()
        self.p.sites.set([self.site])
        self.assertEqual(set(self.statuses()), {"10.0.0.1"})
        self.p.sites.clear()
        self.p.devices.set([self.b])
        self.assertEqual(set(self.statuses()), {"10.0.0.2"})

    def test_link_local_is_never_scanned_whatever_the_allowlist(self):
        from . import scope

        ll = Prefix.objects.create(tenant=self.tenant, cidr="169.254.0.0/16")
        v6 = Prefix.objects.create(tenant=self.tenant, cidr="fe80::/10")
        for address, prefix in (("169.254.169.254", ll), ("fe80::1", v6)):
            IPAddress.objects.create(tenant=self.tenant, ip_address=address, prefix=prefix)
        self.p.prefixes.set([ll, v6])
        netguard.configure(block_internal=False, allowlist=["169.254.0.0/16", "fe80::/10"])
        self.addCleanup(netguard.configure, block_internal=False)
        self.assertFalse(netguard.target_blocked("169.254.169.254"))
        for outpost in (False, True):
            targets = services.resolve(self.p, outpost=outpost)
            self.assertEqual({t.address: (t.skip, t.message) for t in targets},
                             {"169.254.169.254": ("blocked", scope.LINK_LOCAL),
                              "fe80::1": ("blocked", scope.LINK_LOCAL)})
        self.assertTrue(scope.link_local(ipaddress.ip_address("::ffff:169.254.169.254")))
        self.assertFalse(scope.link_local(ipaddress.ip_address("10.0.0.1")))

    def test_skip_rules(self):
        IPAddress.objects.filter(pk=self.loose.pk).update(scan_exempt=True)
        self.b.scan_exempt = True
        self.b.save()
        self.assertEqual(self.statuses(), {"10.0.0.1": "ready", "10.0.0.2": "exempt",
                                           "10.0.0.9": "exempt"})
        IPAddress.objects.filter(pk=self.loose.pk).update(scan_exempt=False)
        self.b.scan_exempt = False
        self.b.save()
        Prefix.objects.filter(pk=self.prefix.pk).update(scan_exempt=True)
        self.assertEqual(set(self.statuses().values()), {"exempt"})
        Prefix.objects.filter(pk=self.prefix.pk).update(scan_exempt=False)
        s = DiscoverySettings.for_tenant(self.tenant)
        s.deny_subnets = ["10.0.0.1/32"]
        s.save()
        MonitoringDenySubnet.objects.create(tenant=self.tenant, cidr="10.0.0.9/32")
        self.assertEqual(self.statuses(), {"10.0.0.1": "denied", "10.0.0.2": "ready",
                                           "10.0.0.9": "denied"})
        netguard.configure(block_internal=True)
        try:
            self.assertEqual(self.statuses()["10.0.0.2"], "blocked")
        finally:
            netguard.configure(block_internal=False)
        st = Status.objects.create(tenant=self.tenant, name="Open", slug="open-m",
                                   available_to=["maintenanceevent"])
        ev = MaintenanceEvent.objects.create(
            tenant=self.tenant, status=st, name="w",
            starts_at=timezone.now() - dt.timedelta(hours=1),
            ends_at=timezone.now() + dt.timedelta(hours=1))
        EventImpact.objects.create(tenant=self.tenant, event=ev, object_type="api.device",
                                   object_id=self.b.pk)
        self.assertEqual(self.statuses()["10.0.0.2"], "maintenance")

    def test_run_stores_observations_and_never_contacts_skipped(self):
        IPAddress.objects.filter(pk=self.loose.pk).update(scan_exempt=True)
        fake = Fake({"10.0.0.1": [port(22)]})
        run = self.go(self.p, fake)
        self.assertEqual(run.status, "ok")
        self.assertEqual(run.kind, "service_scan")
        self.assertEqual(sorted(fake.calls[0][0]), ["10.0.0.1", "10.0.0.2"])
        self.assertEqual(run.counts["services"], 1)
        o = ObservedService.objects.get()
        self.assertEqual((o.device, o.port, o.product, o.version), (self.a, 22, "OpenSSH",
                                                                      "9.6p1"))
        rows = {h.address: h.status for h in InventoryHostResult.objects.filter(run=run)}
        self.assertEqual(rows, {"10.0.0.1": "ok", "10.0.0.2": "ok", "10.0.0.9": "exempt"})
        # Machine data: no change-log rows for observations; the run is logged.
        self.assertFalse(ChangeLogEntry.objects.filter(
            object_type="discovery.observedservice").exists())
        self.assertTrue(ChangeLogEntry.objects.filter(
            object_type="discovery.inventoryrun", object_id=str(run.pk)).exists())

    def test_closed_port_gets_gone_at_and_comes_back(self):
        self.go(self.p, Fake({"10.0.0.1": [port(22), port(80, service="http", product="")]}))
        self.go(self.p, Fake({"10.0.0.1": [port(22)]}))
        self.assertIsNotNone(ObservedService.objects.get(port=80).gone_at)
        run = self.go(self.p, Fake({"10.0.0.1": [port(22), port(80, service="http")]}))
        self.assertIsNone(ObservedService.objects.get(port=80).gone_at)
        self.assertEqual(run.counts["new"], 1)

    def test_host_key_is_observed_never_accepted(self):
        key = {"key_type": "ssh-ed25519", "public_key": "AAAAC3Nza", "fingerprint": "SHA256:k"}
        self.go(self.p, Fake({"10.0.0.1": [port(22, host_key=key)]}))
        k = SSHHostKey.objects.get(device=self.a)
        self.assertTrue(k.observed)
        self.assertFalse(k.uploaded)

    def test_banner_never_makes_a_vulnerability_match(self):
        VulnerabilitySettings.objects.update_or_create(pk=1, defaults={"enabled": True})
        self.go(self.p, Fake({"10.0.0.1": [port(22)]}))
        self.assertFalse(VulnerabilityMatch.objects.exists())

    def test_job_rechecks_gates(self):
        for change in ("disabled", "unauthorised", "switch", "window"):
            with self.subTest(change):
                InventoryRun.objects.all().delete()
                run = runner.start(self.p, user=self.su)
                if change == "disabled":
                    InventoryProfile.objects.filter(pk=self.p.pk).update(enabled=False)
                elif change == "unauthorised":
                    InventoryProfile.objects.filter(pk=self.p.pk).update(authorised_at=None)
                elif change == "window":
                    now = timezone.localtime().time()
                    start = (dt.datetime.combine(dt.date.today(), now)
                             + dt.timedelta(hours=2)).time()
                    end = (dt.datetime.combine(dt.date.today(), now)
                           + dt.timedelta(hours=3)).time()
                    InventoryProfile.objects.filter(pk=self.p.pk).update(
                        window_start=start, window_end=end)
                fake = Fake()
                if change == "switch":
                    with override_settings(DISCOVERY_ENABLED=False):
                        runner.execute(str(run.pk), scanner=fake)
                else:
                    runner.execute(str(run.pk), scanner=fake)
                run.refresh_from_db()
                self.assertEqual(run.status, "skipped")
                self.assertEqual(fake.calls, [])
                InventoryProfile.objects.filter(pk=self.p.pk).update(
                    enabled=True, authorised_at=timezone.now(), window_start=None,
                    window_end=None)

    def test_rate_is_capped_by_the_deployment(self):
        InventoryProfile.objects.filter(pk=self.p.pk).update(connects_per_second=500,
                                                             max_concurrency=99)
        self.p.refresh_from_db()
        with override_settings(DISCOVERY_SCAN_MAX_RATE=50):
            plan = services.plan(self.p)
        self.assertEqual(plan["rate"], 50)
        self.assertEqual(plan["hosts_parallel"], services.HOSTS_PARALLEL_MAX)
        self.assertEqual(plan["port_concurrency"], ss.PORT_CONCURRENCY)

    def test_end_to_end_against_a_local_socket(self):
        """The real engine, one IPAM address on 127.0.0.1, one open port."""
        peer = Peer(greeting(b"SSH-2.0-OpenSSH_9.2p1 Debian-2+deb12u3\r\n"))
        try:
            lp = Prefix.objects.create(tenant=self.tenant, cidr="127.0.0.0/30")
            ip = IPAddress.objects.create(tenant=self.tenant, ip_address=LOCAL, prefix=lp,
                                          assigned_device=self.a)
            p = self.scan_profile(name="local", ports=[peer.port])
            p.prefixes.set([lp])
            with mock.patch("danbyte_checks.inventory.observe_host_key",
                            mock.AsyncMock(return_value=None)):
                run = self.go(p, None)
        finally:
            peer.close()
        self.assertEqual(run.status, "ok", run.errors)
        o = ObservedService.objects.get(ip_address=ip)
        self.assertEqual((o.port, o.product, o.version), (peer.port, "OpenSSH", "9.2p1"))
        self.assertEqual(run.counts["connects"], 1)


# ─── API ─────────────────────────────────────────────────────────────────────


@override_settings(DISCOVERY_ENABLED=True)
class ApiTests(ApiBase):
    def setUp(self):
        super().setUp()
        self.a = self.host("a", "10.0.0.1", site=self.site, cred=None, key=False)
        self.b = self.host("b", "10.0.0.2", site=self.branch, cred=None, key=False)
        self.p = self.profile(name="scan", kind="service_scan")
        self.p.prefixes.set([self.prefix])
        now = timezone.now()
        self.obs = []
        for host, address in ((self.a, "10.0.0.1"), (self.b, "10.0.0.2")):
            self.obs.append(ObservedService.objects.create(
                tenant=self.tenant, ip_address=host.primary_ip, device=host, address=address,
                port=22, service_name="ssh", product="OpenSSH", vendor="OpenBSD",
                version="9.6p1", cpe="cpe:2.3:a:openbsd:openssh:9.6p1:*:*:*:*:*:*:*",
                source="danbyte", confidence="high", first_seen=now, last_seen=now))
        IPAddress.objects.filter(pk=self.a.primary_ip_id).update(site=self.site)
        IPAddress.objects.filter(pk=self.b.primary_ip_id).update(site=self.branch)
        other = self.host("theirs", "10.0.0.7", tenant=self.other, cred=None, key=False)
        ObservedService.objects.create(
            tenant=self.other, ip_address=other.primary_ip, device=other, address="10.0.0.7",
            port=22, service_name="ssh", product="OpenSSH", first_seen=now, last_seen=now)

    def test_profile_create_validates_ports_rate_and_scope(self):
        self.login(self.su)
        theirs = Prefix.objects.get(tenant=self.other, cidr="10.0.0.0/24")
        base = {"name": "s2", "kind": "service_scan", "authorisation": "ok by ops"}
        for bad in ({"ports": ["1-5000"]}, {"ports": ["22;id"]},
                    {"connects_per_second": 100000}, {"prefix_ids": [str(theirs.pk)]}):
            r = self.client.post("/api/discovery/profiles/", {**base, **bad}, format="json")
            self.assertEqual(r.status_code, 400, bad)
        r = self.client.post("/api/discovery/profiles/", {**base, "ports": [22, "8000-8010"],
                                                          "connects_per_second": 10},
                             format="json")
        self.assertEqual(r.status_code, 201, r.data)
        self.assertTrue(r.data["authorised"])
        pid = r.data["id"]
        # Widening the ports clears the authorisation; the kind never changes.
        r = self.client.patch(f"/api/discovery/profiles/{pid}/", {"ports": ["1-1024"]},
                              format="json")
        self.assertFalse(r.data["authorised"])
        r = self.client.patch(f"/api/discovery/profiles/{pid}/", {"kind": "inventory"},
                              format="json")
        self.assertEqual(r.status_code, 400)

    def test_run_now_needs_scan_not_credentials(self):
        self.member("viewer", {"inventoryprofile": ["view"]})
        url = f"/api/discovery/profiles/{self.p.pk}/run/"
        self.assertEqual(self.client.post(url, {}, format="json").status_code, 403)
        self.member("scanner", {"inventoryprofile": ["view", "scan"]})
        with self.captureOnCommitCallbacks(execute=False):
            r = self.client.post(url, {}, format="json")
        self.assertEqual(r.status_code, 202, r.data)
        self.assertEqual(r.data["kind"], "service_scan")
        r = self.client.post(url, {"accept_new_host_keys": True}, format="json")
        self.assertIn(r.status_code, (400, 403, 409))

    def test_services_and_findings_are_tenant_and_rbac_scoped(self):
        for url in ("/api/discovery/services/", "/api/discovery/findings/"):
            self.member(f"none-{url[16:20]}", {"inventoryprofile": ["view"]})
            self.assertEqual(self.client.get(url).status_code, 403, url)
        self.member("site", {"ipaddress": ["view"]}, sites=[self.site])
        r = self.client.get("/api/discovery/services/")
        self.assertEqual(r.status_code, 200)
        self.assertEqual([x["address"] for x in r.data["results"]], ["10.0.0.1"])
        r = self.client.get("/api/discovery/findings/")
        self.assertEqual({f["host"]["name"] for f in r.data["results"]}, {"a"})
        self.login(self.su)
        r = self.client.get("/api/discovery/services/")
        self.assertEqual(sorted(x["address"] for x in r.data["results"]),
                         ["10.0.0.1", "10.0.0.2"])
        with override_settings(DISCOVERY_ENABLED=False):
            self.assertEqual(self.client.get("/api/discovery/findings/").status_code, 404)

    def test_findings_proposals(self):
        self.login(self.su)
        r = self.client.get("/api/discovery/findings/")
        kinds = sorted(f["kind"] for f in r.data["results"])
        self.assertEqual(kinds, ["service", "service", "software", "software"])
        self.assertEqual(r.data["totals"], {"service": 2, "software": 2, "cpe": 0,
                                            "platform": 0, "application": 0, "link": 0})
        ev = r.data["results"][0]["evidence"][0]
        self.assertEqual((ev["port"], ev["source"], ev["confidence"]), (22, "danbyte", "high"))
        # A recorded service on the port closes the service finding.
        Service.objects.create(tenant=self.tenant, name="ssh", protocol="tcp", ports=[22],
                               device=self.a)
        r = self.client.get("/api/discovery/findings/?kind=service")
        self.assertEqual([f["host"]["name"] for f in r.data["results"]], ["b"])
        # An address without a host proposes nothing.
        loose = IPAddress.objects.create(tenant=self.tenant, ip_address="10.0.0.50",
                                         prefix=self.prefix)
        ObservedService.objects.create(tenant=self.tenant, ip_address=loose,
                                       address="10.0.0.50", port=8443, service_name="https",
                                       first_seen=timezone.now(), last_seen=timezone.now())
        r = self.client.get("/api/discovery/findings/?kind=service")
        self.assertEqual(len(r.data["results"]), 1)

    def test_cpe_finding_once_the_application_exists(self):
        VulnerabilitySettings.objects.update_or_create(pk=1, defaults={"enabled": True})
        self.login(self.su)
        Application.objects.create(tenant=self.tenant, name="OpenSSH", slug="openssh")
        r = self.client.get("/api/discovery/findings/?kind=cpe")
        [row] = r.data["results"]
        self.assertEqual(row["proposal"]["identifier"], "cpe:2.3:a:openbsd:openssh")
        self.assertEqual(len(row["evidence"]), 2)
        r = self.client.post("/api/discovery/findings/accept/", {"ids": [row["id"]]},
                             format="json")
        self.assertEqual(r.data["created"], [])

    def test_accept_creates_change_logged_objects(self):
        self.login(self.su)
        ids = [f"service:{self.obs[0].pk}", f"software:{self.obs[0].pk}"]
        r = self.client.post("/api/discovery/findings/accept/", {"ids": ids}, format="json")
        self.assertEqual(r.status_code, 200)
        self.assertEqual([c["kind"] for c in r.data["created"]], ["service", "software"])
        svc = Service.objects.get(device=self.a)
        self.assertEqual((svc.ports, svc.protocol, svc.ip_address_id),
                         ([22], "tcp", self.a.primary_ip_id))
        inst = InstalledSoftware.objects.get(device=self.a)
        self.assertEqual((inst.application.name, inst.version, inst.source),
                         ("OpenSSH", "9.6p1", "discovery"))
        for t, pk in (("api.service", svc.pk), ("api.installedsoftware", inst.pk)):
            self.assertTrue(ChangeLogEntry.objects.filter(object_type=t,
                                                          object_id=str(pk)).exists(), t)
        # Accepted once: the findings are gone, a second accept is refused.
        r = self.client.post("/api/discovery/findings/accept/", {"ids": ids}, format="json")
        self.assertEqual(r.data["created"], [])
        self.assertEqual(len(r.data["refused"]), 2)

    def test_accept_needs_add_on_the_created_object_and_site(self):
        ids = [f"service:{self.obs[0].pk}", f"service:{self.obs[1].pk}"]
        self.member("look", {"ipaddress": ["view"]})
        r = self.client.post("/api/discovery/findings/accept/", {"ids": ids}, format="json")
        self.assertEqual(len(r.data["refused"]), 2)
        self.member("hq", {"ipaddress": ["view"], "service": ["add", "view"]},
                    sites=[self.site])
        r = self.client.post("/api/discovery/findings/accept/", {"ids": ids}, format="json")
        # The HQ grant sees and creates only HQ's (site a); b is not even visible.
        self.assertEqual([c["finding"] for c in r.data["created"]], [ids[0]])
        self.assertFalse(Service.objects.filter(device=self.b).exists())
        # Another tenant's observation is never reachable.
        theirs = ObservedService.objects.get(tenant=self.other)
        self.login(self.su)
        r = self.client.post("/api/discovery/findings/accept/",
                             {"ids": [f"service:{theirs.pk}"]}, format="json")
        self.assertEqual(r.data["refused"][0]["reason"], "Not found.")

    def test_accept_software_new_application_needs_application_add(self):
        self.member("inst", {"ipaddress": ["view"], "installedsoftware": ["add", "view"]})
        fid = f"software:{self.obs[0].pk}"
        r = self.client.post("/api/discovery/findings/accept/", {"ids": [fid]}, format="json")
        self.assertIn("application.add", r.data["refused"][0]["reason"])
        self.assertFalse(Application.objects.filter(tenant=self.tenant).exists())

    def test_ignore_is_remembered_until_the_evidence_changes(self):
        self.login(self.su)
        fid = f"service:{self.obs[0].pk}"
        r = self.client.post("/api/discovery/findings/ignore/", {"ids": [fid]}, format="json")
        self.assertEqual(r.data["done"], [fid])
        self.assertTrue(FindingDecision.objects.filter(observed=self.obs[0]).exists())
        ids = {f["id"] for f in self.client.get("/api/discovery/findings/").data["results"]}
        self.assertNotIn(fid, ids)
        ids = {f["id"] for f in self.client.get(
            "/api/discovery/findings/?ignored=true").data["results"]}
        self.assertIn(fid, ids)
        ObservedService.objects.filter(pk=self.obs[0].pk).update(version="9.7p1")
        ids = {f["id"] for f in self.client.get("/api/discovery/findings/").data["results"]}
        self.assertIn(fid, ids)

    def test_run_hosts_lists_addresses_without_a_host(self):
        self.login(self.su)
        IPAddress.objects.create(tenant=self.tenant, ip_address="10.0.0.60", prefix=self.prefix)
        run = runner.start(self.p, user=self.su)
        runner.execute(str(run.pk), scanner=Fake())
        r = self.client.get(f"/api/discovery/runs/{run.pk}/hosts/")
        self.assertIn("10.0.0.60", [h["address"] for h in r.data["results"]])
        self.member("devonly", {"inventoryprofile": ["view"], "device": ["view"]})
        r = self.client.get(f"/api/discovery/runs/{run.pk}/hosts/")
        self.assertNotIn("10.0.0.60", [h["address"] for h in r.data["results"]])

    def test_queries_ignore_nothing(self):
        self.login(self.su)
        for url in ("/api/discovery/services/?run=x", "/api/discovery/findings/?kind=bogus"):
            self.assertEqual(self.client.get(url).status_code, 400, url)
        r = self.client.get("/api/discovery/profiles/?kind=service_scan")
        self.assertEqual([x["name"] for x in r.data["results"]], ["scan"])

