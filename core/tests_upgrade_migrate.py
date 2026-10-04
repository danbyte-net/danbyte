"""The upgrade's migrate, verify and maintenance commands."""
from __future__ import annotations

import contextlib
import uuid
from io import StringIO
from types import SimpleNamespace
from unittest.mock import patch

from django.contrib.auth.models import User
from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import IntegrityError, OperationalError, connection, transaction
from django.test import SimpleTestCase, TestCase

from backups import maintenance
from core import upgrade_migrate as um


def _mig(name, atomic=True):
    return SimpleNamespace(app_label="api", name=name, atomic=atomic)


class _PgError(Exception):
    def __init__(self, code):
        super().__init__(f"sqlstate {code}")
        self.sqlstate = code


def _db_error(code):
    exc = OperationalError(f"wrapped {code}")
    exc.__cause__ = _PgError(code)
    return exc


class RunMigrateTests(SimpleTestCase):
    """The wrapping decisions, with Django's migrate replaced by a recorder."""

    def setUp(self):
        self.calls = []
        self.depth = 0

        @contextlib.contextmanager
        def fake_atomic(using=None):
            self.depth += 1
            try:
                yield
            finally:
                self.depth -= 1

        def fake_migrate(alias, verbosity, stdout):
            self.calls.append({"atomic": self.depth > 0, "flushing": um.flushing()})
            if self.outcomes:
                outcome = self.outcomes.pop(0)
                if outcome is not None:
                    raise outcome

        self.outcomes = []
        for target, value in (("core.upgrade_migrate.transaction.atomic", fake_atomic),
                              ("core.upgrade_migrate._migrate", fake_migrate)):
            p = patch(target, value)
            p.start()
            self.addCleanup(p.stop)

    def _run(self, plan, **kw):
        with patch("core.upgrade_migrate.pending_plan", return_value=plan):
            return um.run_migrate(**kw)

    def test_nothing_pending_runs_nothing(self):
        r = self._run([])
        self.assertEqual((r.code, r.mode), (0, "none"))
        self.assertEqual(self.calls, [])

    def test_an_atomic_plan_runs_in_one_transaction_and_flushes(self):
        r = self._run([_mig("0184"), _mig("0185")])
        self.assertEqual((r.code, r.mode, r.planned), (0, "atomic", 2))
        self.assertEqual(self.calls, [{"atomic": True, "flushing": "default"}])
        self.assertIsNone(um.flushing())

    def test_a_non_atomic_migration_runs_plain(self):
        r = self._run([_mig("0184"), _mig("0185", atomic=False)])
        self.assertEqual((r.code, r.mode), (0, "plain"))
        self.assertEqual(self.calls, [{"atomic": False, "flushing": None}])
        self.assertIn("non-atomic migration api.0185", r.notes[0])

    def test_the_env_switch_runs_plain(self):
        with patch.dict("os.environ", {"DANBYTE_UPGRADE_ATOMIC_MIGRATE": "0"}):
            r = self._run([_mig("0184")])
        self.assertEqual(r.mode, "plain")
        self.assertFalse(self.calls[0]["atomic"])

    def test_a_failed_transaction_leaves_the_database_unchanged(self):
        self.outcomes = [_db_error("42703")]
        r = self._run([_mig("0184")])
        self.assertEqual((r.code, r.mode), (um.EXIT_UNCHANGED, "atomic"))
        self.assertEqual(len(self.calls), 1)

    def test_transaction_limits_retry_once_without_it(self):
        for code in ("55006", "53200", "54000"):
            with self.subTest(code=code):
                self.calls.clear()
                self.outcomes = [_db_error(code), None]
                r = self._run([_mig("0184")])
                self.assertEqual((r.code, r.mode), (0, "retried"))
                self.assertEqual([c["atomic"] for c in self.calls], [True, False])

    def test_a_failed_retry_may_be_partial(self):
        self.outcomes = [_db_error("53200"), _db_error("42P07")]
        r = self._run([_mig("0184")])
        self.assertEqual((r.code, r.mode), (um.EXIT_PARTIAL, "retried"))

    def test_a_failed_plain_run_may_be_partial(self):
        self.outcomes = [RuntimeError("boom")]
        r = self._run([_mig("0184", atomic=False)])
        self.assertEqual(r.code, um.EXIT_PARTIAL)

    def test_command_exit_codes(self):
        self.outcomes = [_db_error("42703")]
        with patch("core.upgrade_migrate.pending_plan", return_value=[_mig("0184")]):
            with self.assertRaises(CommandError) as ctx:
                call_command("upgrade_migrate", stdout=StringIO())
        self.assertEqual(ctx.exception.returncode, 3)
        self.assertIn("unchanged", str(ctx.exception))

    def test_plan_lists_and_says_how(self):
        out = StringIO()
        with patch("core.upgrade_migrate.pending_plan",
                   return_value=[_mig("0184"), _mig("0185", atomic=False)]):
            call_command("upgrade_migrate", "--plan", stdout=out)
        text = out.getvalue()
        self.assertIn("api.0185 (non-atomic)", text)
        self.assertIn("pending: 2", text)
        self.assertIn("mode: plain (non-atomic migration api.0185)", text)
        self.assertEqual(self.calls, [])

    def test_sqlstate_walks_the_cause_chain(self):
        self.assertEqual(um.sqlstate(_db_error("55006")), "55006")
        self.assertIsNone(um.sqlstate(RuntimeError("x")))


