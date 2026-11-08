"""Bulk select on Users, Groups and Permissions.

The access lists are deployment-wide and their writes deployment-admin only.
A bulk change keeps every rule the single one has, and the single one
refuses what the bulk one keeps: nobody deletes or switches off their own
account, only a superuser touches a superuser, the last active superuser
stays, built-in groups and the built-in Administrator grant stay, and an
admin cannot take away the grants or groups they manage users through.
"""
from __future__ import annotations

from django.contrib.auth.models import Group, User
from rest_framework.test import APITestCase

from audit.models import ChangeLogEntry
from core.models import Organization, Tenant

from .builtin_groups import ensure_builtin_groups, grant_names
from .bulk_guards import (
    BUILTIN_ADMIN_GRANT,
    LAST_SUPERUSER,
    OWN_GRANT,
    OWN_GROUP,
    SELF,
    SUPERUSER_TARGET,
    user_blockers,
)
from .models import GroupProfile, ObjectPermission, UserProfile

USERS, GROUPS, PERMS = "/api/users/", "/api/groups/", "/api/object-permissions/"


class _Base(APITestCase):
    def setUp(self):
        ensure_builtin_groups()
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.other = Tenant.objects.create(org=org, name="Other", slug="other")
        self.root = User.objects.create_superuser("bulk-root", password="x")
        self.login(self.root)

    def login(self, user):
        self.client.force_login(user)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def person(self, name, **kw):
        u = User.objects.create_user(name, password="x", **kw)
        UserProfile.objects.create(user=u, role="custom").tenants.add(self.tenant)
        return u

    def admin(self, name="dep-admin", *, tenant=None, via_group=None):
        """A non-superuser deployment admin: an unscoped grant naming the
        access types (scoped to ``tenant``: a tenant admin only), held
        directly or through ``via_group``."""
        u = self.person(name)
        p = ObjectPermission.objects.create(
            name=f"{name} access", object_types=["user", "group", "objectpermission"],
            actions=["view", "add", "change", "delete"],
        )
        if tenant is not None:
            p.tenants.add(tenant)
        if via_group is not None:
            p.groups.add(via_group)
            u.groups.add(via_group)
        else:
            p.users.add(u)
        return u, p

    def post(self, url, action, ids, **body):
        return self.client.post(f"{url}{action}/", {"ids": [str(i) for i in ids], **body},
                                format="json")

    def ok(self, r, code=200):
        self.assertEqual(r.status_code, code, r.content)
        return r.json() if r.content else None

    def skipped(self, body):
        return {s["id"]: s["reason"] for s in body["skipped"]}


