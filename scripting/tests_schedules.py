"""Scheduled scripts: due-ness, one run per occurrence, retention, and the
tick that ties them together."""
from __future__ import annotations

import tempfile
from datetime import timedelta
from io import StringIO
from unittest import mock

from django.contrib.auth import get_user_model
from django.core.files.base import ContentFile
from django.core.management import call_command
from django.test import TestCase, override_settings
from django.utils import timezone

from auth_api.models import ApiToken, ObjectPermission, UserProfile
from core.models import Organization, Tenant
from scripting.models import Script, ScriptOutput, ScriptRun
from scripting.schedules import due_scripts, fire, is_due, next_run, prune


class _Base(TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.override = override_settings(MEDIA_ROOT=self.tmp.name)
        self.override.enable()
        self.addCleanup(self.override.disable)
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.user = get_user_model().objects.create_user("owner", "o@e.com", "x")
        # A schedule runs as its owner, who must still hold `run` when it fires.
        UserProfile.objects.create(user=self.user).tenants.add(self.tenant)
        self.run_grant = ObjectPermission.objects.create(
            name="owner runs scripts", object_types=["script"],
            actions=["view", "add", "change", "run"],
        )
        self.run_grant.users.add(self.user)
        # Nothing in these tests should reach a worker.
        p = mock.patch("scripting.schedules.enqueue")
        p.start()
        self.addCleanup(p.stop)

    def _script(self, **kw):
        kw.setdefault("name", "nightly")
        kw.setdefault("owner", self.user)
        kw.setdefault("schedule_enabled", True)
        kw.setdefault("cadence", {"frequency": "daily", "at": "02:00"})
        return Script.objects.create(tenant=self.tenant, source="print(1)", **kw)


class DueTests(_Base):
    def test_due_only_once_per_occurrence(self):
        script = self._script()
        # created before today's 02:00, never run → due
        Script.objects.filter(pk=script.pk).update(
            created_at=timezone.now() - timedelta(days=2)
        )
        script.refresh_from_db()
        now = timezone.localtime().replace(hour=3, minute=0, second=0, microsecond=0)
        self.assertTrue(is_due(script, now))
        self.assertEqual([s.pk for s in due_scripts(now)], [script.pk])

        fire(script, now)
        script.refresh_from_db()
        self.assertFalse(is_due(script, now), "fired twice in one occurrence")
        self.assertEqual(script.runs.count(), 1)
        run = script.runs.first()
        self.assertTrue(run.scheduled)
        self.assertEqual(run.run_as_user, self.user)

    def test_disabled_and_unscheduled_are_never_due(self):
        now = timezone.localtime().replace(hour=3, minute=0)
        for kw in ({"enabled": False}, {"schedule_enabled": False}, {"cadence": {}}):
            script = self._script(name=str(kw), **kw)
            Script.objects.filter(pk=script.pk).update(
                created_at=timezone.now() - timedelta(days=2)
            )
            self.assertFalse(is_due(Script.objects.get(pk=script.pk), now), kw)

    def test_next_run_is_reported(self):
        self.assertIsNotNone(next_run(self._script()))

    def test_scheduled_params_reach_the_run(self):
        script = self._script(schedule_params={"site": "aarhus"})
        run = fire(script)
        self.assertEqual(run.params, {"site": "aarhus"})

    def test_an_ownerless_script_does_not_fire(self):
        script = self._script()
        Script.objects.filter(pk=script.pk).update(owner=None)
        self.assertIsNone(fire(Script.objects.get(pk=script.pk)))


class OwnerRecheckTests(_Base):
    """The owner's right to run is checked when the schedule fires, not only
    when it was set."""

    def _skipped(self, script):
        now = timezone.now()
        self.assertIsNone(fire(Script.objects.get(pk=script.pk), now))
        self.assertFalse(script.runs.exists())
        # Skipped once per occurrence, not retried every tick.
        self.assertEqual(Script.objects.get(pk=script.pk).last_run_at, now)

    def test_an_owner_who_lost_run_does_not_fire(self):
        script = self._script()
        self.run_grant.actions = ["view", "add", "change"]
        self.run_grant.save()
        self._skipped(script)

    def test_a_deactivated_owner_does_not_fire(self):
        script = self._script()
        self.user.is_active = False
        self.user.save(update_fields=["is_active"])
        self._skipped(script)

    def test_an_owner_removed_from_the_tenant_does_not_fire(self):
        script = self._script()
        self.user.profile.tenants.clear()
        self._skipped(script)

    def test_a_trusted_script_needs_the_owner_to_hold_trust(self):
        script = self._script(trusted=True)
        self._skipped(script)
        self.run_grant.actions = [*self.run_grant.actions, "trust"]
        self.run_grant.save()
        run = fire(Script.objects.get(pk=script.pk))
        self.assertIsNotNone(run)
        self.assertTrue(run.trusted)


class RetentionTests(_Base):
    def _run(self, script, days_ago, status="success"):
        run = ScriptRun.objects.create(script=script, status=status)
        ScriptRun.objects.filter(pk=run.pk).update(
            created_at=timezone.now() - timedelta(days=days_ago)
        )
        out = ScriptOutput(run=run, name="r.csv", size=3)
        out.file.save("r.csv", ContentFile(b"a,b"), save=True)
        return ScriptRun.objects.get(pk=run.pk)

    def test_count_and_age_rules_delete_runs_and_their_files(self):
        script = self._script(retention={"max_count": 2})
        keep_a, keep_b = self._run(script, 1), self._run(script, 2)
        old = self._run(script, 3)
        path = old.outputs.first().file.path
        self.assertEqual(prune(script), 1)
        self.assertEqual(set(script.runs.values_list("pk", flat=True)), {keep_a.pk, keep_b.pk})
        self.assertFalse(ScriptOutput.objects.filter(run_id=old.pk).exists())
        import os

        self.assertFalse(os.path.exists(path))

    def test_a_running_run_is_never_pruned(self):
        script = self._script(retention={"max_count": 1})
        self._run(script, 5, status="running")
        self._run(script, 1)
        self.assertEqual(prune(script), 0)
        self.assertEqual(script.runs.count(), 2)

    def test_no_rule_prunes_nothing(self):
        script = self._script(retention={})
        for d in range(5):
            self._run(script, d + 1)
        self.assertEqual(prune(script), 0)


class TickTests(_Base):
    def test_command_fires_prunes_and_purges(self):
        script = self._script(retention={"max_count": 1})
        Script.objects.filter(pk=script.pk).update(
            created_at=timezone.now() - timedelta(days=2)
        )
        for _ in range(3):
            ScriptRun.objects.create(script=script, status="success")
        ApiToken.objects.create(
            user=self.user, tenant=self.tenant, name="dead run", key_hash="b" * 64,
            prefix="dbt_dead", kind="run",
            expires_at=timezone.now() - timedelta(hours=2),
        )
        out = StringIO()
        call_command("run_scripts", stdout=out)
        self.assertIn("started 1 script(s)", out.getvalue())
        self.assertFalse(ApiToken.objects.filter(kind="run").exists())
        # the fresh scheduled run survives; the three old ones are pruned to the rule
        self.assertLessEqual(script.runs.count(), 2)

    def test_quiet_tick_says_nothing_due(self):
        self._script(schedule_enabled=False)
        out = StringIO()
        call_command("run_scripts", stdout=out)
        self.assertIn("nothing due", out.getvalue())


class UpgradeKeepsSchedulesTests(_Base):
    """0.17 made a schedule need run. An existing schedule whose owner could
    not run it - an Administrator or Operator, say - keeps firing through a
    grant limited to that script, and only that script."""

    def _migrate(self):
        import contextlib
        import importlib
        import io

        from django.apps import apps

        mig = importlib.import_module("scripting.migrations.0002_keep_scheduled_scripts")
        with contextlib.redirect_stdout(io.StringIO()):
            mig.forwards(apps, None)

    def test_an_owner_without_run_keeps_their_schedules_and_nothing_more(self):
        from auth_api import rbac
        from scripting.schedules import owner_may_run

        self.run_grant.actions = ["view", "add", "change", "delete"]
        self.run_grant.save()
        scheduled = self._script(name="nightly")
        trusted = self._script(name="trusted", trusted=True)
        unscheduled = self._script(name="adhoc", schedule_enabled=False)
        self.assertFalse(owner_may_run(scheduled))

        self._migrate()
        for s in (scheduled, trusted):
            self.assertTrue(owner_may_run(Script.objects.get(pk=s.pk)), s.name)
        # Limited to the scheduled scripts: nothing else runs, and trust
        # covers the trusted one only.
        for action, script, ok in (
            ("run", unscheduled, False),
            ("trust", scheduled, False),
            ("trust", trusted, True),
        ):
            with self.subTest(action=action, script=script.name):
                self.assertEqual(
                    rbac.can_act_on(self.user, self.tenant, "script", action, script), ok
                )

        before = ObjectPermission.objects.count()
        self._migrate()
        self.assertEqual(ObjectPermission.objects.count(), before)

    def test_owners_who_may_run_or_should_not_are_left_alone(self):
        self._script(name="fine")
        gone = get_user_model().objects.create_user("gone", "", "x", is_active=False)
        UserProfile.objects.create(user=gone).tenants.add(self.tenant)
        self._script(name="orphaned", owner=gone)
        before = ObjectPermission.objects.count()
        self._migrate()
        self.assertEqual(ObjectPermission.objects.count(), before)
