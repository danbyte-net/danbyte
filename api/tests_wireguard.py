"""WireGuard values on tunnel terminations and the ``tunnels`` render block.

The acceptance case: one ``/etc/network/interfaces`` template renders the
wg0 block on both ends of a point-to-point tunnel, each end printing the far
end's public key, outside address and port, and its own key reference.
"""
from __future__ import annotations

import base64

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from api.models import (
    Device,
    DeviceType,
    ExportTemplate,
    Interface,
    IPAddress,
    Manufacturer,
    Prefix,
    Site,
    Tunnel,
    TunnelTermination,
)
from core.models import Organization, Tenant
from routing.models import RoutingKeychain

User = get_user_model()

KEY_A = base64.b64encode(bytes([1] * 32)).decode()
KEY_B = base64.b64encode(bytes([2] * 32)).decode()
KEY_C = base64.b64encode(bytes([3] * 32)).decode()

WG_TEMPLATE = """{% set t = tunnels_by_interface["wg0"] %}auto wg0
iface wg0 inet static
    pre-up ip link add wg0 type wireguard
    pre-up wg set wg0 private-key {{ t.wireguard.private_key_ref }} listen-port {{ t.wireguard.listen_port }}
{% for p in t.peers %}    pre-up wg set wg0 peer {{ p.public_key }} allowed-ips {{ p.allowed_ips|join(",") }}{% if p.endpoint %} endpoint {{ p.endpoint }}{% endif %}{% if p.persistent_keepalive %} persistent-keepalive {{ p.persistent_keepalive }}{% endif %}
{% endfor %}"""


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        site = Site.objects.create(tenant=self.tenant, name="DC1")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="M", slug="m")
        dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="VM")
        self.r1 = Device.objects.create(tenant=self.tenant, name="wan-a", device_type=dt, site=site)
        self.r2 = Device.objects.create(tenant=self.tenant, name="wan-b", device_type=dt, site=site)
        self.wg1 = Interface.objects.create(device=self.r1, name="wg0", type="virtual")
        self.wg2 = Interface.objects.create(device=self.r2, name="wg0", type="virtual")
        n1 = Prefix.objects.create(tenant=self.tenant, cidr="198.51.100.0/24")
        n2 = Prefix.objects.create(tenant=self.tenant, cidr="203.0.113.0/24")
        self.ip1 = IPAddress.objects.create(tenant=self.tenant, ip_address="198.51.100.4", prefix=n1)
        self.ip2 = IPAddress.objects.create(tenant=self.tenant, ip_address="203.0.113.9", prefix=n2)
        self.tun = Tunnel.objects.create(tenant=self.tenant, name="wan-wg", encapsulation="wireguard")
        RoutingKeychain.objects.create(tenant=self.tenant, name="WG-A")
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _end(self, iface, ip, **kw):
        r = self.client.post("/api/tunnel-terminations/", {
            "tunnel_id": str(self.tun.id), "interface_id": str(iface.id),
            "outside_ip_id": str(ip.id), **kw,
        }, format="json")
        return r


