from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import (
    Cable,
    CableTermination,
    Device,
    FrontPort,
    Interface,
    RearPort,
    Status,
)

User = get_user_model()


class PortUtilizationTests(APITestCase):
    """/api/devices/<id>/port-utilization/ (issue #64).

    Connected = port terminates a cable; reserved = that cable's status is
    "planned"; free = no cable.
    """

    def setUp(self):
        self.org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=self.org, name="Acme", slug="acme")
        admin = User.objects.create_superuser("admin", "a@example.com", "x")
        self.client.force_login(admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

        self.planned = Status.objects.create(
            tenant=self.tenant, name="Planned", slug="planned",
            available_to=["cable"],
        )
        self.dev = Device.objects.create(tenant=self.tenant, name="pp-01")
        self.other = Device.objects.create(tenant=self.tenant, name="sw-01")

    def _cable(self, status=None, **term):
        c = Cable.objects.create(tenant=self.tenant, status=status)
        CableTermination.objects.create(cable=c, end="A", **term)
        return c

    def test_counts_connected_reserved_free(self):
        # 3 interfaces: one patched, one planned (reserved), one free.
        i1 = Interface.objects.create(device=self.dev, name="Gi1")
        i2 = Interface.objects.create(device=self.dev, name="Gi2")
        Interface.objects.create(device=self.dev, name="Gi3")
        self._cable(interface=i1)
        self._cable(status=self.planned, interface=i2)
        # 2 front ports: one patched, one free; 1 rear port, free.
        rp = RearPort.objects.create(device=self.dev, name="R1", positions=4)
        f1 = FrontPort.objects.create(
            device=self.dev, name="F1", rear_port=rp, rear_port_position=1
        )
        FrontPort.objects.create(
            device=self.dev, name="F2", rear_port=rp, rear_port_position=2
        )
        self._cable(front_port=f1)

        r = self.client.get(f"/api/devices/{self.dev.id}/port-utilization/")
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertEqual(
            body["interfaces"],
            {"total": 3, "connected": 1, "reserved": 1, "free": 1, "marked": 0},
        )
        self.assertEqual(
            body["front_ports"],
            {"total": 2, "connected": 1, "reserved": 0, "free": 1, "marked": 0},
        )
        self.assertEqual(
            body["rear_ports"],
            {"total": 1, "connected": 0, "reserved": 0, "free": 1, "marked": 0},
        )
        self.assertEqual(
            body["combined"],
            {"total": 6, "connected": 2, "reserved": 1, "free": 3, "marked": 0},
        )

    def test_statusless_cable_counts_as_connected(self):
        i = Interface.objects.create(device=self.dev, name="Gi1")
        self._cable(interface=i)
        body = self.client.get(
            f"/api/devices/{self.dev.id}/port-utilization/"
        ).json()
        self.assertEqual(body["interfaces"]["connected"], 1)
        self.assertEqual(body["interfaces"]["reserved"], 0)

    def test_other_devices_ports_do_not_leak_in(self):
        Interface.objects.create(device=self.other, name="Gi1")
        body = self.client.get(
            f"/api/devices/{self.dev.id}/port-utilization/"
        ).json()
        self.assertEqual(body["combined"]["total"], 0)

    def test_marked_counts_as_connected_and_clears_on_cable(self):
        # Two interfaces: one mark_connected (undocumented), one free.
        i1 = Interface.objects.create(
            device=self.dev, name="Gi1", mark_connected=True
        )
        Interface.objects.create(device=self.dev, name="Gi2")
        body = self.client.get(
            f"/api/devices/{self.dev.id}/port-utilization/"
        ).json()
        self.assertEqual(
            body["interfaces"],
            {"total": 2, "connected": 1, "reserved": 0, "free": 1, "marked": 1},
        )
        # Documenting a real cable retires the placeholder flag.
        self._cable(interface=i1)
        i1.refresh_from_db()
        self.assertFalse(i1.mark_connected)
        body = self.client.get(
            f"/api/devices/{self.dev.id}/port-utilization/"
        ).json()
        self.assertEqual(body["interfaces"]["marked"], 0)
        self.assertEqual(body["interfaces"]["connected"], 1)

    def test_excluded_status_ports_leave_the_math(self):
        """A Not-present stack port is not capacity - free or otherwise
        (#105). Only the excludes_capacity flag matters, not the slug."""
        absent = Status.objects.create(
            tenant=self.tenant, name="Not Present", slug="not_present",
            available_to=["interface"], excludes_capacity=True,
        )
        Interface.objects.create(device=self.dev, name="Gi1")
        Interface.objects.create(device=self.dev, name="2/1", status=absent)
        Interface.objects.create(device=self.dev, name="2/2", status=absent)

        r = self.client.get(f"/api/devices/{self.dev.id}/port-utilization/")
        self.assertEqual(r.status_code, 200, r.content)
        combined = r.json()["combined"]
        self.assertEqual(combined["total"], 1)
        self.assertEqual(combined["free"], 1)

        from api.models import Device as D
        from api.port_utilization import device_port_counts

        counts = device_port_counts(D.objects.filter(pk=self.dev.pk))
        self.assertEqual(counts[self.dev.id]["total"], 1)

    def test_rollup_lists_port_devices_fullest_first(self):
        # pp-01: 1 of 2 interfaces cabled (50%); sw-01: 1 of 1 (100%).
        i1 = Interface.objects.create(device=self.dev, name="Gi1")
        Interface.objects.create(device=self.dev, name="Gi2")
        self._cable(interface=i1)
        o1 = Interface.objects.create(device=self.other, name="Gi1")
        self._cable(status=self.planned, interface=o1)
        # A portless device stays out of the roll-up entirely.
        Device.objects.create(tenant=self.tenant, name="cam-01")

        r = self.client.get("/api/devices/port-utilization/")
        self.assertEqual(r.status_code, 200, r.content)
        rows = r.json()["results"]
        self.assertEqual([x["name"] for x in rows], ["sw-01", "pp-01"])
        self.assertEqual(rows[0]["pct"], 100)
        self.assertEqual(rows[0]["reserved"], 1)
        self.assertEqual(rows[1]["pct"], 50)
        self.assertEqual(rows[1]["free"], 1)


class StackPortUtilizationTests(PortUtilizationTests):
    """/api/virtual-chassis/<id>/port-utilization/ sums the members."""

    def test_stack_sums_its_members(self):
        from .models import VirtualChassis

        vc = VirtualChassis.objects.create(tenant=self.tenant, name="stack")
        Device.objects.filter(pk__in=[self.dev.pk, self.other.pk]).update(virtual_chassis=vc)
        i1 = Interface.objects.create(device=self.dev, name="Gi1")
        Interface.objects.create(device=self.dev, name="Gi2")
        i3 = Interface.objects.create(device=self.other, name="Gi1")
        Interface.objects.create(device=self.other, name="Gi2", mark_connected=True)
        self._cable(interface=i1)
        self._cable(status=self.planned, interface=i3)
        Device.objects.create(tenant=self.tenant, name="loner")  # not in the stack
        body = self.client.get(f"/api/virtual-chassis/{vc.id}/port-utilization/").json()
        self.assertEqual(
            body["interfaces"],
            {"total": 4, "connected": 2, "reserved": 1, "free": 1, "marked": 1},
        )
        self.assertEqual(body["combined"]["total"], 4)
        # The per-device card is unchanged by the refactor.
        one = self.client.get(f"/api/devices/{self.dev.id}/port-utilization/").json()
        self.assertEqual(one["interfaces"]["connected"], 1)

