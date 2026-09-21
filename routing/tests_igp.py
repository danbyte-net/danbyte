"""OSPF and IS-IS: an instance per device (per table and process for OSPF),
areas as a tenant catalog, interfaces enrolled one per instance with their
own knobs, a NET that has to read like one, and the IGP rows a template
reaches by port name.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from api.models import VRF, Device, DeviceType, Interface, Manufacturer, Site
from api.status_registry import seed_builtin_statuses
from core.models import Organization, Tenant

from .models import (
    BFDProfile,
    BGPInstance,
    BGPPeerGroup,
    BGPSession,
    EIGRPInstance,
    ISISInstance,
    OSPFArea,
    OSPFInstance,
    RoutingKeychain,
    RoutingPolicy,
)
from .render import routing_context

User = get_user_model()


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        seed_builtin_statuses(self.tenant)
        site = Site.objects.create(tenant=self.tenant, name="DC1")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="C", slug="c")
        dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="X")
        self.leaf = Device.objects.create(tenant=self.tenant, name="leaf1", device_type=dt, site=site)
        self.spine = Device.objects.create(tenant=self.tenant, name="spine1", device_type=dt, site=site)
        self.swp1 = Interface.objects.create(device=self.leaf, name="swp1")
        self.swp2 = Interface.objects.create(device=self.leaf, name="swp2")
        self.lo = Interface.objects.create(device=self.leaf, name="lo0")
        self.far = Interface.objects.create(device=self.spine, name="swp1")
        self.vrf = VRF.objects.create(tenant=self.tenant, name="CUST")
        self.area0 = OSPFArea.objects.create(tenant=self.tenant, name="backbone", area_id="0")
        self.policy = RoutingPolicy.objects.create(tenant=self.tenant, name="CONN-OUT")
        self.key = RoutingKeychain.objects.create(tenant=self.tenant, name="ISIS-KEY")
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _post(self, url, body):
        return self.client.post(url, body, format="json")


class OSPFTests(_Base):
    def test_area_ids_normalise(self):
        r = self._post("/api/routing/ospf-areas/", {"name": "dc", "area_id": "0.0.0.1"})
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["area_id"], "0.0.0.1")
        r = self._post("/api/routing/ospf-areas/", {"name": "x", "area_id": "010"})
        self.assertEqual(r.json()["area_id"], "10")
        r = self._post("/api/routing/ospf-areas/", {"name": "y", "area_id": "nope"})
        self.assertEqual(r.status_code, 400)

    def test_instance_with_redistribution_and_interfaces(self):
        r = self._post("/api/routing/ospf-instances/", {
            "device_id": str(self.leaf.id), "process_id": "UNDERLAY", "router_id": "10.0.0.11",
            "reference_bandwidth": 100000, "passive_by_default": True,
            "redistributions": [{"source": "connected", "policy_id": str(self.policy.id)}],
        })
        self.assertEqual(r.status_code, 201, r.content)
        inst = r.json()
        self.assertEqual(inst["redistributions"][0]["policy"]["name"], "CONN-OUT")
        # Same process again in the same table: refused; a v3 one is fine.
        r = self._post("/api/routing/ospf-instances/", {
            "device_id": str(self.leaf.id), "process_id": "UNDERLAY",
        })
        self.assertEqual(r.status_code, 409)
        r = self._post("/api/routing/ospf-instances/", {
            "device_id": str(self.leaf.id), "process_id": "UNDERLAY", "version": 3,
        })
        self.assertEqual(r.status_code, 201, r.content)
        # Enrol two interfaces; one on another device is refused.
        r = self._post("/api/routing/ospf-interfaces/", {
            "instance_id": inst["id"], "interface_id": str(self.swp1.id),
            "area_id": str(self.area0.id), "network_type": "point-to-point", "passive": False,
        })
        self.assertEqual(r.status_code, 201, r.content)
        r = self._post("/api/routing/ospf-interfaces/", {
            "instance_id": inst["id"], "interface_id": str(self.lo.id),
            "area_id": str(self.area0.id), "cost": 1,
        })
        self.assertEqual(r.status_code, 201, r.content)
        r = self._post("/api/routing/ospf-interfaces/", {
            "instance_id": inst["id"], "interface_id": str(self.far.id),
            "area_id": str(self.area0.id),
        })
        self.assertEqual(r.status_code, 400)
        self.assertIn("interface", r.json())
        r = self._post("/api/routing/ospf-interfaces/", {
            "instance_id": inst["id"], "interface_id": str(self.swp1.id),
            "area_id": str(self.area0.id),
        })
        self.assertEqual(r.status_code, 409)
        # Authentication needs a keychain.
        r = self._post("/api/routing/ospf-interfaces/", {
            "instance_id": inst["id"], "interface_id": str(self.swp2.id),
            "area_id": str(self.area0.id), "authentication": "md5",
        })
        self.assertEqual(r.status_code, 400)
        self.assertIn("keychain", r.json())
        body = self.client.get(f"/api/routing/ospf-instances/{inst['id']}/").json()
        self.assertEqual(body["interface_count"], 2)
        self.assertEqual([i["interface"]["name"] for i in body["interfaces"]], ["lo0", "swp1"])
        rows = self.client.get(f"/api/routing/ospf-interfaces/?interface={self.swp1.id}").json()
        self.assertEqual(rows["count"], 1)
        area = self.client.get(f"/api/routing/ospf-areas/{self.area0.id}/").json()
        self.assertEqual(area["interface_count"], 2)


class ISISTests(_Base):
    def test_net_is_checked_and_families_default(self):
        r = self._post("/api/routing/isis-instances/", {
            "device_id": str(self.leaf.id), "process": "UNDERLAY", "net": "49.0001.0000.0000.0011",
        })
        self.assertEqual(r.status_code, 400)
        self.assertIn("net", r.json())
        r = self._post("/api/routing/isis-instances/", {
            "device_id": str(self.leaf.id), "process": "UNDERLAY",
            "net": " 49.0001.0000.0000.0011.00 ", "level": "2",
            "authentication": "md5", "keychain_id": str(self.key.id),
        })
        self.assertEqual(r.status_code, 201, r.content)
        inst = r.json()
        self.assertEqual(inst["net"], "49.0001.0000.0000.0011.00")
        r = self._post("/api/routing/isis-interfaces/", {
            "instance_id": inst["id"], "interface_id": str(self.swp1.id),
            "network_type": "point-to-point", "metric": 10,
        })
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["families"], ["ipv4"])
        r = self._post("/api/routing/isis-interfaces/", {
            "instance_id": inst["id"], "interface_id": str(self.lo.id),
            "families": ["ipv6", "ipv4", "ipv4"], "passive": True,
        })
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["families"], ["ipv6", "ipv4"])
        # The collection says which instance each row belongs to.
        rows = self.client.get("/api/routing/isis-interfaces/").json()["results"]
        self.assertEqual({x["instance"]["id"] for x in rows}, {inst["id"]})
        self.assertEqual(rows[0]["instance"]["name"], "UNDERLAY")
        r = self._post("/api/routing/isis-interfaces/", {
            "instance_id": inst["id"], "interface_id": str(self.swp2.id), "families": ["ipx"],
        })
        self.assertEqual(r.status_code, 400)
        r = self._post("/api/routing/isis-instances/", {
            "device_id": str(self.leaf.id), "process": "UNDERLAY", "net": "49.0001.0000.0000.0012.00",
        })
        self.assertEqual(r.status_code, 409)


class EIGRPTests(_Base):
    def test_instance_checks_its_numbers_and_enrols_interfaces(self):
        r = self._post("/api/routing/eigrp-instances/", {
            "device_id": str(self.leaf.id), "asn": 70000,
        })
        self.assertEqual(r.status_code, 400)
        self.assertIn("asn", r.json())
        r = self._post("/api/routing/eigrp-instances/", {
            "device_id": str(self.leaf.id), "asn": 100, "k_values": "1 0 1",
        })
        self.assertEqual(r.status_code, 400)
        self.assertIn("k_values", r.json())
        r = self._post("/api/routing/eigrp-instances/", {
            "device_id": str(self.leaf.id), "asn": 100, "name": "CORE", "k_values": " 1 0  1 0 0 ",
            "router_id": "10.0.0.11", "passive_by_default": True, "stub": True,
            "redistributions": [{"source": "static", "policy_id": str(self.policy.id)}],
        })
        self.assertEqual(r.status_code, 201, r.content)
        inst = r.json()
        self.assertEqual(inst["k_values"], "1 0 1 0 0")
        self.assertEqual(inst["redistributions"][0]["source"], "static")
        # Same AS in the same table again: refused.
        r = self._post("/api/routing/eigrp-instances/", {
            "device_id": str(self.leaf.id), "asn": 100,
        })
        self.assertEqual(r.status_code, 409)
        r = self._post("/api/routing/eigrp-interfaces/", {
            "instance_id": inst["id"], "interface_id": str(self.swp1.id),
            "summary_addresses": ["10.1.0.0/16"], "passive": False, "bandwidth_percent": 50,
        })
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["summary_addresses"], ["10.1.0.0/16"])
        r = self._post("/api/routing/eigrp-interfaces/", {
            "instance_id": inst["id"], "interface_id": str(self.swp2.id),
            "summary_addresses": ["10.1.1.1/16"],
        })
        self.assertEqual(r.status_code, 400)
        self.assertIn("summary_addresses", r.json())
        r = self._post("/api/routing/eigrp-interfaces/", {
            "instance_id": inst["id"], "interface_id": str(self.far.id),
        })
        self.assertEqual(r.status_code, 400)
        self.assertIn("interface", r.json())
        r = self._post("/api/routing/eigrp-interfaces/", {
            "instance_id": inst["id"], "interface_id": str(self.swp2.id), "authentication": "md5",
        })
        self.assertEqual(r.status_code, 400)
        self.assertIn("keychain", r.json())
        r = self._post("/api/routing/eigrp-interfaces/", {
            "instance_id": inst["id"], "interface_id": str(self.swp2.id),
            "authentication": "hmac-sha-256", "keychain_id": str(self.key.id),
        })
        self.assertEqual(r.status_code, 201, r.content)
        body = self.client.get(f"/api/routing/eigrp-instances/{inst['id']}/").json()
        self.assertEqual(body["interface_count"], 2)
        self.assertEqual(
            self.client.get(f"/api/routing/eigrp-interfaces/?interface={self.swp1.id}").json()["count"], 1
        )
        # A redistribution row on its own names the EIGRP parent.
        r = self._post("/api/routing/redistributions/", {
            "eigrp_instance_id": inst["id"], "source": "connected",
        })
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(
            self.client.get(f"/api/routing/redistributions/?eigrp_instance={inst['id']}").json()["count"], 2
        )
        self.assertEqual(self.client.get(f"/api/devices/{self.leaf.id}/").json()["routing_count"], 1)

    def test_render(self):
        inst = EIGRPInstance.objects.create(
            tenant=self.tenant, device=self.leaf, asn=100, vrf=self.vrf, passive_by_default=True,
        )
        inst.interfaces.create(interface=self.swp1, passive=False, summary_addresses=["10.1.0.0/16"])
        inst.interfaces.create(interface=self.lo)
        inst.redistributions.create(source="bgp", policy=self.policy)
        ctx = routing_context(self.leaf)
        e = ctx["eigrp"][0]
        self.assertEqual((e["asn"], e["vrf"], e["stub"]), (100, "CUST", False))
        self.assertEqual([i["interface"] for i in e["interfaces"]], ["lo0", "swp1"])
        self.assertTrue(e["interfaces"][0]["passive"])
        self.assertEqual(e["interfaces"][1]["summary_addresses"], ["10.1.0.0/16"])
        self.assertEqual(e["redistribute"][0]["policy"], "CONN-OUT")
        self.assertEqual(ctx["by_interface"]["swp1"]["eigrp"]["asn"], 100)
        self.assertIsNone(ctx["by_interface"]["swp2"]["eigrp"])
        self.assertEqual([v["name"] for v in ctx["vrfs"]], ["CUST"])


class BFDTests(_Base):
    def test_profile_is_checked_and_applied_down_the_chain(self):
        r = self._post("/api/routing/bfd-profiles/", {"name": "FAST", "min_tx": 0})
        self.assertEqual(r.status_code, 400)
        self.assertIn("min_tx", r.json())
        r = self._post("/api/routing/bfd-profiles/", {
            "name": "FAST", "min_tx": 100, "min_rx": 100, "multiplier": 3,
        })
        self.assertEqual(r.status_code, 201, r.content)
        fast = r.json()["id"]
        r = self._post("/api/routing/bfd-profiles/", {"name": "FAST"})
        self.assertEqual(r.status_code, 409)
        slow = BFDProfile.objects.create(tenant=self.tenant, name="SLOW", min_tx=1000, min_rx=1000)
        # An instance carries the default; an interface row can override it.
        r = self._post("/api/routing/ospf-instances/", {
            "device_id": str(self.leaf.id), "process_id": "1", "bfd": True, "bfd_profile_id": fast,
        })
        self.assertEqual(r.status_code, 201, r.content)
        inst = r.json()
        self.assertEqual(inst["bfd_profile"]["name"], "FAST")
        self._post("/api/routing/ospf-interfaces/", {
            "instance_id": inst["id"], "interface_id": str(self.swp1.id),
            "area_id": str(self.area0.id), "bfd": True,
        })
        self._post("/api/routing/ospf-interfaces/", {
            "instance_id": inst["id"], "interface_id": str(self.swp2.id),
            "area_id": str(self.area0.id), "bfd": True, "bfd_profile_id": str(slow.id),
        })
        # A session inherits the group's profile, then the instance's.
        asn = self.tenant.asns.create(asn=65000)
        bgp = BGPInstance.objects.create(
            tenant=self.tenant, device=self.leaf, asn=asn, bfd=True, bfd_profile=slow,
        )
        group = BGPPeerGroup.objects.create(
            tenant=self.tenant, name="SPINES", bfd_profile_id=fast,
        )
        s1 = BGPSession.objects.create(
            tenant=self.tenant, instance=bgp, remote_address="10.0.0.1", remote_asn=65000,
            peer_group=group,
        )
        BGPSession.objects.create(
            tenant=self.tenant, instance=bgp, remote_address="10.0.0.2", remote_asn=65000,
        )
        body = self.client.get(f"/api/routing/bgp-sessions/{s1.id}/").json()
        self.assertEqual(body["effective"]["bfd_profile"]["name"], "FAST")
        self.assertIsNone(body["bfd_profile"])
        ctx = routing_context(self.leaf)
        o = ctx["ospf"][0]
        self.assertEqual(o["bfd_profile"], "FAST")
        self.assertEqual([i["bfd_profile"] for i in o["interfaces"]], ["FAST", "SLOW"])
        sessions = {s["remote_address"]: s for s in ctx["bgp"][0]["sessions"]}
        self.assertEqual(sessions["10.0.0.1"]["bfd_profile"], "FAST")
        self.assertEqual(sessions["10.0.0.2"]["bfd_profile"], "SLOW")
        self.assertEqual(ctx["bgp"][0]["peer_groups"][0]["bfd_profile"], "FAST")
        self.assertEqual(
            [(p["name"], p["min_tx"], p["multiplier"]) for p in ctx["bfd_profiles"]],
            [("FAST", 100, 3), ("SLOW", 1000, 3)],
        )
        # Deleting a profile leaves the rows, BFD still on, timers default.
        self.assertEqual(self.client.delete(f"/api/routing/bfd-profiles/{fast}/").status_code, 204)
        self.assertIsNone(routing_context(self.leaf)["ospf"][0]["bfd_profile"])


class RenderTests(_Base):
    def test_igp_blocks_and_by_interface(self):
        ospf = OSPFInstance.objects.create(
            tenant=self.tenant, device=self.leaf, process_id="1", router_id="10.0.0.11",
            passive_by_default=True,
        )
        ospf.interfaces.create(interface=self.swp1, area=self.area0, network_type="point-to-point",
                               passive=False, cost=10)
        ospf.interfaces.create(interface=self.lo, area=self.area0)
        ospf.redistributions.create(source="connected", policy=self.policy)
        isis = ISISInstance.objects.create(
            tenant=self.tenant, device=self.leaf, process="CORE", net="49.0001.0000.0000.0011.00",
        )
        isis.interfaces.create(interface=self.swp2, families=["ipv4", "ipv6"], metric=20)
        ctx = routing_context(self.leaf)
        o = ctx["ospf"][0]
        self.assertEqual(o["process_id"], "1")
        self.assertEqual(o["areas"], [{"area_id": "0", "name": "backbone", "kind": "normal"}])
        self.assertEqual([i["interface"] for i in o["interfaces"]], ["lo0", "swp1"])
        self.assertTrue(o["interfaces"][0]["passive"])   # instance default
        self.assertFalse(o["interfaces"][1]["passive"])  # own value
        self.assertEqual(o["redistribute"], [{"source": "connected", "policy": "CONN-OUT", "metric": None}])
        i = ctx["isis"][0]
        self.assertEqual(i["net"], "49.0001.0000.0000.0011.00")
        self.assertEqual(i["interfaces"][0]["families"], ["ipv4", "ipv6"])
        self.assertEqual(i["interfaces"][0]["level"], "1-2")  # instance's
        self.assertEqual(ctx["by_interface"]["swp1"]["ospf"]["area"], "0")
        self.assertIsNone(ctx["by_interface"]["swp1"]["isis"])
        self.assertEqual(ctx["by_interface"]["swp2"]["isis"]["process"], "CORE")
        self.assertEqual(list(ctx["policies"]), ["CONN-OUT"])


class FabricKnobTests(_Base):
    """The IS-IS stanza a fabric router runs is more than net + level: timers,
    LSP settings and default-information are first-class, and the context
    speaks FRR's level words so a template keeps no mapping of its own."""

    def test_isis_timers_and_defaults_reach_the_context(self):
        isis = ISISInstance.objects.create(
            tenant=self.tenant, device=self.leaf, process="CORE",
            net="49.0001.0000.0000.0011.00", level="2",
            lsp_gen_interval=1, spf_interval=1, lsp_mtu=4352,
            spf_init_delay=50, spf_short_delay=200, spf_long_delay=5000,
            spf_holddown=5000, spf_time_to_learn=500,
            log_adjacency_changes=True, default_originate_ipv4="always",
        )
        isis.interfaces.create(interface=self.swp2)
        isis.redistributions.create(source="bgp", policy=self.policy, level="2")
        isis.redistributions.create(source="connected", family="ipv6")

        i = routing_context(self.leaf)["isis"][0]

        self.assertEqual(i["level_frr"], "level-2-only")
        self.assertEqual(i["interfaces"][0]["level_frr"], "level-2-only")
        self.assertEqual(i["lsp_gen_interval"], 1)
        self.assertEqual(i["lsp_mtu"], 4352)
        self.assertEqual(
            i["spf_delay_ietf"],
            {"init_delay": 50, "short_delay": 200, "long_delay": 5000,
             "holddown": 5000, "time_to_learn": 500},
        )
        self.assertTrue(i["log_adjacency_changes"])
        self.assertEqual(i["default_originate"], {"ipv4": "always"})
        by_source = {r["source"]: r for r in i["redistribute"]}
        self.assertEqual(by_source["bgp"]["level_frr"], "level-2-only")
        self.assertEqual(by_source["bgp"]["policy"], "CONN-OUT")
        self.assertEqual(by_source["bgp"]["family"], "ipv4")
        # A row with no level of its own inherits the instance's.
        self.assertEqual(by_source["connected"]["level"], "2")
        self.assertEqual(by_source["connected"]["family"], "ipv6")

    def test_an_unset_instance_renders_nothing_extra(self):
        isis = ISISInstance.objects.create(
            tenant=self.tenant, device=self.leaf, process="CORE",
            net="49.0001.0000.0000.0011.00",
        )
        isis.interfaces.create(interface=self.swp2)

        i = routing_context(self.leaf)["isis"][0]

        self.assertIsNone(i["spf_delay_ietf"])
        self.assertIsNone(i["lsp_gen_interval"])
        self.assertEqual(i["default_originate"], {})
        self.assertEqual(i["level_frr"], "level-1-2")

    def test_spf_delay_is_all_five_values_or_none(self):
        res = self._post("/api/routing/isis-instances/", {
            "device_id": str(self.leaf.id), "process": "CORE",
            "net": "49.0001.0000.0000.0011.00",
            "spf_init_delay": 50, "spf_short_delay": 200,
        })
        self.assertEqual(res.status_code, 400, res.content)
        self.assertIn("all five", str(res.json()))

    def test_only_the_bfd_profiles_a_device_names_are_in_used(self):
        from routing.models import BFDProfile

        fabric = BFDProfile.objects.create(tenant=self.tenant, name="fabric")
        BFDProfile.objects.create(tenant=self.tenant, name="wan")
        isis = ISISInstance.objects.create(
            tenant=self.tenant, device=self.leaf, process="CORE",
            net="49.0001.0000.0000.0011.00", bfd=True, bfd_profile=fabric,
        )
        isis.interfaces.create(interface=self.swp2)

        ctx = routing_context(self.leaf)

        self.assertEqual([p["name"] for p in ctx["bfd_profiles"]], ["fabric", "wan"])
        self.assertEqual([p["name"] for p in ctx["used_bfd_profiles"]], ["fabric"])


class RoutingSearchTests(_Base):
    """``?search=`` on a routing list matches the device name like any other
    list - the viewsets' own search field list no longer shares its name with
    the framework's search filter, which re-filtered every hit away (#210)."""

    def test_search_by_device_name(self):
        OSPFInstance.objects.create(
            tenant=self.tenant, device=self.leaf, process_id="1", router_id="10.0.0.11"
        )
        r = self.client.get("/api/routing/ospf-instances/?search=leaf1")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["count"], 1)
        r = self.client.get("/api/routing/ospf-instances/?search=10.0.0.11")
        self.assertEqual(r.json()["count"], 1)
        r = self.client.get("/api/routing/ospf-instances/?search=nothing-here")
        self.assertEqual(r.json()["count"], 0)
