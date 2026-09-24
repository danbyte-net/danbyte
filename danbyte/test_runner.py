"""The project's test runner.

One per-request value, the session idle timeout, is cached for a minute
(core.middleware). Inside a test the deployment-settings row does not exist
until something loads it, so the request that follows an expiry creates it -
nine extra queries - and whether that lands inside a measured request
depended on the wall clock. Tests that count queries failed at random on
long runs. Under test the value does not expire; tests that change the
setting clear it, as they already did.
"""
from __future__ import annotations

from django.test.runner import DiscoverRunner


class DanbyteTestRunner(DiscoverRunner):
    def setup_test_environment(self, **kwargs):
        super().setup_test_environment(**kwargs)
        from core import middleware

        middleware._IDLE_CACHE_TTL = None  # no expiry: counts stop depending on time
        middleware.clear_idle_timeout_cache()
