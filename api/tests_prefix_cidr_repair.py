"""Prefixes whose cidr is not an address: repaired, never deleted (#501).

0.19.0 and 0.19.1's migration api 0265 deleted them, and with each one every
IP address (CASCADE) and what hung off those. 0265 now rewrites what the
prefix API accepts and stops, changing nothing, on the rest; the upgrade
preflights and ``manage.py prefix_cidrs`` share its survey, and
``manage.py prefix_loss_report`` shows what the old version took.
"""
from __future__ import annotations

import contextlib
import importlib
import importlib.util
import io
import subprocess
import tempfile
import uuid
from pathlib import Path

from django.apps import apps as live_apps
from django.conf import settings
from django.contrib.auth import get_user_model
from django.core.management import CommandError, call_command
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TestCase, TransactionTestCase
from rest_framework.test import APITestCase

from core.models import Organization, Tenant

from .models import IPAddress, Prefix

M0265 = importlib.import_module("api.migrations.0265_drop_unparseable_prefixes")
BEFORE = ("api", "0261_sbom_package_ids")
TARGET = ("api", "0265_drop_unparseable_prefixes")


class _Editor:
    def __init__(self, conn):
        self.connection = conn


def _plant(tenant, cidr, value):
    """A prefix stored as ``value``, which the API and the containment index
    refuse; the index goes inside the test's transaction."""
    p = Prefix.objects.create(tenant=tenant, cidr=cidr)
    with connection.cursor() as cur:
        cur.execute("DROP INDEX IF EXISTS prefix_cidr_inet_gist")
        cur.execute("UPDATE api_prefix SET cidr = %s WHERE id = %s", [value, p.pk])
    return p


