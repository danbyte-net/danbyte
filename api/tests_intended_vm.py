"""Intended VMs over the API: build fields, the represented device, virtual
disks, the device's backing VM, the render context and the provision event."""
from __future__ import annotations

from unittest import mock

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.models import (
    Cluster,
    ClusterType,
    Device,
    ExportTemplate,
    Site,
    VirtualDisk,
    VirtualMachine,
    VMInterface,
)
from audit.models import ChangeAction, ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant
from integrations import dispatch
from integrations.models import AutomationTarget, DeployRun


class _Base(APITestCase):
    def setUp(self):
        self.org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=self.org, name="T", slug="t")
        self.site = Site.objects.create(tenant=self.tenant, name="A")
        ct = ClusterType.objects.create(tenant=self.tenant, name="Proxmox", slug="pve")
        self.cluster = Cluster.objects.create(tenant=self.tenant, name="pve-a", type=ct)
        self.host = Device.objects.create(tenant=self.tenant, name="pve1", site=self.site)
        self.router = Device.objects.create(tenant=self.tenant, name="edge-r1", site=self.site)
        self.vm = VirtualMachine.objects.create(
            tenant=self.tenant, name="edge-r1-vm", cluster=self.cluster, device=self.host,
            intended=True, vmid=120, cpu_type="host", vcpus=2, memory_mb=2048,
            image="local:import/debian-13.qcow2", storage="ceph-vm",
            represents_device=self.router,
        )
        VMInterface.objects.create(vm=self.vm, name="eth1", index=1, model="virtio",
                                   bridge="vnet-wan")
        VMInterface.objects.create(vm=self.vm, name="eth0", index=0, model="virtio",
                                   bridge="vmbr0", mtu=9000)
        VirtualDisk.objects.create(vm=self.vm, key="scsi0", size_gb=16, storage="ceph-vm")
        self.other = Tenant.objects.create(org=self.org, name="U", slug="u")
        self.foreign_device = Device.objects.create(tenant=self.other, name="x1")

    def login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def admin(self):
        u = User.objects.create_user("su", password="x", is_superuser=True)
        UserProfile.objects.create(user=u).tenants.add(self.tenant)
        self.login(u)
        return u

    def member(self, name, grants):
        u = User.objects.create_user(name, password="x")
        UserProfile.objects.create(user=u, role="custom").tenants.add(self.tenant)
        for i, (types, actions) in enumerate(grants):
            perm = ObjectPermission.objects.create(
                name=f"{name}-{i}", object_types=list(types), actions=list(actions),
            )
            perm.users.add(u)
            perm.tenants.add(self.tenant)
        self.login(u)
        return u


