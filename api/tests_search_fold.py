"""The accent-folding SQL function global search indexes on."""
from __future__ import annotations

from django.db import connection
from django.test import TestCase


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
