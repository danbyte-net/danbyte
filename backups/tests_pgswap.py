"""backups.pgswap against a real, throwaway database: the restore makes
``public`` the dump's, and any failure leaves the database as it was."""
from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

from django.db import connection
from django.db.backends.postgresql.base import DatabaseWrapper
from django.test import SimpleTestCase

from backups import pgswap

SCHEMA = """
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE TABLE site (id serial PRIMARY KEY, name text NOT NULL);
CREATE TABLE device (id serial PRIMARY KEY, site_id int REFERENCES site(id), name text);
CREATE INDEX device_name_trgm ON device USING gin (name gin_trgm_ops);
CREATE VIEW device_names AS SELECT d.name, s.name AS site FROM device d JOIN site s ON s.id = d.site_id;
CREATE COLLATION natural_sort (provider = icu, locale = $$und-u-kn-true$$);
CREATE TABLE tagged (id serial PRIMARY KEY, label text COLLATE natural_sort);
CREATE INDEX tagged_label ON tagged (label COLLATE natural_sort);
CREATE FUNCTION shout(text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT upper($1) $$;
INSERT INTO site (name) VALUES ('hq'), ('lab');
INSERT INTO device (site_id, name) VALUES (1, 'core-sw01'), (2, 'lab-sw01');
"""


@unittest.skipUnless(shutil.which("pg_dump") and shutil.which("pg_restore"), "no pg_dump/pg_restore")
class PgSwapTests(SimpleTestCase):
    databases = {"default"}

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.name = f"{connection.settings_dict['NAME']}_pgswap"[:63]
        with connection.cursor() as c:
            c.execute(f'DROP DATABASE IF EXISTS "{cls.name}" WITH (FORCE)')
            c.execute(f'CREATE DATABASE "{cls.name}"')

    @classmethod
    def tearDownClass(cls):
        with connection.cursor() as c:
            c.execute(f'DROP DATABASE IF EXISTS "{cls.name}" WITH (FORCE)')
        super().tearDownClass()

    def setUp(self):
        self.db = DatabaseWrapper({**connection.settings_dict, "NAME": self.name}, alias="pgswap")
        self.addCleanup(self.db.close)
        with self.db.cursor() as c:
            c.execute("DROP SCHEMA IF EXISTS danbyte_pre_restore CASCADE")
            c.execute("DROP SCHEMA public CASCADE")
            c.execute("CREATE SCHEMA public")
            c.execute(SCHEMA)
        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        self.dump = os.path.join(tmp, "db.dump")
        _db, args, env = pgswap._pg(self.db)
        subprocess.run(["pg_dump", "-Fc", "-w", "--no-owner", "--no-privileges", *args,
                        "-f", self.dump, self.name], env=env, check=True, capture_output=True)
        self.original = self.facts()
        # What a migration of the failed release did.
        with self.db.cursor() as c:
            c.execute("CREATE TABLE added (id int)")
            c.execute("INSERT INTO device (site_id, name) VALUES (1, 'new-sw')")
        self.mutated = self.facts()

    def q(self, sql):
        with self.db.cursor() as c:
            c.execute(sql)
            return c.fetchall()

    def facts(self):
        return {
            "tables": self.q("SELECT string_agg(tablename, ',' ORDER BY tablename) FROM pg_tables "
                             "WHERE schemaname = 'public'"),
            "devices": self.q("SELECT name FROM device ORDER BY id"),
            "view": self.q("SELECT * FROM device_names ORDER BY name"),
            "shout": self.q("SELECT shout('x')"),
            "trgm": self.q("SELECT name FROM device WHERE name % 'core-sw1' ORDER BY name"),
            "indexes": self.q("SELECT indexname FROM pg_indexes WHERE schemaname = 'public' "
                              "ORDER BY indexname"),
            "ext": self.q("SELECT extname, extnamespace::regnamespace::text FROM pg_extension "
                          "WHERE extname = 'pg_trgm'"),
            "collation": self.q("SELECT collname FROM pg_collation WHERE collnamespace = "
                                "'public'::regnamespace"),
            "schemas": self.q("SELECT nspname FROM pg_namespace WHERE nspname IN "
                              "('public', 'danbyte_pre_restore') ORDER BY 1"),
        }

    def test_the_dump_replaces_public_and_the_old_schema_is_gone(self):
        said = []
        pgswap.replace_public(self.dump, self.db, say=said.append)
        self.assertEqual(self.facts(), self.original)
        self.assertTrue(any("set aside" in s for s in said), said)
        self.assertTrue(any("dropped the replaced schema" in s for s in said), said)

    def test_an_incomplete_restore_puts_the_database_back(self):
        with mock.patch.object(pgswap, "missing_objects", return_value=["table device"]):
            with self.assertRaisesRegex(pgswap.SwapError, "incomplete.*left as it was"):
                pgswap.replace_public(self.dump, self.db)
        self.assertEqual(self.facts(), self.mutated)

    def test_a_pg_restore_that_fails_half_way_puts_the_database_back(self):
        real = pgswap._pg_restore

        def half(dump, conn):
            real(dump, conn)
            raise pgswap.SwapError("pg_restore failed: boom")

        with mock.patch.object(pgswap, "_pg_restore", side_effect=half):
            with self.assertRaisesRegex(pgswap.SwapError, "boom - the database was left as it was"):
                pgswap.replace_public(self.dump, self.db)
        self.assertEqual(self.facts(), self.mutated)

    def test_an_unreadable_dump_changes_nothing(self):
        bad = self.dump + ".bad"
        with open(self.dump, "rb") as src, open(bad, "wb") as dst:
            dst.write(src.read(64))
        with self.assertRaisesRegex(pgswap.SwapError, "cannot be read"):
            pgswap.replace_public(bad, self.db)
        os.chmod(self.dump, 0)
        if not os.access(self.dump, os.R_OK):  # root reads it anyway
            with self.assertRaisesRegex(pgswap.SwapError, "cannot be read"):
                pgswap.replace_public(self.dump, self.db)
        self.assertEqual(self.facts(), self.mutated)

    def test_a_run_killed_during_the_restore_is_put_back_by_the_next(self):
        pgswap.set_aside(self.db)
        with self.db.cursor() as c:
            c.execute("CREATE TABLE site (id int)")  # the start of a restore
        self.db.close()
        pgswap.replace_public(self.dump, self.db)
        self.assertEqual(self.facts(), self.original)

    def test_a_run_killed_while_moving_is_put_back_and_nothing_live_is_dropped(self):
        # Half the live objects moved out (or half moved back after a
        # failure): every object either side is live, none may be dropped.
        with self.db.cursor() as c:
            c.execute("CREATE SCHEMA danbyte_pre_restore")
            c.execute("COMMENT ON SCHEMA danbyte_pre_restore IS %s", [pgswap.MARK_MOVING])
            c.execute("ALTER TABLE public.device SET SCHEMA danbyte_pre_restore")
            c.execute("ALTER FUNCTION public.shout(text) SET SCHEMA danbyte_pre_restore")
        pgswap.put_back(self.db)
        self.assertEqual(self.facts(), self.mutated)

    def test_moving_back_is_marked_before_the_first_live_object_returns(self):
        pgswap.set_aside(self.db)
        seen = []
        real = pgswap._move

        def move(conn, src, dst):
            seen.append(pgswap._mark(conn))
            return real(conn, src, dst)

        with mock.patch.object(pgswap, "_move", side_effect=move):
            pgswap.put_back(self.db)
        self.assertEqual(seen, [pgswap.MARK_MOVING])
        self.assertEqual(self.facts(), self.mutated)

    def test_a_replaced_schema_left_behind_is_dropped_first(self):
        pgswap.replace_public(self.dump, self.db)
        with self.db.cursor() as c:
            c.execute("CREATE SCHEMA danbyte_pre_restore")
            c.execute("CREATE TABLE danbyte_pre_restore.junk (id int)")
            c.execute("COMMENT ON SCHEMA danbyte_pre_restore IS %s", [pgswap.MARK_STALE])
        pgswap.replace_public(self.dump, self.db)
        self.assertEqual(self.facts(), self.original)

    def test_a_schema_it_did_not_make_is_never_touched(self):
        with self.db.cursor() as c:
            c.execute("CREATE SCHEMA danbyte_pre_restore")
            c.execute("CREATE TABLE danbyte_pre_restore.mine (id int)")
        with self.assertRaisesRegex(pgswap.SwapError, "did not make"):
            pgswap.replace_public(self.dump, self.db)
        self.assertEqual(self.q("SELECT count(*) FROM danbyte_pre_restore.mine"), [(0,)])
        self.assertEqual(self.facts()["devices"], self.mutated["devices"])

    def test_dropping_takes_a_few_locks_at_a_time(self):
        # Each relation is its own statement: never one lock per object of
        # the whole schema in one transaction.
        statements = []
        real = self.db.cursor

        def spy():
            cur = real()
            execute = cur.execute

            def ex(sql, params=None):
                statements.append(sql)
                return execute(sql, params)
            cur.execute = ex
            return cur

        pgswap.set_aside(self.db)
        with mock.patch.object(self.db, "cursor", side_effect=spy):
            pgswap.drop_aside(self.db)
        drops = [s for s in statements if s.startswith("DROP ")]
        self.assertGreaterEqual(len(drops), 4, drops)
        self.assertEqual(drops[-1], 'DROP SCHEMA IF EXISTS "danbyte_pre_restore" CASCADE')


