"""Spec sheet PDFs (#150): the context carries what the page shows, hidden
custom fields stay out, and the endpoint answers with a PDF under RBAC."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from core.models import Organization, Tenant
from customization.models import CustomField

from .models import (
    Cable,
    CableTermination,
    Cluster,
    ClusterType,
    Device,
    DeviceType,
    Interface,
    Manufacturer,
    VirtualChassis,
    VirtualDisk,
    VirtualMachine,
    VMInterface,
)
from .spec_sheets import (
    device_context,
    device_full_context,
    device_hardware_context,
    render_spec_html,
    spec_filename,
    vm_context,
)

User = get_user_model()


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="Cisco", slug="cisco")
        self.dt = DeviceType.objects.create(
            tenant=self.tenant, manufacturer=mfr, model="C9300-24T", u_height=1
        )
        self.device = Device.objects.create(
            tenant=self.tenant, name="aarhus-sw1", device_type=self.dt,
            serial_number="FOC1234", asset_tag="A-1", comments="Core switch, row 3.",
            custom_fields={"support": "gold", "netbox_id": "42"},
        )
        self.peer = Device.objects.create(tenant=self.tenant, name="aarhus-core1", device_type=self.dt)
        self.i1 = Interface.objects.create(
            device=self.device, name="GigabitEthernet1/0/1", mac_address="00:1b:44:11:3a:b7",
            speed="1G",
        )
        p = Interface.objects.create(device=self.peer, name="Ethernet1/10")
        cable = Cable.objects.create(tenant=self.tenant)
        CableTermination.objects.create(cable=cable, end="A", interface=self.i1)
        CableTermination.objects.create(cable=cable, end="B", interface=p)
        CustomField.objects.create(
            tenant=self.tenant, key="support", label="Support tier", applies_to=["device"]
        )
        CustomField.objects.create(
            tenant=self.tenant, key="netbox_id", label="NetBox id", applies_to=["device"],
            hidden=True,
        )
        self.admin = User.objects.create_superuser("admin", "a@e.com", "x")
        self.client.force_login(self.admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()


class DeviceSheetTests(_Base):
    def test_context_carries_the_page(self):
        ctx = device_context(self.device)
        self.assertEqual(ctx["name"], "aarhus-sw1")
        self.assertEqual(ctx["stats"][0], {"label": "Interfaces", "value": "1"})
        details = dict(ctx["details"])
        self.assertEqual(details["Serial number"], "FOC1234")
        self.assertEqual(details["Type"], "Cisco C9300-24T")
        self.assertEqual(details["Support tier"], "gold")
        self.assertNotIn("NetBox id", details)
        row = ctx["interfaces"][0]
        self.assertEqual(row["peer"], "aarhus-core1:Ethernet1/10")
        self.assertEqual(row["mac"], "00:1b:44:11:3a:b7")
        self.assertEqual(ctx["comments"], "Core switch, row 3.")

    def test_ports_follow_the_counting_rule(self):
        """The sheet's Port utilization block is the device card's: virtual
        interfaces only when the deployment counts them (0.17)."""
        from core.models import DeploymentSettings

        Interface.objects.create(device=self.device, name="Vlan10", virtual=True)
        ports = device_context(self.device)["ports"]
        self.assertEqual((ports["used"], ports["total"]), (1, 1))
        ds = DeploymentSettings.load()
        ds.port_count_virtual = True
        ds.save()
        ports = device_context(self.device)["ports"]
        self.assertEqual((ports["used"], ports["total"], ports["pct"]), (1, 2, 50))

    def test_html_and_pdf(self):
        html = render_spec_html("device", self.device)
        self.assertIn("aarhus-sw1", html)
        self.assertIn("FOC1234", html)
        self.assertNotIn("netbox_id", html)
        self.assertNotIn("42</div>", html)
        r = self.client.get(f"/api/devices/{self.device.id}/spec-sheet/")
        self.assertEqual(r.status_code, 200, r.content[:200])
        self.assertEqual(r["Content-Type"], "application/pdf")
        self.assertTrue(r.content.startswith(b"%PDF"))
        self.assertIn("inline", r["Content-Disposition"])
        self.assertIn("aarhus-sw1-spec-", r["Content-Disposition"])
        r = self.client.get(f"/api/devices/{self.device.id}/spec-sheet/?download=1")
        self.assertIn("attachment", r["Content-Disposition"])

    def test_hardware_variant(self):
        from .models import InventoryItem

        mk = InventoryItem.objects.create
        for n, slot in (("CPU1", "Socket 1"), ("CPU2", "Socket 2")):
            mk(device=self.device, name=n, kind="cpu", slot=slot, speed="3.0 GHz",
               cores=18, description="Intel Xeon Gold 6154")
        for n, slot in (("RAM1", "DIMM A1"), ("RAM2", "DIMM B1")):
            mk(device=self.device, name=n, kind="ram", slot=slot, speed="DDR4-2666",
               capacity_bytes=64_000_000_000)
        mk(device=self.device, name="Disk 0", kind="disk", media="ssd",
           capacity_bytes=960_000_000_000, speed="SATA 6Gb/s")
        # No recorded figure on a third socket: the "36 x …" the BMC wrote
        # into the description counts instead.
        mk(device=self.device, name="CPU3", kind="cpu", slot="Socket 3",
           description="36 x Intel(R) Xeon(R) Gold 6154")
        ctx = device_hardware_context(self.device)
        stats = {s["label"]: s for s in ctx["stats"]}
        self.assertEqual(stats["CPU"]["value"], "72 cores")
        for bit in ("3 sockets", "3.0 GHz", "Intel Xeon Gold 6154"):
            self.assertIn(bit, stats["CPU"]["hint"])
        self.assertEqual(stats["Memory"]["value"], "128 GB")
        self.assertIn("2 × 64 GB", stats["Memory"]["hint"])
        self.assertIn("DDR4-2666", stats["Memory"]["hint"])
        self.assertEqual(stats["Storage"]["value"], "960 GB")
        self.assertEqual(ctx["cpus"][0]["slot"], "Socket 1")
        self.assertEqual(ctx["cpus"][2]["model"], "Intel(R) Xeon(R) Gold 6154")
        self.assertNotIn("36 x", stats["CPU"]["hint"])
        self.assertNotIn("interfaces", ctx)
        self.assertNotIn("ports", ctx)
        html = render_spec_html("device_hardware", self.device)
        self.assertIn("Processors", html)
        self.assertIn("Socket 2", html)
        r = self.client.get(f"/api/devices/{self.device.id}/spec-sheet/?variant=hardware")
        self.assertEqual(r.status_code, 200, r.content[:200])
        self.assertTrue(r.content.startswith(b"%PDF"))
        # The serial number names the file, not the date.
        self.assertIn("aarhus-sw1-spec-hardware-FOC1234.pdf", r["Content-Disposition"])

        # The all-in-one sheet: the datasheet's boxes, plus the hardware block
        # and the interfaces.
        full = device_full_context(self.device)
        self.assertEqual(full["stats"][0]["label"], "Interfaces")
        self.assertEqual(full["hardware_stats"][0]["value"], "72 cores")
        self.assertEqual(len(full["interfaces"]), 1)
        html = render_spec_html("device_full", self.device)
        for bit in ("Processors", "DIMM B1", "Interfaces", "aarhus-core1:Ethernet1/10"):
            self.assertIn(bit, html)
        r = self.client.get(f"/api/devices/{self.device.id}/spec-sheet/?variant=full")
        self.assertEqual(r.status_code, 200, r.content[:200])
        self.assertIn("aarhus-sw1-spec-full-FOC1234.pdf", r["Content-Disposition"])

    def test_memory_in_gb_and_parts_in_natural_order(self):
        """#244: a BMC stores DIMMs in binary bytes, so 16 x 64 GiB used to
        read "1.1 TB" and "16 x 68.72 GB"; and synced parts carry no slot, so
        their names ordered them as DIMM 1, DIMM 10, DIMM 11, ..., DIMM 2."""
        from .models import InventoryItem

        order = (16, 3, 12, 1, 10, 2, 11, 4, 9, 5, 15, 6, 14, 7, 13, 8)
        for n in order:
            InventoryItem.objects.create(
                device=self.device, name=f"DIMM {n}", kind="ram",
                capacity_bytes=64 * 1024**3, speed="4800 MT/s",
            )
        for n in (10, 2, 1):
            InventoryItem.objects.create(
                device=self.device, name=f"Disk {n}", kind="disk", slot=f"Bay {n}",
                capacity_bytes=960_000_000_000,
            )
        ctx = device_hardware_context(self.device)
        stats = {s["label"]: s for s in ctx["stats"]}
        self.assertEqual(stats["Memory"]["value"], "1024 GB")
        self.assertIn("16 × 64 GB", stats["Memory"]["hint"])
        self.assertEqual([r["name"] for r in ctx["rams"]], [f"DIMM {n}" for n in range(1, 17)])
        self.assertEqual(ctx["rams"][0]["capacity"], "64 GB")
        # Disks keep the decimal, largest-unit formatting.
        self.assertEqual(stats["Storage"]["value"], "2.88 TB")
        self.assertEqual([r["slot"] for r in ctx["disks"]], ["Bay 1", "Bay 2", "Bay 10"])
        # The Modules and inventory list on the datasheet reads the same way.
        names = [r["name"] for r in device_context(self.device)["inventory"]]
        self.assertEqual(names[:3], ["DIMM 1", "DIMM 2", "DIMM 3"])
        self.assertEqual(names[-3:], ["Disk 1", "Disk 2", "Disk 10"])

        html = render_spec_html("device_hardware", self.device)
        at = [html.index(f"<td>DIMM {n}</td>") for n in range(1, 17)]
        self.assertEqual(at, sorted(at))
        self.assertIn("1024 GB", html)

    def test_mixed_sizes_count_each_size(self):
        """Two 2 TB and eight 10 TB disks read "2 × 2 TB · 8 × 10 TB", not ten
        times the most common size; mixed DIMMs likewise."""
        from .models import InventoryItem

        mk = InventoryItem.objects.create
        for n in range(8):
            mk(device=self.device, name=f"Data {n}", kind="disk", media="hdd",
               capacity_bytes=10_000_000_000_000)
        for n in range(2):
            mk(device=self.device, name=f"Boot {n}", kind="disk", media="hdd",
               capacity_bytes=2_000_000_000_000)
        for n, size in enumerate((32, 32, 64, 64, 64, 64)):
            mk(device=self.device, name=f"DIMM {n}", kind="ram",
               capacity_bytes=size * 1024**3)
        stats = {s["label"]: s for s in device_hardware_context(self.device)["stats"]}
        self.assertEqual(stats["Storage"]["value"], "84 TB")
        self.assertIn("2 × 2 TB · 8 × 10 TB", stats["Storage"]["hint"])
        self.assertNotIn("10 × ", stats["Storage"]["hint"])
        self.assertEqual(stats["Memory"]["value"], "320 GB")
        self.assertIn("2 × 32 GB · 4 × 64 GB", stats["Memory"]["hint"])

        # Mixed media: each size names its medium, and no medium trails.
        InventoryItem.objects.filter(name__startswith="Boot").update(media="ssd")
        hint = {s["label"]: s for s in device_hardware_context(self.device)["stats"]}["Storage"]["hint"]
        self.assertTrue(hint.startswith("2 × 2 TB SSD"), hint)
        self.assertIn("8 × 10 TB HDD", hint)

    def test_slots_order_before_names(self):
        from .models import InventoryItem

        for n in (12, 1, 10, 2, 11, 3):
            InventoryItem.objects.create(
                device=self.device, name=f"RAM{13 - n}", kind="ram", slot=f"DIMM A{n}",
                capacity_bytes=32_000_000_000,
            )
        ctx = device_hardware_context(self.device)
        self.assertEqual(
            [r["slot"] for r in ctx["rams"]],
            ["DIMM A1", "DIMM A2", "DIMM A3", "DIMM A10", "DIMM A11", "DIMM A12"],
        )
        self.assertEqual(ctx["stats"][1]["value"], "192 GB")

    def test_memory_formatting(self):
        from .spec_sheets import _memory, format_memory

        self.assertEqual(format_memory(32 * 1024**3), "32 GB")  # BMC, binary
        self.assertEqual(format_memory(32_000_000_000), "32 GB")  # form, decimal
        self.assertEqual(format_memory(512 * 1024**2), "0.5 GB")
        self.assertEqual(format_memory(1_500_000_000), "1.5 GB")
        self.assertEqual(format_memory(33_300_000_000), "33.3 GB")
        self.assertEqual(format_memory(None), "")
        self.assertEqual(format_memory(0), "")
        self.assertEqual(_memory(1536), "1.5 GB")
        self.assertEqual(_memory(1024 * 1024), "1024 GB")
        self.assertEqual(_memory(0), "—")

    def test_needs_view_permission(self):
        member = User.objects.create_user("m", password="x")
        self.client.force_login(member)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()
        r = self.client.get(f"/api/devices/{self.device.id}/spec-sheet/")
        self.assertIn(r.status_code, (403, 404))

    def test_filename_is_safe(self):
        self.device.name = "sw 1/core (a)"
        self.device.serial_number = "FOC 12/34"
        self.assertEqual(spec_filename(self.device), "sw-1-core-a-spec-FOC-12-34.pdf")
        # No serial: the date names the file instead.
        self.device.serial_number = ""
        self.assertRegex(spec_filename(self.device), r"^sw-1-core-a-spec-\d{4}-\d{2}-\d{2}\.pdf$")


class VmSheetTests(_Base):
    def setUp(self):
        super().setUp()
        ct = ClusterType.objects.create(tenant=self.tenant, name="vmware", slug="vmware")
        cl = Cluster.objects.create(tenant=self.tenant, name="C1", type=ct)
        self.vm = VirtualMachine.objects.create(
            tenant=self.tenant, name="hq-web1", cluster=cl, vcpus=4, memory_mb=8192,
        )
        VirtualDisk.objects.create(vm=self.vm, key="disk0", name="Hard disk 1", size_gb=40)
        VirtualDisk.objects.create(vm=self.vm, key="disk1", name="Hard disk 2", size_gb=100)
        VMInterface.objects.create(vm=self.vm, name="Network adapter 1", mac_address="00:50:56:82:04:ea")

    def test_context_and_pdf(self):
        ctx = vm_context(self.vm)
        self.assertEqual([s["value"] for s in ctx["stats"]], ["4", "8 GB", "140 GB"])
        self.assertEqual(dict(ctx["details"])["Cluster"], "C1")
        self.assertEqual(len(ctx["disks"]), 2)
        self.assertEqual(ctx["interfaces"][0]["mac"], "00:50:56:82:04:ea")
        r = self.client.get(f"/api/virtual-machines/{self.vm.id}/spec-sheet/")
        self.assertEqual(r.status_code, 200, r.content[:200])
        self.assertTrue(r.content.startswith(b"%PDF"))


class StackSheetTests(_Base):
    def test_stack_context_and_pdf(self):
        vc = VirtualChassis.objects.create(tenant=self.tenant, name="aarhus-stack1", domain="d1")
        Device.objects.filter(pk__in=[self.device.pk, self.peer.pk]).update(virtual_chassis=vc)
        Device.objects.filter(pk=self.device.pk).update(vc_position=1, vc_priority=15)
        Device.objects.filter(pk=self.peer.pk).update(vc_position=2, vc_priority=10)
        vc.master = Device.objects.get(pk=self.device.pk)
        vc.save()
        from .spec_sheets import vc_context

        ctx = vc_context(vc)
        self.assertEqual(ctx["stats"][0], {"label": "Members", "value": "2"})
        self.assertEqual([m["role"] for m in ctx["members"]], ["Master", "Member"])
        self.assertEqual(dict(ctx["details"])["Domain"], "d1")
        self.assertEqual(ctx["member_ifaces"][0]["label"], "1 · aarhus-sw1 · master")
        self.assertEqual(ctx["member_ifaces"][0]["rows"][0]["peer"], "aarhus-core1:Ethernet1/10")
        r = self.client.get(f"/api/virtual-chassis/{vc.id}/spec-sheet/")
        self.assertEqual(r.status_code, 200, r.content[:200])
        self.assertTrue(r.content.startswith(b"%PDF"))
