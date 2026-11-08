"""The device profile engine: application groups, tags, custom fields and the
platform written on assign, released on unassign, taken over between
profiles, and the parent chain."""
from __future__ import annotations

from api import applications as groups
from api.models import ApplicationGroupAssignment, InstalledSoftware

from . import engine
from .models import DeviceProfileAssignment, DeviceProfileItemLink
from .testing import ProfileBase


class GroupSectionTests(ProfileBase):
    def test_assign_assigns_the_group_and_unassign_releases_it(self):
        p = self.profile("RDS-HR", groups_=[self.group])
        a, result = engine.assign(p, self.dev)
        self.assertEqual([i.label for i in result.created], ["RDS"])
        aga = ApplicationGroupAssignment.objects.get(device=self.dev)
        self.assertEqual(aga.group, self.group)
        self.assertEqual(InstalledSoftware.objects.filter(device=self.dev).count(), 2)
        link = DeviceProfileItemLink.objects.get(assignment=a)
        self.assertEqual((link.object_type, link.object_id),
                         ("applicationgroupassignment", aga.pk))
        self.assertEqual(engine.from_profile("applicationgroupassignment", [aga.pk]),
                         {str(aga.pk): {"id": str(p.pk), "name": "RDS-HR"}})
        counts = engine.unassign(a)
        self.assertEqual(counts, {"removed": 1, "kept": 0, "moved": 0})
        self.assertFalse(ApplicationGroupAssignment.objects.exists())
        self.assertFalse(InstalledSoftware.objects.exists())
        self.assertFalse(DeviceProfileItemLink.objects.exists())

    def test_a_group_assigned_by_hand_is_never_claimed(self):
        mine, _ = groups.assign_group(self.group, device=self.dev)
        p = self.profile("RDS-HR", groups_=[self.group])
        a, result = engine.assign(p, self.dev)
        self.assertEqual(result.created, [])
        self.assertFalse(DeviceProfileItemLink.objects.exists())
        engine.unassign(a)
        self.assertTrue(ApplicationGroupAssignment.objects.filter(pk=mine.pk).exists())

    def test_edited_installs_stay_when_the_group_goes(self):
        p = self.profile("RDS-HR", groups_=[self.group])
        a, _ = engine.assign(p, self.dev)
        office = InstalledSoftware.objects.get(device=self.dev, application=self.office)
        office.version = "2024"
        office.save()
        engine.unassign(a)
        self.assertEqual(list(InstalledSoftware.objects.filter(device=self.dev)
                              .values_list("application__slug", "group_id")),
                         [("office", None)])

    def test_another_profile_takes_the_group_over(self):
        hr = self.profile("RDS-HR", groups_=[self.group])
        fin = self.profile("RDS-Finance", groups_=[self.group, self.desk])
        a_hr, _ = engine.assign(hr, self.dev)
        a_fin, result = engine.assign(fin, self.dev)
        self.assertEqual([i.label for i in result.created], ["Desk"])
        self.assertEqual(DeviceProfileItemLink.objects.filter(assignment=a_fin).count(), 1)
        counts = engine.unassign(a_hr)
        self.assertEqual(counts, {"removed": 0, "kept": 0, "moved": 1})
        self.assertEqual(ApplicationGroupAssignment.objects.filter(device=self.dev).count(), 2)
        self.assertEqual(DeviceProfileItemLink.objects.filter(assignment=a_fin).count(), 2)
        engine.unassign(a_fin)
        self.assertFalse(ApplicationGroupAssignment.objects.exists())

    def test_a_group_unassigned_by_hand_is_missing_until_reapply(self):
        p = self.profile("RDS-HR", groups_=[self.group])
        a, _ = engine.assign(p, self.dev)
        groups.unassign_group(ApplicationGroupAssignment.objects.get(device=self.dev))
        engine.sync_host(self.dev)
        a.refresh_from_db()
        self.assertEqual((a.state, a.missing_count), ("missing", 1))
        self.assertFalse(ApplicationGroupAssignment.objects.exists())
        engine.reapply(a)
        a.refresh_from_db()
        self.assertEqual((a.state, a.missing_count), ("ok", 0))
        aga = ApplicationGroupAssignment.objects.get(device=self.dev)
        self.assertEqual(DeviceProfileItemLink.objects.get(assignment=a).object_id, aga.pk)

    def test_vm_and_deleting_the_host(self):
        p = self.profile("RDS-HR", groups_=[self.group])
        engine.assign(p, self.vm)
        self.assertTrue(ApplicationGroupAssignment.objects.filter(virtual_machine=self.vm)
                        .exists())
        self.vm.delete()
        self.assertFalse(DeviceProfileAssignment.objects.exists())
        self.assertFalse(DeviceProfileItemLink.objects.exists())


