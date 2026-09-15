"""BGP: an instance per device and table, its address families, sessions
whose unset fields come from the peer group, a far end that is an address
or an interface, and the mirror session on the peer device.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from api.models import (
    ASN,
    VRF,
    Device,
    DeviceType,
    Interface,
    IPAddress,
    Manufacturer,
    Prefix,
    Site,
)
from api.status_registry import seed_builtin_statuses
from core.models import Organization, Tenant

from .models import BGPInstance, BGPPeerGroup, BGPSession, RoutingPolicy
from .render import routing_context

User = get_user_model()


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        seed_builtin_statuses(self.tenant)
        site = Site.objects.create(tenant=self.tenant, name="DC1")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="C", slug="c")
        dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="X")
        self.leaf = Device.objects.create(tenant=self.tenant, name="leaf1", device_type=dt, site=site)
        self.spine = Device.objects.create(tenant=self.tenant, name="spine1", device_type=dt, site=site)
        self.as65001 = ASN.objects.create(tenant=self.tenant, asn=65001)
        self.lo_leaf = Interface.objects.create(device=self.leaf, name="lo0")
        self.lo_spine = Interface.objects.create(device=self.spine, name="lo0")
        self.swp1 = Interface.objects.create(device=self.leaf, name="swp1")
        net = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/24")
        self.ip_leaf = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.11", prefix=net,
            assigned_device=self.leaf, assigned_interface=self.lo_leaf,
        )
        self.ip_spine = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.0.0.1", prefix=net,
            assigned_device=self.spine, assigned_interface=self.lo_spine,
        )
        self.vrf = VRF.objects.create(tenant=self.tenant, name="CUST")
        self.policy = RoutingPolicy.objects.create(tenant=self.tenant, name="SPINES-IN")
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _post(self, url, body):
        return self.client.post(url, body, format="json")

    def _instance(self, device=None, vrf=None):
        return BGPInstance.objects.create(
            tenant=self.tenant, device=device or self.leaf, vrf=vrf, asn=self.as65001,
            router_id="10.0.0.11",
        )


class InstanceTests(_Base):
    def test_one_per_device_and_table(self):
        r = self._post("/api/routing/bgp-instances/", {
            "device_id": str(self.leaf.id), "asn_id": str(self.as65001.id),
            "router_id": " 10.0.0.11 ",
        })
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["router_id"], "10.0.0.11")
        r = self._post("/api/routing/bgp-instances/", {
            "device_id": str(self.leaf.id), "asn_id": str(self.as65001.id),
        })
        self.assertEqual(r.status_code, 409)
        r = self._post("/api/routing/bgp-instances/", {
            "device_id": str(self.leaf.id), "asn_id": str(self.as65001.id),
            "vrf_id": str(self.vrf.id),
        })
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(
            self.client.get(f"/api/routing/bgp-instances/?device={self.leaf.id}&vrf=global").json()["count"], 1
        )

    def test_address_family_rows_with_redistribution(self):
        inst = self._instance()
        r = self._post("/api/routing/bgp-address-families/", {
            "instance_id": str(inst.id), "afi_safi": "ipv4-unicast",
            "networks": ["10.10.0.0/16"], "maximum_paths": 4,
            "export_policy_id": str(self.policy.id),
            "redistributions": [{"source": "connected", "policy_id": str(self.policy.id)}],
        })
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertEqual(body["export_policy"]["name"], "SPINES-IN")
        self.assertEqual(body["redistributions"][0]["source"], "connected")
        r = self._post("/api/routing/bgp-address-families/", {
            "instance_id": str(inst.id), "afi_safi": "ipv4-unicast",
        })
        self.assertEqual(r.status_code, 409)
        r = self._post("/api/routing/bgp-address-families/", {
            "instance_id": str(inst.id), "afi_safi": "ipv6-unicast", "networks": ["10.10.0.1/16"],
        })
        self.assertEqual(r.status_code, 400)
        self.assertIn("networks", r.json())
        inst_body = self.client.get(f"/api/routing/bgp-instances/{inst.id}/").json()
        self.assertEqual(inst_body["address_families"][0]["afi_safi"], "ipv4-unicast")
        self.assertEqual(inst_body["session_count"], 0)


class SessionTests(_Base):
    def setUp(self):
        super().setUp()
        self.inst = self._instance()
        self.group = BGPPeerGroup.objects.create(
            tenant=self.tenant, name="SPINES", remote_asn=65000,
            address_families=["ipv4-unicast", "l2vpn-evpn"], bfd=True,
            keepalive=3, hold_time=9, import_policy=self.policy,
            update_source="lo0",
        )

    def test_inherits_from_the_group_and_overrides(self):
        r = self._post("/api/routing/bgp-sessions/", {
            "instance_id": str(self.inst.id), "peer_group_id": str(self.group.id),
            "remote_address": "10.0.0.1", "local_address_id": str(self.ip_leaf.id),
            "hold_time": 30,
        })
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        eff = body["effective"]
        self.assertEqual(eff["remote_asn"], 65000)
        self.assertEqual(eff["address_families"], ["ipv4-unicast", "l2vpn-evpn"])
        self.assertTrue(eff["bfd"])
        self.assertEqual(eff["keepalive"], 3)
        self.assertEqual(eff["hold_time"], 30)  # own value wins
        self.assertEqual(eff["import_policy"]["name"], "SPINES-IN")
        self.assertEqual(eff["local_asn"], 65001)  # from the instance
        self.assertEqual(eff["kind"], "ebgp")  # 65001 → 65000
        self.assertEqual(eff["update_source"], "lo0")  # from the local address
        # The stored row keeps the nulls, so the group still governs later.
        self.assertIsNone(body["remote_asn"])
        self.assertIsNone(body["keepalive"])
        # The far address was in IPAM on spine1: linked, and the peer device set.
        self.assertEqual(body["remote_address_obj"]["ip_address"], "10.0.0.1")
        self.assertEqual(body["peer_device"]["name"], "spine1")

    def test_remote_asn_must_come_from_somewhere(self):
        r = self._post("/api/routing/bgp-sessions/", {
            "instance_id": str(self.inst.id), "remote_address": "192.0.2.1",
        })
        self.assertEqual(r.status_code, 400)
        self.assertIn("remote_asn", r.json())
        r = self._post("/api/routing/bgp-sessions/", {
            "instance_id": str(self.inst.id), "remote_address": "192.0.2.1",
            "remote_asn": 64512,
        })
        self.assertEqual(r.status_code, 201, r.content)
        self.assertIsNone(r.json()["remote_address_obj"])

    def test_unnumbered_peering_on_an_interface(self):
        r = self._post("/api/routing/bgp-sessions/", {
            "instance_id": str(self.inst.id), "interface_id": str(self.swp1.id),
            "remote_asn_mode": "external",
        })
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["interface"]["name"], "swp1")
        # Both, or neither, is refused; another device's port is refused.
        r = self._post("/api/routing/bgp-sessions/", {
            "instance_id": str(self.inst.id), "interface_id": str(self.swp1.id),
            "remote_address": "10.0.0.1", "remote_asn": 1,
        })
        self.assertEqual(r.status_code, 400)
        r = self._post("/api/routing/bgp-sessions/", {
            "instance_id": str(self.inst.id), "remote_asn": 1,
        })
        self.assertEqual(r.status_code, 400)
        r = self._post("/api/routing/bgp-sessions/", {
            "instance_id": str(self.inst.id), "interface_id": str(self.lo_spine.id),
            "remote_asn_mode": "external",
        })
        self.assertEqual(r.status_code, 400)
        self.assertIn("interface", r.json())
        # The same port twice on one instance is one session.
        r = self._post("/api/routing/bgp-sessions/", {
            "instance_id": str(self.inst.id), "interface_id": str(self.swp1.id),
            "remote_asn_mode": "external",
        })
        self.assertEqual(r.status_code, 409)

    def test_local_address_must_be_on_the_device_and_in_the_table(self):
        r = self._post("/api/routing/bgp-sessions/", {
            "instance_id": str(self.inst.id), "remote_address": "10.0.0.1",
            "remote_asn": 65000, "local_address_id": str(self.ip_spine.id),
        })
        self.assertEqual(r.status_code, 400)
        self.assertIn("local_address", r.json())

    def test_address_family_validation(self):
        r = self._post("/api/routing/bgp-sessions/", {
            "instance_id": str(self.inst.id), "remote_address": "10.0.0.1",
            "remote_asn": 65000, "address_families": ["ipv4-multicast"],
        })
        self.assertEqual(r.status_code, 400)
        self.assertIn("address_families", r.json())

    def test_create_peer_writes_the_mirror(self):
        far = BGPInstance.objects.create(
            tenant=self.tenant, device=self.spine, asn=self.as65001, router_id="10.0.0.1",
        )
        r = self._post("/api/routing/bgp-sessions/", {
            "instance_id": str(self.inst.id), "peer_group_id": str(self.group.id),
            "remote_address": "10.0.0.1", "local_address_id": str(self.ip_leaf.id),
        })
        sid = r.json()["id"]
        r = self.client.post(f"/api/routing/bgp-sessions/{sid}/create-peer/")
        self.assertEqual(r.status_code, 201, r.content)
        mirror = r.json()
        self.assertEqual(mirror["instance"]["device"]["name"], "spine1")
        self.assertEqual(mirror["remote_address"], "10.0.0.11")
        self.assertEqual(mirror["local_address"]["ip_address"], "10.0.0.1")
        self.assertEqual(mirror["remote_asn"], 65001)
        self.assertEqual(mirror["effective"]["kind"], "ibgp")  # same AS both ends
        self.assertEqual(mirror["effective"]["address_families"], ["ipv4-unicast", "l2vpn-evpn"])
        self.assertEqual(mirror["peer_session"]["device"]["name"], "leaf1")
        near = self.client.get(f"/api/routing/bgp-sessions/{sid}/").json()
        self.assertEqual(near["peer_session"]["id"], mirror["id"])
        # A second time: already paired.
        r = self.client.post(f"/api/routing/bgp-sessions/{sid}/create-peer/")
        self.assertEqual(r.status_code, 400)
        self.assertEqual(BGPSession.objects.filter(instance=far).count(), 1)

    def test_filters_and_tenant_isolation(self):
        BGPSession.objects.create(
            tenant=self.tenant, instance=self.inst, peer_group=self.group,
            remote_address="10.0.0.1",
        )
        BGPSession.objects.create(
            tenant=self.tenant, instance=self.inst, remote_address="192.0.2.9",
            remote_asn=64512, address_families=["ipv6-unicast"],
        )
        get = lambda q: self.client.get(f"/api/routing/bgp-sessions/?{q}").json()["count"]  # noqa: E731
        self.assertEqual(get(f"device={self.leaf.id}"), 2)
        self.assertEqual(get(f"peer_group={self.group.id}"), 1)
        self.assertEqual(get("af=l2vpn-evpn"), 1)
        self.assertEqual(get("af=ipv6-unicast"), 1)
        self.assertEqual(get("search=64512"), 1)
        self.assertEqual(get("remote_asn=65000"), 0)  # stored on the group, not the row
        foreign = BGPPeerGroup.objects.create(tenant=self.other, name="X", remote_asn=1)
        r = self._post("/api/routing/bgp-sessions/", {
            "instance_id": str(self.inst.id), "remote_address": "10.9.9.9",
            "peer_group_id": str(foreign.id),
        })
        self.assertEqual(r.status_code, 400)


class RenderTests(_Base):
    def test_bgp_block_and_policy_closure(self):
        inst = self._instance()
        group = BGPPeerGroup.objects.create(
            tenant=self.tenant, name="SPINES", remote_asn=65000,
            address_families=["ipv4-unicast", "l2vpn-evpn"], import_policy=self.policy,
        )
        BGPSession.objects.create(
            tenant=self.tenant, instance=inst, peer_group=group,
            remote_address="10.0.0.1", local_address=self.ip_leaf,
        )
        BGPSession.objects.create(
            tenant=self.tenant, instance=inst, interface=self.swp1, remote_asn_mode="external",
        )
        ctx = routing_context(self.leaf)
        bgp = ctx["bgp"][0]
        self.assertEqual(bgp["asn"], 65001)
        self.assertEqual(bgp["router_id"], "10.0.0.11")
        self.assertEqual([s["remote_address"] or s["interface"] for s in bgp["sessions"]],
                         ["10.0.0.1", "swp1"])
        s0 = bgp["sessions"][0]
        self.assertEqual(s0["peer_group"], "SPINES")
        self.assertEqual(s0["import_policy"], "SPINES-IN")
        self.assertEqual(s0["local_address"], {"address": "10.0.0.11", "cidr": "10.0.0.11/24", "interface": "lo0"})
        self.assertEqual(s0["update_source"], "lo0")
        self.assertEqual(bgp["peer_groups"][0]["name"], "SPINES")
        self.assertEqual(bgp["sessions"][1]["remote_asn_mode"], "external")
        self.assertEqual(bgp["sessions"][1]["kind"], "ebgp")
        self.assertEqual(bgp["sessions"][0]["kind"], "ebgp")
        # The policy the group references is in the closure; nothing else.
        self.assertEqual(list(ctx["policies"]), ["SPINES-IN"])
        RoutingPolicy.objects.create(tenant=self.tenant, name="UNUSED")
        self.assertEqual(list(routing_context(self.leaf)["policies"]), ["SPINES-IN"])

    def test_frr_fragment(self):
        from api.models import ExportTemplate

        inst = self._instance()
        BGPSession.objects.create(
            tenant=self.tenant, instance=inst, remote_address="10.0.0.1", remote_asn=65000,
            local_address=self.ip_leaf, address_families=["ipv4-unicast"], bfd=True,
        )
        t = ExportTemplate.objects.create(
            tenant=self.tenant, name="frr", object_type="device", template_code=(
                "{% for b in routing.bgp %}router bgp {{ b.asn }}{% if b.vrf %} vrf {{ b.vrf }}{% endif %}\n"
                "{% if b.router_id %} bgp router-id {{ b.router_id }}\n{% endif %}"
                "{% for s in b.sessions %} neighbor {{ s.remote_address or s.interface }} remote-as "
                "{{ s.remote_asn if s.remote_asn_mode == 'asn' else s.remote_asn_mode }}\n"
                "{% if s.update_source %} neighbor {{ s.remote_address or s.interface }} update-source {{ s.update_source }}\n{% endif %}"
                "{% if s.bfd %} neighbor {{ s.remote_address or s.interface }} bfd\n{% endif %}"
                "{% endfor %}{% endfor %}"
            ),
        )
        r = self.client.get(f"/api/devices/{self.leaf.id}/render/?template={t.id}")
        self.assertEqual(r.status_code, 200, r.content)
        out = r.json()["output"]
        # trim_blocks eats the newline after an {% endif %}, as in every template.
        self.assertIn("router bgp 65001 bgp router-id 10.0.0.11", out)
        self.assertIn(" neighbor 10.0.0.1 remote-as 65000", out)
        self.assertIn(" neighbor 10.0.0.1 update-source lo0", out)
        self.assertIn(" neighbor 10.0.0.1 bfd", out)
