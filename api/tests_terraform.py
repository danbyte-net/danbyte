"""Per-VM render endpoint — the Terraform-for-VMs pull surface."""
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
