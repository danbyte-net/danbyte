"""LLDP ghost links to a virtual chassis (#283).

A stack answers SNMP as one box: each polled member's neighbour table lists
the whole stack's neighbours, and a neighbour names the stack rather than a
member. A link belongs to the member that owns the port, once."""
from __future__ import annotations

from django.contrib.auth.models import User
from django.utils import timezone
from rest_framework.test import APITestCase

from api.models import Cable, CableTermination, Device, Interface, VirtualChassis
from core.models import Organization, Tenant

from .models import DeviceSnmp

STACK_TABLE = [
    {"local_port": "GigabitEthernet2/0/1", "remote_device": "access-x", "remote_port": "eth0"},
]


class StackGhostTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        vc = VirtualChassis.objects.create(tenant=self.tenant, name="stack1")
        self.m1 = Device.objects.create(tenant=self.tenant, name="stack1-1", virtual_chassis=vc,
                                        vc_position=1)
        self.m2 = Device.objects.create(tenant=self.tenant, name="stack1-2", virtual_chassis=vc,
                                        vc_position=2)
        vc.master = self.m1
        vc.save()
        Interface.objects.create(device=self.m1, name="GigabitEthernet1/0/1")
        self.port = Interface.objects.create(device=self.m2, name="GigabitEthernet2/0/1")
        self.x = Device.objects.create(tenant=self.tenant, name="access-x")
        self.eth0 = Interface.objects.create(device=self.x, name="eth0")
        # Both members polled: each holds the stack's whole table.
        for member in (self.m1, self.m2):
            self.snmp(member, "stack1", STACK_TABLE)
        self.snmp(self.x, "access-x", [{"local_port": "eth0", "remote_device": "stack1",
                                        "remote_port": "GigabitEthernet2/0/1"}])
        admin = User.objects.create_superuser("admin", "a@b.c", "x")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def snmp(self, device, sys_name, neighbors):
        DeviceSnmp.objects.update_or_create(
            tenant=self.tenant, device=device,
            defaults={"reachable": True, "polled_at": timezone.now(),
                      "data": {"sys_name": sys_name}, "neighbors": neighbors},
        )

    def ghosts(self, **params):
        return self.client.get("/api/monitoring/topology/ghosts/", params).json()

    def test_one_link_to_the_member_that_owns_the_port(self):
        (edge,) = self.ghosts()["edges"]
        self.assertEqual({edge["source"], edge["target"]},
                         {f"dev:{self.m2.id}", f"dev:{self.x.id}"})

    def test_no_link_once_that_member_is_cabled(self):
        cable = Cable.objects.create(tenant=self.tenant)
        CableTermination.objects.create(cable=cable, end="A", interface=self.port)
        CableTermination.objects.create(cable=cable, end="B", interface=self.eth0)
        self.assertEqual(self.ghosts()["edges"], [])

    def test_a_port_without_an_interface_goes_by_its_slot(self):
        self.port.delete()
        DeviceSnmp.objects.filter(device=self.m2).delete()  # only the master polled
        (edge,) = self.ghosts()["edges"]
        self.assertEqual({edge["source"], edge["target"]},
                         {f"dev:{self.m2.id}", f"dev:{self.x.id}"})

    def test_the_device_maps_show_the_member_with_the_link(self):
        r = self.ghosts(device=self.x.id)
        self.assertEqual({n["data"]["name"] for n in r["nodes"]}, {"access-x", "stack1-2"})
        self.assertEqual(len(r["edges"]), 1)
        self.assertEqual(self.ghosts(device=self.m1.id), {"nodes": [], "edges": []})
        r = self.ghosts(device=self.m2.id)
        self.assertEqual({n["data"]["name"] for n in r["nodes"]}, {"stack1-2", "access-x"})
