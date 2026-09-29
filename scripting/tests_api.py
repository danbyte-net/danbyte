"""The scripts API: who sees what, who may run, who may trust, and what a
Run dialog is allowed to send."""
from __future__ import annotations

import tempfile
from unittest import mock

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group
from django.test import override_settings
from rest_framework.test import APITestCase

from auth_api.models import ObjectPermission, UserProfile
from auth_api.rbac import effective_actions
from core.models import Organization, Tenant
from scripting.models import Script, ScriptOutput, ScriptRun
from scripting.runner import create_run


def grant(user, tenant, actions, types=("script",)):
    perm = ObjectPermission.objects.create(
        name=f"{user.username}-{'-'.join(actions)}", object_types=list(types),
        actions=list(actions), enabled=True,
    )
    perm.tenants.add(tenant)
    perm.users.add(user)
    return perm


class _Base(APITestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.override = override_settings(MEDIA_ROOT=self.tmp.name)
        self.override.enable()
        self.addCleanup(self.override.disable)
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        U = get_user_model()
        self.admin = U.objects.create_superuser("admin", "a@e.com", "x")
        self.author = U.objects.create_user("author", "w@e.com", "x")
        self.reader = U.objects.create_user("reader", "r@e.com", "x")
        for u in (self.author, self.reader):
            UserProfile.objects.create(user=u, role="custom").tenants.add(self.tenant)
        grant(self.author, self.tenant, ["view", "add", "change", "delete", "run"])
        grant(self.reader, self.tenant, ["view"])
        self.enq = mock.patch("scripting.api_views.enqueue")
        self.enqueue = self.enq.start()
        self.addCleanup(self.enq.stop)

    def _script(self, **kw):
        kw.setdefault("name", "S")
        kw.setdefault("owner", self.author)
        return Script.objects.create(tenant=self.tenant, source="print('hi')", **kw)


class VerbTests(_Base):
    def test_run_and_trust_are_grantable_verbs(self):
        acts = effective_actions(self.author, self.tenant)
        self.assertIn("run", acts["script"])
        self.assertNotIn("trust", acts["script"])
        from auth_api.object_types import registry_payload

        entry = next(t for t in registry_payload() if t["slug"] == "script")
        self.assertEqual(entry["actions"], ["view", "add", "change", "delete", "run", "trust"])

    def test_row_permissions_report_run_and_trust(self):
        self._script(visibility="global")
        self.client.force_login(self.author)
        row = self.client.get("/api/scripts/").json()["results"][0]
        self.assertEqual(row["permissions"], {"change": True, "delete": True, "run": True,
                                              "trust": False})


class VisibilityTests(_Base):
    def test_each_visibility_reaches_exactly_the_right_people(self):
        group = Group.objects.create(name="netops")
        self.reader.groups.add(group)
        mine = self._script(name="mine", visibility="owner")
        shared = self._script(name="shared", visibility="users")
        shared.shared_users.add(self.reader)
        grouped = self._script(name="grouped", visibility="groups")
        grouped.shared_groups.add(group)
        published = self._script(name="published", visibility="global")

        self.client.force_login(self.reader)
        seen = {s["name"] for s in self.client.get("/api/scripts/").json()["results"]}
        self.assertEqual(seen, {"shared", "grouped", "published"})
        self.assertEqual(self.client.get(f"/api/scripts/{mine.id}/").status_code, 404)

        self.client.force_login(self.author)
        seen = {s["name"] for s in self.client.get("/api/scripts/").json()["results"]}
        self.assertEqual(seen, {"mine", "shared", "grouped", "published"})

    def test_publishing_globally_needs_the_permission(self):
        self.client.force_login(self.author)
        body = {"name": "pub", "source": "print(1)", "visibility": "global"}
        r = self.client.post("/api/scripts/", body, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("publish", r.json()["visibility"][0])

        prof = self.author.profile
        prof.permissions = ["scripts.publish"]
        prof.save()
        r = self.client.post("/api/scripts/", body, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["visibility"], "global")
        self.assertEqual(r.json()["owner_name"], "author")

    def test_a_run_is_only_visible_with_its_script(self):
        hidden = self._script(name="hidden", visibility="owner")
        run = create_run(hidden, user=self.author)
        self.client.force_login(self.reader)
        self.assertEqual(self.client.get("/api/scripts/runs/").json()["count"], 0)
        self.assertEqual(self.client.get(f"/api/scripts/runs/{run.id}/").status_code, 404)
        self.client.force_login(self.author)
        self.assertEqual(self.client.get(f"/api/scripts/runs/{run.id}/").status_code, 200)


class RunTests(_Base):
    def test_running_needs_the_run_verb(self):
        script = self._script(visibility="global")
        self.client.force_login(self.reader)
        self.assertEqual(self.client.post(f"/api/scripts/{script.id}/run/").status_code, 403)
        self.client.force_login(self.author)
        r = self.client.post(f"/api/scripts/{script.id}/run/")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["status"], "queued")
        self.enqueue.assert_called_once()
        run = ScriptRun.objects.get(pk=r.json()["id"])
        self.assertEqual(run.started_by, self.author)
        self.assertEqual(run.run_as_user, self.author)
        self.assertEqual(run.source, "print('hi')")

    def test_params_are_validated_against_the_schema(self):
        script = self._script(params_schema=[
            {"name": "site", "type": "string", "required": True},
            {"name": "limit", "type": "integer", "default": 10},
            {"name": "mode", "type": "choice", "choices": ["a", "b"]},
        ])
        self.client.force_login(self.author)
        r = self.client.post(f"/api/scripts/{script.id}/run/", {"params": {}}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("required", r.json()["site"][0])

        r = self.client.post(f"/api/scripts/{script.id}/run/",
                             {"params": {"site": "aarhus", "limit": "no"}}, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("integer", r.json()["limit"][0])

        r = self.client.post(f"/api/scripts/{script.id}/run/",
                             {"params": {"site": "aarhus", "mode": "z"}}, format="json")
        self.assertEqual(r.status_code, 400)

        r = self.client.post(f"/api/scripts/{script.id}/run/",
                             {"params": {"site": "aarhus", "limit": "25"}}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(ScriptRun.objects.get(pk=r.json()["id"]).params,
                         {"site": "aarhus", "limit": 25, "mode": None})

    def test_a_disabled_script_does_not_run(self):
        script = self._script(enabled=False)
        self.client.force_login(self.author)
        r = self.client.post(f"/api/scripts/{script.id}/run/")
        self.assertEqual(r.status_code, 400)
        self.assertIn("disabled", r.json()["detail"])

    def test_cancel_marks_the_run_and_needs_run(self):
        script = self._script(visibility="global")
        run = create_run(script, user=self.author)
        self.client.force_login(self.reader)
        self.assertEqual(self.client.post(f"/api/scripts/runs/{run.id}/cancel/").status_code, 403)
        self.client.force_login(self.author)
        r = self.client.post(f"/api/scripts/runs/{run.id}/cancel/")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["status"], "canceled")
        r = self.client.post(f"/api/scripts/runs/{run.id}/cancel/")
        self.assertEqual(r.status_code, 400)

    def test_output_download(self):
        from django.core.files.base import ContentFile

        script = self._script(visibility="global")
        run = create_run(script, user=self.author)
        out = ScriptOutput(run=run, name="report.csv", content_type="text/csv", size=7)
        out.file.save("report.csv", ContentFile(b"a,b\n1,2\n"), save=True)
        self.client.force_login(self.author)
        r = self.client.get(f"/api/scripts/runs/{run.id}/outputs/{out.id}/download/")
        self.assertEqual(r.status_code, 200)
        self.assertIn("report.csv", r["Content-Disposition"])
        self.assertEqual(b"".join(r.streaming_content), b"a,b\n1,2\n")
        r = self.client.get(f"/api/scripts/runs/{run.id}/outputs/{run.id}/download/")
        self.assertEqual(r.status_code, 404)


class TrustTests(_Base):
    def test_trusted_cannot_be_set_by_writing_the_field(self):
        script = self._script()
        self.client.force_login(self.author)
        r = self.client.patch(f"/api/scripts/{script.id}/", {"trusted": True}, format="json")
        self.assertEqual(r.status_code, 200)
        self.assertFalse(Script.objects.get(pk=script.pk).trusted)

    def test_the_trust_action_needs_its_own_grant(self):
        script = self._script()
        self.client.force_login(self.author)
        self.assertEqual(self.client.post(f"/api/scripts/{script.id}/trust/").status_code, 403)
        grant(self.author, self.tenant, ["trust"])
        r = self.client.post(f"/api/scripts/{script.id}/trust/", {"trusted": True}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(Script.objects.get(pk=script.pk).trusted)
        r = self.client.post(f"/api/scripts/{script.id}/trust/", {"trusted": False}, format="json")
        self.assertFalse(Script.objects.get(pk=script.pk).trusted)


class ValidationTests(_Base):
    def test_schema_and_timeout_are_checked(self):
        self.client.force_login(self.author)
        bad = {"name": "x", "params_schema": [{"name": "not a name", "type": "string"}]}
        r = self.client.post("/api/scripts/", bad, format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("usable name", str(r.json()["params_schema"]))

        r = self.client.post("/api/scripts/", {"name": "x", "timeout_seconds": 99999},
                             format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("timeout_seconds", r.json())

        r = self.client.post("/api/scripts/", {
            "name": "ok", "params_schema": [{"name": "site", "type": "choice",
                                             "choices": ["a"]}],
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["params_schema"][0]["label"], "Site")

    def test_a_schedule_needs_a_cadence(self):
        self.client.force_login(self.author)
        r = self.client.post("/api/scripts/", {"name": "s", "schedule_enabled": True},
                             format="json")
        self.assertEqual(r.status_code, 400)
        self.assertIn("cadence", r.json())
        r = self.client.post("/api/scripts/", {
            "name": "s", "schedule_enabled": True,
            "cadence": {"frequency": "daily", "at": "02:00"},
        }, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["cadence_label"], "daily at 02:00")
        self.assertIsNotNone(r.json()["next_run_at"])


class ExecutionFieldTests(_Base):
    """What a script runs, and whose access it runs with, stay the owner's:
    a colleague it is shared with can't trojan it, and a schedule - code
    running unattended as the owner - needs the run permission."""

    def setUp(self):
        super().setUp()
        U = get_user_model()
        self.editor = U.objects.create_user("editor", "e@e.com", "x")
        UserProfile.objects.create(user=self.editor, role="custom").tenants.add(self.tenant)
        grant(self.editor, self.tenant, ["view", "add", "change"])
        self.shared = self._script(visibility="users", run_as="caller")
        self.shared.shared_users.add(self.editor)

    def _patch(self, script, body):
        return self.client.patch(f"/api/scripts/{script.id}/", body, format="json")

    def test_a_colleague_cannot_change_code_or_who_it_runs_as(self):
        self.client.force_login(self.editor)
        for body in (
            {"source": "import os"},
            {"run_as": "owner"},
            {"token_scope": "read"},
            {"params_schema": [{"name": "x", "type": "string"}]},
            {"schedule_enabled": True, "cadence": {"frequency": "daily", "at": "02:00"}},
        ):
            with self.subTest(body=body):
                r = self._patch(self.shared, body)
                self.assertEqual(r.status_code, 400, r.content)
                self.assertIn("owner", str(r.json()))
        self.shared.refresh_from_db()
        self.assertEqual(self.shared.source, "print('hi')")
        self.assertEqual(self.shared.run_as, "caller")

    def test_a_colleague_may_still_edit_the_rest(self):
        self.client.force_login(self.editor)
        # The page sends unchanged fields back; only a real change counts.
        r = self._patch(self.shared, {
            "name": "Renamed", "description": "d", "source": "print('hi')",
            "run_as": "caller", "enabled": False,
        })
        self.assertEqual(r.status_code, 200, r.content)

    def test_scheduling_needs_the_run_permission(self):
        mine = self._script(owner=self.editor, name="mine")
        self.client.force_login(self.editor)
        schedule = {
            "schedule_enabled": True, "cadence": {"frequency": "daily", "at": "02:00"},
        }
        r = self._patch(mine, schedule)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("run permission", str(r.json()))
        r = self.client.post("/api/scripts/", {"name": "new", **schedule}, format="json")
        self.assertEqual(r.status_code, 400, r.content)
        grant(self.editor, self.tenant, ["run"])
        self.assertEqual(self._patch(mine, schedule).status_code, 200)

    def test_new_code_on_a_scheduled_script_needs_run(self):
        mine = self._script(
            owner=self.editor, name="mine", schedule_enabled=True,
            cadence={"frequency": "daily", "at": "02:00"},
        )
        self.client.force_login(self.editor)
        r = self._patch(mine, {"source": "print('changed')"})
        self.assertEqual(r.status_code, 400, r.content)
        # Unscheduled, the owner edits code freely.
        self.assertEqual(self._patch(self.shared, {}).status_code, 200)
        unscheduled = self._script(owner=self.editor, name="plain")
        self.assertEqual(
            self._patch(unscheduled, {"source": "print('ok')"}).status_code, 200
        )

    def test_new_code_without_trust_clears_the_trusted_mark(self):
        script = self._script(trusted=True, name="trusted")
        self.client.force_login(self.author)
        r = self._patch(script, {"description": "same code"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(Script.objects.get(pk=script.pk).trusted)
        r = self._patch(script, {"source": "print('new')"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(Script.objects.get(pk=script.pk).trusted)
        # With trust, the owner keeps the mark.
        grant(self.author, self.tenant, ["trust"])
        Script.objects.filter(pk=script.pk).update(trusted=True)
        self._patch(script, {"source": "print('newer')"})
        self.assertTrue(Script.objects.get(pk=script.pk).trusted)

    def test_a_superuser_may_edit_anyones_script(self):
        self.client.force_login(self.admin)
        r = self._patch(self.shared, {"source": "print('reviewed')", "run_as": "owner"})
        self.assertEqual(r.status_code, 200, r.content)



class SharingTests(_Base):
    """Who a script is shared with decides who may act as its owner when it
    runs as the owner, so sharing is the owner's too - and only ever with
    the tenant's own people."""

    def setUp(self):
        super().setUp()
        U = get_user_model()
        self.editor = U.objects.create_user("editor", "e@e.com", "x")
        UserProfile.objects.create(user=self.editor, role="custom").tenants.add(self.tenant)
        grant(self.editor, self.tenant, ["view", "add", "change"])
        self.runner = U.objects.create_user("runner", "r2@e.com", "x")
        UserProfile.objects.create(user=self.runner, role="custom").tenants.add(self.tenant)
        grant(self.runner, self.tenant, ["view", "run"])
        other = Tenant.objects.create(org=self.tenant.org, name="Other", slug="other")
        self.outsider = U.objects.create_user("outsider", "o@e.com", "x")
        UserProfile.objects.create(user=self.outsider, role="custom").tenants.add(other)
        self.far_team = Group.objects.create(name="far-team")
        self.outsider.groups.add(self.far_team)
        self.script = self._script(visibility="users", run_as="owner")
        self.script.shared_users.add(self.editor)

    def _patch(self, body, user):
        self.client.force_login(user)
        return self.client.patch(f"/api/scripts/{self.script.id}/", body, format="json")

    def test_a_colleague_cannot_reshare_a_script(self):
        for body in (
            {"shared_users": [self.editor.id, self.runner.id]},
            {"visibility": "owner"},
            {"visibility": "groups", "shared_groups": []},
        ):
            with self.subTest(body=body):
                r = self._patch(body, self.editor)
                self.assertEqual(r.status_code, 400, r.content)
                self.assertIn("owner", str(r.json()))
        self.assertEqual(list(self.script.shared_users.all()), [self.editor])
        # The runner never saw it, so cannot run it as the owner.
        self.client.force_login(self.runner)
        r = self.client.post(f"/api/scripts/{self.script.id}/run/", {}, format="json")
        self.assertEqual(r.status_code, 404, r.content)

    def test_unchanged_sharing_sent_back_is_fine(self):
        r = self._patch(
            {"description": "d", "visibility": "users", "shared_users": [self.editor.id]},
            self.editor,
        )
        self.assertEqual(r.status_code, 200, r.content)

    def test_the_owner_shares_within_the_tenant_only(self):
        r = self._patch({"shared_users": [self.editor.id, self.runner.id]}, self.author)
        self.assertEqual(r.status_code, 200, r.content)
        r = self._patch({"shared_users": [self.editor.id, self.outsider.id]}, self.author)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("shared_users", r.json())
        r = self._patch(
            {"visibility": "groups", "shared_groups": [self.far_team.id]}, self.author
        )
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("shared_groups", r.json())


class ScheduleStopTests(_Base):
    """Anyone who may change a script can turn its schedule off, and the
    script says why a schedule skips its runs."""

    def setUp(self):
        super().setUp()
        U = get_user_model()
        self.editor = U.objects.create_user("editor", "e@e.com", "x")
        UserProfile.objects.create(user=self.editor, role="custom").tenants.add(self.tenant)
        grant(self.editor, self.tenant, ["view", "change"])
        self.script = self._script(
            visibility="users", schedule_enabled=True,
            cadence={"frequency": "daily", "at": "02:00"},
        )
        self.script.shared_users.add(self.editor)

    def test_a_colleague_may_turn_the_schedule_off_but_not_on(self):
        self.client.force_login(self.editor)
        url = f"/api/scripts/{self.script.id}/"
        r = self.client.patch(url, {"schedule_enabled": False}, format="json")
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(Script.objects.get(pk=self.script.pk).schedule_enabled)
        r = self.client.patch(url, {"schedule_enabled": True}, format="json")
        self.assertEqual(r.status_code, 400, r.content)

    def test_a_skipped_schedule_says_why(self):
        self.client.force_login(self.author)
        row = self.client.get(f"/api/scripts/{self.script.id}/").json()
        self.assertEqual(row["schedule_blocked"], "")
        self.assertIsNotNone(row["next_run_at"])
        ObjectPermission.objects.filter(users=self.author).update(
            actions=["view", "add", "change", "delete"]
        )
        row = self.client.get(f"/api/scripts/{self.script.id}/").json()
        self.assertIn("run permission", row["schedule_blocked"])
        self.assertIsNone(row["next_run_at"])
