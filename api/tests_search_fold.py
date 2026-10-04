"""The accent-folding SQL function global search indexes on, and the folded
columns the index stores it in (#300)."""
from __future__ import annotations

from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TestCase

from core.models import Organization, Tenant

from .models import Site

BEFORE = ("api", "0194_interface_never_uplink")
FOLDED = ("api", "0195_searchentry_folded_columns")


class FoldFunctionTests(TestCase):
    def _fold(self, value: str) -> str:
        with connection.cursor() as c:
            c.execute("SELECT danbyte_fold(%s)", [value])
            return c.fetchone()[0]

    def test_folds_case_and_accents(self):
        self.assertEqual(self._fold("Århus DC"), "arhus dc")
        self.assertEqual(self._fold("Genève"), "geneve")

    def test_extensions_present(self):
        with connection.cursor() as c:
            c.execute(
                "SELECT extname FROM pg_extension WHERE extname IN ('pg_trgm', 'unaccent')"
            )
            self.assertEqual({r[0] for r in c.fetchall()}, {"pg_trgm", "unaccent"})


def _columns() -> dict[str, tuple[str, str]]:
    """Generated columns of the search index: name -> (kind, expression)."""
    with connection.cursor() as c:
        c.execute(
            "SELECT a.attname, a.attgenerated, pg_get_expr(d.adbin, d.adrelid) "
            "FROM pg_attribute a LEFT JOIN pg_attrdef d "
            "ON d.adrelid = a.attrelid AND d.adnum = a.attnum "
            "WHERE a.attrelid = 'api_searchentry'::regclass AND a.attnum > 0 "
            "AND NOT a.attisdropped AND a.attgenerated <> ''"
        )
        return {name: (kind, expr) for name, kind, expr in c.fetchall()}


def _indexes() -> dict[str, str]:
    with connection.cursor() as c:
        c.execute("SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'api_searchentry'")
        return dict(c.fetchall())


def _folded(object_id) -> tuple[str, str]:
    with connection.cursor() as c:
        c.execute("SELECT title_f, body_f FROM api_searchentry WHERE object_id = %s", [object_id])
        return c.fetchone()


class FoldedColumnsTests(TestCase):
    def setUp(self):
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")

    def assertFoldedSchema(self):
        columns = _columns()
        self.assertEqual(set(columns), {"title_f", "body_f"})
        for name, source in (("title_f", "title"), ("body_f", "body")):
            kind, expr = columns[name]
            self.assertEqual(kind, "s")  # stored
            self.assertIn("danbyte_fold", expr)
            self.assertIn(source, expr)
        indexes = _indexes()
        for name, column in (("searchentry_title_f_trgm", "title_f"),
                             ("searchentry_body_f_trgm", "body_f")):
            self.assertIn(name, indexes)
            self.assertIn("gin", indexes[name])
            self.assertIn(f"{column} gin_trgm_ops", indexes[name])
        # The expression indexes they replace are gone.
        self.assertNotIn("searchentry_title_trgm", indexes)
        self.assertNotIn("searchentry_body_trgm", indexes)

    def test_columns_and_indexes(self):
        self.assertFoldedSchema()

    def test_columns_follow_every_write(self):
        site = Site.objects.create(tenant=self.tenant, name="Århus DC", description="Næstved Ø")
        title_f, body_f = _folded(site.id)
        self.assertEqual(title_f, "arhus dc")
        self.assertIn("naestved o", body_f)
        site.name = "Genève"
        site.save()
        self.assertEqual(_folded(site.id)[0], "geneve")

    def test_migration_reverses_and_applies_on_existing_rows(self):
        site = Site.objects.create(tenant=self.tenant, name="Århus DC", description="Næstved")
        # Rows written in this transaction leave deferred foreign-key checks
        # pending, and ALTER TABLE refuses a table with pending checks; the
        # upgrade checks them at every migration boundary the same way.
        with connection.cursor() as c:
            c.execute("SET CONSTRAINTS ALL IMMEDIATE")

        MigrationExecutor(connection).migrate([BEFORE])
        self.assertEqual(_columns(), {})
        indexes = _indexes()
        self.assertIn("danbyte_fold(", indexes["searchentry_title_trgm"])
        self.assertIn("danbyte_fold(", indexes["searchentry_body_trgm"])
        self.assertNotIn("searchentry_title_f_trgm", indexes)
        self.assertNotIn("searchentry_body_f_trgm", indexes)

        MigrationExecutor(connection).migrate([FOLDED])
        self.assertFoldedSchema()
        # Rows that were already there are folded when the columns arrive.
        title_f, body_f = _folded(site.id)
        self.assertEqual(title_f, "arhus dc")
        self.assertIn("naestved", body_f)
