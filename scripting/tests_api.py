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


class ExecutionRightsTests(_Base):
    """Trust approves specific code, and running as the owner lends the
    owner's identity to whoever may edit the script (#317)."""

    def setUp(self):
        super().setUp()
        U = get_user_model()
        self.editor = U.objects.create_user("editor", "e@e.com", "x")
        self.approver = U.objects.create_user("approver", "p@e.com", "x")
        for u in (self.editor, self.approver):
            UserProfile.objects.create(user=u, role="custom").tenants.add(self.tenant)
        grant(self.editor, self.tenant, ["view", "change", "run"])
        grant(self.approver, self.tenant, ["view", "change", "run", "trust"])
        self.script = self._script(visibility="users", trusted=True)
        self.script.shared_users.add(self.editor, self.approver)

    def _patch(self, user, body, script=None):
        self.client.force_login(user)
        return self.client.patch(f"/api/scripts/{(script or self.script).id}/", body,
                                 format="json")

    def _log(self):
        from audit.models import ChangeLogEntry

        return ChangeLogEntry.objects.filter(object_id=str(self.script.id), action="update")

    def test_a_source_change_without_trust_clears_trusted(self):
        r = self._patch(self.editor, {"source": "print('mine')"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(r.json()["trusted"])
        self.script.refresh_from_db()
        self.assertFalse(self.script.trusted)
        self.assertEqual(self.script.source, "print('mine')")
        # the next run executes sandboxed
        self.client.force_login(self.editor)
        r = self.client.post(f"/api/scripts/{self.script.id}/run/")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertFalse(ScriptRun.objects.get(pk=r.json()["id"]).trusted)
        # audited as one change by the editor, trust reset included
        entry = self._log().get()
        self.assertEqual(entry.user, self.editor)
        self.assertEqual(entry.changes["trusted"], {"old": True, "new": False})
        self.assertIn("source", entry.changes)

    def test_the_owner_without_trust_also_loses_it(self):
        r = self._patch(self.author, {"source": "print('v2')"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertFalse(r.json()["trusted"])

    def test_a_holder_of_trust_keeps_it_trusted(self):
        r = self._patch(self.approver, {"source": "print('reviewed')"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()["trusted"])
        self.assertTrue(Script.objects.get(pk=self.script.pk).trusted)

    def test_every_executed_field_clears_trusted(self):
        for body in (
            {"params_schema": [{"name": "site", "type": "string", "default": "x"}]},
            {"schedule_params": {"site": "aarhus"}},
        ):
            Script.objects.filter(pk=self.script.pk).update(trusted=True)
            r = self._patch(self.editor, body)
            self.assertEqual(r.status_code, 200, r.content)
            self.assertFalse(r.json()["trusted"], body)

    def test_an_unrelated_edit_keeps_trusted(self):
        for body in (
            {"description": "d"},
            {"timeout_seconds": 60, "token_scope": "read"},
            {"source": "print('hi')"},  # unchanged
            {"params_schema": [], "schedule_params": {}},  # unchanged
        ):
            r = self._patch(self.editor, body)
            self.assertEqual(r.status_code, 200, r.content)
            self.assertTrue(r.json()["trusted"], body)
        self.assertFalse(self._log().filter(changes__has_key="trusted").exists())

    def test_run_as_owner_needs_the_owner_or_trust(self):
        r = self._patch(self.editor, {"run_as": "owner"})
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("run_as", r.json())
        self.assertEqual(Script.objects.get(pk=self.script.pk).run_as, "caller")

        r = self._patch(self.author, {"run_as": "owner"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["run_as"], "owner")
        # resending the same value, or stepping back down, is not a grant
        r = self._patch(self.editor, {"run_as": "owner", "timeout_seconds": 60})
        self.assertEqual(r.status_code, 200, r.content)
        r = self._patch(self.editor, {"run_as": "caller"})
        self.assertEqual(r.status_code, 200, r.content)

        r = self._patch(self.approver, {"run_as": "owner"})
        self.assertEqual(r.status_code, 200, r.content)

    def test_run_as_owner_on_create_is_the_creator(self):
        self.client.force_login(self.editor)
        grant(self.editor, self.tenant, ["add"])
        r = self.client.post("/api/scripts/", {"name": "own", "run_as": "owner"}, format="json")
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()["owner_name"], "editor")

    def test_others_cannot_change_what_an_owner_run_script_executes(self):
        Script.objects.filter(pk=self.script.pk).update(run_as="owner")
        for body in (
            {"source": "print('as the owner')"},
            {"params_schema": [{"name": "n", "type": "integer", "default": 1}]},
            {"schedule_params": {"n": 2}},
        ):
            r = self._patch(self.editor, body)
            self.assertEqual(r.status_code, 400, (body, r.content))
            self.assertEqual(set(r.json()), set(body))
        self.script.refresh_from_db()
        self.assertEqual(self.script.source, "print('hi')")
        self.assertTrue(self.script.trusted)
        # settings that do not change what runs are still theirs to edit
        r = self._patch(self.editor, {"description": "d", "timeout_seconds": 30})
        self.assertEqual(r.status_code, 200, r.content)
        # the owner and a holder of trust may
        r = self._patch(self.author, {"source": "print('v2')"})
        self.assertEqual(r.status_code, 200, r.content)
        r = self._patch(self.approver, {"source": "print('v3')"})
        self.assertEqual(r.status_code, 200, r.content)

    def test_stepping_down_to_the_caller_frees_the_code_but_clears_trust(self):
        Script.objects.filter(pk=self.script.pk).update(run_as="owner")
        r = self._patch(self.editor, {"run_as": "caller", "source": "print('mine')"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["run_as"], "caller")
        self.assertFalse(r.json()["trusted"])
        self.client.force_login(self.editor)
        r = self.client.post(f"/api/scripts/{self.script.id}/run/")
        run = ScriptRun.objects.get(pk=r.json()["id"])
        self.assertEqual(run.run_as_user, self.editor)
        self.assertFalse(run.trusted)

    def test_a_schedule_runs_as_the_owner_so_the_same_rule_applies(self):
        cadence = {"frequency": "daily", "at": "02:00"}
        r = self._patch(self.editor, {"schedule_enabled": True, "cadence": cadence})
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("schedule_enabled", r.json())

        r = self._patch(self.author, {"schedule_enabled": True, "cadence": cadence})
        self.assertEqual(r.status_code, 200, r.content)
        r = self._patch(self.editor, {"source": "print('scheduled')"})
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("source", r.json())
        # re-saving the schedule as it is, or switching it off, is fine
        r = self._patch(self.editor, {"schedule_enabled": True, "cadence": cadence})
        self.assertEqual(r.status_code, 200, r.content)
        r = self._patch(self.editor, {"schedule_enabled": False})
        self.assertEqual(r.status_code, 200, r.content)
        r = self._patch(self.editor, {"source": "print('scheduled')"})
        self.assertEqual(r.status_code, 200, r.content)

    def test_others_cannot_widen_the_token_of_an_owner_run_script(self):
        Script.objects.filter(pk=self.script.pk).update(run_as="owner", token_scope="read")
        r = self._patch(self.editor, {"token_scope": "full"})
        self.assertEqual(r.status_code, 400, r.content)
        self.assertEqual(set(r.json()), {"token_scope"})
        self.assertEqual(Script.objects.get(pk=self.script.pk).token_scope, "read")
        # resending the same value is not a widening
        r = self._patch(self.editor, {"token_scope": "read", "timeout_seconds": 60})
        self.assertEqual(r.status_code, 200, r.content)
        # the owner and a holder of trust may
        r = self._patch(self.author, {"token_scope": "full"})
        self.assertEqual(r.status_code, 200, r.content)
        Script.objects.filter(pk=self.script.pk).update(token_scope="read")
        r = self._patch(self.approver, {"token_scope": "full"})
        self.assertEqual(r.status_code, 200, r.content)

    def test_narrowing_the_token_stays_open(self):
        Script.objects.filter(pk=self.script.pk).update(run_as="owner", token_scope="full")
        r = self._patch(self.editor, {"token_scope": "read"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["token_scope"], "read")

    def test_a_scheduled_scripts_token_follows_the_same_rule(self):
        Script.objects.filter(pk=self.script.pk).update(
            schedule_enabled=True, cadence={"frequency": "daily", "at": "02:00"},
            token_scope="read",
        )
        r = self._patch(self.editor, {"token_scope": "full"})
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("token_scope", r.json())
        # switching the schedule off in the same write makes it the caller's own
        r = self._patch(self.editor, {"token_scope": "full", "schedule_enabled": False})
        self.assertEqual(r.status_code, 200, r.content)

    def test_widening_a_caller_run_script_stays_open(self):
        Script.objects.filter(pk=self.script.pk).update(token_scope="read")
        r = self._patch(self.editor, {"token_scope": "full"})
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()["token_scope"], "full")

    def test_the_trust_action_is_audited(self):
        self.client.force_login(self.approver)
        r = self.client.post(f"/api/scripts/{self.script.id}/trust/", {"trusted": False},
                             format="json")
        self.assertEqual(r.status_code, 200, r.content)
        entry = self._log().get()
        self.assertEqual(entry.user, self.approver)
        self.assertEqual(entry.changes["trusted"], {"old": True, "new": False})


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


class ShareTargetTests(_Base):
    """A script is shared only with people and groups of its own tenant."""

    def setUp(self):
        super().setUp()
        other = Tenant.objects.create(org=self.tenant.org, name="Other", slug="other")
        self.outsider = get_user_model().objects.create_user("outsider", "o@e.com", "x")
        UserProfile.objects.create(user=self.outsider, role="custom").tenants.add(other)
        self.far_team = Group.objects.create(name="far-team")
        self.outsider.groups.add(self.far_team)
        self.team = Group.objects.create(name="team")
        self.reader.groups.add(self.team)
        self.script = self._script(visibility="users")
        self.client.force_login(self.author)

    def _patch(self, body):
        return self.client.patch(f"/api/scripts/{self.script.id}/", body, format="json")

    def test_shares_within_the_tenant(self):
        r = self._patch({"shared_users": [self.reader.id]})
        self.assertEqual(r.status_code, 200, r.content)
        r = self._patch({"visibility": "groups", "shared_groups": [self.team.id]})
        self.assertEqual(r.status_code, 200, r.content)

    def test_refuses_people_and_groups_of_another_tenant(self):
        r = self._patch({"shared_users": [self.reader.id, self.outsider.id]})
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("shared_users", r.json())
        r = self._patch({"visibility": "groups", "shared_groups": [self.far_team.id]})
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn("shared_groups", r.json())
        r = self.client.post("/api/scripts/", {
            "name": "new", "visibility": "users", "shared_users": [self.outsider.id],
        }, format="json")
        self.assertEqual(r.status_code, 400, r.content)
        self.assertFalse(self.script.shared_users.exists())

    def test_someone_already_on_the_list_stays(self):
        self.script.shared_users.add(self.outsider)
        r = self._patch({"description": "d", "shared_users": [self.outsider.id]})
        self.assertEqual(r.status_code, 200, r.content)

    def test_a_superuser_works_across_tenants(self):
        self.client.force_login(self.admin)
        session = self.client.session
        session["current_tenant_id"] = str(self.tenant.pk)
        session.save()
        r = self._patch({"shared_users": [self.outsider.id]})
        self.assertEqual(r.status_code, 200, r.content)