class TagAndFieldTests(ProfileBase):
    def test_tags_added_and_only_the_profiles_removed(self):
        self.dev.tags.add(self.tag_hr)
        p = self.profile("RDS-HR", tags=[self.tag_rds, self.tag_hr])
        a, result = engine.assign(p, self.dev)
        self.assertEqual([i.label for i in result.created], ["rds"])
        self.assertEqual(self.tags_of(self.dev), {"rds", "hr"})
        engine.unassign(a)
        self.assertEqual(self.tags_of(self.dev), {"hr"})

    def test_a_tag_another_profile_wants_stays(self):
        a1, _ = engine.assign(self.profile("One", tags=[self.tag_rds]), self.dev)
        engine.assign(self.profile("Two", tags=[self.tag_rds]), self.dev)
        self.assertEqual(engine.unassign(a1)["moved"], 1)
        self.assertEqual(self.tags_of(self.dev), {"rds"})

    def test_custom_field_filled_only_when_blank(self):
        p = self.profile("RDS-HR", cf={"owner": "HR"})
        a, _ = engine.assign(p, self.dev)
        self.assertEqual(self.fresh(self.dev).custom_fields, {"owner": "HR"})
        engine.unassign(a)
        self.assertEqual(self.fresh(self.dev).custom_fields, {})
        self.dev.custom_fields = {"owner": "Ops"}
        self.dev.save()
        a, result = engine.assign(p, self.dev)
        self.assertEqual(result.created, [])
        self.assertFalse(DeviceProfileItemLink.objects.exists())
        engine.unassign(a)
        self.assertEqual(self.fresh(self.dev).custom_fields, {"owner": "Ops"})

    def test_an_edited_value_is_kept(self):
        a, _ = engine.assign(self.profile("RDS-HR", cf={"owner": "HR"}), self.dev)
        self.dev.custom_fields = {"owner": "Payroll"}
        self.dev.save()
        engine.sync_host(self.dev)
        a.refresh_from_db()
        self.assertEqual((a.state, a.edited_count), ("edited", 1))
        self.assertEqual(engine.unassign(a), {"removed": 0, "kept": 1, "moved": 0})
        self.assertEqual(self.fresh(self.dev).custom_fields, {"owner": "Payroll"})

    def test_platform_set_when_blank(self):
        a, _ = engine.assign(self.profile("Win", platform=self.win), self.dev)
        self.assertEqual(self.fresh(self.dev).platform, self.win)
        engine.unassign(a)
        self.assertIsNone(self.fresh(self.dev).platform)
        self.dev.platform = self.linux
        self.dev.save()
        a, _ = engine.assign(self.profile("Win2", platform=self.win), self.dev)
        self.assertEqual(self.fresh(self.dev).platform, self.linux)

    def test_a_field_the_object_kind_lacks_is_skipped(self):
        self.cf_owner.applies_to = ["device"]
        self.cf_owner.save()
        p = self.profile("RDS-HR", cf={"owner": "HR"})
        _a, result = engine.assign(p, self.vm)
        self.assertEqual(result.created, [])
        self.assertEqual(self.fresh(self.vm).custom_fields, {})

    def test_conflicting_values_order_wins(self):
        hr = self.profile("HR", cf={"owner": "HR"})
        fin = self.profile("Finance", cf={"owner": "Finance"})
        a_hr, _ = engine.assign(hr, self.dev)
        a_fin, _ = engine.assign(fin, self.dev)
        self.assertEqual(self.fresh(self.dev).custom_fields["owner"], "HR")
        engine.set_host_profiles([fin, hr], self.dev)
        self.assertEqual(self.fresh(self.dev).custom_fields["owner"], "Finance")
        a_fin.refresh_from_db()
        engine.unassign(a_fin)
        self.assertEqual(self.fresh(self.dev).custom_fields["owner"], "HR")
        a_hr.refresh_from_db()
        engine.unassign(a_hr)
        self.assertNotIn("owner", self.fresh(self.dev).custom_fields)


class InheritanceTests(ProfileBase):
    def test_child_adds_to_lists_and_overrides_single_values(self):
        base = self.profile("RDS", groups_=[self.group], tags=[self.tag_rds],
                            cf={"owner": "IT"}, platform=self.linux)
        hr = self.profile("RDS-HR", parent=base, groups_=[self.desk], tags=[self.tag_hr],
                          cf={"owner": "HR"}, platform=self.win)
        engine.assign(hr, self.dev)
        dev = self.fresh(self.dev)
        self.assertEqual(set(ApplicationGroupAssignment.objects.filter(device=dev)
                             .values_list("group__slug", flat=True)), {"rds", "desk"})
        self.assertEqual(self.tags_of(dev), {"rds", "hr"})
        self.assertEqual((dev.custom_fields["owner"], dev.platform), ("HR", self.win))
        items = {i.key: i.source.name for i in engine.profile_items(hr, None)}
        self.assertEqual(items[f"group:{self.group.pk}"], "RDS")
        self.assertEqual(items["cf:owner"], "RDS-HR")

    def test_preview_lists_create_present_skip_and_permissions(self):
        self.dev.custom_fields = {"owner": "Ops"}
        self.dev.save()
        self.dev.tags.add(self.tag_hr)
        p = self.profile("RDS-HR", groups_=[self.group], tags=[self.tag_hr, self.tag_rds],
                         cf={"owner": "HR"}, platform=self.win)
        out = engine.preview(p, self.dev, user=self.admin, tenant=self.tenant)
        by = {s["kind"]: s for s in out["sections"]}
        self.assertEqual([r["label"] for r in by["application_group"]["create"]], ["RDS"])
        self.assertEqual([r["label"] for r in by["tag"]["create"]], ["rds"])
        self.assertEqual([r["label"] for r in by["tag"]["present"]], ["hr"])
        self.assertEqual(by["custom_field"]["skip"][0]["reason"], "Already has a value.")
        self.assertEqual([r["label"] for r in by["platform"]["create"]], ["Windows"])
        self.assertEqual(out["missing_permissions"], [])
        self.assertFalse(DeviceProfileAssignment.objects.exists())
        self.assertFalse(ApplicationGroupAssignment.objects.exists())
