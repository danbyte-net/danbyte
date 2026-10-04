"""Per-VM render endpoint - the Terraform-for-VMs pull surface."""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.models import (
    Cluster, ClusterType, ExportTemplate, IPAddress, Prefix, VirtualMachine,
)
from auth_api.models import UserProfile
from core.models import Organization, Tenant


from api.test_utils import status_for


class VmRenderTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.su = User.objects.create_user("su", password="x", is_superuser=True)
        prof = UserProfile.objects.create(user=self.su)
        prof.tenants.add(self.tenant)
        prof.current_tenant = self.tenant
        prof.save()
        ct = ClusterType.objects.create(tenant=self.tenant, name="vSphere", slug="vsphere")
        cluster = Cluster.objects.create(tenant=self.tenant, name="dc1", type=ct)
        pfx = Prefix.objects.create(tenant=self.tenant, cidr="10.0.0.0/24", status=status_for(self.tenant))
        ip = IPAddress.objects.create(tenant=self.tenant, ip_address="10.0.0.9", prefix=pfx)
        self.vm = VirtualMachine.objects.create(
            tenant=self.tenant, name="web01", cluster=cluster, primary_ip=ip,
            vcpus=4, memory_mb=8192,
        )
        self.tmpl = ExportTemplate.objects.create(
            tenant=self.tenant, name="tfvars", object_type="virtualmachine",
            template_code='name = "{{ vm.name }}"\ncpus = {{ vm.vcpus }}',
        )
        self.client.force_login(self.su)
        self.client.post(f"/api/tenants/{self.tenant.id}/switch/")

    def _url(self, vm=None, tmpl=None):
        v = vm or self.vm
        t = tmpl or self.tmpl
        return f"/api/virtual-machines/{v.id}/render/?template={t.id}"

    def test_renders_tfvars(self):
        res = self.client.get(self._url())
        self.assertEqual(res.status_code, 200)
        self.assertIn('name = "web01"', res.json()["output"])
        self.assertIn("cpus = 4", res.json()["output"])
        self.assertEqual(res.json()["template"], "tfvars")

    def test_device_alias_in_context(self):
        # `device` is aliased to the VM for template parity.
        t = ExportTemplate.objects.create(
            tenant=self.tenant, name="alias", object_type="virtualmachine",
            template_code="{{ device.name }}",
        )
        res = self.client.get(self._url(tmpl=t))
        self.assertEqual(res.json()["output"], "web01")

    def test_unknown_template_400(self):
        res = self.client.get(
            f"/api/virtual-machines/{self.vm.id}/render/"
            f"?template=00000000-0000-0000-0000-000000000000"
        )
        self.assertEqual(res.status_code, 400)

    def test_unknown_vm_404(self):
        res = self.client.get(
            f"/api/virtual-machines/00000000-0000-0000-0000-000000000000/render/"
            f"?template={self.tmpl.id}"
        )
        self.assertEqual(res.status_code, 404)

    def test_cross_tenant_vm_hidden(self):
        other = Tenant.objects.create(
            org=self.tenant.org, name="U", slug="u"
        )
        ct = ClusterType.objects.create(tenant=other, name="x", slug="x")
        cl = Cluster.objects.create(tenant=other, name="c", type=ct)
        vm2 = VirtualMachine.objects.create(tenant=other, name="secret", cluster=cl)
        res = self.client.get(self._url(vm=vm2))
        self.assertEqual(res.status_code, 404)


class VmRenderScopeTests(APITestCase):
    """A template walking a relation sees only the rows the caller may view,
    as the export path does (#255)."""

    def test_cluster_neighbours_outside_scope_stay_out(self):
        from api.models import Site
        from auth_api.models import ObjectPermission

        org = Organization.objects.create(name="O", slug="o")
        tenant = Tenant.objects.create(org=org, name="T", slug="t")
        hq = Site.objects.create(tenant=tenant, name="HQ")
        branch = Site.objects.create(tenant=tenant, name="Branch")
        ct = ClusterType.objects.create(tenant=tenant, name="vSphere", slug="vsphere")
        cluster = Cluster.objects.create(tenant=tenant, name="c1", type=ct)
        vm_a = VirtualMachine.objects.create(tenant=tenant, name="vm-a", cluster=cluster, site=hq)
        VirtualMachine.objects.create(tenant=tenant, name="SECRET-vm-b", cluster=cluster,
                                      site=branch)
        tmpl = ExportTemplate.objects.create(
            tenant=tenant, name="peers", object_type="virtualmachine",
            template_code="{% for v in vm.cluster.virtual_machines.all() %}{{ v.name }},"
                          "{% endfor %}",
        )
        user = User.objects.create_user("scoped", password="x")
        prof = UserProfile.objects.create(user=user, role="custom")
        prof.tenants.add(tenant)
        perm = ObjectPermission.objects.create(
            name="vms", object_types=["virtualmachine", "cluster"], actions=["view"]
        )
        perm.users.add(user)
        perm.tenants.add(tenant)
        perm.sites.add(hq)
        self.client.force_login(user)
        self.client.post(f"/api/tenants/{tenant.id}/switch/")
        res = self.client.get(f"/api/virtual-machines/{vm_a.id}/render/?template={tmpl.id}")
        self.assertEqual(res.status_code, 200, res.content)
        self.assertNotIn("SECRET", res.json()["output"])
        self.assertIn("vm-a", res.json()["output"])
