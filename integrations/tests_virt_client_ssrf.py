"""The hypervisor clients ride the SSRF-guarded transport: pinned to the
validated address, refusing redirects (#321)."""
from __future__ import annotations

import json
import socket
from unittest import mock

import requests
from django.test import TestCase
from requests.adapters import HTTPAdapter

from core.models import Organization, Tenant
from core.ssrf import _PinnedSNIAdapter

from . import vcloud_client, virt_client
from .models import VirtualizationSource
from .virt_client import VCenterClient, VirtAPIError, proxmox_get

PUBLIC_IP = "93.184.216.34"


def _resolves_to(ip: str):
    return mock.patch(
        "core.ssrf.socket.getaddrinfo",
        return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 443))],
    )


def _response(request, status=200, headers=None, body=None):
    r = requests.Response()
    r.status_code = status
    r.headers.update(headers or {})
    r._content = json.dumps(body).encode() if body is not None else b""
    r.request = request
    r.url = request.url
    return r


class _Wire:
    """Stands in for the adapter's ``send``: records every request ``requests``
    would have put on the wire and answers from a script, so a redirect that
    *is* followed shows up as a second send."""

    def __init__(self, *script):
        # Each entry: (status, headers, body) - consumed in order, last repeats.
        self.script = list(script) or [(200, {}, {"data": {}})]
        self.sent: list[tuple[HTTPAdapter, requests.PreparedRequest, dict]] = []

    def __call__(self, adapter, request, **kw):
        self.sent.append((adapter, request, kw))
        status, headers, body = self.script[min(len(self.sent) - 1, len(self.script) - 1)]
        return _response(request, status, headers, body)

    def patch(self):
        # A function, so it binds and receives the adapter as ``self``.
        return mock.patch.object(
            HTTPAdapter, "send", lambda adapter, request, **kw: self(adapter, request, **kw)
        )

    @property
    def urls(self):
        return [req.url for _, req, _ in self.sent]


REDIRECT = (302, {"Location": "http://127.0.0.1:8006/api2/json/version"}, None)


class VirtClientTransportTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")

    def _source(self, kind, host, port, **creds):
        return VirtualizationSource.objects.create(
            tenant=self.tenant, kind=kind, name=kind, host=host, port=port,
            verify_ssl=False, credentials=creds,
        )

    # ─── Proxmox ────────────────────────────────────────────────────────
    def test_proxmox_refuses_a_redirect_and_never_follows_it(self):
        src = self._source("proxmox", "pve.example.net", 8006, token_id="a@pam!t", secret="s")
        wire = _Wire(REDIRECT)
        with _resolves_to(PUBLIC_IP), wire.patch(), self.assertRaises(VirtAPIError) as caught:
            proxmox_get(src, "version")
        self.assertIn("redirect", str(caught.exception).lower())
        self.assertEqual(len(wire.sent), 1)  # the loopback hop was never made
        self.assertEqual(wire.urls, [f"https://{PUBLIC_IP}:8006/api2/json/version"])

    def test_proxmox_is_pinned_and_keeps_its_auth_and_tls_settings(self):
        src = self._source("proxmox", "pve.example.net", 8006, token_id="a@pam!t", secret="s")
        wire = _Wire((200, {}, {"data": {"version": "8.2.2"}}))
        with _resolves_to(PUBLIC_IP), wire.patch():
            data = proxmox_get(src, "version")
        self.assertEqual(data, {"version": "8.2.2"})
        adapter, req, kw = wire.sent[0]
        self.assertEqual(req.url, f"https://{PUBLIC_IP}:8006/api2/json/version")
        self.assertEqual(req.headers["Host"], "pve.example.net:8006")
        self.assertEqual(req.headers["Authorization"], "PVEAPIToken=a@pam!t=s")
        self.assertFalse(kw["verify"])  # the source said not to verify
        self.assertEqual(adapter._sni, "pve.example.net")

    def test_proxmox_blocked_host_never_reaches_the_wire(self):
        src = self._source("proxmox", "pve.internal", 8006, token_id="a", secret="s")
        wire = _Wire()
        with _resolves_to("10.0.0.5"), wire.patch(), self.assertRaises(VirtAPIError):
            proxmox_get(src, "version")
        self.assertEqual(wire.sent, [])

    # ─── vCenter ────────────────────────────────────────────────────────
    def test_vcenter_login_refuses_a_redirect(self):
        src = self._source("vcenter", "vc.example.net", 443, username="u", password="p")
        wire = _Wire(REDIRECT)
        with _resolves_to(PUBLIC_IP), wire.patch(), self.assertRaises(VirtAPIError) as caught:
            VCenterClient(src).login()
        self.assertIn("redirect", str(caught.exception).lower())
        self.assertEqual(wire.urls, [f"https://{PUBLIC_IP}:443/api/session"])

    def test_vcenter_session_is_pinned_end_to_end(self):
        src = self._source("vcenter", "vc.example.net", 443, username="u", password="p")
        wire = _Wire(
            (201, {}, "sid-1"),
            (200, {}, [{"vm": "vm-1"}]),
            (204, {}, None),
        )
        with _resolves_to(PUBLIC_IP), wire.patch():
            client = VCenterClient(src)
            vms = client.get("vcenter/vm")
            client.close()
        self.assertEqual(vms, [{"vm": "vm-1"}])
        self.assertEqual(wire.urls, [
            f"https://{PUBLIC_IP}:443/api/session",
            f"https://{PUBLIC_IP}:443/api/vcenter/vm",
            f"https://{PUBLIC_IP}:443/api/session",
        ])
        login, listing, logout = [req for _, req, _ in wire.sent]
        self.assertEqual(login.method, "POST")
        self.assertTrue(login.headers["Authorization"].startswith("Basic "))
        self.assertEqual(listing.headers["vmware-api-session-id"], "sid-1")
        self.assertEqual(logout.method, "DELETE")
        for _, req, kw in wire.sent:
            self.assertEqual(req.headers["Host"], "vc.example.net")
            self.assertFalse(kw["verify"])

    def test_vcenter_get_refuses_a_redirect(self):
        src = self._source("vcenter", "vc.example.net", 443, username="u", password="p")
        wire = _Wire((201, {}, "sid-1"), REDIRECT)
        with _resolves_to(PUBLIC_IP), wire.patch(), self.assertRaises(VirtAPIError) as caught:
            VCenterClient(src).get("vcenter/vm")
        self.assertIn("redirect", str(caught.exception).lower())
        self.assertEqual(len(wire.sent), 2)

    def test_vcenter_blocked_host_never_reaches_the_wire(self):
        src = self._source("vcenter", "vc.internal", 443, username="u", password="p")
        wire = _Wire()
        with _resolves_to("169.254.169.254"), wire.patch(), self.assertRaises(VirtAPIError):
            VCenterClient(src).login()
        self.assertEqual(wire.sent, [])

    # ─── Cloud Director ─────────────────────────────────────────────────
    def test_vcloud_refuses_a_redirect_and_is_pinned(self):
        src = self._source("vcloud", "vcd.example.net", 443, username="u@org", password="p")
        wire = _Wire(REDIRECT)
        with _resolves_to(PUBLIC_IP), wire.patch(), self.assertRaises(VirtAPIError) as caught:
            vcloud_client.VCloudClient(src).login()
        self.assertIn("redirect", str(caught.exception).lower())
        self.assertEqual(wire.urls, [f"https://{PUBLIC_IP}:443/api/versions"])
        self.assertEqual(wire.sent[0][1].headers["Host"], "vcd.example.net")

    def test_the_clients_do_not_open_a_plain_session(self):
        """A bare ``requests.Session`` re-resolves the host on connect and
        follows redirects by default - exactly the two holes being closed."""
        src = self._source("vcenter", "vc.example.net", 443, username="u", password="p")
        self.assertIsInstance(VCenterClient(src)._http, virt_client.SafeSession)
        self.assertIsInstance(
            vcloud_client.VCloudClient(src)._http, vcloud_client.SafeSession
        )