class ValidationTests(_Base):
    def test_a_pasted_private_key_is_refused(self):
        r = self._end(self.wg1, self.ip1, private_key_ref=KEY_A)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("private_key_ref", r.json())
        self.assertFalse(TunnelTermination.objects.exists())

    def test_a_reference_is_kept_verbatim(self):
        for ref in ("<keychain:WG-A>", "/etc/wireguard/private.key"):
            TunnelTermination.objects.all().delete()
            r = self._end(self.wg1, self.ip1, private_key_ref=ref)
            self.assertEqual(r.status_code, 201, r.content)
            self.assertEqual(r.json()["private_key_ref"], ref)

    def test_a_relative_path_or_free_text_is_refused(self):
        for ref in ("private.key", "secret words", "/etc/../root/key"):
            r = self._end(self.wg1, self.ip1, private_key_ref=ref)
            self.assertEqual(r.status_code, 400, (ref, r.content))
            self.assertIn("private_key_ref", r.json())

    def test_a_keychain_of_another_tenant_is_refused(self):
        org = Organization.objects.create(name="Other", slug="other")
        other = Tenant.objects.create(org=org, name="Other", slug="other")
        RoutingKeychain.objects.create(tenant=other, name="THEIRS")
        r = self._end(self.wg1, self.ip1, private_key_ref="<keychain:THEIRS>")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("private_key_ref", r.json())

    def test_a_bad_public_key_is_refused(self):
        for key in ("not-a-key", base64.b64encode(b"x" * 31).decode(), KEY_A[:-2]):
            r = self._end(self.wg1, self.ip1, public_key=key)
            self.assertEqual(r.status_code, 400, (key, r.content))
            self.assertIn("public_key", r.json())

    def test_a_public_key_is_unique_in_the_tenant(self):
        self.assertEqual(self._end(self.wg1, self.ip1, public_key=KEY_A).status_code, 201)
        r = self._end(self.wg2, self.ip2, public_key=KEY_A)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("public_key", r.json())

    def test_wireguard_values_need_a_wireguard_tunnel(self):
        self.tun.encapsulation = "gre"
        self.tun.save()
        r = self._end(self.wg1, self.ip1, listen_port=51820)
        self.assertEqual(r.status_code, 400, r.content)
        # A GRE end without WireGuard values is still fine.
        self.assertEqual(self._end(self.wg1, self.ip1).status_code, 201)

    def test_allowed_ips_are_normalised(self):
        r = self._end(self.wg1, self.ip1, allowed_ips=["10.0.0.0/24", "10.0.0.0/24", "::/0"])
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["allowed_ips"], ["10.0.0.0/24", "::/0"])
        r = self._end(self.wg2, self.ip2, allowed_ips=["10.0.0.1/24"])
        self.assertEqual(r.status_code, 400, r.content)

    def test_ports_are_in_range(self):
        r = self._end(self.wg1, self.ip1, listen_port=70000)
        self.assertEqual(r.status_code, 400, r.content)

    def test_bulk_import_reads_a_comma_separated_cell(self):
        from api.bulk_import import import_rows

        res = import_rows(TunnelTermination, self.tenant, [{
            "tunnel": "wan-wg", "role": "peer", "interface": str(self.wg1.id),
            "allowed_ips": "0.0.0.0/0, ::/0", "listen_port": "51820",
        }])
        self.assertFalse(res.get("errors"), res)
        t = TunnelTermination.objects.get()
        self.assertEqual(t.allowed_ips, ["0.0.0.0/0", "::/0"])

    def test_the_change_log_records_the_new_fields(self):
        from audit.models import ChangeLogEntry

        r = self._end(self.wg1, self.ip1, listen_port=51820)
        tid = r.json()["id"]
        self.client.patch(f"/api/tunnel-terminations/{tid}/", {"public_key": KEY_A},
                          format="json")
        last = ChangeLogEntry.objects.filter(object_id=tid).order_by("timestamp").last()
        self.assertIsNotNone(last)
        self.assertIn("public_key", last.changes)


