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
        self.assertEqual(wire.urls, ["http://dc.example.net:5985/wsman"])
