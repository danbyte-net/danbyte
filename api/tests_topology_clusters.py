"""Clusters on the topology map (#517): ``group_clusters=1`` puts
``cluster`` on the hosts of each cluster the caller may view and adds
``clusters`` - members, the cables between them and the cables to every
other node, counted per far node. A virtual chassis member stays with its
chassis."""
from __future__ import annotations

from django.contrib.auth import get_user_model
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APITestCase

from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

from .models import (
    Cable,
    CableTermination,
    Cluster,
    ClusterType,
    Device,
    Interface,
    Site,
    VirtualChassis,
    VirtualMachine,
)

User = get_user_model()


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.site_a = Site.objects.create(tenant=self.tenant, name="dc-a")
        self.site_b = Site.objects.create(tenant=self.tenant, name="dc-b")
        ct = ClusterType.objects.create(tenant=self.tenant, name="vSphere", slug="vsphere")
        self.cl = Cluster.objects.create(tenant=self.tenant, name="prod", type=ct)
        self.other = Cluster.objects.create(tenant=self.tenant, name="lab", type=ct)
        # esx-1 and esx-2 by the FK, esx-3 only by the VMs it runs.
        self.h1 = self._dev("esx-1", self.site_a, cluster=self.cl)
        self.h2 = self._dev("esx-2", self.site_a, cluster=self.cl)
        self.h3 = self._dev("esx-3", self.site_b)
        VirtualMachine.objects.create(
            tenant=self.tenant, name="vm-a", cluster=self.cl, device=self.h3
        )
        self.core = self._dev("core-1", self.site_a)
        self.edge = self._dev("edge-1", self.site_a)
        for i, h in enumerate((self.h1, self.h2, self.h3)):
            self._cable(h, "vmnic0", self.core, f"eth{i}")
        self._cable(self.h1, "vmnic1", self.core, "eth9")
        self._cable(self.h1, "vmnic2", self.h2, "vmnic2")
        self._cable(self.h2, "vmnic3", self.edge, "eth0")

    def _dev(self, name, site, cluster=None, vc=None, pos=None):
        return Device.objects.create(
            tenant=self.tenant, name=name, site=site, cluster=cluster,
            virtual_chassis=vc, vc_position=pos,
        )

    def _cable(self, a, pa, b, pb):
        ia = Interface.objects.create(device=a, name=pa)
        ib = Interface.objects.create(device=b, name=pb)
        cab = Cable.objects.create(tenant=self.tenant)
        CableTermination.objects.create(cable=cab, end="A", interface=ia)
        CableTermination.objects.create(cable=cab, end="B", interface=ib)

    def _login(self, user):
        self.client.force_login(user)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.id)
        session.save()

    def _admin(self):
        self._login(User.objects.create_superuser("admin", "a@example.com", "x"))

    def _member(self, *grants):
        """A user holding ``grants``: (object types, sites or None,
        constraints or None)."""
        user = User.objects.create_user("m", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        for i, (types, sites, constraints) in enumerate(grants):
            perm = ObjectPermission.objects.create(
                name=f"g{i}", object_types=list(types), actions=["view"],
                constraints=constraints,
            )
            perm.users.add(user)
            perm.tenants.add(self.tenant)
            for s in sites or ():
                perm.sites.add(s)
        self._login(user)
        return user

    def _graph(self, **body):
        r = self.client.post("/api/topology/", body, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def _nodes(self, graph):
        return {n["data"]["name"]: n for n in graph["nodes"]}


class ClusterGroupingTests(_Base):
    def test_off_by_default(self):
        self._admin()
        g = self._graph()
        self.assertNotIn("clusters", g)
        for n in g["nodes"]:
            self.assertNotIn("cluster", n["data"])

    def test_get_takes_the_switch_too(self):
        self._admin()
        r = self.client.get("/api/topology/?group_clusters=1")
        self.assertEqual(r.status_code, 200)
        self.assertEqual([c["name"] for c in r.json()["clusters"]], ["prod"])
        r = self.client.get("/api/topology/?group_clusters=0")
        self.assertNotIn("clusters", r.json())

    def test_members_by_fk_and_by_hosted_vms(self):
        self._admin()
        g = self._graph(group_clusters=True)
        nodes = self._nodes(g)
        want = {"id": str(self.cl.id), "name": "prod"}
        for name in ("esx-1", "esx-2", "esx-3"):
            self.assertEqual(nodes[name]["data"]["cluster"], want)
        self.assertNotIn("cluster", nodes["core-1"]["data"])
        [c] = g["clusters"]
        self.assertEqual(c["id"], str(self.cl.id))
        self.assertEqual(c["frame"], f"cl:{self.cl.id}")
        self.assertEqual(c["member_count"], 3)
        self.assertEqual(
            c["members"], [nodes[n]["id"] for n in ("esx-1", "esx-2", "esx-3")]
        )

    def test_links_aggregate_per_far_node(self):
        self._admin()
        g = self._graph(group_clusters=True)
        nodes = self._nodes(g)
        [c] = g["clusters"]
        # esx-1 ↔ esx-2 is inside the cluster: counted, not a link.
        self.assertEqual(c["inner"], 1)
        by = {row["node"]: row for row in c["links"]}
        self.assertEqual(set(by), {nodes["core-1"]["id"], nodes["edge-1"]["id"]})
        core = by[nodes["core-1"]["id"]]
        self.assertEqual(core["cable_count"], 4)
        self.assertEqual(len(core["edges"]), 4)
        edge_ids = {e["id"] for e in g["edges"]}
        self.assertTrue(set(core["edges"]) <= edge_ids)
        self.assertEqual(by[nodes["edge-1"]["id"]]["cable_count"], 1)

    def test_two_clusters_see_each_other_as_far_nodes(self):
        lab = self._dev("lab-1", self.site_a, cluster=self.other)
        self._cable(lab, "vmnic0", self.h1, "vmnic7")
        self._admin()
        g = self._graph(group_clusters=True)
        nodes = self._nodes(g)
        by = {c["name"]: c for c in g["clusters"]}
        self.assertEqual(list(by), ["lab", "prod"])
        lab_far = {r["node"]: r["cable_count"] for r in by["lab"]["links"]}
        self.assertEqual(lab_far, {nodes["esx-1"]["id"]: 1})

    def test_own_cluster_beats_hosted_vms(self):
        VirtualMachine.objects.create(
            tenant=self.tenant, name="vm-x", cluster=self.other, device=self.h1
        )
        self._admin()
        nodes = self._nodes(self._graph(group_clusters=True))
        self.assertEqual(nodes["esx-1"]["data"]["cluster"]["name"], "prod")

    def test_most_vms_wins_among_hosted_clusters(self):
        for i in range(2):
            VirtualMachine.objects.create(
                tenant=self.tenant, name=f"lab-vm{i}", cluster=self.other,
                device=self.h3,
            )
        self._admin()
        nodes = self._nodes(self._graph(group_clusters=True))
        self.assertEqual(nodes["esx-3"]["data"]["cluster"]["name"], "lab")

    def test_virtual_chassis_takes_precedence(self):
        vc = VirtualChassis.objects.create(tenant=self.tenant, name="stack")
        Device.objects.filter(pk=self.h2.pk).update(
            virtual_chassis=vc, vc_position=1
        )
        self._admin()
        g = self._graph(group_clusters=True)
        nodes = self._nodes(g)
        self.assertIn("vc", nodes["esx-2"]["data"])
        self.assertNotIn("cluster", nodes["esx-2"]["data"])
        [c] = g["clusters"]
        self.assertNotIn(nodes["esx-2"]["id"], c["members"])
        # Its cable to esx-1 is now a link to a far node, not inner.
        self.assertEqual(c["inner"], 0)
        far = {r["node"] for r in c["links"]}
        self.assertIn(nodes["esx-2"]["id"], far)

    def test_a_tenant_without_clusters_answers_an_empty_list(self):
        Device.objects.update(cluster=None)
        VirtualMachine.objects.all().delete()
        self._admin()
        self.assertEqual(self._graph(group_clusters=True)["clusters"], [])

    def test_the_query_count_does_not_grow_with_the_map(self):
        self._admin()

        def count():
            with CaptureQueriesContext(connection) as ctx:
                self._graph(group_clusters=True)
            return len(ctx.captured_queries)

        small = count()
        for i in range(5):
            d = self._dev(f"x{i}", self.site_a, cluster=self.other)
            self._cable(d, "up", self.core, f"p{i}")
            VirtualMachine.objects.create(
                tenant=self.tenant, name=f"v{i}", cluster=self.cl, device=self.edge
            )
        self.assertEqual(count(), small)


class ClusterRbacTests(_Base):
    def test_no_cluster_view_strips_it(self):
        self._member((["device"], None, None))
        g = self._graph(group_clusters=True)
        self.assertEqual(g["clusters"], [])
        for n in g["nodes"]:
            self.assertNotIn("cluster", n["data"])

    def test_a_scoped_cluster_grant_shows_only_its_cluster(self):
        lab = self._dev("lab-1", self.site_a, cluster=self.other)
        self._cable(lab, "vmnic0", self.core, "eth8")
        self._member(
            (["device"], None, None),
            (["cluster"], None, {"name": "lab"}),
        )
        g = self._graph(group_clusters=True)
        nodes = self._nodes(g)
        self.assertEqual([c["name"] for c in g["clusters"]], ["lab"])
        self.assertNotIn("cluster", nodes["esx-1"]["data"])
        self.assertEqual(nodes["lab-1"]["data"]["cluster"]["name"], "lab")

    def test_only_hosts_the_caller_may_view(self):
        self._member(
            (["device"], [self.site_a], None),
            (["cluster"], None, None),
        )
        g = self._graph(group_clusters=True)
        nodes = self._nodes(g)
        self.assertNotIn("esx-3", nodes)
        [c] = g["clusters"]
        self.assertEqual(c["member_count"], 2)
        self.assertEqual(
            c["members"], [nodes["esx-1"]["id"], nodes["esx-2"]["id"]]
        )
        far = {r["node"] for r in c["links"]}
        self.assertTrue(far <= {n["id"] for n in g["nodes"]})

    def test_another_tenants_cluster_never_shows(self):
        org = Organization.objects.create(name="Other", slug="other")
        t2 = Tenant.objects.create(org=org, name="Other", slug="other")
        ct2 = ClusterType.objects.create(tenant=t2, name="KVM", slug="kvm")
        foreign = Cluster.objects.create(tenant=t2, name="foreign", type=ct2)
        # A hand-edited row pointing across tenants must not leak its name.
        Device.objects.filter(pk=self.core.pk).update(cluster=foreign)
        self._admin()
        g = self._graph(group_clusters=True)
        self.assertNotIn("foreign", [c["name"] for c in g["clusters"]])
        nodes = self._nodes(g)
        self.assertNotIn("cluster", nodes["core-1"]["data"])