class PeersTests(_Base):
    def _hub_spoke(self):
        site = self.r1.site
        dt = self.r1.device_type
        r3 = Device.objects.create(tenant=self.tenant, name="wan-c", device_type=dt, site=site)
        wg3 = Interface.objects.create(device=r3, name="wg0", type="virtual")
        hub = TunnelTermination.objects.create(tunnel=self.tun, role="hub", interface=self.wg1)
        s1 = TunnelTermination.objects.create(tunnel=self.tun, role="spoke", interface=self.wg2)
        s2 = TunnelTermination.objects.create(tunnel=self.tun, role="spoke", interface=wg3)
        return hub, s1, s2

    def test_peer_resolution_by_role(self):
        from api.wireguard import peer_terminations

        hub, s1, s2 = self._hub_spoke()
        ends = list(self.tun.terminations.all())
        self.assertEqual({t.pk for t in peer_terminations(hub, ends)}, {s1.pk, s2.pk})
        self.assertEqual([t.pk for t in peer_terminations(s1, ends)], [hub.pk])
        # No hub: a spoke talks to every other end, as a peer does.
        hub.role = "spoke"
        hub.save()
        ends = list(self.tun.terminations.all())
        self.assertEqual({t.pk for t in peer_terminations(s1, ends)}, {hub.pk, s2.pk})

    def test_the_detail_carries_peers(self):
        a = self._end(self.wg1, self.ip1, public_key=KEY_A, listen_port=51820).json()
        self._end(self.wg2, self.ip2, public_key=KEY_B, listen_port=51821, endpoint_port=4500,
                  allowed_ips=["10.62.0.0/24"])
        r = self.client.get(f"/api/tunnel-terminations/{a['id']}/")
        peers = r.json()["peers"]
        self.assertEqual(len(peers), 1)
        self.assertEqual(peers[0]["public_key"], KEY_B)
        self.assertEqual(peers[0]["endpoint"], "203.0.113.9:4500")
        # A list does not pay for the far ends.
        r = self.client.get(f"/api/tunnel-terminations/?tunnel={self.tun.id}")
        self.assertEqual(r.json()["results"][0]["peers"], [])


class RenderTests(_Base):
    def test_the_wg0_block_renders_on_both_ends(self):
        self.assertEqual(self._end(
            self.wg1, self.ip1, public_key=KEY_A, private_key_ref="<keychain:WG-A>",
            listen_port=51820, allowed_ips=["10.255.0.1/32", "10.61.0.0/24"],
            persistent_keepalive=25,
        ).status_code, 201)
        self.assertEqual(self._end(
            self.wg2, self.ip2, public_key=KEY_B,
            private_key_ref="/etc/wireguard/private.key",
            listen_port=51821, endpoint_port=4500, allowed_ips=["10.255.0.2/32", "10.62.0.0/24"],
        ).status_code, 201)
        tmpl = ExportTemplate.objects.create(
            tenant=self.tenant, name="interfaces", object_type="device",
            template_code=WG_TEMPLATE,
        )

        def render(dev):
            r = self.client.get(f"/api/devices/{dev.id}/render/?template={tmpl.id}")
            self.assertEqual(r.status_code, 200, r.content)
            return r.json()["output"]

        self.assertEqual(render(self.r1), (
            "auto wg0\n"
            "iface wg0 inet static\n"
            "    pre-up ip link add wg0 type wireguard\n"
            "    pre-up wg set wg0 private-key <keychain:WG-A> listen-port 51820\n"
            f"    pre-up wg set wg0 peer {KEY_B} allowed-ips 10.255.0.2/32,10.62.0.0/24"
            " endpoint 203.0.113.9:4500"
        ))
        self.assertEqual(render(self.r2), (
            "auto wg0\n"
            "iface wg0 inet static\n"
            "    pre-up ip link add wg0 type wireguard\n"
            "    pre-up wg set wg0 private-key /etc/wireguard/private.key listen-port 51821\n"
            f"    pre-up wg set wg0 peer {KEY_A} allowed-ips 10.255.0.1/32,10.61.0.0/24"
            " endpoint 198.51.100.4:51820 persistent-keepalive 25"
        ))

    def test_a_vm_gets_the_block_and_other_tenants_stay_out(self):
        from api.wireguard import tunnels_context

        TunnelTermination.objects.create(tunnel=self.tun, interface=self.wg1)
        rows = tunnels_context(self.r1)
        self.assertEqual(rows[0]["name"], "wan-wg")
        self.assertEqual(rows[0]["wireguard"]["allowed_ips"], [])
        self.assertEqual(tunnels_context(self.r2), [])
        self.assertNotIn(KEY_C, str(rows))