class WinRMRedirectTests(TestCase):
    """pywinrm sends through its own requests.Session; a redirect from a host
    that passed the SSRF check must not be followed (#321)."""

    def _conn(self, **kw):
        from types import SimpleNamespace

        return SimpleNamespace(
            host="dc.example.net", port=5985, use_tls=False, username="u",
            credentials={"password": "p"}, auth_mode="basic", verify_ssl=True, **kw,
        )

    def test_redirect_is_refused_before_the_next_hop(self):
        from .winrm_client import WinRMError, run_ps

        wire = _Wire((307, {"Location": "http://169.254.169.254/wsman"}, None))
        with _resolves_to(PUBLIC_IP), wire.patch(), self.assertRaises(WinRMError) as caught:
            run_ps(self._conn(), "Get-Date")
        self.assertIn("redirect", str(caught.exception).lower())
        self.assertEqual(wire.urls, [f"http://{PUBLIC_IP}:5985/wsman"])

    def test_request_is_pinned_and_keeps_the_host_name(self):
        from .winrm_client import WinRMError, run_ps

        wire = _Wire((500, {}, None))
        with _resolves_to(PUBLIC_IP), wire.patch(), self.assertRaises(WinRMError):
            run_ps(self._conn(), "Get-Date")
        _, req, _ = wire.sent[0]
        self.assertEqual(req.url, f"http://{PUBLIC_IP}:5985/wsman")
        self.assertEqual(req.headers["Host"], "dc.example.net:5985")
        self.assertTrue(req.headers["Authorization"].startswith("Basic "))

    def test_tls_is_verified_against_the_host_name(self):
        from .winrm_client import WinRMError, run_ps

        wire = _Wire((500, {}, None))
        conn = self._conn()
        conn.use_tls, conn.port = True, 5986
        with _resolves_to(PUBLIC_IP), wire.patch(), self.assertRaises(WinRMError):
            run_ps(conn, "Get-Date")
        adapter, req, kw = wire.sent[0]
        self.assertEqual(req.url, f"https://{PUBLIC_IP}:5986/wsman")
        self.assertIsInstance(adapter, _PinnedSNIAdapter)
        self.assertEqual(adapter._sni, "dc.example.net")
        self.assertTrue(kw["verify"])

    def test_kerberos_keeps_the_service_principal_on_the_name(self):
        from .winrm_client import _session

        conn = self._conn()
        conn.auth_mode = "kerberos"
        try:
            session = _session(conn, PUBLIC_IP)
        except Exception as exc:  # noqa: BLE001 - pykerberos is optional
            self.skipTest(f"kerberos transport unavailable: {exc}")
        self.assertEqual(
            session.protocol.transport.kerberos_hostname_override, "dc.example.net"
        )

    def test_a_rebinding_name_cannot_move_the_connection(self):
        """The name answers public for the check and private afterwards; the
        socket still only ever opens to the checked address."""
        from .winrm_client import WinRMError, run_ps

        connects, answers = _rebinding("dc.example.net", ["10.0.0.5"])
        with mock.patch("socket.getaddrinfo", side_effect=answers), \
                mock.patch("urllib3.util.connection.create_connection",
                           side_effect=connects), \
                self.assertRaises(WinRMError):
            run_ps(self._conn(), "Get-Date")
        self.assertTrue(connects.seen)
        self.assertEqual(set(connects.seen), {PUBLIC_IP})

    def test_blocked_host_never_reaches_the_wire(self):
        from .winrm_client import WinRMError, run_ps

        wire = _Wire()
        with _resolves_to("10.0.0.5"), wire.patch(), self.assertRaises(WinRMError):
            run_ps(self._conn(), "Get-Date")
        self.assertEqual(wire.sent, [])


