"""Bulk edit and safe bulk delete on the Platforms list: the dry run names
the platforms kept because devices, virtual machines or a device profile
still use them, the delete takes only the free ones with a change-log entry
each, the edit writes the fields the spec names, and both stay inside the
caller's tenant and grant."""
from __future__ import annotations

from django.contrib.auth.models import User
from rest_framework.test import APITestCase

from api.models import (
    Cluster,
    ClusterType,
    Device,
    DeviceType,
    Manufacturer,
    Platform,
    PlatformGroup,
    Site,
    VirtualMachine,
)
from audit.models import ChangeAction, ChangeLogEntry
from auth_api.models import ObjectPermission, UserProfile
from core.models import Organization, Tag, Tenant
from profiles.models import DeviceProfile

URL = "/api/platforms/"


class _Base(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="Acme", slug="acme")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        other_org = Organization.objects.create(name="Other", slug="other")
        self.other = Tenant.objects.create(org=other_org, name="Other", slug="other")
        self.admin = User.objects.create_superuser("root", "r@a.c", "pw")
        self.login(self.admin)
        self.free = self.platform("Spare")
        self.on_device = self.platform("IOS-XE")
        self.on_vm = self.platform("Ubuntu")
        self.in_profile = self.platform("Windows")
        self.theirs = Platform.objects.create(tenant=self.other, name="Theirs", slug="theirs")

        site = Site.objects.create(tenant=self.tenant, name="dc1")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="C", slug="c")
        dt = DeviceType.objects.create(tenant=self.tenant, manufacturer=mfr, model="X")
        Device.objects.create(tenant=self.tenant, name="r1", device_type=dt, site=site,
                              platform=self.on_device)
        Device.objects.create(tenant=self.tenant, name="r2", device_type=dt, site=site,
                              platform=self.on_device)
        ct = ClusterType.objects.create(tenant=self.tenant, name="c", slug="c")
        cl = Cluster.objects.create(tenant=self.tenant, name="C1", type=ct)
        VirtualMachine.objects.create(tenant=self.tenant, name="vm1", cluster=cl,
                                      platform=self.on_vm)
        DeviceProfile.objects.create(tenant=self.tenant, name="RDS", slug="rds",
                                     platform=self.in_profile)

    def platform(self, name):
        return Platform.objects.create(tenant=self.tenant, name=name, slug=name.lower())

    def login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def delete(self, ids, dry_run=False):
        return self.client.post(f"{URL}bulk-delete/",
                                {"ids": [str(i) for i in ids], "dry_run": dry_run},
                                format="json")

    def update(self, ids, fields):
        return self.client.post(f"{URL}bulk-update/",
                                {"ids": [str(i) for i in ids], "fields": fields},
                                format="json")

    def member(self, actions):
        user = User.objects.create_user("member", password="x")
        UserProfile.objects.create(user=user, role="custom").tenants.add(self.tenant)
        perm = ObjectPermission.objects.create(name="p", object_types=["platform"],
                                               actions=list(actions))
        perm.users.add(user)
        perm.tenants.add(self.tenant)
        self.login(user)
        return user


class BulkDeleteTests(_Base):
    def test_dry_run_names_the_platforms_in_use_and_deletes_nothing(self):
        ids = [self.free.id, self.on_device.id, self.on_vm.id, self.in_profile.id]
        r = self.delete(ids, dry_run=True)
        self.assertEqual(r.status_code, 200, r.content)
        body = r.json()
        self.assertTrue(body["dry_run"])
        self.assertEqual(body["deleted_ids"], [str(self.free.id)])
        reasons = {s["name"]: s["reason"] for s in body["skipped"]}
        self.assertEqual(reasons, {
            "IOS-XE": "In use: 2 devices.",
            "Ubuntu": "In use: 1 virtual machine.",
            "Windows": "In use: 1 device profiles.",
        })
        self.assertEqual(Platform.objects.filter(tenant=self.tenant).count(), 4)

    def test_only_the_free_platforms_go_each_with_a_log_entry(self):
        r = self.delete([self.free.id, self.on_device.id, self.in_profile.id])
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["deleted"], 1)
        self.assertFalse(Platform.objects.filter(pk=self.free.pk).exists())
        self.assertTrue(Platform.objects.filter(pk=self.on_device.pk).exists())
        self.assertTrue(Platform.objects.filter(pk=self.in_profile.pk).exists())
        self.assertTrue(ChangeLogEntry.objects.filter(
            action=ChangeAction.DELETE, object_id=str(self.free.pk)).exists())

    def test_another_tenants_platform_falls_out(self):
        r = self.delete([self.theirs.id])
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["deleted"], 0)
        self.assertEqual(r.json()["skipped"], [])
        self.assertTrue(Platform.objects.filter(pk=self.theirs.pk).exists())

    def test_needs_the_delete_permission(self):
        self.member(["view", "change"])
        r = self.delete([self.free.id])
        self.assertEqual(r.status_code, 403, r.content)
        self.assertTrue(Platform.objects.filter(pk=self.free.pk).exists())

    def test_a_delete_grant_is_enough(self):
        self.member(["view", "delete"])
        r = self.delete([self.free.id])
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(Platform.objects.filter(pk=self.free.pk).exists())


class BulkUpdateTests(_Base):
    def test_describes_its_fields(self):
        r = self.client.get(f"{URL}bulk-edit-fields/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual([f["key"] for f in r.json()["fields"]], [
            "group_id", "manufacturer_id", "config_template_id", "target_version",
            "description",
        ])
        self.assertTrue(r.json()["tags"])

    def test_writes_group_manufacturer_description_and_tags_with_a_log_per_row(self):
        group = PlatformGroup.objects.create(tenant=self.tenant, name="Linux", slug="linux")
        mfr = Manufacturer.objects.create(tenant=self.tenant, name="Canonical",
                                          slug="canonical")
        tag = Tag.objects.create(tenant=self.tenant, name="core", slug="core")
        r = self.update([self.free.id, self.on_vm.id, self.theirs.id], {
            "group_id": str(group.id), "manufacturer_id": str(mfr.id),
            "description": "  linux  ", "add_tag_ids": [tag.id],
        })
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["updated"], 2)
        for p in (self.free, self.on_vm):
            p.refresh_from_db()
            self.assertEqual((p.group_id, p.manufacturer_id, p.description),
                             (group.id, mfr.id, "linux"))
            self.assertEqual([t.slug for t in p.tags.all()], ["core"])
            self.assertTrue(ChangeLogEntry.objects.filter(
                action=ChangeAction.UPDATE, object_id=str(p.pk),
                changes__has_key="description").exists())
        self.theirs.refresh_from_db()
        self.assertIsNone(self.theirs.group_id)

    def test_another_tenants_group_is_refused(self):
        foreign = PlatformGroup.objects.create(tenant=self.other, name="X", slug="x")
        r = self.update([self.free.id], {"group_id": str(foreign.id)})
        self.assertEqual(r.status_code, 400, r.content)
        self.free.refresh_from_db()
        self.assertIsNone(self.free.group_id)

    def test_fields_outside_the_spec_are_refused(self):
        r = self.update([self.free.id], {"version_pattern": "x"})
        self.assertEqual(r.status_code, 400, r.content)

    def test_view_only_may_not_edit_or_read_the_fields(self):
        self.member(["view"])
        self.assertEqual(self.update([self.free.id], {"description": "x"}).status_code, 403)
        self.assertEqual(self.client.get(f"{URL}bulk-edit-fields/").status_code, 403)
        self.free.refresh_from_db()
        self.assertEqual(self.free.description, "")
