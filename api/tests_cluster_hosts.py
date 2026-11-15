"""A cluster page's Hosts tab lists only that cluster's hosts (#515).

``GET /api/devices/?cluster=<id>`` returns the devices whose cluster it is and
the hosts its VMs run on (a hypervisor sync links a VM to an existing Device
by node name without setting that Device's cluster) - never every device.
"""
from __future__ import annotations

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from api.models import Cluster, ClusterType, Device, VirtualMachine
from core.models import Organization, Tenant


class ClusterHostsFilterTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        ctype = ClusterType.objects.create(
            tenant=self.tenant, name="VMware vSphere", slug="vmware-vsphere"
        )
        self.cl1 = Cluster.objects.create(tenant=self.tenant, name="cl1", type=ctype)
        self.cl2 = Cluster.objects.create(tenant=self.tenant, name="cl2", type=ctype)
        user = get_user_model().objects.create_superuser("admin", "a@b.c", "pw")
        self.client.force_login(user)
        sess = self.client.session
        sess["current_tenant_id"] = str(self.tenant.id)
        sess.save()

    def _names(self, cluster):
        r = self.client.get("/api/devices/", {"cluster": str(cluster.id)})
        self.assertEqual(r.status_code, 200, r.content)
        return sorted(d["name"] for d in r.json()["results"])

    def test_only_the_clusters_hosts(self):
        Device.objects.create(tenant=self.tenant, name="esx1", cluster=self.cl1)
        Device.objects.create(tenant=self.tenant, name="esx2", cluster=self.cl2)
        Device.objects.create(tenant=self.tenant, name="switch1")
        # A host the sync linked through its VM, its own cluster left blank.
        node = Device.objects.create(tenant=self.tenant, name="pve1")
        for i in range(2):
            VirtualMachine.objects.create(
                tenant=self.tenant, name=f"vm{i}", cluster=self.cl1, device=node
            )
        self.assertEqual(self._names(self.cl1), ["esx1", "pve1"])
        self.assertEqual(self._names(self.cl2), ["esx2"])

    def test_page_count_is_the_host_count(self):
        Device.objects.create(tenant=self.tenant, name="esx1", cluster=self.cl1)
        Device.objects.create(tenant=self.tenant, name="other")
        r = self.client.get(
            "/api/devices/", {"cluster": str(self.cl1.id), "page_size": 1}
        )
        self.assertEqual(r.json()["count"], 1)

    def test_bad_cluster_id_is_a_400(self):
        r = self.client.get("/api/devices/", {"cluster": "nope"})
        self.assertEqual(r.status_code, 400, r.content)