class UserBulkTests(_Base):
    def setUp(self):
        super().setUp()
        self.a = self.person("alice")
        self.b = self.person("bob")
        self.other_root = User.objects.create_superuser("other-root", password="x")

    def test_describes_only_the_active_switch(self):
        body = self.ok(self.client.get(f"{USERS}bulk-edit-fields/"))
        self.assertEqual([f["key"] for f in body["fields"]], ["is_active"])
        for fields in ({"is_superuser": True}, {"is_staff": True}, {"password": "x"},
                       {"email": "x@y.z"}, {"group_ids": [1]}):
            r = self.post(USERS, "bulk-update", [self.a.id], fields=fields)
            self.assertEqual(r.status_code, 400, fields)
        self.a.refresh_from_db()
        self.assertFalse(self.a.is_superuser)

    def test_deactivate_and_activate_log_each_account(self):
        body = self.ok(self.post(USERS, "bulk-update", [self.a.id, self.b.id],
                                 fields={"is_active": False}))
        self.assertEqual(body["updated"], 2)
        self.assertFalse(User.objects.filter(pk__in=[self.a.pk, self.b.pk],
                                             is_active=True).exists())
        self.assertEqual(ChangeLogEntry.objects.filter(
            object_type="auth.user", object_id__in=[str(self.a.pk), str(self.b.pk)]).count(), 2)
        self.ok(self.post(USERS, "bulk-update", [self.a.id], fields={"is_active": True}))
        self.a.refresh_from_db()
        self.assertTrue(self.a.is_active)

    def test_nobody_deactivates_themselves(self):
        r = self.post(USERS, "bulk-update", [self.a.id, self.root.id],
                      fields={"is_active": False})
        self.assertEqual(r.status_code, 400)
        self.assertIn(SELF, str(r.json()))
        self.assertTrue(User.objects.get(pk=self.a.pk).is_active)
        # The single edit refuses it too.
        r = self.client.patch(f"{USERS}{self.root.id}/", {"is_active": False}, format="json")
        self.assertEqual(r.status_code, 400)
        self.root.refresh_from_db()
        self.assertTrue(self.root.is_active)

    def test_only_a_superuser_switches_a_superuser(self):
        admin, _ = self.admin()
        self.login(admin)
        r = self.post(USERS, "bulk-update", [self.a.id, self.other_root.id],
                      fields={"is_active": False})
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.json()["detail"], SUPERUSER_TARGET)
        self.assertTrue(User.objects.get(pk=self.a.pk).is_active)
        self.assertTrue(User.objects.get(pk=self.other_root.pk).is_active)

    def test_delete_keeps_yourself_and_superusers_and_logs_the_rest(self):
        admin, _ = self.admin()
        self.login(admin)
        ids = [self.a.id, admin.id, self.other_root.id]
        body = self.ok(self.post(USERS, "bulk-delete", ids, dry_run=True))
        self.assertEqual(body["deleted_ids"], [str(self.a.id)])
        self.assertEqual(self.skipped(body), {str(admin.id): SELF,
                                              str(self.other_root.id): SUPERUSER_TARGET})
        self.assertTrue(User.objects.filter(pk=self.a.pk).exists())
        body = self.ok(self.post(USERS, "bulk-delete", ids))
        self.assertEqual(body["deleted"], 1)
        self.assertFalse(User.objects.filter(pk=self.a.pk).exists())
        self.assertTrue(User.objects.filter(pk__in=[admin.pk, self.other_root.pk]).count(), 2)
        self.assertTrue(ChangeLogEntry.objects.filter(
            object_type="auth.user", object_id=str(self.a.pk), action="delete").exists())

    def test_single_delete_refuses_yourself(self):
        r = self.client.delete(f"{USERS}{self.root.id}/")
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json()["detail"], SELF)
        self.assertTrue(User.objects.filter(pk=self.root.pk).exists())

    def test_the_last_active_superuser_stays(self):
        # An actor who is not one of the active superusers, removing them all.
        ghost = User.objects.create_superuser("ghost", password="x", is_active=False)
        why = user_blockers(ghost, [self.root, self.other_root, self.a])
        self.assertEqual(why, {self.root.pk: LAST_SUPERUSER,
                               self.other_root.pk: LAST_SUPERUSER})
        self.assertEqual(user_blockers(ghost, [self.root, self.a]), {})

    def test_a_tenant_admin_or_viewer_may_not(self):
        tenant_admin, _ = self.admin("t-admin", tenant=self.tenant)
        for user in (tenant_admin, self.b):
            self.login(user)
            self.assertEqual(self.post(USERS, "bulk-update", [self.a.id],
                                       fields={"is_active": False}).status_code, 403)
            self.assertEqual(self.post(USERS, "bulk-delete", [self.a.id]).status_code, 403)
        self.assertTrue(User.objects.get(pk=self.a.pk).is_active)

    def test_ids_are_whole_numbers(self):
        for ids in (["not-an-id"], [True], [{"id": 1}]):
            r = self.client.post(f"{USERS}bulk-delete/", {"ids": ids}, format="json")
            self.assertEqual(r.status_code, 400, ids)


class GroupBulkTests(_Base):
    def setUp(self):
        super().setUp()
        self.ops = Group.objects.create(name="Ops")
        GroupProfile.objects.create(group=self.ops)
        self.net = Group.objects.create(name="Net")
        GroupProfile.objects.create(group=self.net)
        self.builtin = Group.objects.get(name="Administrator")

    def test_delete_keeps_the_built_in_groups_and_logs_the_rest(self):
        ids = [self.ops.id, self.builtin.id]
        body = self.ok(self.post(GROUPS, "bulk-delete", ids, dry_run=True))
        self.assertEqual(body["deleted_ids"], [str(self.ops.id)])
        self.assertEqual(self.skipped(body),
                         {str(self.builtin.id): "Built-in groups can't be deleted."})
        self.ok(self.post(GROUPS, "bulk-delete", ids))
        self.assertFalse(Group.objects.filter(pk=self.ops.pk).exists())
        self.assertTrue(Group.objects.filter(pk=self.builtin.pk).exists())
        self.assertTrue(ChangeLogEntry.objects.filter(
            object_type="auth.group", object_id=str(self.ops.pk), action="delete").exists())

    def test_an_admin_keeps_the_group_they_manage_users_through(self):
        admin, _ = self.admin(via_group=self.ops)
        self.login(admin)
        body = self.ok(self.post(GROUPS, "bulk-delete", [self.ops.id, self.net.id]))
        self.assertEqual(body["deleted_ids"], [str(self.net.id)])
        self.assertEqual(self.skipped(body), {str(self.ops.id): OWN_GROUP})
        r = self.client.delete(f"{GROUPS}{self.ops.id}/")
        self.assertEqual(r.status_code, 409)
        self.assertEqual(r.json()["detail"], OWN_GROUP)
        # Holding the grant directly as well, the group may go.
        ObjectPermission.objects.get(name="dep-admin access").users.add(admin)
        body = self.ok(self.post(GROUPS, "bulk-delete", [self.ops.id]))
        self.assertEqual(body["deleted"], 1)

    def test_a_tenant_admin_may_not(self):
        tenant_admin, _ = self.admin("t-admin", tenant=self.tenant)
        self.login(tenant_admin)
        self.assertEqual(self.post(GROUPS, "bulk-delete", [self.ops.id]).status_code, 403)
        self.assertTrue(Group.objects.filter(pk=self.ops.pk).exists())

    def test_there_is_no_bulk_edit(self):
        r = self.post(GROUPS, "bulk-update", [self.ops.id], fields={"name": "x"})
        self.assertIn(r.status_code, (404, 405))
        self.assertTrue(Group.objects.filter(name="Ops").exists())


