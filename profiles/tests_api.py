"""Device profiles over the API: the catalog with its sections, inheritance
rules, refused deletes, assignments (assign, set, re-apply, bulk), tenant
and site scope, the preview's permission listing and webhooks."""
from __future__ import annotations

from unittest import mock

from django.contrib.auth.models import User

from api.models import (
    ApplicationGroup,
    ApplicationGroupAssignment,
    Device,
    InstalledSoftware,
    Platform,
    Site,
)
from auth_api.models import ObjectPermission, UserProfile
from core.models import Tag

from . import engine
from .models import DeviceProfile, DeviceProfileAssignment, DeviceProfileItemLink
from .testing import ASSIGN, PROFILES, ProfileBase


class CatalogTests(ProfileBase):
    def test_crud_with_sections(self):
        body = self.ok(self.client.post(PROFILES, {
            "name": "RDS HR", "color": "#10B981",
            "application_group_ids": [str(self.desk.id), str(self.group.id)],
            "add_tag_ids": [str(self.tag_rds.id)],
            "cf_values": {"owner": "HR"}, "platform_id": str(self.win.id),
        }, format="json"), 201)
        self.assertEqual((body["slug"], body["color"]), ("rds-hr", "#10b981"))
        self.assertEqual([g["slug"] for g in body["application_groups"]], ["desk", "rds"])
        self.assertEqual([t["name"] for t in body["add_tags"]], ["rds"])
        self.assertEqual((body["cf_values"], body["platform"]["name"]),
                         ({"owner": "HR"}, "Windows"))
        pid = body["id"]
        body = self.ok(self.client.patch(f"{PROFILES}{pid}/", {
            "application_group_ids": [str(self.group.id)]}, format="json"))
        self.assertEqual([g["slug"] for g in body["application_groups"]], ["rds"])
        child = self.ok(self.client.post(PROFILES, {
            "name": "RDS HR Night", "parent_id": pid, "cf_values": {"owner": "Night"},
        }, format="json"), 201)
        self.assertEqual(child["path"], "RDS HR / RDS HR Night")
        detail = self.ok(self.client.get(f"{PROFILES}{child['id']}/"))
        eff = detail["effective"]
        self.assertEqual(eff["application_group"],
                         [{"label": "RDS", "from": "RDS HR", "inherited": True}])
        self.assertEqual(eff["custom_field"][0]["value"], "Night")
        picker = self.ok(self.client.get(f"{PROFILES}?picker=1"))["results"]
        self.assertEqual(set(picker[0]), {"id", "name", "slug", "color", "path", "numid"})
        names = [r["name"] for r in self.ok(self.client.get(f"{PROFILES}?parent={pid}"))["results"]]
        self.assertEqual(names, ["RDS HR Night"])
        self.ok(self.client.delete(f"{PROFILES}{child['id']}/"), 204)

    def test_section_values_are_checked(self):
        r = self.client.post(PROFILES, {"name": "X", "cf_values": {"nope": 1}}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("nope", r.json()["cf_values"])
        self.cf_owner.applies_to = ["device"]
        self.cf_owner.save()
        r = self.client.post(PROFILES, {"name": "X", "cf_values": {"owner": "a"}},
                             format="json")
        self.assertEqual(r.status_code, 400)
        self.ok(self.client.post(PROFILES, {"name": "X", "applies_to_vms": False,
                                            "cf_values": {"owner": "a"}}, format="json"), 201)
        r = self.client.post(PROFILES, {"name": "Y", "application_group_ids": [
            str(self.group.id), str(self.group.id)]}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_cycles_and_depth_are_refused(self):
        a = self.profile("A")
        b = self.profile("B", parent=a)
        r = self.client.patch(f"{PROFILES}{a.id}/", {"parent_id": str(b.id)}, format="json")
        self.assertEqual(r.status_code, 400)
        r = self.client.patch(f"{PROFILES}{a.id}/", {"parent_id": str(a.id)}, format="json")
        self.assertEqual(r.status_code, 400)
        c = self.profile("C", parent=b)
        d = self.profile("D", parent=c)
        r = self.client.post(PROFILES, {"name": "E", "parent_id": str(d.id)}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("at most 4 deep", str(r.json()["parent_id"]))
        # Moving a two-level subtree under a three-level chain is too deep too.
        x = self.profile("X")
        self.profile("Y", parent=x)
        r = self.client.patch(f"{PROFILES}{x.id}/", {"parent_id": str(c.id)}, format="json")
        self.assertEqual(r.status_code, 400)
        self.ok(self.client.patch(f"{PROFILES}{x.id}/", {"parent_id": str(b.id)},
                                  format="json"))

    def test_deletes_are_refused_while_in_use(self):
        parent = self.profile("Base", groups_=[self.group], platform=self.win)
        child = self.profile("Child", parent=parent)
        r = self.client.delete(f"{PROFILES}{parent.id}/")
        self.assertEqual(r.status_code, 409)
        self.assertIn("child profile", r.json()["detail"])
        engine.assign(child, self.dev)
        r = self.client.delete(f"{PROFILES}{child.id}/")
        self.assertEqual(r.status_code, 409)
        self.assertIn("Assigned to 1 object", r.json()["detail"])
        body = self.ok(self.client.post(f"{PROFILES}bulk-delete/", {
            "ids": [str(child.id)]}, format="json"))
        self.assertTrue(DeviceProfile.objects.filter(pk=child.pk).exists(), body)
        r = self.client.delete(f"/api/application-groups/{self.desk.id}/")
        self.assertEqual(r.status_code, 204)
        r = self.client.delete(f"/api/application-groups/{self.group.id}/")
        self.assertEqual(r.status_code, 409)
        # Off every host, so the group's and the platform's own guards pass.
        ApplicationGroupAssignment.objects.all().delete()
        Device.objects.update(platform=None)
        r = self.client.delete(f"/api/application-groups/{self.group.id}/")
        self.assertEqual(r.status_code, 409)
        self.assertIn("device profile Base", r.json()["detail"])
        r = self.client.delete(f"/api/platforms/{self.win.id}/")
        self.assertEqual(r.status_code, 409)
        self.assertIn("device profile Base", r.json()["detail"])
        self.assertTrue(ApplicationGroup.objects.filter(pk=self.group.pk).exists())
        self.assertTrue(Platform.objects.filter(pk=self.win.pk).exists())

    def test_tags_and_fields_cascade_out_of_the_section(self):
        p = self.profile("Base", tags=[self.tag_rds])
        self.tag_rds.delete()
        self.assertEqual(list(p.add_tags.all()), [])

    def test_default_closed(self):
        user = User.objects.create_user("nobody", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        self.login(user)
        self.assertEqual(self.client.get(PROFILES).status_code, 403)
        self.assertEqual(self.client.get(ASSIGN).status_code, 403)


class AssignmentApiTests(ProfileBase):
    def setUp(self):
        super().setUp()
        self.p = self.profile("RDS-HR", groups_=[self.group], tags=[self.tag_rds],
                              cf={"owner": "HR"})

    def test_assign_list_reorder_and_unassign(self):
        body = self.ok(self.client.post(ASSIGN, {
            "profile_id": str(self.p.id), "device_id": str(self.dev.id)}, format="json"), 201)
        a = body["assignment"]
        self.assertEqual((a["profile"]["slug"], a["device"]["name"], a["state"]),
                         ("rds-hr", "rds1", "ok"))
        self.assertEqual(a["created_by"], "profiles-root")
        self.assertEqual({c["kind"] for c in body["created"]},
                         {"application_group", "tag", "custom_field"})
        r = self.client.post(ASSIGN, {"profile_id": str(self.p.id),
                                      "device_id": str(self.dev.id)}, format="json")
        self.assertEqual(r.status_code, 400)
        listed = self.ok(self.client.get(f"{ASSIGN}?device={self.dev.id}"))["results"]
        self.assertEqual(len(listed), 1)
        self.ok(self.client.patch(f"{ASSIGN}{a['id']}/", {"position": 3}, format="json"))
        r = self.client.patch(f"{ASSIGN}{a['id']}/", {"device_id": str(self.dev_b.id)},
                              format="json")
        self.assertEqual(r.status_code, 400)
        counts = self.ok(self.client.delete(f"{ASSIGN}{a['id']}/"))
        self.assertEqual(counts, {"removed": 3, "kept": 0, "moved": 0})
        self.assertFalse(InstalledSoftware.objects.exists())
        self.assertEqual(self.tags_of(self.dev), set())

    def test_exactly_one_object_and_applies_to(self):
        r = self.client.post(ASSIGN, {"profile_id": str(self.p.id)}, format="json")
        self.assertEqual(r.status_code, 400)
        self.p.applies_to_vms = False
        self.p.save()
        r = self.client.post(ASSIGN, {"profile_id": str(self.p.id),
                                      "virtual_machine_id": str(self.vm.id)}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("virtual machines", str(r.json()["profile_id"]))

    def test_set_and_reapply(self):
        other = self.profile("Desk", groups_=[self.desk])
        body = self.ok(self.client.post(f"{ASSIGN}set/", {
            "virtual_machine_id": str(self.vm.id),
            "profile_ids": [str(other.id), str(self.p.id)]}, format="json"))
        self.assertEqual([r["profile"]["slug"] for r in body["results"]], ["desk", "rds-hr"])
        self.assertEqual(self.fresh(self.vm).custom_fields, {"owner": "HR"})
        self.vm.tags.clear()
        a = DeviceProfileAssignment.objects.get(virtual_machine=self.vm, profile=self.p)
        body = self.ok(self.client.post(f"{ASSIGN}{a.id}/reapply/"))
        self.assertEqual([c["label"] for c in body["created"]], ["rds"])
        self.assertEqual(body["assignment"]["state"], "ok")
        body = self.ok(self.client.post(f"{ASSIGN}set/", {
            "virtual_machine_id": str(self.vm.id), "profile_ids": [str(other.id)]},
            format="json"))
        self.assertEqual(body["unassigned"], [str(self.p.id)])
        self.assertEqual(self.fresh(self.vm).custom_fields, {})
        r = self.client.post(f"{ASSIGN}set/", {
            "virtual_machine_id": str(self.vm.id),
            "profile_ids": [str(other.id), str(other.id)]}, format="json")
        self.assertEqual(r.status_code, 400)

    def test_preview_writes_nothing(self):
        body = self.ok(self.client.post(f"{PROFILES}{self.p.id}/preview/", {
            "device_id": str(self.dev.id)}, format="json"))
        self.assertEqual(body["object"]["name"], "rds1")
        self.assertFalse(body["already_assigned"])
        self.assertEqual(body["missing_permissions"], [])
        self.assertFalse(DeviceProfileAssignment.objects.exists())
        self.assertFalse(InstalledSoftware.objects.exists())

    def test_bulk_inline_and_as_a_job(self):
        body = self.ok(self.client.post(f"{ASSIGN}bulk/", {
            "profile_id": str(self.p.id), "action": "assign",
            "device_ids": [str(self.dev.id), str(self.dev_b.id)]}, format="json"))
        self.assertEqual(body["counts"], {"assigned": 2})
        body = self.ok(self.client.post(f"{ASSIGN}bulk/", {
            "profile_id": str(self.p.id), "action": "unassign",
            "device_ids": [str(self.dev.id)]}, format="json"))
        self.assertEqual(body["counts"], {"unassigned": 1})
        many = [Device.objects.create(tenant=self.tenant, name=f"d{i}", site=self.site_a)
                for i in range(26)]
        job = mock.Mock(id="job-1")
        queue = mock.Mock()
        queue.enqueue.return_value = job
        with mock.patch("django_rq.get_queue", return_value=queue):
            body = self.ok(self.client.post(f"{ASSIGN}bulk/", {
                "profile_id": str(self.p.id), "action": "assign",
                "device_ids": [str(d.id) for d in many]}, format="json"), 202)
        self.assertEqual(body, {"job_id": "job-1", "count": 26})
        self.assertFalse(DeviceProfileAssignment.objects.filter(device__in=many).exists())
        from .tasks import run_bulk

        args = queue.enqueue.call_args
        self.assertIs(args.args[0], run_bulk)
        tally = run_bulk(*args.args[1:], via=args.kwargs["via"],
                         request_id=args.kwargs["request_id"])
        self.assertEqual(tally, {"assigned": 26})
        self.assertEqual(DeviceProfileAssignment.objects.filter(device__in=many).count(), 26)

    def test_webhooks_fire_on_assign_and_unassign(self):
        from integrations.models import Webhook
        from integrations.webhooks import deliver_webhook

        Webhook.objects.create(
            tenant=self.tenant, name="profiles", payload_url="http://x.test/h",
            object_types=["deviceprofileassignment"], on_create=True, on_delete=True,
        )
        queue = mock.Mock()
        with mock.patch("django_rq.get_queue", return_value=queue):
            with self.captureOnCommitCallbacks(execute=True):
                a, _ = engine.assign(self.p, self.dev)
            with self.captureOnCommitCallbacks(execute=True):
                engine.unassign(a)
        events = [(c.args[2], c.args[3], c.args[5]["profile"]) for c in
                  queue.enqueue.call_args_list if c.args[0] is deliver_webhook]
        self.assertEqual(events, [("created", "deviceprofileassignment", str(self.p.id)),
                                  ("deleted", "deviceprofileassignment", str(self.p.id))])


class ScopeTests(ProfileBase):
    def setUp(self):
        super().setUp()
        self.p = self.profile("RDS-HR", groups_=[self.group], cf={"owner": "HR"})

    def test_foreign_ids_on_every_write_path(self):
        their_site = Site.objects.create(tenant=self.other, name="S")
        their_dev = Device.objects.create(tenant=self.other, name="x", site=their_site)
        their_group = ApplicationGroup.objects.create(tenant=self.other, name="G", slug="g")
        their_tag = Tag.objects.create(tenant=self.other, name="t", slug="t")
        their_platform = Platform.objects.create(tenant=self.other, name="P", slug="p")
        theirs = self.profile("Theirs", tenant=self.other)
        self.assertEqual(self.client.get(f"{PROFILES}{theirs.id}/").status_code, 404)
        self.assertNotIn("Theirs", [r["name"] for r in
                                    self.ok(self.client.get(PROFILES))["results"]])
        for payload in ({"application_group_ids": [str(their_group.id)]},
                        {"add_tag_ids": [str(their_tag.id)]},
                        {"platform_id": str(their_platform.id)},
                        {"parent_id": str(theirs.id)}):
            r = self.client.post(PROFILES, {"name": "X", **payload}, format="json")
            self.assertEqual(r.status_code, 400, payload)
            r = self.client.patch(f"{PROFILES}{self.p.id}/", payload, format="json")
            self.assertEqual(r.status_code, 400, payload)
        r = self.client.post(ASSIGN, {"profile_id": str(self.p.id),
                                      "device_id": str(their_dev.id)}, format="json")
        self.assertEqual(r.status_code, 400)
        r = self.client.post(ASSIGN, {"profile_id": str(theirs.id),
                                      "device_id": str(self.dev.id)}, format="json")
        self.assertEqual(r.status_code, 400)
        r = self.client.post(f"{ASSIGN}set/", {"device_id": str(self.dev.id),
                                               "profile_ids": [str(theirs.id)]}, format="json")
        self.assertEqual(r.status_code, 400)
        r = self.client.post(f"{ASSIGN}set/", {"device_id": str(their_dev.id),
                                               "profile_ids": [str(self.p.id)]}, format="json")
        self.assertEqual(r.status_code, 400)
        r = self.client.post(f"{ASSIGN}bulk/", {
            "profile_id": str(self.p.id), "action": "assign",
            "device_ids": [str(self.dev.id), str(their_dev.id)]}, format="json")
        self.assertEqual(r.status_code, 400)
        r = self.client.post(f"{ASSIGN}bulk/", {
            "profile_id": str(theirs.id), "action": "assign",
            "device_ids": [str(self.dev.id)]}, format="json")
        self.assertEqual(r.status_code, 400)
        r = self.client.post(f"{PROFILES}{self.p.id}/preview/",
                             {"device_id": str(their_dev.id)}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertFalse(DeviceProfileAssignment.objects.exists())
        self.assertFalse(DeviceProfileItemLink.objects.exists())
        with self.assertRaises(engine.ProfileError):
            engine.assign(theirs, self.dev)

    def _site_editor(self, types):
        user = User.objects.create_user("site-ed", password="x")
        UserProfile.objects.create(user=user).tenants.add(self.tenant)
        p = ObjectPermission.objects.create(
            name="ed", object_types=types, actions=["view", "add", "change", "delete"])
        p.users.add(user)
        p.tenants.add(self.tenant)
        p.sites.set([self.site_a])
        view = ObjectPermission.objects.create(
            name="cat", object_types=["deviceprofile", "applicationgroup", "application"],
            actions=["view"])
        view.users.add(user)
        view.tenants.add(self.tenant)
        self.login(user)
        return user

    FULL = ["deviceprofileassignment", "applicationgroupassignment", "installedsoftware",
            "device", "virtualmachine"]

    def test_a_site_editor_assigns_on_their_sites_only(self):
        self._site_editor(self.FULL)
        body = self.ok(self.client.post(ASSIGN, {
            "profile_id": str(self.p.id), "device_id": str(self.dev.id)}, format="json"), 201)
        r = self.client.post(ASSIGN, {"profile_id": str(self.p.id),
                                      "device_id": str(self.dev_b.id)}, format="json")
        self.assertEqual(r.status_code, 403)
        r = self.client.post(f"{ASSIGN}set/", {"device_id": str(self.dev_b.id),
                                               "profile_ids": [str(self.p.id)]}, format="json")
        self.assertEqual(r.status_code, 403)
        body2 = self.ok(self.client.post(f"{ASSIGN}bulk/", {
            "profile_id": str(self.p.id), "action": "assign",
            "device_ids": [str(self.dev_b.id)]}, format="json"))
        self.assertEqual(body2["counts"], {"denied": 1})
        self.assertFalse(DeviceProfileAssignment.objects.filter(device=self.dev_b).exists())
        self.assertFalse(InstalledSoftware.objects.filter(device=self.dev_b).exists())
        self.assertEqual(self.client.patch(f"{PROFILES}{self.p.id}/", {"name": "Y"},
                                           format="json").status_code, 403)
        self.ok(self.client.delete(f"{ASSIGN}{body['assignment']['id']}/"))

    def test_missing_rights_are_named_and_previewed(self):
        self._site_editor(["deviceprofileassignment", "applicationgroupassignment", "device"])
        body = self.ok(self.client.post(f"{PROFILES}{self.p.id}/preview/", {
            "device_id": str(self.dev.id)}, format="json"))
        self.assertEqual([(m["type"], m["action"]) for m in body["missing_permissions"]],
                         [("installedsoftware", "add")])
        r = self.client.post(ASSIGN, {"profile_id": str(self.p.id),
                                      "device_id": str(self.dev.id)}, format="json")
        self.assertEqual(r.status_code, 403)
        self.assertIn("installed software", r.json()["detail"])
        self.assertFalse(DeviceProfileAssignment.objects.exists())
        self.assertFalse(ApplicationGroupAssignment.objects.exists())
