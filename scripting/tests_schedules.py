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

from auth_api.models import ApiToken
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