class RepairTests(APITestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        admin = get_user_model().objects.create_superuser("a", "a@x.dk", "pw")
        self.client.force_login(admin)
        s = self.client.session
        s["current_tenant_id"] = str(self.tenant.id)
        s.save()

    def test_the_rule_is_what_the_api_stores(self):
        for raw in (" 10.0.60.0/24", "10.0.60.0/24 ", "10.0.20.0/255.255.255.0",
                    "10.0.20.0/0.0.0.255", " 2001:0db8:0001::/64\t", "10.0.0.0/33",
                    "banana", "10.0.30.5/255.255.255.0", "10.0.0.1", "/24"):
            with self.subTest(raw=raw):
                r = self.client.post("/api/prefixes/", {"cidr": raw}, format="json")
                new, why = M0265.normalise(raw)
                if r.status_code == 201:
                    self.assertEqual(new, r.json()["cidr"])
                    Prefix.objects.filter(pk=r.json()["id"]).delete()
                else:
                    self.assertEqual(r.status_code, 400, r.content)
                    self.assertIsNone(new)
                    self.assertTrue(why)

    def test_repairs_and_deletes_nothing(self):
        space = _plant(self.tenant, "10.0.60.0/24", "10.0.60.0/24 ")
        mask = _plant(self.tenant, "10.0.20.0/24", "10.0.20.0/255.255.255.0")
        IPAddress.objects.create(tenant=self.tenant, prefix=space, ip_address="10.0.60.5")
        with self.assertLogs("danbyte.migrations", "WARNING") as logs:
            M0265.repair_unparseable(live_apps, _Editor(connection))
        space.refresh_from_db()
        mask.refresh_from_db()
        self.assertEqual((space.cidr, mask.cidr), ("10.0.60.0/24", "10.0.20.0/24"))
        self.assertEqual(IPAddress.objects.filter(prefix=space).count(), 1)
        text = "\n".join(logs.output)
        self.assertIn("'10.0.60.0/24 ' (tenant 'T'", text)
        self.assertIn("-> '10.0.60.0/24' (kept with it: 1 api.IPAddress", text)
        self.assertIn("rewrote 2 prefix cidr(s)", text)

    def test_a_row_it_cannot_repair_stops_it_before_any_change(self):
        Prefix.objects.create(tenant=self.tenant, cidr="10.0.20.0/24")
        space = _plant(self.tenant, "10.0.60.0/24", "10.0.60.0/24 ")
        dup = _plant(self.tenant, "10.0.21.0/24", "10.0.20.0/255.255.255.0")
        junk = _plant(self.tenant, "10.0.99.0/24", "banana")
        IPAddress.objects.create(tenant=self.tenant, prefix=junk, ip_address="10.0.99.9")
        with self.assertLogs("danbyte.migrations", "WARNING"):
            with self.assertRaises(M0265.UnrepairablePrefixes) as ctx:
                M0265.repair_unparseable(live_apps, _Editor(connection))
        msg = str(ctx.exception)
        self.assertIn("2 prefix(es)", msg)
        self.assertIn(f"prefix {junk.pk} cidr 'banana' (tenant 'T'", msg)
        self.assertIn(f"prefix {dup.pk}", msg)
        self.assertIn("which this VRF already has: 10.0.20.0/24", msg)
        self.assertNotIn(str(space.pk), msg)
        self.assertIn("prefix_cidrs --set", msg)
        space.refresh_from_db()
        self.assertEqual(space.cidr, "10.0.60.0/24 ")
        self.assertEqual(Prefix.objects.count(), 4)
        self.assertEqual(IPAddress.objects.filter(prefix=junk).count(), 1)

    def test_the_index_is_built_concurrently_because_a_plain_build_reads_old_rows(self):
        # One transaction (the upgrade's): repair, then a plain CREATE INDEX.
        # The build still reads the replaced version and fails on it - the
        # 0.19 delete had the same effect - so 0262 builds it concurrently.
        from django.db import DataError, transaction

        _plant(self.tenant, "10.0.60.0/24", "10.0.60.0/24 ")
        M0265.repair_unparseable(live_apps, _Editor(connection))
        with self.assertRaises(DataError), transaction.atomic(), connection.cursor() as cur:
            cur.execute("SET CONSTRAINTS ALL IMMEDIATE")
            cur.execute("CREATE INDEX t_inet ON api_prefix USING gist ((cidr::inet) inet_ops)")
        m0262 = importlib.import_module("api.migrations.0262_natural_name_and_inet_indexes")
        self.assertFalse(m0262.Migration.atomic)
        self.assertEqual(type(m0262.Migration.operations[1]).__name__, "AddIndexConcurrently")

    def test_the_upgrade_probe_reports_what_0265_would_do(self):
        _plant(self.tenant, "10.0.60.0/24", "10.0.60.0/24 ")
        _plant(self.tenant, "10.0.99.0/24", "banana")
        spec = importlib.util.spec_from_file_location(
            "dbtool_test", Path(settings.BASE_DIR) / "scripts/upgrade/dbtool.py")
        dbtool = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(dbtool)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            dbtool._prefix_survey(str(settings.BASE_DIR), connection)
        lines = out.getvalue().splitlines()
        self.assertIn("prefix_repair=1", lines)
        self.assertIn("prefix_unrepairable=1", lines)
        self.assertTrue(any(ln.startswith("prefix_unrepairable_rows=") and "banana" in ln
                            for ln in lines), lines)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            dbtool._prefix_survey("/nonexistent", connection)
        self.assertEqual(out.getvalue(), "")

    def test_the_command_lists_checks_and_sets(self):
        good = Prefix.objects.create(tenant=self.tenant, cidr="10.0.20.0/24")
        space = _plant(self.tenant, "10.0.60.0/24", "10.0.60.0/24 ")
        junk = _plant(self.tenant, "10.0.99.0/24", "banana")
        IPAddress.objects.create(tenant=self.tenant, prefix=junk, ip_address="10.0.99.9")
        out = io.StringIO()
        call_command("prefix_cidrs", stdout=out)
        self.assertIn(f"rewrite prefix {space.pk}", out.getvalue())
        self.assertIn(f"cannot repair prefix {junk.pk}", out.getvalue())
        with self.assertRaises(CommandError):
            call_command("prefix_cidrs", "--check", stdout=io.StringIO())
        for value, why in (("10.0.20.0/255.255.255.0", "already exists"),
                           ("10.0.98.0/24", "not inside"), ("pear", "not a valid")):
            with self.subTest(value=value), self.assertRaisesMessage(CommandError, why):
                call_command("prefix_cidrs", "--set", str(junk.pk), value,
                             stdout=io.StringIO())
        with self.assertRaisesMessage(CommandError, "already an address"):
            call_command("prefix_cidrs", "--set", str(good.pk), "10.0.1.0/24")
        call_command("prefix_cidrs", "--set", str(junk.pk), " 10.0.99.0/255.255.255.0",
                     stdout=io.StringIO())
        junk.refresh_from_db()
        self.assertEqual(junk.cidr, "10.0.99.0/24")
        call_command("prefix_cidrs", "--check", stdout=io.StringIO())
        from audit.models import ChangeLogEntry

        entry = ChangeLogEntry.objects.get(object_id=str(junk.pk), cause__contains="prefix_cidrs")
        self.assertEqual(entry.changes, {"cidr": {"old": "banana", "new": "10.0.99.0/24"}})

    def test_it_marks_the_upgrade_note_done(self):
        from core import upgrade_notes
        from core.models import DeploymentSettings

        self.assertEqual(M0265.NOTE_ID, upgrade_notes.PREFIX_CLEANUP_NOTE)
        self.assertIn(M0265.NOTE_ID, [n.id for n in upgrade_notes.NOTES])
        dep = DeploymentSettings.load()
        dep.upgrade_notes_done = []
        dep.save()
        M0265.repair_unparseable(live_apps, _Editor(connection))
        self.assertEqual(DeploymentSettings.load().upgrade_notes_done, [M0265.NOTE_ID])


class LossReportTests(TestCase):
    """prefix_loss_report reads a dump with pg_restore and changes nothing."""

    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="Acme", slug="acme")
        self.kept = Prefix.objects.create(tenant=self.tenant, cidr="10.1.0.0/24")
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dump = str(Path(self.tmp.name) / "old.dump")
        self._make_dump()

    def _make_dump(self):
        """A database from before the upgrade, as a pg_dump -Fc file: a
        schema of its own, committed on a second connection so pg_dump sees
        it, and dropped again."""
        from backups.engine import pg_args, pg_env

        schema = f"lossrpt_{uuid.uuid4().hex[:8]}"
        raw = connection.get_new_connection(connection.get_connection_params())
        raw.autocommit = True
        t = str(self.tenant.pk)
        self.bad_space, self.bad_junk, self.gone_valid = (str(uuid.uuid4()) for _ in range(3))
        rows = [
            (str(self.kept.pk), t, "10.1.0.0/24", "kept"),
            (self.bad_space, t, "10.0.60.0/24 ", "with a\ttab"),
            (self.bad_junk, t, "banana", None),
            (self.gone_valid, t, "10.5.0.0/16", "deleted by a user"),
        ]
        ips = [(str(uuid.uuid4()), self.bad_space, "10.0.60.5", "gw.example"),
               (str(uuid.uuid4()), self.bad_space, "10.0.60.6", ""),
               (str(uuid.uuid4()), self.bad_junk, "10.0.99.9", "")]
        self.lost_ips = [ip[2] for ip in ips]
        try:
            with raw.cursor() as cur:
                cur.execute(f"CREATE SCHEMA {schema}")
                cur.execute(f"CREATE TABLE {schema}.api_prefix (id uuid, tenant_id uuid,"
                            " vrf_id uuid, cidr varchar(64), description text)")
                cur.execute(f"CREATE TABLE {schema}.api_ipaddress (id uuid, prefix_id uuid,"
                            " ip_address inet, dns_name varchar(255), description text)")
                for pk, tenant, cidr, desc in rows:
                    cur.execute(f"INSERT INTO {schema}.api_prefix VALUES (%s, %s, NULL, %s, %s)",
                                [pk, tenant, cidr, desc])
                for pk, prefix, ip, dns in ips:
                    cur.execute(f"INSERT INTO {schema}.api_ipaddress VALUES (%s, %s, %s, %s, '')",
                                [pk, prefix, ip, dns])
            db = settings.DATABASES["default"]
            res = subprocess.run(
                ["pg_dump", "-Fc", "-w", "--no-owner", "-n", schema, *pg_args(db),
                 "-f", self.dump, connection.settings_dict["NAME"]],
                env=pg_env(), capture_output=True, text=True, timeout=120,
            )
            self.assertEqual(res.returncode, 0, res.stderr)
        finally:
            with raw.cursor() as cur:
                cur.execute(f"DROP SCHEMA IF EXISTS {schema} CASCADE")
            raw.close()

    def _report(self, *args):
        out = io.StringIO()
        call_command("prefix_loss_report", *args, stdout=out)
        return out.getvalue()

    def test_lists_what_the_old_migration_took(self):
        before = (Prefix.objects.count(), IPAddress.objects.count())
        text = self._report("--dump", self.dump)
        self.assertIn(f"prefix {self.bad_space} '10.0.60.0/24 ' (not an address; "
                      "tenant 'Acme', VRF Global): missing, with 2 of its 2", text)
        self.assertIn("    10.0.60.5 ", text)
        self.assertIn("gw.example", text)
        self.assertIn(f"prefix {self.bad_junk} 'banana'", text)
        self.assertNotIn(self.gone_valid, text)
        self.assertNotIn(str(self.kept.pk), text)
        self.assertIn("2 prefix(es) whose cidr is not an address are in the backup", text)
        self.assertIn("1 other missing prefix(es) (--all lists them)", text)
        self.assertIn("3 IP address(es) of missing prefixes are gone", text)
        self.assertIn(self.gone_valid, self._report("--dump", self.dump, "--all"))
        self.assertEqual((Prefix.objects.count(), IPAddress.objects.count()), before)

    def test_writes_the_rows_as_json_and_reads_an_archive(self):
        import json

        from backups.archive import Writer

        archive = str(Path(self.tmp.name) / "pre.dbk")
        with Writer(archive) as w:
            w.add_json("manifest.json", {"kind": "pre_upgrade"})
            w.add_file("db.dump", self.dump)
        out = str(Path(self.tmp.name) / "lost.json")
        text = self._report("--backup", archive, "--json", out)
        self.assertIn("2 prefix(es) whose cidr is not an address", text)
        data = json.loads(Path(out).read_text())
        self.assertEqual({p["id"] for p in data["prefixes"]}, {self.bad_space, self.bad_junk})
        self.assertEqual(sorted(ip["ip_address"] for ip in data["ip_addresses"]),
                         sorted(self.lost_ips))
        desc = {p["id"]: p["description"] for p in data["prefixes"]}
        self.assertEqual(desc[self.bad_space], "with a\ttab")
        self.assertIsNone(desc[self.bad_junk])

    def test_refuses_what_is_not_a_backup(self):
        with self.assertRaisesMessage(CommandError, "neither a file nor a backup id"):
            self._report("--backup", "nope")


