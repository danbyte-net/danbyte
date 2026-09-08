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
    VirtualDisk,
    VirtualMachine,
    VMInterface,
)
from .spec_sheets import device_context, render_spec_html, spec_filename, vm_context

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
