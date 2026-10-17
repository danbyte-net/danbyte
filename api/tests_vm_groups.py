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
    SearchEntry,
    Site,
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


class VmGroupPageTests(APITestCase):
    """What the /vm-groups list and detail pages rely on (#98)."""

    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.site = Site.objects.create(tenant=self.tenant, name="Aarhus")
        ctype = ClusterType.objects.create(
            tenant=self.tenant, name="Proxmox VE", slug="proxmox-ve"
        )
        self.cluster = Cluster.objects.create(
            tenant=self.tenant, name="PVE", type=ctype, site=self.site
        )
        self.other_cluster = Cluster.objects.create(
            tenant=self.tenant, name="DR", type=ctype
        )
        self.pool = VirtualMachineGroup.objects.create(
            tenant=self.tenant, cluster=self.cluster, name="prod",
            kind="pool", description="production guests",
        )
        self.folder = VirtualMachineGroup.objects.create(
            tenant=self.tenant, cluster=self.other_cluster, name="Linux",
            kind="folder",
        )
        user = get_user_model().objects.create_superuser("admin", "a@b.c", "pw")
        self.client.force_login(user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def names(self, query=""):
        res = self.client.get(f"/api/vm-groups/{query}")
        self.assertEqual(res.status_code, 200, res.content)
        return [r["name"] for r in res.json()["results"]]

    def test_a_group_carries_its_clusters_site(self):
        row = self.client.get(f"/api/vm-groups/{self.pool.id}/").json()
        self.assertEqual(row["site"]["name"], "Aarhus")
        self.assertIsNone(
            self.client.get(f"/api/vm-groups/{self.folder.id}/").json()["site"]
        )

    def test_filters(self):
        self.assertEqual(self.names("?kind=folder"), ["Linux"])
        self.assertEqual(self.names(f"?site={self.site.id}"), ["prod"])
        self.assertEqual(self.names("?search=production"), ["prod"])
        self.assertEqual(self.names("?search=linu"), ["Linux"])

    def test_the_vm_list_filters_by_group(self):
        VirtualMachine.objects.create(
            tenant=self.tenant, name="web01", cluster=self.cluster,
            group=self.pool,
        )
        VirtualMachine.objects.create(
            tenant=self.tenant, name="web02", cluster=self.cluster
        )

        res = self.client.get(f"/api/virtual-machines/?group={self.pool.id}")

        self.assertEqual([r["name"] for r in res.json()["results"]], ["web01"])
        self.assertEqual(res.json()["results"][0]["group"]["name"], "prod")

    def test_a_vm_only_joins_a_group_on_its_own_cluster(self):
        vm = VirtualMachine.objects.create(
            tenant=self.tenant, name="web01", cluster=self.cluster
        )

        res = self.client.patch(
            f"/api/virtual-machines/{vm.id}/",
            {"group_id": str(self.folder.id)}, format="json",
        )

        self.assertEqual(res.status_code, 400, res.content)
        self.assertIn("group_id", res.json())
        ok = self.client.patch(
            f"/api/virtual-machines/{vm.id}/",
            {"group_id": str(self.pool.id)}, format="json",
        )
        self.assertEqual(ok.status_code, 200, ok.content)

    def test_moving_a_vm_to_another_cluster_drops_its_old_group(self):
        vm = VirtualMachine.objects.create(
            tenant=self.tenant, name="web01", cluster=self.cluster,
            group=self.pool,
        )

        res = self.client.patch(
            f"/api/virtual-machines/{vm.id}/",
            {"cluster_id": str(self.other_cluster.id)}, format="json",
        )

        self.assertEqual(res.status_code, 200, res.content)
        vm.refresh_from_db()
        self.assertIsNone(vm.group_id)

    def test_an_unrelated_vm_edit_keeps_the_group(self):
        vm = VirtualMachine.objects.create(
            tenant=self.tenant, name="web01", cluster=self.cluster,
            group=self.pool,
        )

        self.client.patch(
            f"/api/virtual-machines/{vm.id}/",
            {"description": "x", "cluster_id": str(self.cluster.id)},
            format="json",
        )

        vm.refresh_from_db()
        self.assertEqual(vm.group_id, self.pool.id)

    def test_a_group_with_members_cannot_move_cluster(self):
        VirtualMachine.objects.create(
            tenant=self.tenant, name="web01", cluster=self.cluster,
            group=self.pool,
        )

        res = self.client.patch(
            f"/api/vm-groups/{self.pool.id}/",
            {"cluster_id": str(self.other_cluster.id)}, format="json",
        )

        self.assertEqual(res.status_code, 400, res.content)
        self.assertIn("cluster_id", res.json())
        empty = self.client.patch(
            f"/api/vm-groups/{self.folder.id}/",
            {"cluster_id": str(self.cluster.id)}, format="json",
        )
        self.assertEqual(empty.status_code, 200, empty.content)

    def test_create_and_edit_by_hand(self):
        res = self.client.post("/api/vm-groups/", {
            "name": "web", "cluster_id": str(self.cluster.id),
        }, format="json")
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(res.json()["kind"], "other")

        res = self.client.patch(
            f"/api/vm-groups/{res.json()['id']}/",
            {"description": "front end"}, format="json",
        )
        self.assertEqual(res.status_code, 200, res.content)

    def test_a_group_is_in_the_search_index(self):
        entry = SearchEntry.objects.get(
            object_type="virtualmachinegroup", object_id=self.pool.id
        )
        self.assertEqual(entry.title, "prod")
        self.assertEqual(entry.subtitle, "PVE")
        self.assertEqual(entry.site_id, self.site.id)
        self.assertIn("pve", entry.facets.get("cluster", []))