class PermissionBulkTests(_Base):
    def setUp(self):
        super().setUp()
        self.builtin = ObjectPermission.objects.get(name__in=grant_names("Administrator"))
        self.p = ObjectPermission.objects.create(name="Racks", object_types=["rack"],
                                                 actions=["view"])
        self.theirs = ObjectPermission.objects.create(name="Theirs", object_types=["rack"],
                                                      actions=["view"])
        self.theirs.tenants.add(self.other)

    def test_describes_its_fields_and_refuses_reach(self):
        body = self.ok(self.client.get(f"{PERMS}bulk-edit-fields/"))
        self.assertEqual([f["key"] for f in body["fields"]], ["enabled", "description"])
        for fields in ({"object_types": ["*"]}, {"actions": ["delete"]},
                       {"constraints": {}}, {"user_ids": [1]}):
            r = self.post(PERMS, "bulk-update", [self.p.id], fields=fields)
            self.assertEqual(r.status_code, 400, fields)
        self.p.refresh_from_db()
        self.assertEqual((self.p.object_types, self.p.actions), (["rack"], ["view"]))

    def test_disable_logs_and_keeps_the_built_in_admin_grant(self):
        self.ok(self.post(PERMS, "bulk-update", [self.p.id], fields={"enabled": False}))
        self.p.refresh_from_db()
        self.assertFalse(self.p.enabled)
        self.assertTrue(ChangeLogEntry.objects.filter(object_id=str(self.p.pk)).exists())
        r = self.post(PERMS, "bulk-update", [self.p.id, self.builtin.id],
                      fields={"enabled": False})
        self.assertEqual(r.status_code, 400)
        self.assertIn(BUILTIN_ADMIN_GRANT, str(r.json()))
        self.builtin.refresh_from_db()
        self.assertTrue(self.builtin.enabled)
        r = self.client.patch(f"{PERMS}{self.builtin.id}/", {"enabled": False}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_delete_keeps_the_built_in_admin_grant(self):
        body = self.ok(self.post(PERMS, "bulk-delete", [self.p.id, self.builtin.id]))
        self.assertEqual(body["deleted_ids"], [str(self.p.id)])
        self.assertEqual(self.skipped(body), {str(self.builtin.id): BUILTIN_ADMIN_GRANT})
        self.assertEqual(self.client.delete(f"{PERMS}{self.builtin.id}/").status_code, 409)
        self.assertTrue(ObjectPermission.objects.filter(pk=self.builtin.pk).exists())

    def test_an_admin_keeps_the_grant_they_manage_users_through(self):
        admin, own = self.admin()
        self.login(admin)
        body = self.ok(self.post(PERMS, "bulk-delete", [own.id, self.p.id]))
        self.assertEqual(body["deleted_ids"], [str(self.p.id)])
        self.assertEqual(self.skipped(body), {str(own.id): OWN_GRANT})
        r = self.post(PERMS, "bulk-update", [own.id], fields={"enabled": False})
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self.client.patch(f"{PERMS}{own.id}/", {"enabled": False},
                                           format="json").status_code, 400)
        self.assertEqual(self.client.delete(f"{PERMS}{own.id}/").status_code, 409)
        own.refresh_from_db()
        self.assertTrue(own.enabled)
        # With a second such grant, either one may go.
        second = ObjectPermission.objects.create(name="spare", object_types=["user"],
                                                 actions=["change"])
        second.users.add(admin)
        self.ok(self.post(PERMS, "bulk-update", [own.id], fields={"enabled": False}))

    def test_another_tenants_grant_falls_out_for_an_admin(self):
        admin, _ = self.admin()
        self.login(admin)
        body = self.ok(self.post(PERMS, "bulk-delete", [self.theirs.id, self.p.id]))
        self.assertEqual(body["deleted_ids"], [str(self.p.id)])
        self.assertTrue(ObjectPermission.objects.filter(pk=self.theirs.pk).exists())
        self.ok(self.post(PERMS, "bulk-update", [self.theirs.id], fields={"enabled": False}))
        self.theirs.refresh_from_db()
        self.assertTrue(self.theirs.enabled)

    def test_a_tenant_admin_may_not(self):
        tenant_admin, _ = self.admin("t-admin", tenant=self.tenant)
        self.login(tenant_admin)
        self.assertEqual(self.post(PERMS, "bulk-update", [self.p.id],
                                   fields={"enabled": False}).status_code, 403)
        self.assertEqual(self.post(PERMS, "bulk-delete", [self.p.id]).status_code, 403)
