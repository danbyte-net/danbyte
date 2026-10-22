"""Database session settings (#443)."""
from django.conf import settings
from django.db import connection
from django.test import SimpleTestCase, TestCase


class JitOffTests(TestCase):
    def test_sessions_run_without_jit(self):
        # A wide list query crossed jit_above_cost and paid seconds of JIT
        # compile on every request; Danbyte's sessions turn JIT off.
        with connection.cursor() as cur:
            cur.execute("SHOW jit")
            self.assertEqual(cur.fetchone()[0], "off")


class JitOptionTests(SimpleTestCase):
    def test_option_is_on_the_connection_settings(self):
        self.assertEqual(settings.DATABASES["default"]["OPTIONS"].get("options"), "-c jit=off")
