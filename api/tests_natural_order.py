"""Natural order (#244): names with numbers read 1, 2, 3 ... 10, 11 - in the
related lists a model's default ordering drives, in the list endpoints, and
in lists sorted in memory."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import (
    Cluster,
    ClusterType,
    Device,
    DeviceType,
    Interface,
    InventoryItem,
    Location,
    Manufacturer,
    Rack,
    Site,
    VirtualDisk,
    VirtualMachine,
)
from .natural import natural_key

User = get_user_model()


class NaturalKeyTests(SimpleTestCase):
    def test_numbers_compare_as_numbers(self):
        names = ["DIMM 10", "DIMM 2", "dimm 1", "DIMM 11", "DIMM 3"]
        self.assertEqual(
            sorted(names, key=natural_key),
            ["dimm 1", "DIMM 2", "DIMM 3", "DIMM 10", "DIMM 11"],
        )
        ports = ["Ethernet1/10", "Ethernet1/2", "Ethernet2/1", "Ethernet1/1"]
        self.assertEqual(
            sorted(ports, key=natural_key),
            ["Ethernet1/1", "Ethernet1/2", "Ethernet1/10", "Ethernet2/1"],
        )

    def test_odd_input(self):
        self.assertEqual(sorted(["b", None, "", "a2"], key=natural_key), [None, "", "a2", "b"])
        # A superscript digit is not a digit run; it must not break int().
        self.assertEqual(sorted(["x²", "x1"], key=natural_key), ["x1", "x²"])
        self.assertEqual(sorted([10, 9], key=natural_key), [9, 10])


class NaturalOrderTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="M", slug="m")
        self.dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="X")
        self.site = Site.objects.create(tenant=self.tenant, name="S")
        self.admin = User.objects.create_superuser("admin", "a@e.com", "x")
        self.client.force_login(self.admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

    def _device(self, name):
        return Device.objects.create(tenant=self.tenant, name=name, device_type=self.dt)

    def test_related_lists_default_to_natural_order(self):
        dev = self._device("sw1")
        for n in ("Ethernet1/10", "Ethernet1/2", "Ethernet1/1"):
            Interface.objects.create(device=dev, name=n)
        for n in ("DIMM 11", "DIMM 2", "DIMM 1"):
            InventoryItem.objects.create(device=dev, name=n, kind="ram")
        self.assertEqual(
            [i.name for i in dev.interfaces.all()],
            ["Ethernet1/1", "Ethernet1/2", "Ethernet1/10"],
        )
        self.assertEqual(
            [i.name for i in dev.inventory_items.all()], ["DIMM 1", "DIMM 2", "DIMM 11"]
        )
        ct = ClusterType.objects.create(tenant=self.tenant, name="pve", slug="pve")
        vm = VirtualMachine.objects.create(
            tenant=self.tenant, name="vm1",
            cluster=Cluster.objects.create(tenant=self.tenant, name="C", type=ct),
        )
        for key in ("scsi10", "scsi2", "scsi0"):
            VirtualDisk.objects.create(vm=vm, key=key)
        self.assertEqual([d.key for d in vm.disks.all()], ["scsi0", "scsi2", "scsi10"])

    def test_list_endpoints(self):
        for n in ("R10", "R2", "R1"):
            Rack.objects.create(tenant=self.tenant, site=self.site, name=n)
        r = self.client.get("/api/racks/?page_size=100")
        self.assertEqual(r.status_code, 200, r.content[:200])
        self.assertEqual([x["name"] for x in r.json()["results"]], ["R1", "R2", "R10"])

        for n in ("Room 10", "Room 2", "Room 1"):
            Location.objects.create(
                tenant=self.tenant, site=self.site, name=n, slug=n.lower().replace(" ", "-")
            )
        r = self.client.get("/api/locations/?page_size=100")
        self.assertEqual(r.status_code, 200, r.content[:200])
        self.assertEqual(
            [x["name"] for x in r.json()["results"]], ["Room 1", "Room 2", "Room 10"]
        )

        # Across devices the device name orders first, naturally too.
        for d in ("sw10", "sw2", "sw1"):
            dev = self._device(d)
            for n in ("eth10", "eth2"):
                Interface.objects.create(device=dev, name=n)
        r = self.client.get("/api/interfaces/?page_size=100")
        self.assertEqual(r.status_code, 200, r.content[:200])
        rows = [(x["device"]["name"], x["name"]) for x in r.json()["results"]]
        self.assertEqual(rows, [
            ("sw1", "eth2"), ("sw1", "eth10"),
            ("sw2", "eth2"), ("sw2", "eth10"),
            ("sw10", "eth2"), ("sw10", "eth10"),
        ])
