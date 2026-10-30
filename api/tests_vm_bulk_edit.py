"""Bulk edit on the VM list: the fields it offers, tenant and site scope on
the selection and on every relation, per-VM permission, custom fields kept
or set key by key, tags, the change log, and what a single save derives (a
group dropped by a cluster move, the cluster's site, a PRTG plan)."""
from __future__ import annotations

from unittest import mock

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.models import (
    Cluster,
    ClusterType,
    DeviceRole,
    Platform,
    Site,
    Status,
    VirtualMachine,
    VirtualMachineGroup,
)
from api.status_registry import seed_builtin_statuses
from audit.models import ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tag, Tenant
from customization.models import CustomField

VMS = "/api/virtual-machines/"
UPDATE = f"{VMS}bulk-update/"


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        seed_builtin_statuses(self.tenant)
        seed_builtin_statuses(self.other)
        self.site_a = Site.objects.create(tenant=self.tenant, name="A")
        self.site_b = Site.objects.create(tenant=self.tenant, name="B")
        ct = ClusterType.objects.create(tenant=self.tenant, name="CT", slug="ct")
        self.c1 = Cluster.objects.create(tenant=self.tenant, name="C1", type=ct)
        self.c2 = Cluster.objects.create(tenant=self.tenant, name="C2", type=ct)
        self.g1 = VirtualMachineGroup.objects.create(
            tenant=self.tenant, cluster=self.c1, name="vapp")
        self.vm_a = VirtualMachine.objects.create(
            tenant=self.tenant, name="vm-a", cluster=self.c1, site=self.site_a,
            group=self.g1, custom_fields={"owner": "net", "legacy": "x"})
        self.vm_b = VirtualMachine.objects.create(
            tenant=self.tenant, name="vm-b", cluster=self.c1, site=self.site_b)
        o_ct = ClusterType.objects.create(tenant=self.other, name="CT", slug="ct")
        o_cl = Cluster.objects.create(tenant=self.other, name="OC", type=o_ct)
        self.theirs = VirtualMachine.objects.create(
            tenant=self.other, name="theirs", cluster=o_cl)
        self.role = DeviceRole.objects.create(tenant=self.tenant, name="Web", slug="web")
        self.o_role = DeviceRole.objects.create(tenant=self.other, name="Web", slug="web")
        self.platform = Platform.objects.create(tenant=self.tenant, name="Linux", slug="linux")
        self.planned = self._status(self.tenant, "planned")
        self.admin = User.objects.create_superuser("vm-root", password="x")
        self.login(self.admin)

    def _status(self, tenant, slug):
        return Status.objects.get(tenant=tenant, slug=slug)

    def login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def update(self, fields, ids=None):
        ids = ids if ids is not None else [self.vm_a.id, self.vm_b.id]
        return self.client.post(
            UPDATE, {"ids": [str(i) for i in ids], "fields": fields}, format="json")

    def ok(self, r, code=200):
        self.assertEqual(r.status_code, code, r.content)
        return r.json()

    def member(self, name, actions, sites=None):
        user = User.objects.create_user(name, password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        p = ObjectPermission.objects.create(
            name=f"{name}-p", object_types=["virtualmachine"], actions=actions)
        p.users.add(user)
        p.tenants.add(self.tenant)
        if sites:
            p.sites.set(sites)
        return user


class FieldsTests(_Base):
    def test_the_dialog_reads_the_fields_tags_and_custom_fields(self):
        body = self.ok(self.client.get(f"{VMS}bulk-edit-fields/"))
        keys = [f["key"] for f in body["fields"]]
        self.assertEqual(keys, ["status_id", "role_id", "platform_id", "cluster_id",
                                "group_id", "device_id", "site_id", "description",
                                "prtg_sync"])
        status = next(f for f in body["fields"] if f["key"] == "status_id")
        self.assertEqual((status["kind"], status["status_model"]),
                         ("status", "virtualmachine"))
        prtg = next(f for f in body["fields"] if f["key"] == "prtg_sync")
        self.assertEqual(prtg["kind"], "options")
        self.assertTrue(body["tags"])
        self.assertEqual(body["custom_fields"], "virtualmachine")

    def test_a_field_not_offered_is_refused(self):
        r = self.update({"name": "same"})
        self.assertEqual(r.status_code, 400)
        r = self.update({"vcpus": 4})
        self.assertEqual(r.status_code, 400)


class WriteTests(_Base):
    def test_sets_the_fields_and_logs_each_vm(self):
        body = self.ok(self.update({
            "status_id": str(self.planned.id), "role_id": str(self.role.id),
            "platform_id": str(self.platform.id), "description": "  web tier "}))
        self.assertEqual(body["updated"], 2)
        for vm in (self.vm_a, self.vm_b):
            vm.refresh_from_db()
            self.assertEqual((vm.status, vm.role, vm.platform, vm.description),
                             (self.planned, self.role, self.platform, "web tier"))
            entry = ChangeLogEntry.objects.get(
                object_type="api.virtualmachine", object_id=str(vm.pk), action="update")
            self.assertLessEqual({"status", "role", "platform", "description"},
                                 set(entry.changes))

    def test_tags_are_added_and_removed(self):
        keep = Tag.objects.create(tenant=self.tenant, name="keep", slug="keep")
        drop = Tag.objects.create(tenant=self.tenant, name="drop", slug="drop")
        add = Tag.objects.create(tenant=self.tenant, name="add", slug="add")
        self.vm_a.tags.add(keep, drop)
        self.ok(self.update({"add_tag_ids": [add.id], "remove_tag_ids": [drop.id]}))
        self.assertEqual({t.slug for t in self.vm_a.tags.all()}, {"keep", "add"})
        self.assertEqual({t.slug for t in self.vm_b.tags.all()}, {"add"})

    def test_a_foreign_vm_is_left_out(self):
        body = self.ok(self.update({"description": "x"},
                                   ids=[self.vm_a.id, self.theirs.id]))
        self.assertEqual(body["updated"], 1)
        self.theirs.refresh_from_db()
        self.assertEqual(self.theirs.description, "")
        self.assertFalse(ChangeLogEntry.objects.filter(
            object_id=str(self.theirs.pk), action="update").exists())

    def test_a_foreign_relation_is_refused_and_nothing_written(self):
        r = self.update({"role_id": str(self.o_role.id), "description": "x"})
        self.assertEqual(r.status_code, 400)
        r = self.update({"status_id": str(self._status(self.other, "active").id)})
        self.assertEqual(r.status_code, 400)
        self.vm_a.refresh_from_db()
        self.assertEqual((self.vm_a.role, self.vm_a.description), (None, ""))

    def test_moving_cluster_drops_a_group_on_the_old_one(self):
        self.ok(self.update({"cluster_id": str(self.c2.id)}))
        self.vm_a.refresh_from_db()
        self.assertEqual((self.vm_a.cluster, self.vm_a.group), (self.c2, None))
        entry = ChangeLogEntry.objects.get(
            object_type="api.virtualmachine", object_id=str(self.vm_a.pk), action="update")
        self.assertEqual(set(entry.changes), {"cluster", "group"})

    def test_a_group_on_another_cluster_is_refused(self):
        r = self.update({"group_id": str(self.g1.id)}, ids=[self.vm_a.id])
        self.assertEqual(r.status_code, 200, r.content)
        self.vm_b.cluster = self.c2
        self.vm_b.save()
        r = self.update({"group_id": str(self.g1.id)})
        self.assertEqual(r.status_code, 400)
        self.assertIn("vm-b", str(r.content))

    def test_a_vm_without_site_takes_its_clusters_when_it_applies(self):
        self.c2.site = self.site_b
        self.c2.apply_site_to_vms = True
        self.c2.save()
        self.ok(self.update({"cluster_id": str(self.c2.id), "site_id": None}))
        for vm in (self.vm_a, self.vm_b):
            vm.refresh_from_db()
            self.assertEqual(vm.site, self.site_b)

    def test_prtg_is_planned_for_the_vms_whose_setting_changed(self):
        self.vm_b.prtg_sync = "never"
        self.vm_b.save()
        with mock.patch("prtg.provision.plan_after_save") as plan:
            self.ok(self.update({"prtg_sync": "never"}))
        self.assertEqual([c.args[0].pk for c in plan.call_args_list], [self.vm_a.pk])
        r = self.update({"prtg_sync": "sometimes"})
        self.assertEqual(r.status_code, 400)


class CustomFieldTests(_Base):
    def setUp(self):
        super().setUp()
        self.owner = CustomField.objects.create(
            tenant=self.tenant, key="owner", label="Owner", type="text",
            applies_to=["virtualmachine"])
        self.tier = CustomField.objects.create(
            tenant=self.tenant, key="tier", label="Tier", type="select",
            choices=["gold", "silver"], applies_to=["virtualmachine"])
        self.needed = CustomField.objects.create(
            tenant=self.tenant, key="needed", label="Needed", type="text",
            applies_to=["virtualmachine"], required=True)
        self.site_ref = CustomField.objects.create(
            tenant=self.tenant, key="home", label="Home", type="object",
            related_model="site", applies_to=["virtualmachine"])
        CustomField.objects.create(
            tenant=self.tenant, key="rack_only", label="Rack only", type="text",
            applies_to=["rack"])

    def test_sets_only_the_keys_sent(self):
        self.ok(self.update({"custom_fields": {"tier": "gold", "owner": None}}))
        self.vm_a.refresh_from_db()
        self.vm_b.refresh_from_db()
        self.assertEqual(self.vm_a.custom_fields, {"tier": "gold", "legacy": "x"})
        self.assertEqual(self.vm_b.custom_fields, {"tier": "gold"})
        entry = ChangeLogEntry.objects.get(
            object_type="api.virtualmachine", object_id=str(self.vm_a.pk), action="update")
        self.assertEqual(entry.changes["custom_fields"]["new"], {"tier": "gold", "legacy": "x"})

    def test_bad_values_are_refused_and_nothing_written(self):
        o_site = Site.objects.create(tenant=self.other, name="Theirs")
        for cf in ({"tier": "bronze"}, {"needed": ""}, {"nope": "x"},
                   {"rack_only": "x"}, {"home": str(o_site.id)}, "gold"):
            r = self.update({"custom_fields": cf, "description": "x"})
            self.assertEqual(r.status_code, 400, cf)
        self.vm_a.refresh_from_db()
        self.assertEqual(self.vm_a.custom_fields, {"owner": "net", "legacy": "x"})
        self.assertEqual(self.vm_a.description, "")

    def test_an_object_field_takes_a_tenant_row(self):
        self.ok(self.update({"custom_fields": {"home": str(self.site_b.id)}}))
        self.vm_b.refresh_from_db()
        self.assertEqual(self.vm_b.custom_fields, {"home": str(self.site_b.id)})


class PermissionTests(_Base):
    def test_change_is_needed(self):
        self.login(self.member("viewer", ["view"]))
        self.assertEqual(self.update({"description": "x"}).status_code, 403)
        self.assertEqual(self.client.get(f"{VMS}bulk-edit-fields/").status_code, 403)
        self.vm_a.refresh_from_db()
        self.assertEqual(self.vm_a.description, "")

    def test_a_site_scoped_user_edits_only_their_sites_vms(self):
        self.login(self.member("site-a", ["view", "change"], sites=[self.site_a]))
        body = self.ok(self.update({"description": "mine"}))
        self.assertEqual(body["updated"], 1)
        self.vm_a.refresh_from_db()
        self.vm_b.refresh_from_db()
        self.assertEqual((self.vm_a.description, self.vm_b.description), ("mine", ""))

    def test_a_site_scoped_user_cannot_move_a_vm_out_of_their_sites(self):
        self.login(self.member("site-a2", ["view", "change"], sites=[self.site_a]))
        r = self.update({"site_id": str(self.site_b.id)}, ids=[self.vm_a.id])
        self.assertIn(r.status_code, (400, 403), r.content)
        self.vm_a.refresh_from_db()
        self.assertEqual(self.vm_a.site, self.site_a)