class BuildFieldTests(_Base):
    def test_detail_carries_the_build_fields(self):
        self.admin()
        body = self.client.get(f"/api/virtual-machines/{self.vm.id}/").json()
        self.assertTrue(body["intended"])
        self.assertEqual(body["vmid"], 120)
        self.assertEqual(body["represents_device"], {"id": str(self.router.id), "name": "edge-r1"})
        self.assertEqual([d["key"] for d in body["disks"]], ["scsi0"])
        self.assertIsNone(body["missing_since"])

    def test_filters(self):
        self.admin()
        VirtualMachine.objects.create(tenant=self.tenant, name="plain", cluster=self.cluster)
        names = lambda q: [r["name"] for r in self.client.get(  # noqa: E731
            f"/api/virtual-machines/?{q}").json()["results"]]
        self.assertEqual(names("intended=true"), ["edge-r1-vm"])
        self.assertEqual(names("intended=false"), ["plain"])
        self.assertEqual(names(f"represents_device={self.router.id}"), ["edge-r1-vm"])
        self.assertEqual(names("vmid=120"), ["edge-r1-vm"])

    def test_represents_device_of_another_tenant_is_refused(self):
        self.admin()
        r = self.client.patch(f"/api/virtual-machines/{self.vm.id}/",
                              {"represents_device_id": str(self.foreign_device.id)},
                              format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("represents_device_id", r.json())

    def test_the_host_cannot_be_the_represented_device(self):
        self.admin()
        r = self.client.patch(f"/api/virtual-machines/{self.vm.id}/",
                              {"represents_device_id": str(self.host.id)}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("represents_device_id", r.json())

    def test_one_vm_per_represented_device(self):
        self.admin()
        r = self.client.post("/api/virtual-machines/", {
            "name": "second", "cluster_id": str(self.cluster.id),
            "represents_device_id": str(self.router.id),
        }, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("represents_device_id", r.json())

    def test_vmid_is_unique_per_cluster(self):
        self.admin()
        r = self.client.post("/api/virtual-machines/", {
            "name": "second", "cluster_id": str(self.cluster.id), "vmid": 120,
        }, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("vmid", r.json())

    def test_nic_index_is_unique_per_vm(self):
        self.admin()
        r = self.client.post("/api/vm-interfaces/", {
            "vm_id": str(self.vm.id), "name": "eth2", "index": 1,
        }, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("index", r.json())

    def test_device_shows_its_backing_vm(self):
        self.admin()
        body = self.client.get(f"/api/devices/{self.router.id}/").json()
        self.assertEqual(body["backing_vm"]["id"], str(self.vm.id))
        self.assertTrue(body["backing_vm"]["intended"])

    def test_backing_vm_hidden_without_vm_view(self):
        self.member("devonly", [(["device"], ["view"])])
        body = self.client.get(f"/api/devices/{self.router.id}/").json()
        self.assertIsNone(body["backing_vm"])


class VirtualDiskApiTests(_Base):
    def test_crud_and_scoping(self):
        self.admin()
        r = self.client.post("/api/virtual-disks/", {
            "vm_id": str(self.vm.id), "key": "scsi1", "size_gb": 8, "controller": "scsi",
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertFalse(r.json()["created_disk"])
        rows = self.client.get(f"/api/virtual-disks/?vm={self.vm.id}").json()["results"]
        self.assertEqual([d["key"] for d in rows], ["scsi0", "scsi1"])
        dup = self.client.post("/api/virtual-disks/", {
            "vm_id": str(self.vm.id), "key": "scsi1"}, format="json")
        self.assertEqual(dup.status_code, 400)

    def test_another_tenants_disk_is_out_of_reach(self):
        self.admin()
        ct = ClusterType.objects.create(tenant=self.other, name="P", slug="p")
        cl = Cluster.objects.create(tenant=self.other, name="c", type=ct)
        vm = VirtualMachine.objects.create(tenant=self.other, name="theirs", cluster=cl)
        disk = VirtualDisk.objects.create(vm=vm, key="scsi0")
        self.assertEqual(self.client.get(f"/api/virtual-disks/{disk.id}/").status_code, 404)
        r = self.client.post("/api/virtual-disks/", {"vm_id": str(vm.id), "key": "scsi1"},
                             format="json")
        self.assertEqual(r.status_code, 400)
        keys = [d["key"] for d in self.client.get("/api/virtual-disks/").json()["results"]]
        self.assertEqual(keys, ["scsi0"])  # ours only


class RenderContextTests(_Base):
    def test_vm_render_exposes_the_build(self):
        self.admin()
        t = ExportTemplate.objects.create(
            tenant=self.tenant, name="vm", object_type="virtualmachine",
            template_code=(
                "{{ build.vmid }} {{ build.cpu_type }} {{ represents_device.name }} "
                "{% for i in build.interfaces %}{{ i.index }}:{{ i.bridge }} {% endfor %}"
                "{% for d in disks %}{{ d.key }}={{ d.size_gb }}{% endfor %}"
            ),
        )
        r = self.client.get(f"/api/virtual-machines/{self.vm.id}/render/?template={t.id}")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(
            r.json()["output"], "120 host edge-r1 0:vmbr0 1:vnet-wan scsi0=16"
        )

    def test_device_render_exposes_its_backing_vm(self):
        from api.export_templates import render_device_config

        t = ExportTemplate.objects.create(
            tenant=self.tenant, name="dev", object_type="device",
            template_code="{{ backing_vm.vmid }} {{ backing_vm.node }} "
                          "{{ backing_vm.interfaces[0].mtu }} {{ backing_vm.image }}",
        )
        out = render_device_config(t, self.router, self.tenant)
        self.assertEqual(out, "120 pve1 9000 local:import/debian-13.qcow2")


class ProvisionTests(_Base):
    def setUp(self):
        super().setUp()
        self.target = AutomationTarget.objects.create(
            tenant=self.tenant, name="rebuild", kind="webhook",
            base_url="https://runner.example.net/hook", token="s3cret",
            object_types=["virtualmachine"],
        )

    def url(self, vm=None):
        return f"/api/virtual-machines/{(vm or self.vm).id}/provision/"

    def post(self, vm=None, target=None):
        with mock.patch("django_rq.get_queue") as q:
            q.return_value.enqueue.return_value = None
            return self.client.post(
                self.url(vm), {"target_id": str((target or self.target).id)}, format="json",
            )

    def test_change_alone_cannot_provision(self):
        self.member("editor", [(["virtualmachine", "automationtarget"], ["view", "change"])])
        self.assertEqual(self.post().status_code, 403)
        self.assertFalse(DeployRun.objects.exists())

    def test_the_provision_grant_queues_a_run_and_audits_it(self):
        user = self.member("builder", [(["virtualmachine"], ["view", "provision"])])
        r = self.post()
        self.assertEqual(r.status_code, 202, r.content)
        run = DeployRun.objects.get()
        self.assertEqual((run.event, run.object_type), ("provision", "virtualmachine"))
        self.assertEqual(run.device_ids, [str(self.vm.id)])
        entry = ChangeLogEntry.objects.get(action=ChangeAction.PROVISION)
        self.assertEqual(entry.object_id, str(self.vm.id))
        self.assertEqual(entry.user, user)
        self.assertEqual(entry.changes["target"], "rebuild")

    def test_a_vm_that_is_not_intended_is_refused(self):
        self.admin()
        VirtualMachine.objects.filter(pk=self.vm.pk).update(intended=False)
        self.assertEqual(self.post().status_code, 400)

    def test_a_target_that_does_not_take_vms_is_refused(self):
        self.admin()
        self.target.object_types = ["device"]
        self.target.save(update_fields=["object_types"])
        r = self.post()
        self.assertEqual(r.status_code, 400)
        self.assertIn("target_id", r.json())

    def test_another_tenants_target_is_refused(self):
        self.admin()
        theirs = AutomationTarget.objects.create(
            tenant=self.other, name="x", kind="webhook", base_url="https://x.example.net/",
            object_types=["*"],
        )
        self.assertEqual(self.post(target=theirs).status_code, 400)

    def test_the_job_refilters_ids_and_posts_through_the_guard(self):
        ct = ClusterType.objects.create(tenant=self.other, name="P", slug="p")
        foreign = VirtualMachine.objects.create(
            tenant=self.other, name="theirs", intended=True,
            cluster=Cluster.objects.create(tenant=self.other, name="c", type=ct),
        )
        plain = VirtualMachine.objects.create(
            tenant=self.tenant, name="plain", cluster=self.cluster,
        )
        resp = mock.Mock(status_code=202)
        with mock.patch.object(dispatch, "safe_post", return_value=resp) as post:
            out = dispatch.dispatch_deploy(
                str(self.target.id), [str(self.vm.id), str(foreign.id), str(plain.id)],
                event="provision", object_type="virtualmachine",
            )
        self.assertTrue(out["ok"])
        import json

        payload = json.loads(post.call_args.kwargs["data"])
        self.assertEqual(payload["object_ids"], [str(self.vm.id)])
        self.assertEqual(payload["device_ids"], [str(self.vm.id)])
        self.assertEqual(payload["represents_device_ids"], [str(self.router.id)])
        spec = payload["virtual_machines"][0]
        self.assertEqual((spec["vmid"], spec["node"], spec["storage"]), (120, "pve1", "ceph-vm"))
        self.assertNotIn("s3cret", post.call_args.kwargs["data"].decode())
        self.assertEqual(post.call_args.kwargs["headers"]["X-Danbyte-Event"], "deploy.provision")

    def test_the_job_fails_when_nothing_is_left(self):
        VirtualMachine.objects.filter(pk=self.vm.pk).update(intended=False)
        with mock.patch.object(dispatch, "safe_post") as post:
            out = dispatch.dispatch_deploy(
                str(self.target.id), [str(self.vm.id)],
                event="provision", object_type="virtualmachine",
            )
        self.assertFalse(out["ok"])
        post.assert_not_called()


class ImportExportTests(_Base):
    """The build fields round-trip through /api/io/ like any other field,
    and the represented device resolves inside the tenant only."""

    def export(self):
        import csv
        import io

        resp = self.client.get("/api/io/virtualmachine/export/?fmt=csv")
        self.assertEqual(resp.status_code, 200)
        body = b"".join(resp.streaming_content).decode()
        return body, list(csv.DictReader(io.StringIO(body)))

    def load(self, content, dry_run=False):
        resp = self.client.post(
            "/api/io/virtualmachine/import/",
            {"format": "csv", "content": content, "dry_run": dry_run}, format="json",
        )
        self.assertEqual(resp.status_code, 200, resp.content)
        return resp.json()

    def test_an_unchanged_export_imports_as_a_no_op(self):
        self.admin()
        body, rows = self.export()
        row = rows[0]
        self.assertEqual(row["vmid"], "120")
        self.assertEqual(row["represents_device"], "edge-r1")
        res = self.load(body)
        self.assertEqual(res["errors"], [])
        self.assertEqual(res["created"], 0)
        self.vm.refresh_from_db()
        self.assertEqual(self.vm.represents_device_id, self.router.id)
        self.assertTrue(self.vm.intended)

    def test_a_represented_device_of_another_tenant_does_not_resolve(self):
        self.admin()
        content = (
            "name,cluster,represents_device\n"
            f"new-vm,pve-a,{self.foreign_device.name}\n"
        )
        res = self.load(content, dry_run=True)
        self.assertEqual(res["created"], 0)
        self.assertTrue(res["errors"])
