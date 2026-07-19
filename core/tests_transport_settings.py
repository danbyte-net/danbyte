"""Transport hardening must stay decoupled from DEBUG.

Regression guard: these settings used to hang off ``if not DEBUG``. When the
DEBUG default flipped to False, every install that never set DEBUG silently
started marking the session cookie ``Secure`` and 301-ing to https — on a
plain-http server the browser then DROPS the session cookie and login bounces
back to the form with no error. Transport hardening is now opt-in via
``DANBYTE_HTTPS`` so that can never happen again.
"""
from __future__ import annotations

import importlib

from django.test import SimpleTestCase


def _reload_settings(env: dict[str, str]):
    """Import danbyte.settings fresh under ``env`` and return the module."""
    import os

    saved = {k: os.environ.get(k) for k in ("DEBUG", "DANBYTE_HTTPS")}
    os.environ.setdefault("DJANGO_SECRET_KEY", "x" * 60)
    os.environ.setdefault("MONITORING_SECRET_KEY", "y" * 60)
    try:
        for k in ("DEBUG", "DANBYTE_HTTPS"):
            os.environ.pop(k, None)
        os.environ.update(env)
        import danbyte.settings as s

        return importlib.reload(s)
    finally:
        for k, v in saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


class TransportHardeningTests(SimpleTestCase):
    def test_debug_off_alone_does_not_force_secure_cookies(self):
        # THE regression: a production (DEBUG=False) install that hasn't declared
        # TLS must not get Secure-only cookies / an https redirect, or a
        # plain-http deployment can never hold a session.
        s = _reload_settings({"DEBUG": "False"})
        self.assertFalse(s.DEBUG)
        self.assertFalse(getattr(s, "SESSION_COOKIE_SECURE", False))
        self.assertFalse(getattr(s, "CSRF_COOKIE_SECURE", False))
        self.assertFalse(getattr(s, "SECURE_SSL_REDIRECT", False))

    def test_https_flag_enables_hardening(self):
        s = _reload_settings({"DEBUG": "False", "DANBYTE_HTTPS": "True"})
        self.assertTrue(s.SESSION_COOKIE_SECURE)
        self.assertTrue(s.CSRF_COOKIE_SECURE)
        self.assertTrue(s.SECURE_SSL_REDIRECT)
        self.assertEqual(s.SECURE_HSTS_SECONDS, 31536000)

    def test_https_flag_is_independent_of_debug(self):
        # Even in DEBUG, an explicit opt-in is honoured — the two are orthogonal.
        s = _reload_settings({"DEBUG": "True", "DANBYTE_HTTPS": "True"})
        self.assertTrue(s.DEBUG)
        self.assertTrue(s.SESSION_COOKIE_SECURE)

    def test_dev_default_is_unhardened(self):
        s = _reload_settings({"DEBUG": "True"})
        self.assertFalse(getattr(s, "SECURE_SSL_REDIRECT", False))