class BoundaryFlushTests(TestCase):
    """A migration may break a deferred foreign key for a moment; the check
    runs when it finishes, as a commit would, not at the start."""

    def _boundary(self):
        from core.management.commands.migrate import Command

        cmd = Command(stdout=StringIO())
        cmd.verbosity = 0
        with um._flush_at_boundaries("default"):
            cmd.migration_progress_callback("apply_success", _mig("0184"))

    def _dangling_tenant(self, org_id):
        """A tenant whose organization does not exist (yet); bulk_create
        skips save() so nothing looks the organization up."""
        from core.models import Tenant

        Tenant.objects.bulk_create([Tenant(org_id=org_id, name="T", slug="t")])

    def test_a_violation_mended_inside_the_migration_passes(self):
        from core.models import Organization

        oid = uuid.uuid4()
        with transaction.atomic():
            self._dangling_tenant(oid)        # FK to an organization not made yet
            Organization.objects.create(id=oid, name="O", slug="o")
            self._boundary()

    def test_a_violation_left_at_the_boundary_fails_there(self):
        with self.assertRaises(IntegrityError):
            with transaction.atomic():
                self._dangling_tenant(uuid.uuid4())
                self._boundary()

    def test_no_flush_outside_the_wrapper(self):
        from core.management.commands.migrate import Command

        with patch("core.upgrade_migrate.flush_deferred") as flush:
            cmd = Command(stdout=StringIO())
            cmd.verbosity = 0
            cmd.migration_progress_callback("apply_success", _mig("0184"))
        flush.assert_not_called()


class VerifyTests(TestCase):
    def test_passes_on_the_test_database(self):
        User.objects.create_superuser("root", "r@e.com", "x")
        out = StringIO()
        call_command("upgrade_verify", stdout=out)
        self.assertIn("verified", out.getvalue())

    def test_passes_without_a_superuser(self):
        problems, notes = um.verify()
        self.assertEqual(problems, [])
        self.assertTrue(any("no active superuser" in n for n in notes))

    def test_pending_migrations_fail_it(self):
        with patch("core.upgrade_migrate.pending_plan", return_value=[_mig("0999_new")]):
            with self.assertRaises(CommandError) as ctx:
                call_command("upgrade_verify", stdout=StringIO(), stderr=StringIO())
        self.assertIn("api.0999_new", str(ctx.exception))

    def test_a_server_error_fails_it_and_a_client_error_does_not(self):
        User.objects.create_superuser("root", "r@e.com", "x")

        def view(status):
            def _v(request, *a, **kw):
                return SimpleNamespace(status_code=status)
            return _v

        with patch("django.urls.resolve", return_value=SimpleNamespace(
                func=view(500), args=(), kwargs={})):
            problems, _ = um.verify()
        self.assertTrue(any("HTTP 500" in p for p in problems))
        with patch("django.urls.resolve", return_value=SimpleNamespace(
                func=view(403), args=(), kwargs={})):
            problems, notes = um.verify()
        self.assertEqual(problems, [])
        self.assertTrue(any("HTTP 403" in n for n in notes))


class UpgradeMaintenanceTests(TestCase):
    def setUp(self):
        self.addCleanup(maintenance.leave)
        self.client.force_login(User.objects.create_superuser("root", "r@e.com", "x"))

    def test_on_holds_the_site_and_the_probe_passes(self):
        with patch.dict("os.environ", {"DANBYTE_UPGRADE_PROBE": "s3cret-token"}):
            call_command("upgrade_maintenance", "on", "--ttl", "60", stdout=StringIO())
        state = maintenance.active()
        self.assertTrue(state["upgrade"])
        self.assertNotIn("s3cret-token", str(state))
        r = self.client.get("/api/me/")
        self.assertEqual(r.status_code, 503)
        self.assertNotIn("probe_sha256", r.json()["maintenance"])
        self.assertEqual(self.client.get("/api/me/", HTTP_X_DANBYTE_PROBE="wrong").status_code, 503)
        self.assertEqual(self.client.get("/api/me/", HTTP_X_DANBYTE_PROBE="s3cret-token").status_code,
                         200)
        # exempt while held: health and the upgrade status
        self.assertEqual(self.client.get("/api/system/upgrade/status/").status_code, 200)
        call_command("upgrade_maintenance", "off", stdout=StringIO())
        self.assertEqual(self.client.get("/api/me/").status_code, 200)

    def test_no_probe_token_never_opens_it(self):
        maintenance.enter("restore in progress", "abc")
        self.assertFalse(maintenance.probe_matches(maintenance.active(), ""))
        self.assertEqual(self.client.get("/api/me/", HTTP_X_DANBYTE_PROBE="").status_code, 503)

    def test_does_not_take_over_a_restore(self):
        maintenance.enter("restore in progress", "abc")
        with self.assertRaises(CommandError):
            call_command("upgrade_maintenance", "on", stdout=StringIO())
        self.assertEqual(maintenance.active()["run_id"], "abc")
