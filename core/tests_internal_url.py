"""DANBYTE_INTERNAL_URL's host is accepted by the backend, and nothing else
is widened: the operator's ALLOWED_HOSTS stays the WebSocket origin list and
the public host name."""
import json
import os
import subprocess
import sys

from django.conf import settings
from django.test import SimpleTestCase

PROBE = (
    "import json, django; django.setup(); from django.conf import settings as s; "
    "from danbyte.asgi import application; "
    "ws = application.application_mapping['websocket']; "
    "print(json.dumps({'allowed': s.ALLOWED_HOSTS, 'public': s.PUBLIC_ALLOWED_HOSTS, "
    "'ws': list(ws.allowed_origins), 'url': s.DANBYTE_INTERNAL_URL}))"
)


def load(**env) -> dict:
    base = {k: v for k, v in os.environ.items()
            if k not in ("ALLOWED_HOSTS", "DANBYTE_INTERNAL_URL", "DEBUG")}
    base.update(DJANGO_SETTINGS_MODULE="danbyte.settings", DEBUG="False",
                DJANGO_SECRET_KEY="internal-url-test-" + "x" * 40,
                MONITORING_SECRET_KEY="internal-url-test-" + "y" * 40)
    base.update(env)
    out = subprocess.run([sys.executable, "-c", PROBE], env=base, cwd=settings.BASE_DIR,  # noqa: S603
                         capture_output=True, text=True, timeout=120, check=True)
    return json.loads(out.stdout.strip().splitlines()[-1])


class InternalHostTests(SimpleTestCase):
    def test_set_url_adds_only_its_host(self):
        got = load(ALLOWED_HOSTS="ipam.example.com", DANBYTE_INTERNAL_URL="http://backend:8000")
        self.assertEqual(got["allowed"], ["ipam.example.com", "backend"])
        self.assertEqual(got["public"], ["ipam.example.com"])
        self.assertEqual(got["ws"], ["ipam.example.com"])

    def test_unset_url_changes_nothing(self):
        got = load(ALLOWED_HOSTS="ipam.example.com")
        self.assertEqual(got["allowed"], ["ipam.example.com"])
        self.assertEqual(got["ws"], ["ipam.example.com"])
        self.assertEqual(got["url"], "http://127.0.0.1:8000")

    def test_listed_or_wildcard_host_is_not_added_twice(self):
        got = load(ALLOWED_HOSTS="backend,ipam.example.com",
                   DANBYTE_INTERNAL_URL="http://backend:8000/")
        self.assertEqual(got["allowed"], ["backend", "ipam.example.com"])
        got = load(ALLOWED_HOSTS="*", DANBYTE_INTERNAL_URL="http://backend:8000")
        self.assertEqual(got["allowed"], ["*"])

    def test_ipv6_literal_is_bracketed(self):
        got = load(ALLOWED_HOSTS="ipam.example.com", DANBYTE_INTERNAL_URL="http://[fd00::5]:8000")
        self.assertEqual(got["allowed"], ["ipam.example.com", "[fd00::5]"])