class DbtoolRestoreTests(SimpleTestCase):
    """The upgrade's ``dbtool.py restore`` uses the pgswap.py copied beside
    it (the target release's), and the release on disk only without one."""

    def load(self, with_pgswap: bool):
        import importlib.util
        from pathlib import Path

        from django.conf import settings

        tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, tmp, ignore_errors=True)
        src = Path(settings.BASE_DIR) / "scripts" / "upgrade" / "dbtool.py"
        shutil.copy2(src, os.path.join(tmp, "dbtool.py"))
        if with_pgswap:
            with open(os.path.join(tmp, "pgswap.py"), "w") as fh:
                fh.write("CALLS = []\n"
                         "def replace_public(dump, connection, say=None):\n"
                         "    CALLS.append(dump)\n"
                         "    import sys; sys.modules['danbyte_test_pgswap_calls'] = CALLS\n")
        spec = importlib.util.spec_from_file_location("dbtool_under_test", os.path.join(tmp, "dbtool.py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        mod._setup = lambda: None
        return mod

    def test_the_copy_beside_it_restores(self):
        import sys

        mod = self.load(with_pgswap=True)
        with mock.patch("backups.restore.replace_database") as old, \
                mock.patch.object(connection, "close"):
            self.assertEqual(mod.restore("/tmp/snap.dump"), 0)
        old.assert_not_called()
        self.assertEqual(sys.modules.pop("danbyte_test_pgswap_calls"), ["/tmp/snap.dump"])

    def test_without_a_copy_the_release_on_disk_restores(self):
        mod = self.load(with_pgswap=False)
        with mock.patch("backups.restore.replace_database") as old:
            self.assertEqual(mod.restore("/tmp/snap.dump"), 0)
        old.assert_called_once_with("/tmp/snap.dump")
