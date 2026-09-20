"""VM groups: a vApp / resource pool / folder, below a cluster.

Written by the virtualization sync, editable by hand, and tenant-scoped like
everything else - the sync reaching across tenants is the failure that would
matter, so that is what this pins down.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from api.models import (
    Cluster,
    ClusterType,
    VirtualMachine,
    VirtualMachineGroup,
)
from core.models import Organization, Tenant


class VmGroupApiTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        self.ctype = ClusterType.objects.create(
            tenant=self.tenant, name="VMware Cloud Director",
            slug="vmware-cloud-director",
        )
        self.cluster = Cluster.objects.create(
            tenant=self.tenant, name="Prod-VDC", type=self.ctype
        )
        self.group = VirtualMachineGroup.objects.create(
            tenant=self.tenant, cluster=self.cluster, name="web-stack",
            kind="vapp",
        )
        self.user = get_user_model().objects.create_superuser(
            "admin", "a@b.c", "pw"
        )
        self.client.force_login(self.user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def test_a_group_lists_with_its_vm_count(self):
        VirtualMachine.objects.create(
            tenant=self.tenant, name="web01", cluster=self.cluster,
            group=self.group,
        )
        VirtualMachine.objects.create(
            tenant=self.tenant, name="loner", cluster=self.cluster
        )

        res = self.client.get("/api/vm-groups/")

        self.assertEqual(res.status_code, 200, res.content)
        row = res.json()["results"][0]
        self.assertEqual(row["name"], "web-stack")
        self.assertEqual(row["kind_display"], "vApp")
        self.assertEqual(row["vm_count"], 1)

    def test_the_cluster_filter_is_what_the_cluster_page_uses(self):
        other_cluster = Cluster.objects.create(
            tenant=self.tenant, name="DR-VDC", type=self.ctype
        )
        VirtualMachineGroup.objects.create(
            tenant=self.tenant, cluster=other_cluster, name="dr-stack",
            kind="vapp",
        )

        res = self.client.get(f"/api/vm-groups/?cluster={self.cluster.id}")

        self.assertEqual(
            [r["name"] for r in res.json()["results"]], ["web-stack"]
        )

    def test_another_tenants_group_is_invisible(self):
        foreign_type = ClusterType.objects.create(
            tenant=self.other, name="VMware Cloud Director",
            slug="vmware-cloud-director",
        )
        foreign_cluster = Cluster.objects.create(
            tenant=self.other, name="Foreign-VDC", type=foreign_type
        )
        foreign = VirtualMachineGroup.objects.create(
            tenant=self.other, cluster=foreign_cluster, name="theirs",
            kind="vapp",
        )

        listed = self.client.get("/api/vm-groups/").json()["results"]
        self.assertEqual([r["name"] for r in listed], ["web-stack"])
        self.assertEqual(
            self.client.get(f"/api/vm-groups/{foreign.id}/").status_code, 404
        )

    def test_a_vm_cannot_be_put_in_another_tenants_group(self):
        """The picker is scoped; this is the rule behind it."""
        foreign_type = ClusterType.objects.create(
            tenant=self.other, name="VMware Cloud Director",
            slug="vmware-cloud-director",
        )
        foreign_cluster = Cluster.objects.create(
            tenant=self.other, name="Foreign-VDC", type=foreign_type
        )
        foreign = VirtualMachineGroup.objects.create(
            tenant=self.other, cluster=foreign_cluster, name="theirs",
            kind="vapp",
        )
        vm = VirtualMachine.objects.create(
            tenant=self.tenant, name="web01", cluster=self.cluster
        )

        res = self.client.patch(
            f"/api/virtual-machines/{vm.id}/",
            {"group_id": str(foreign.id)}, format="json",
        )

        self.assertEqual(res.status_code, 400, res.content)
        vm.refresh_from_db()
        self.assertIsNone(vm.group_id)

    def test_a_group_is_named_once_per_cluster(self):
        res = self.client.post("/api/vm-groups/", {
            "name": "web-stack", "cluster_id": str(self.cluster.id),
            "kind": "vapp",
        }, format="json")

        self.assertEqual(res.status_code, 400, res.content)

    def test_deleting_a_group_leaves_its_vms_alone(self):
        vm = VirtualMachine.objects.create(
            tenant=self.tenant, name="web01", cluster=self.cluster,
            group=self.group,
        )

        res = self.client.delete(f"/api/vm-groups/{self.group.id}/")

        self.assertEqual(res.status_code, 204, res.content)
        vm.refresh_from_db()
        self.assertIsNone(vm.group_id)
