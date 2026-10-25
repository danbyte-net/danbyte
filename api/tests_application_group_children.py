"""Adding a parent application to a group with ``include_children`` (#436):
every descendant joins as its own member, in tree order, deduplicated, kept
to the tenant, and installed on the group's hosts."""
from __future__ import annotations

from api import applications as sync
from api.models import Application, ApplicationGroupMember, InstalledSoftware
from api.tests_application_groups import GROUPS, _Base


class IncludeChildrenTests(_Base):
    def setUp(self):
        super().setUp()
        self.platform = self.app("Danbyte platform", "platform")
        self.danbyte = self.child("Danbyte", "danbyte", self.platform)
        self.postgres = self.child("Postgres", "postgres", self.platform)
        self.nginx = self.child("nginx", "nginx", self.platform)
        self.python = self.child("Python", "python", self.danbyte)
        self.django = self.child("Django", "django", self.python)

    def child(self, name, slug, parent, tenant=None):
        return Application.objects.create(
            tenant=tenant or self.tenant, name=name, slug=slug, parent=parent)

    def current(self):
        return [{"application_id": str(m.application_id), "version": m.version}
                for m in self.group.members.all()]

    def write(self, rows, code=200):
        return self.ok(self.client.patch(f"{GROUPS}{self.group.id}/", {"members": rows},
                                         format="json"), code)

    def members(self):
        return [(m.application.slug, m.version) for m in
                ApplicationGroupMember.objects.filter(group=self.group)
                .select_related("application")]

    def test_descendants_join_at_all_depths_in_tree_order(self):
        body = self.write(self.current() + [
            {"application_id": str(self.platform.id), "version": "1.0",
             "include_children": True}])
        self.assertEqual(self.members(), [
            ("rdsh", "2022"), ("office", "365"), ("platform", "1.0"),
            ("danbyte", ""), ("python", ""), ("django", ""),
            ("nginx", ""), ("postgres", ""),
        ])
        self.assertEqual(body["member_count"], 8)
        self.assertNotIn("include_children", body["members"][0])

    def test_without_the_flag_only_the_parent_joins(self):
        self.write(self.current() + [{"application_id": str(self.platform.id)}])
        self.assertEqual([s for s, _v in self.members()], ["rdsh", "office", "platform"])

    def test_existing_members_are_not_duplicated(self):
        sync.add_member(self.group, self.python, "3.13", 2)
        self.write(self.current() + [
            {"application_id": str(self.platform.id), "include_children": True}])
        got = self.members()
        self.assertEqual([s for s, _v in got],
                         ["rdsh", "office", "python", "platform", "danbyte", "django",
                          "nginx", "postgres"])
        self.assertIn(("python", "3.13"), got)
        self.assertEqual(got[3], ("platform", ""))

    def test_another_tenants_child_is_ignored(self):
        self.child("Foreign", "foreign", self.platform, tenant=self.other)
        self.write(self.current() + [
            {"application_id": str(self.platform.id), "include_children": True}])
        self.assertNotIn("foreign", [s for s, _v in self.members()])

    def test_new_members_are_installed_on_assigned_hosts(self):
        sync.assign_group(self.group, device=self.dev)
        sync.assign_group(self.group, virtual_machine=self.vm)
        self.write(self.current() + [
            {"application_id": str(self.danbyte.id), "version": "0.19",
             "include_children": True}])
        for host in ({"device": self.dev}, {"virtual_machine": self.vm}):
            got = {i.application.slug: i.version for i in
                   InstalledSoftware.objects.filter(**host).select_related("application")}
            self.assertEqual(got, {"rdsh": "2022", "office": "365", "danbyte": "0.19",
                                   "python": "", "django": ""})

    def test_picker_carries_child_count_and_ancestor_lists_the_subtree(self):
        rows = self.ok(self.client.get("/api/applications/?picker=1"))["results"]
        counts = {r["slug"]: r["child_count"] for r in rows}
        self.assertEqual((counts["platform"], counts["danbyte"], counts["django"]), (3, 1, 0))
        rows = self.ok(self.client.get(
            f"/api/applications/?picker=1&ancestor={self.platform.id}&page_size=100"))
        self.assertEqual(sorted(r["slug"] for r in rows["results"]),
                         ["danbyte", "django", "nginx", "postgres", "python"])
        theirs = self.app("Theirs", "theirs", tenant=self.other)
        rows = self.ok(self.client.get(f"/api/applications/?ancestor={theirs.id}"))
        self.assertEqual(rows["results"], [])
