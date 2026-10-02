"""The test runner keeps per-request cached values from expiring mid-test,
so query counts do not depend on the clock (danbyte/test_runner.py)."""
from django.conf import settings
from django.test import SimpleTestCase


class RunnerTests(SimpleTestCase):
    def test_idle_timeout_cache_does_not_expire_under_test(self):
        from core import middleware

        self.assertEqual(settings.TEST_RUNNER, "danbyte.test_runner.DanbyteTestRunner")
        self.assertIsNone(middleware._IDLE_CACHE_TTL)
