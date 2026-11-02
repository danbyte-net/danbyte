"""Per-object render of an export template (C1): one cluster, with its hosts,
VMs and groups, through ``/api/export-templates/<id>/render/?object=`` and the
``/api/clusters/<id>/render/`` alias. The list render is unchanged."""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.models import (
    Cluster,
    ClusterType,
    Device,
    ExportTemplate,
    Site,
    VirtualMachine,
    VirtualMachineGroup,
)
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tenant

CODE = (
    "{{ cluster.name }} {{ cluster.custom_fields.kolla_vip }} | "
    "{% for h in hosts %}{{ h.name }} {% endfor %}| "
    "{% for v in virtual_machines %}{{ v.name }}@{{ v.device.name }} {% endfor %}| "
    "{% for g in vm_groups %}{{ g.name }}{% endfor %} | {{ count }}"
)


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        site = Site.objects.create(tenant=self.tenant, name="A")
        ct = ClusterType.objects.create(tenant=self.tenant, name="Kolla", slug="kolla")
        self.cluster = Cluster.objects.create(
            tenant=self.tenant, name="kolla-a", type=ct,
            custom_fields={"kolla_vip": "10.0.0.10"},
        )
        Cluster.objects.create(tenant=self.tenant, name="kolla-b", type=ct)
        self.member_host = Device.objects.create(
            tenant=self.tenant, name="ctl1", site=site, cluster=self.cluster,
        )
        self.run_host = Device.objects.create(tenant=self.tenant, name="cmp1", site=site)
        group = VirtualMachineGroup.objects.create(
            tenant=self.tenant, cluster=self.cluster, name="openstack",
        )
        VirtualMachine.objects.create(
            tenant=self.tenant, name="vm1", cluster=self.cluster, device=self.run_host,
            group=group,
        )
        self.tmpl = ExportTemplate.objects.create(
            tenant=self.tenant, name="globals", object_type="cluster", template_code=CODE,
        )
        other_org = Organization.objects.create(name="P", slug="p")
        self.other = Tenant.objects.create(org=other_org, name="U", slug="u")
        oct_ = ClusterType.objects.create(tenant=self.other, name="K", slug="k")
        self.foreign = Cluster.objects.create(tenant=self.other, name="theirs", type=oct_)

    def login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def admin(self):
        u = User.objects.create_user("su", password="x", is_superuser=True)
        UserProfile.objects.create(user=u).tenants.add(self.tenant)
        self.login(u)

    def member(self, types, actions=("view",)):
        u = User.objects.create_user("m", password="x")
        UserProfile.objects.create(user=u, role="custom").tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(
            name="m", object_types=list(types), actions=list(actions),
        )
        perm.users.add(u)
        perm.tenants.add(self.tenant)
        self.login(u)

    def render(self, obj_id, action="preview"):
        return self.client.get(
            f"/api/export-templates/{self.tmpl.id}/{action}/?object={obj_id}"
        )


class ClusterRenderTests(_Base):
    def test_renders_one_cluster_with_hosts_vms_and_groups(self):
        self.admin()
        r = self.render(self.cluster.id)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(
            r.json()["output"], "kolla-a 10.0.0.10 | cmp1 ctl1 | vm1@cmp1 | openstack | 1"
        )

    def test_render_download_for_one_object(self):
        self.admin()
        r = self.render(self.cluster.id, action="render")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.content.decode().startswith("kolla-a "))

    def test_the_list_render_still_renders_every_cluster(self):
        self.admin()
        t = ExportTemplate.objects.create(
            tenant=self.tenant, name="all", object_type="cluster",
            template_code="{% for c in objects %}{{ c.name }} {% endfor %}{{ count }}",
        )
        r = self.client.get(f"/api/export-templates/{t.id}/preview/")
        self.assertEqual(r.json()["output"], "kolla-a kolla-b 2")

    def test_another_tenants_cluster_is_refused(self):
        self.admin()
        self.assertEqual(self.render(self.foreign.id).status_code, 404)

    def test_an_object_of_another_type_is_refused(self):
        self.admin()
        self.assertEqual(self.render(self.member_host.id).status_code, 404)

    def test_a_malformed_id_is_refused(self):
        self.admin()
        self.assertEqual(self.render("nope").status_code, 404)

    def test_the_reader_sees_only_the_rows_they_may_view(self):
        self.member(["exporttemplate", "cluster", "virtualmachinegroup"])
        r = self.render(self.cluster.id)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["output"], "kolla-a 10.0.0.10 | | | openstack | 1")

    def test_without_cluster_view_the_cluster_is_not_found(self):
        self.member(["exporttemplate"])
        self.assertEqual(self.render(self.cluster.id).status_code, 404)

    def test_device_templates_use_the_device_renderer(self):
        self.admin()
        t = ExportTemplate.objects.create(
            tenant=self.tenant, name="dev", object_type="device",
            template_code="{{ device.name }} {{ backing_vm }}",
        )
        r = self.client.get(f"/api/export-templates/{t.id}/preview/?object={self.run_host.id}")
        self.assertEqual(r.json()["output"], "cmp1 None")


class ClusterAliasTests(_Base):
    def test_alias_renders(self):
        self.admin()
        r = self.client.get(f"/api/clusters/{self.cluster.id}/render/?template={self.tmpl.id}")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["template"], "globals")
        self.assertTrue(r.json()["output"].startswith("kolla-a 10.0.0.10"))

    def test_alias_refuses_a_template_of_another_type(self):
        self.admin()
        t = ExportTemplate.objects.create(
            tenant=self.tenant, name="dev", object_type="device", template_code="x",
        )
        r = self.client.get(f"/api/clusters/{self.cluster.id}/render/?template={t.id}")
        self.assertEqual(r.status_code, 400)

    def test_alias_needs_template_view(self):
        self.member(["cluster"])
        r = self.client.get(f"/api/clusters/{self.cluster.id}/render/?template={self.tmpl.id}")
        self.assertEqual(r.status_code, 403)

    def test_alias_hides_another_tenants_cluster(self):
        self.admin()
        r = self.client.get(f"/api/clusters/{self.foreign.id}/render/?template={self.tmpl.id}")
        self.assertEqual(r.status_code, 404)