def _rebinding(name, later):
    """``(create_connection, getaddrinfo)`` stand-ins for a DNS-rebinding
    name: ``name`` answers PUBLIC_IP once, then the ``later`` addresses; an IP
    literal answers itself. The connect stand-in resolves what it is asked to
    reach the way the real one does, records the address and refuses."""
    real = socket.getaddrinfo
    calls = {"n": 0}

    def getaddrinfo(host, port, *args, **kw):
        if host == name:
            calls["n"] += 1
            ips = [PUBLIC_IP] if calls["n"] == 1 else later
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port)) for ip in ips]
        return real(host, port, *args, **kw)

    def create_connection(address, *args, **kw):
        host, port = address[0], address[1]
        for info in getaddrinfo(host, port):
            create_connection.seen.append(info[4][0])
        raise ConnectionRefusedError("refused in test")

    create_connection.seen = []
    return create_connection, getaddrinfo


class VSphereSoapPinningTests(TestCase):
    """The SOAP client connects to the checked address, verifies TLS against
    the name and names it in the Host header (#321)."""

    def _source(self, **kw):
        from types import SimpleNamespace

        return SimpleNamespace(
            host="vc.example.net", port=443, verify_ssl=True,
            credentials={"username": "u", "password": "p"}, **kw,
        )

    def test_connect_is_pinned_with_tls_on_the_name(self):
        import ssl

        from .vsphere_soap import VSphereSoap

        with _resolves_to(PUBLIC_IP), mock.patch("pyVim.connect.SmartConnect") as smart:
            VSphereSoap(self._source()).connect()
        kw = smart.call_args.kwargs
        self.assertEqual(kw["host"], PUBLIC_IP)
        self.assertEqual(kw["customHeaders"], {"Host": "vc.example.net"})
        ctx = kw["sslContext"]
        self.assertEqual(ctx.sni_hostname, "vc.example.net")
        self.assertTrue(ctx.check_hostname)
        self.assertEqual(ctx.verify_mode, ssl.CERT_REQUIRED)
        self.assertNotIn("disableSslCertValidation", kw)

    def test_verify_off_still_pins(self):
        import ssl

        from .vsphere_soap import VSphereSoap

        src = self._source()
        src.verify_ssl, src.port = False, 8443
        with _resolves_to(PUBLIC_IP), mock.patch("pyVim.connect.SmartConnect") as smart:
            VSphereSoap(src).connect()
        kw = smart.call_args.kwargs
        self.assertEqual((kw["host"], kw["port"]), (PUBLIC_IP, 8443))
        self.assertEqual(kw["customHeaders"], {"Host": "vc.example.net:8443"})
        self.assertEqual(kw["sslContext"].verify_mode, ssl.CERT_NONE)

    def test_a_rebinding_name_cannot_move_the_connection(self):
        """Through pyVmomi's own HTTP client: only the checked address is
        ever dialled."""
        from .vsphere_soap import VSphereSoap

        connects, answers = _rebinding("vc.example.net", ["127.0.0.1"])
        with mock.patch("socket.getaddrinfo", side_effect=answers), \
                mock.patch("socket.create_connection", side_effect=connects), \
                self.assertRaises(VirtAPIError):
            VSphereSoap(self._source()).connect()
        self.assertTrue(connects.seen)
        self.assertEqual(set(connects.seen), {PUBLIC_IP})

    def test_blocked_host_never_connects(self):
        from .vsphere_soap import VSphereSoap

        with _resolves_to("169.254.169.254"), \
                mock.patch("pyVim.connect.SmartConnect") as smart, \
                self.assertRaises(VirtAPIError):
            VSphereSoap(self._source()).connect()
        smart.assert_not_called()
