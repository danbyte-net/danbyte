"""The virtual network payload carries the colors the Virtual topology draws.

``GET /api/virt-networks/`` names each network's VLAN status and each VM's
status and role as data (id, name, color), so the rail diagram colors its
rails, cards and pills from them and never from a name - and whether each
status is its kind's default, which the diagram draws without a pill. The
VMs listed are only those the caller may view.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.test import TestCase

from api.models import (
    VLAN,
    Cluster,
    ClusterType,
    DeviceRole,
    Site,
    Status,
    VirtualMachine,
    VirtualSwitch,
    VMInterface,
)
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant
from integrations.models import (
    IntegrationSettings,
    VirtNetwork,
    VirtNetworkLink,
    VirtualizationSource,
)


class VirtNetworkColorsTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        IntegrationSettings.objects.create(
            tenant=self.tenant, virt_proxmox_enabled=True,
            virt_vcenter_enabled=True,
        )
        source = VirtualizationSource.objects.create(
            tenant=self.tenant, name="pve", host="192.0.2.30",
            credentials={"token_id": "a@pam!t", "secret": "s"},
        )
        kinds = ["virtualmachine", "vlan"]
        self.active = Status.objects.create(
            tenant=self.tenant, name="Active", slug="active", color="#22c55e",
            available_to=kinds, default_for=kinds,
        )
        self.role = DeviceRole.objects.create(
            tenant=self.tenant, name="App", slug="app", color="#0ea5e9"
        )
        self.vlan = VLAN.objects.create(
            tenant=self.tenant, vlan_id=10, name="dmz", status=self.active
        )
        sw = VirtualSwitch.objects.create(tenant=self.tenant, name="vmbr0")
        self.net = VirtNetwork.objects.create(
            source=source, ext_key="vmbr0:10", name="DMZ", vswitch=sw,
            vlan=self.vlan,
        )
        ct = ClusterType.objects.create(tenant=self.tenant, name="pve")
        cl = Cluster.objects.create(tenant=self.tenant, name="c1", type=ct)
        self.vm = VirtualMachine.objects.create(
            tenant=self.tenant, name="web-01", cluster=cl, role=self.role,
            status=self.active,
        )
        nic = VMInterface.objects.create(vm=self.vm, name="net0")
        VirtNetworkLink.objects.create(network=self.net, vm_interface=nic)
        # A second VM on the network by VLAN alone, with no status or role.
        self.bare = VirtualMachine.objects.create(
            tenant=self.tenant, name="db-01", cluster=cl
        )
        VMInterface.objects.create(vm=self.bare, name="eth0", vlan=self.vlan)

        user = get_user_model().objects.create_superuser("admin", "a@b.c", "pw")
        self.client.force_login(user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def _row(self):
        r = self.client.get("/api/virt-networks/")
        self.assertEqual(r.status_code, 200, r.content)
        (row,) = r.json()["results"]
        return row

    def _mini(self, s, is_default=True):
        return {
            "id": str(s.id), "name": s.name, "slug": s.slug,
            "color": s.color, "text_color": s.text_color,
            "is_default": is_default,
        }

    def test_the_vlan_carries_its_status(self):
        vlan = self._row()["vlan"]
        self.assertEqual(vlan["status"], self._mini(self.active))
        self.assertEqual(vlan["vlan_id"], 10)

    def test_a_status_says_whether_it_is_its_kinds_default(self):
        # Active is the default for VMs only now: the VLAN wears a pill.
        Status.objects.filter(pk=self.active.pk).update(
            default_for=["virtualmachine"]
        )
        row = self._row()
        self.assertFalse(row["vlan"]["status"]["is_default"])
        vms = {v["name"]: v for v in row["vms"]}
        self.assertTrue(vms["web-01"]["status_mini"]["is_default"])

    def test_a_vlan_without_a_status_says_none(self):
        VLAN.objects.filter(pk=self.vlan.pk).update(status=None)
        self.assertIsNone(self._row()["vlan"]["status"])

    def test_vms_carry_status_and_role(self):
        vms = {v["name"]: v for v in self._row()["vms"]}
        web, db = vms["web-01"], vms["db-01"]
        self.assertEqual(web["status_mini"], self._mini(self.active))
        self.assertEqual(
            web["role"],
            {"id": str(self.role.id), "name": "App", "color": "#0ea5e9"},
        )
        # The display name and the leg's interface stay.
        self.assertEqual((web["status"], web["iface"]), ("Active", "net0"))
        self.assertIsNone(db["status_mini"])
        self.assertIsNone(db["role"])


class VirtNetworkVmScopeTests(TestCase):
    """A network lists only the VMs the caller may view: its own grant
    does not open the VMs on it."""

    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        IntegrationSettings.objects.create(
            tenant=self.tenant, virt_proxmox_enabled=True,
            virt_vcenter_enabled=True,
        )
        source = VirtualizationSource.objects.create(
            tenant=self.tenant, name="pve", host="192.0.2.30",
            credentials={"token_id": "a@pam!t", "secret": "s"},
        )
        self.site_a = Site.objects.create(tenant=self.tenant, name="A")
        self.site_b = Site.objects.create(tenant=self.tenant, name="B")
        vlan = VLAN.objects.create(tenant=self.tenant, vlan_id=10, name="dmz")
        self.net = VirtNetwork.objects.create(
            source=source, ext_key="vmbr0:10", name="DMZ", vlan=vlan,
        )
        ct = ClusterType.objects.create(tenant=self.tenant, name="pve")
        cl = Cluster.objects.create(tenant=self.tenant, name="c1", type=ct)
        # One VM by the sync's link, one by VLAN inference, in two sites.
        web = VirtualMachine.objects.create(
            tenant=self.tenant, name="web-01", cluster=cl, site=self.site_a
        )
        nic = VMInterface.objects.create(vm=web, name="net0")
        VirtNetworkLink.objects.create(network=self.net, vm_interface=nic)
        db = VirtualMachine.objects.create(
            tenant=self.tenant, name="db-01", cluster=cl, site=self.site_b
        )
        VMInterface.objects.create(vm=db, name="eth0", vlan=vlan)

        self.user = get_user_model().objects.create_user("op", password="x")
        UserProfile.objects.create(user=self.user, role="custom").tenants.add(
            self.tenant
        )
        self._grant("virtnetwork")
        self.client.force_login(self.user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def _grant(self, obj_type, site=None):
        perm = ObjectPermission.objects.create(
            name=f"{obj_type}-view", object_types=[obj_type], actions=["view"]
        )
        perm.users.add(self.user)
        perm.tenants.add(self.tenant)
        if site is not None:
            perm.sites.add(site)

    def _vms(self):
        r = self.client.get("/api/virt-networks/")
        self.assertEqual(r.status_code, 200, r.content)
        (row,) = r.json()["results"]
        return sorted(v["name"] for v in row["vms"])

    def test_no_vm_grant_lists_no_vms(self):
        self.assertEqual(self._vms(), [])

    def test_a_site_scoped_vm_grant_lists_that_sites_vms(self):
        self._grant("virtualmachine", site=self.site_a)
        self.assertEqual(self._vms(), ["web-01"])

    def test_a_vm_grant_lists_every_vm(self):
        self._grant("virtualmachine")
        self.assertEqual(self._vms(), ["db-01", "web-01"])