class MigrationTests(TransactionTestCase):
    """The real migration, from the state before it, with legacy rows of each
    kind and what hangs off them: it stops on what it can't repair, changes
    nothing until then, and after the fix rewrites the rest in place; the
    containment index then builds."""

    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        # The closing flush empties migration-seeded rows a kept test DB
        # still needs.
        from auth_api.builtin_groups import ensure_builtin_groups

        ensure_builtin_groups()

    def _apps(self):
        executor = MigrationExecutor(connection)
        return executor._create_project_state(with_applied_migrations=True).apps

    def _migrate(self, target):
        executor = MigrationExecutor(connection)
        executor.loader.build_graph()
        executor.migrate(target)

    def test_repairs_in_place_and_stops_on_the_rest(self):
        self._migrate([BEFORE])
        try:
            self._run()
        finally:
            old = self._apps()
            for model in (("monitoring", "CheckAssignment"), ("api", "IPAddress"),
                          ("api", "Prefix")):
                old.get_model(*model).objects.all().delete()
            self._migrate(MigrationExecutor(connection).loader.graph.leaf_nodes())

    def _run(self):
        old = self._apps()
        Org, Ten = old.get_model("core", "Organization"), old.get_model("core", "Tenant")
        OldPrefix, OldIP = old.get_model("api", "Prefix"), old.get_model("api", "IPAddress")
        Template = old.get_model("monitoring", "CheckTemplate")
        Assignment = old.get_model("monitoring", "CheckAssignment")
        org = Org.objects.create(name="M", slug="m")
        acme = Ten.objects.create(org=org, name="Acme", slug="acme")
        beta = Ten.objects.create(org=org, name="Beta", slug="beta")
        tpl = Template.objects.create(tenant=acme, name="ping", slug="ping", kind="icmp")
        old.get_model("core", "DeploymentSettings").objects.update_or_create(
            pk=1, defaults={"upgrade_notes_done": []})

        def prefix(tenant, cidr, ips=()):
            p = OldPrefix.objects.create(tenant=tenant, cidr=cidr)
            for ip in ips:
                OldIP.objects.create(tenant=tenant, prefix=p, ip_address=ip)
            return p

        good = prefix(acme, "10.0.20.0/24", ["10.0.20.1"])
        space = prefix(acme, "10.0.60.0/24 ", ["10.0.60.1", "10.0.60.2", "10.0.60.3"])
        lead = prefix(beta, " 10.0.60.0/24", ["10.0.60.9"])
        mask = prefix(beta, "10.0.20.0/255.255.255.0", ["10.0.20.7", "10.0.20.8"])
        v6 = prefix(acme, " 2001:0db8:0001::/64")
        dup = prefix(acme, "10.0.20.0/255.255.255.0", ["10.0.20.9"])
        junk = prefix(acme, "banana", ["10.0.99.9"])
        wide = prefix(beta, "10.0.0.0/33")
        host = prefix(beta, "10.0.30.5/255.255.255.0")
        Assignment.objects.create(tenant=acme, template=tpl, prefix=space)
        Assignment.objects.create(tenant=acme, template=tpl,
                                  ip_address=OldIP.objects.get(ip_address="10.0.60.1"))
        Assignment.objects.create(tenant=acme, template=tpl, prefix=junk)
        counts = (OldPrefix.objects.count(), OldIP.objects.count(), Assignment.objects.count())
        self.assertEqual(counts, (9, 9, 3))

        # 1. It stops, lists each row it can't repair, and changes nothing.
        with self.assertLogs("danbyte.migrations", "WARNING") as logs:
            with self.assertRaises(M0265.UnrepairablePrefixes) as ctx:
                self._migrate([TARGET])
        msg = str(ctx.exception)
        self.assertIn("4 prefix(es)", msg)
        for p, why in ((dup, "which this VRF already has: 10.0.20.0/24"),
                       (junk, "no prefix length"),
                       (wide, "10.0.0.0/33"), (host, "has host bits set")):
            self.assertIn(f"prefix {p.pk} cidr {p.cidr!r}", msg)
            self.assertIn(why, msg)
        for p in (space, lead, mask, v6):
            self.assertNotIn(str(p.pk), msg)
        text = "\n".join(logs.output)
        self.assertIn(f"cannot repair prefix {junk.pk} cidr 'banana' (tenant 'Acme'", text)
        self.assertIn("1 api.IPAddress, 1 monitoring.CheckAssignment", text)
        self.assertEqual(
            (OldPrefix.objects.count(), OldIP.objects.count(), Assignment.objects.count()),
            counts)
        space.refresh_from_db()
        self.assertEqual(space.cidr, "10.0.60.0/24 ")
        self.assertFalse(MigrationExecutor(connection).loader.applied_migrations.get(TARGET))

        # 2. The command an operator runs before the migrations agrees.
        with self.assertRaises(CommandError):
            call_command("prefix_cidrs", "--check", stdout=io.StringIO())
        for p, value in ((dup, "10.0.20.0/23"), (junk, "10.0.99.0/24"),
                         (wide, "10.0.0.0/16"), (host, "10.0.30.0/24")):
            call_command("prefix_cidrs", "--set", str(p.pk), value, stdout=io.StringIO())
        call_command("prefix_cidrs", "--check", stdout=io.StringIO())

        # 3. Then the upgrade's migrate (the stage's run_migrate) rewrites the
        # rest in place, logs each one, keeps the dependents, and builds the
        # containment index - concurrently, since a plain build in the same
        # transaction reads the replaced row versions and fails on them.
        from core.upgrade_migrate import run_migrate

        with self.assertLogs("danbyte.migrations", "WARNING") as logs:
            result = run_migrate(stdout=io.StringIO())
        self.assertEqual(result.code, 0, result.error)
        self.assertEqual(result.mode, "plain")
        self.assertIn("non-atomic migration api.0262_natural_name_and_inet_indexes",
                      " ".join(result.notes))
        with connection.cursor() as cur:
            cur.execute("SELECT indisvalid FROM pg_index WHERE indexrelid ="
                        " 'prefix_cidr_inet_gist'::regclass")
            self.assertTrue(cur.fetchone()[0])
        text = "\n".join(logs.output)
        expect = {space: "10.0.60.0/24", lead: "10.0.60.0/24", mask: "10.0.20.0/24",
                  v6: "2001:db8:1::/64"}
        for p, new in expect.items():
            self.assertIn(f"prefix {p.pk} cidr {p.cidr!r}", text)
            self.assertIn(f"-> {new!r}", text)
            p.refresh_from_db()
            self.assertEqual(p.cidr, new)
        self.assertIn("3 api.IPAddress, 2 monitoring.CheckAssignment", text)
        self.assertIn("rewrote 4 prefix cidr(s)", text)
        self.assertEqual(
            (OldPrefix.objects.count(), OldIP.objects.count(), Assignment.objects.count()),
            counts)
        self.assertEqual(OldIP.objects.filter(prefix=space).count(), 3)
        new_apps = self._apps()
        Entry = new_apps.get_model("audit", "ChangeLogEntry")
        self.assertEqual(Entry.objects.get(object_id=str(mask.pk)).changes,
                         {"cidr": {"old": "10.0.20.0/255.255.255.0", "new": "10.0.20.0/24"}})
        self.assertEqual(
            new_apps.get_model("core", "DeploymentSettings").objects.get(pk=1)
            .upgrade_notes_done, [M0265.NOTE_ID])

        self.assertEqual(Prefix.objects.count(), 9)
        self.assertEqual(IPAddress.objects.count(), 9)
