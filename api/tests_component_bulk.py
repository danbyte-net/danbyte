"""Component bulk edit — ComponentBulkMixin on interfaces / ports /
VM interfaces / component templates."""
from __future__ import annotations

from django.contrib.auth.models import User
from django.test import TestCase
from rest_framework.test import APIClient

from api.models import (
    ConsolePort, Device, DeviceType, Interface, InterfaceTemplate,
    VLAN, VirtualMachine, Cluster, ClusterType, VMInterface,
)
from core.models import Organization, Tag, Tenant


class ComponentBulkTests(TestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=self.org, name="T", slug="t")
        self.other = Tenant.objects.create(org=self.org, name="U", slug="u")
        self.admin = User.objects.create_superuser("cb-admin", password="x")
        self.client_api = APIClient()
        self.client_api.force_authenticate(self.admin)
        s = self.client_api.session
        s["tenant_id"] = str(self.tenant.id)
        s.save()

        self.dt = DeviceType.objects.create(tenant=self.tenant, name="SW")
        self.dev = Device.objects.create(
            tenant=self.tenant, name="sw1", device_type=self.dt
        )
        self.if1 = Interface.objects.create(device=self.dev, name="Gi0/1")
        self.if2 = Interface.objects.create(device=self.dev, name="Gi0/2")
        self.vlan = VLAN.objects.create(tenant=self.tenant, vlan_id=10, name="v10")
        self.foreign_vlan = VLAN.objects.create(
            tenant=self.other, vlan_id=99, name="v99"
        )

    def test_bulk_update_interfaces(self):
        r = self.client_api.post(
            "/api/interfaces/bulk-update/",
            {"ids": [str(self.if1.id), str(self.if2.id)],
             "fields": {"enabled": False, "mtu": 9000,
                        "vlan_id": str(self.vlan.id), "mode": "access"}},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["updated"], 2)
        self.if1.refresh_from_db()
        self.assertFalse(self.if1.enabled)
        self.assertEqual(self.if1.mtu, 9000)
        self.assertEqual(self.if1.vlan_id, self.vlan.id)
        self.assertEqual(self.if1.mode, "access")

    def test_bad_choice_rejected(self):
        r = self.client_api.post(
            "/api/interfaces/bulk-update/",
            {"ids": [str(self.if1.id)], "fields": {"mode": "pwn"}},
            format="json",
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("mode", r.json())
        self.if1.refresh_from_db()
        self.assertEqual(self.if1.mode, "")

    def test_grouped_choice_accepted(self):
        # Interface.type uses grouped choices — validation reads flatchoices,
        # so a real value from inside a group passes.
        r = self.client_api.post(
            "/api/interfaces/bulk-update/",
            {"ids": [str(self.if1.id)], "fields": {"type": "10gbase-x-sfpp"}},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.if1.refresh_from_db()
        self.assertEqual(self.if1.type, "10gbase-x-sfpp")

    def test_choice_field_clears_to_empty(self):
        self.if1.mode = "access"
        self.if1.save()
        r = self.client_api.post(
            "/api/interfaces/bulk-update/",
            {"ids": [str(self.if1.id)], "fields": {"mode": None}},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.if1.refresh_from_db()
        self.assertEqual(self.if1.mode, "")

    def test_free_text_str_field_unconstrained(self):
        # speed stays free-form (no model choices) — validation must not
        # touch it, only the choice-backed fields.
        r = self.client_api.post(
            "/api/interfaces/bulk-update/",
            {"ids": [str(self.if1.id)], "fields": {"speed": "40G"}},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.if1.refresh_from_db()
        self.assertEqual(self.if1.speed, "40G")

    def test_cross_tenant_fk_rejected(self):
        r = self.client_api.post(
            "/api/interfaces/bulk-update/",
            {"ids": [str(self.if1.id)],
             "fields": {"vlan_id": str(self.foreign_vlan.id)}},
            format="json",
        )
        self.assertEqual(r.status_code, 400)

    def test_unknown_field_rejected(self):
        r = self.client_api.post(
            "/api/interfaces/bulk-update/",
            {"ids": [str(self.if1.id)], "fields": {"device_id": "x"}},
            format="json",
        )
        self.assertEqual(r.status_code, 400)
        self.assertIn("device_id", r.json())

    def test_tags_add_remove(self):
        keep = Tag.objects.create(tenant=self.tenant, name="keep", slug="keep")
        gone = Tag.objects.create(tenant=self.tenant, name="gone", slug="gone")
        self.if1.tags.add(gone)
        r = self.client_api.post(
            "/api/interfaces/bulk-update/",
            {"ids": [str(self.if1.id)],
             "fields": {"add_tag_ids": [keep.id], "remove_tag_ids": [gone.id]}},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        slugs = {t.slug for t in self.if1.tags.all()}
        self.assertEqual(slugs, {"keep"})

    def test_console_ports_and_bulk_delete(self):
        c1 = ConsolePort.objects.create(device=self.dev, name="con0")
        c2 = ConsolePort.objects.create(device=self.dev, name="con1")
        r = self.client_api.post(
            "/api/console-ports/bulk-update/",
            {"ids": [str(c1.id), str(c2.id)], "fields": {"type": "rj-45"}},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        c1.refresh_from_db()
        self.assertEqual(c1.type, "rj-45")
        r = self.client_api.post(
            "/api/console-ports/bulk-delete/",
            {"ids": [str(c1.id), str(c2.id)]},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(ConsolePort.objects.count(), 0)

    def test_interface_templates(self):
        t1 = InterfaceTemplate.objects.create(device_type=self.dt, name="eth0")
        r = self.client_api.post(
            "/api/interface-templates/bulk-update/",
            {"ids": [str(t1.id)],
             "fields": {"type": "10gbase-x-sfpp", "mgmt_only": True}},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        t1.refresh_from_db()
        self.assertEqual(t1.type, "10gbase-x-sfpp")
        self.assertTrue(t1.mgmt_only)
        # Templates have no tags — tag keys must be rejected, not ignored.
        r = self.client_api.post(
            "/api/interface-templates/bulk-update/",
            {"ids": [str(t1.id)], "fields": {"add_tag_ids": [1]}},
            format="json",
        )
        self.assertEqual(r.status_code, 400)

    def test_vm_interfaces(self):
        ct = ClusterType.objects.create(tenant=self.tenant, name="c", slug="c")
        cl = Cluster.objects.create(tenant=self.tenant, name="C1", type=ct)
        vm = VirtualMachine.objects.create(
            tenant=self.tenant, name="vm1", cluster=cl
        )
        v1 = VMInterface.objects.create(vm=vm, name="eth0")
        r = self.client_api.post(
            "/api/vm-interfaces/bulk-update/",
            {"ids": [str(v1.id)],
             "fields": {"enabled": False, "vlan_id": str(self.vlan.id)}},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        v1.refresh_from_db()
        self.assertFalse(v1.enabled)
        self.assertEqual(v1.vlan_id, self.vlan.id)

    def test_foreign_tenant_rows_fall_out_of_selection(self):
        fdt = DeviceType.objects.create(tenant=self.other, name="X")
        fdev = Device.objects.create(
            tenant=self.other, name="alien", device_type=fdt
        )
        fif = Interface.objects.create(device=fdev, name="eth9")
        # A *valid* mode, so this still exercises tenant scoping rather than
        # tripping the choice validation first.
        r = self.client_api.post(
            "/api/interfaces/bulk-update/",
            {"ids": [str(fif.id)], "fields": {"mode": "access"}},
            format="json",
        )
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["updated"], 0)
        fif.refresh_from_db()
        self.assertEqual(fif.mode, "")
