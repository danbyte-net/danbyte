"""Routing on virtual machines (#217): a static route, a protocol instance or
a session belongs to a device or a VM, never both; a VM's rows use its own
ports and addresses, are site-scoped through the VM, and render into its
config context.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from rest_framework.test import APITestCase

from api.models import (
    ASN,
    Cluster,
    ClusterType,
    Device,
    DeviceType,
    Interface,
    IPAddress,
    Manufacturer,
    Prefix,
    Site,
    VirtualMachine,
    VMInterface,
)
from api.search_index import entry_values
from api.status_registry import seed_builtin_statuses
from auth_api import rbac
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from .models import BGPInstance, BGPSession, OSPFArea, OSPFInstance, StaticRoute
from .render import routing_context

User = get_user_model()


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        seed_builtin_statuses(self.tenant)
        self.ams = Site.objects.create(tenant=self.tenant, name="AMS")
        self.lon = Site.objects.create(tenant=self.tenant, name="LON")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="C", slug="c")
        dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="X")
        self.r1 = Device.objects.create(tenant=self.tenant, name="ams-r1", device_type=dt,
                                        site=self.ams)
        self.eth0 = Interface.objects.create(device=self.r1, name="eth0")
        ct = ClusterType.objects.create(tenant=self.tenant, name="kvm", slug="kvm")
        cluster = Cluster.objects.create(tenant=self.tenant, name="c1", type=ct)
        self.vr = VirtualMachine.objects.create(tenant=self.tenant, name="ams-vr1",
                                                cluster=cluster, site=self.ams)
        self.vr2 = VirtualMachine.objects.create(tenant=self.tenant, name="lon-vr1",
                                                 cluster=cluster, site=self.lon)
        self.floating = VirtualMachine.objects.create(tenant=self.tenant, name="nowhere",
                                                      cluster=cluster)
        self.ens3 = VMInterface.objects.create(vm=self.vr, name="ens3")
        self.other_port = VMInterface.objects.create(vm=self.vr2, name="ens3")
        self.asn = ASN.objects.create(tenant=self.tenant, asn=65010)
        net = Prefix.objects.create(tenant=self.tenant, cidr="10.9.0.0/24")
        self.vr_ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.9.0.2", prefix=net,
            assigned_vm=self.vr, assigned_vm_interface=self.ens3,
        )
        self.r1_ip = IPAddress.objects.create(
            tenant=self.tenant, ip_address="10.9.0.1", prefix=net,
            assigned_device=self.r1, assigned_interface=self.eth0,
        )
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def _post(self, url, body):
        return self.client.post(url, body, format="json")

    def _route(self, **over):
        body = {"virtual_machine_id": str(self.vr.id), "prefix": "0.0.0.0/0",
                "next_hop": "10.9.0.1"}
        body.update(over)
        return self._post("/api/routing/static-routes/", body)


class VMStaticRouteTests(_Base):
    def test_route_on_a_vm_reads_back_with_its_site(self):
        r = self._route()
        self.assertEqual(r.status_code, 201, r.content)
        body = r.json()
        self.assertIsNone(body["device"])
        self.assertEqual(body["virtual_machine"]["name"], "ams-vr1")
        self.assertEqual(body["site"]["name"], "AMS")
        get = lambda q: self.client.get(f"/api/routing/static-routes/?{q}").json()["count"]  # noqa: E731
        self.assertEqual(get(f"virtual_machine={self.vr.id}"), 1)
        self.assertEqual(get(f"site={self.ams.id}"), 1)
        self.assertEqual(get(f"site={self.lon.id}"), 0)
        self.assertEqual(get("search=ams-vr1"), 1)
        vm = self.client.get(f"/api/virtual-machines/{self.vr.id}/").json()
        self.assertEqual(vm["routing_count"], 1)

    def test_a_route_has_exactly_one_owner(self):
        r = self._route(device_id=str(self.r1.id))
        self.assertEqual(r.status_code, 400)
        self.assertIn("device", r.json())
        r = self._post("/api/routing/static-routes/",
                       {"prefix": "0.0.0.0/0", "next_hop": "10.9.0.1"})
        self.assertEqual(r.status_code, 400)
        with self.assertRaises(IntegrityError), transaction.atomic():
            StaticRoute.objects.create(tenant=self.tenant, prefix="0.0.0.0/0",
                                       next_hop="10.9.0.1")

    def test_next_hop_port_is_the_vms_own(self):
        r = self._route(kind="interface", next_hop="",
                        next_hop_vm_interface_id=str(self.other_port.id))
        self.assertEqual(r.status_code, 400)
        self.assertIn("next_hop_vm_interface", r.json())
        # A device port cannot carry a VM's route either.
        r = self._route(kind="interface", next_hop="",
                        next_hop_interface_id=str(self.eth0.id))
        self.assertEqual(r.status_code, 400)
        r = self._route(kind="interface", next_hop="",
                        next_hop_vm_interface_id=str(self.ens3.id))
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["next_hop_vm_interface"]["name"], "ens3")

    def test_same_path_twice_is_refused_per_vm(self):
        self.assertEqual(self._route().status_code, 201)
        self.assertEqual(self._route().status_code, 409)
        self.assertEqual(self._route(virtual_machine_id=str(self.vr2.id)).status_code, 201)
        # The same path on a device is its own row.
        r = self._route(virtual_machine_id=None, device_id=str(self.r1.id))
        self.assertEqual(r.status_code, 201, r.content)

    def test_site_scope_runs_through_the_vm(self):
        self._route()
        self._route(virtual_machine_id=str(self.vr2.id))
        self._route(virtual_machine_id=str(self.floating.id))
        self._route(virtual_machine_id=None, device_id=str(self.r1.id))
        user = User.objects.create_user("u")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        p = ObjectPermission.objects.create(
            name="p", object_types=["staticroute"], actions=["view", "add", "change"]
        )
        p.users.add(user)
        p.sites.set([self.ams])
        qs = rbac.restrict_queryset(
            StaticRoute.objects.all(), user, self.tenant, "staticroute", "view"
        )
        # Both AMS rows, and the siteless VM's as a shared row - never LON's.
        self.assertEqual({r.owner_name for r in qs}, {"ams-r1", "ams-vr1", "nowhere"})
        change = rbac.restrict_queryset(
            StaticRoute.objects.all(), user, self.tenant, "staticroute", "change"
        )
        self.assertEqual({r.owner_name for r in change}, {"ams-r1", "ams-vr1"})
        # And an AMS editor cannot place a route on the LON VM.
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()
        r = self._route(virtual_machine_id=str(self.vr2.id), prefix="10.1.0.0/16")
        self.assertEqual(r.status_code, 403, r.content)
        r = self._route(prefix="10.1.0.0/16")
        self.assertEqual(r.status_code, 201, r.content)

    def test_search_entry_links_the_vm_page(self):
        r = self._route()
        route = StaticRoute.objects.get(pk=r.json()["id"])
        vals = entry_values(route)
        self.assertEqual(vals["site_id"], self.ams.id)
        self.assertEqual(vals["subtitle"], "ams-vr1")
        inst = BGPInstance.objects.create(tenant=self.tenant, virtual_machine=self.vr,
                                          asn=self.asn)
        self.assertEqual(entry_values(inst)["url"],
                         f"/virtual-machines/{self.vr.id}?tab=routing")


class VMBGPTests(_Base):
    def _instance(self):
        r = self._post("/api/routing/bgp-instances/", {
            "virtual_machine_id": str(self.vr.id), "asn_id": str(self.asn.id),
            "router_id": "10.9.0.2",
        })
        self.assertEqual(r.status_code, 201, r.content)
        return r.json()

    def test_instance_and_sessions_on_a_vm(self):
        inst = self._instance()
        self.assertEqual(inst["virtual_machine"]["name"], "ams-vr1")
        self.assertEqual(inst["site"]["name"], "AMS")
        # One per table per VM, like a device.
        r = self._post("/api/routing/bgp-instances/", {
            "virtual_machine_id": str(self.vr.id), "asn_id": str(self.asn.id),
        })
        self.assertEqual(r.status_code, 409)
        # Local address must be the VM's.
        r = self._post("/api/routing/bgp-sessions/", {
            "instance_id": inst["id"], "remote_address": "10.9.0.1", "remote_asn": 65000,
            "local_address_id": str(self.r1_ip.id),
        })
        self.assertEqual(r.status_code, 400)
        self.assertIn("local_address", r.json())
        r = self._post("/api/routing/bgp-sessions/", {
            "instance_id": inst["id"], "remote_address": "10.9.0.1", "remote_asn": 65000,
            "local_address_id": str(self.vr_ip.id), "peer_device_id": str(self.r1.id),
        })
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["instance"]["virtual_machine"]["name"], "ams-vr1")
        # Unnumbered: out of the VM's own port only.
        r = self._post("/api/routing/bgp-sessions/", {
            "instance_id": inst["id"], "remote_asn_mode": "external",
            "vm_interface_id": str(self.other_port.id),
        })
        self.assertEqual(r.status_code, 400)
        self.assertIn("vm_interface", r.json())
        r = self._post("/api/routing/bgp-sessions/", {
            "instance_id": inst["id"], "remote_asn_mode": "external",
            "interface_id": str(self.eth0.id),
        })
        self.assertEqual(r.status_code, 400)
        r = self._post("/api/routing/bgp-sessions/", {
            "instance_id": inst["id"], "remote_asn_mode": "external",
            "vm_interface_id": str(self.ens3.id),
        })
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["vm_interface"]["name"], "ens3")
        get = lambda q: self.client.get(f"/api/routing/bgp-sessions/?{q}").json()["count"]  # noqa: E731
        self.assertEqual(get(f"virtual_machine={self.vr.id}"), 2)
        self.assertEqual(get(f"site={self.ams.id}"), 2)

    def test_session_on_a_vm_is_site_scoped_through_it(self):
        inst = BGPInstance.objects.create(tenant=self.tenant, virtual_machine=self.vr2,
                                          asn=self.asn)
        BGPSession.objects.create(tenant=self.tenant, instance=inst,
                                  remote_address="10.9.0.1", remote_asn=65000)
        user = User.objects.create_user("u")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        p = ObjectPermission.objects.create(
            name="p", object_types=["bgpsession"], actions=["view"]
        )
        p.users.add(user)
        p.sites.set([self.ams])
        qs = rbac.restrict_queryset(
            BGPSession.objects.all(), user, self.tenant, "bgpsession", "view"
        )
        self.assertFalse(qs.exists())

    def test_vm_config_context(self):
        inst = self._instance()
        self._post("/api/routing/bgp-sessions/", {
            "instance_id": inst["id"], "remote_address": "10.9.0.1", "remote_asn": 65000,
            "local_address_id": str(self.vr_ip.id),
        })
        self._route(kind="interface", next_hop="",
                    next_hop_vm_interface_id=str(self.ens3.id))
        ctx = routing_context(self.vr)
        self.assertEqual(ctx["bgp"][0]["asn"], 65010)
        session = ctx["bgp"][0]["sessions"][0]
        self.assertEqual(session["local_address"]["interface"], "ens3")
        self.assertEqual(ctx["static_routes"][0]["next_hop_interface"], "ens3")
        self.assertIsNone(ctx["vtep"])
        self.assertIsNone(ctx["ldp"])
        # A device's block does not pick up the VM's rows.
        self.assertEqual(routing_context(self.r1)["bgp"], [])


class VMIGPTests(_Base):
    def test_ospf_on_a_vm_port(self):
        area = OSPFArea.objects.create(tenant=self.tenant, name="backbone", area_id="0")
        r = self._post("/api/routing/ospf-instances/", {
            "virtual_machine_id": str(self.vr.id), "process_id": "1",
            "router_id": "10.9.0.2",
        })
        self.assertEqual(r.status_code, 201, r.content)
        inst = r.json()
        self.assertEqual(inst["site"]["name"], "AMS")
        url = "/api/routing/ospf-interfaces/"
        r = self._post(url, {"instance_id": inst["id"], "area_id": str(area.id),
                             "vm_interface_id": str(self.other_port.id)})
        self.assertEqual(r.status_code, 400)
        r = self._post(url, {"instance_id": inst["id"], "area_id": str(area.id),
                             "interface_id": str(self.eth0.id)})
        self.assertEqual(r.status_code, 400)
        r = self._post(url, {"instance_id": inst["id"], "area_id": str(area.id)})
        self.assertEqual(r.status_code, 400)
        r = self._post(url, {"instance_id": inst["id"], "area_id": str(area.id),
                             "vm_interface_id": str(self.ens3.id), "cost": 10})
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["instance"]["virtual_machine"]["name"], "ams-vr1")
        ctx = routing_context(self.vr)
        self.assertEqual(ctx["ospf"][0]["interfaces"][0]["interface"], "ens3")
        self.assertEqual(ctx["by_interface"]["ens3"]["ospf"]["cost"], 10)
        self.assertEqual(OSPFInstance.objects.get(pk=inst["id"]).owner, self.vr)

    def test_deleting_the_vm_takes_its_routing(self):
        BGPInstance.objects.create(tenant=self.tenant, virtual_machine=self.vr, asn=self.asn)
        StaticRoute.objects.create(tenant=self.tenant, virtual_machine=self.vr,
                                   prefix="0.0.0.0/0", next_hop="10.9.0.1")
        self.vr.delete()
        self.assertFalse(BGPInstance.objects.exists())
        self.assertFalse(StaticRoute.objects.exists())
