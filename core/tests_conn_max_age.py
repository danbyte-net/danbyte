"""Persistent database connections for the WSGI app only (#481).

gunicorn imports ``danbyte.wsgi`` before settings load, and that module marks
the process; daphne (``danbyte.asgi``), runserver and management commands never
see the marker and keep a connection per request.
"""
import json
import os
import subprocess
import sys

from django.conf import settings
from django.test import SimpleTestCase

PROBE = (
    "import json, importlib, sys; importlib.import_module(sys.argv[1]); "
    "from django.conf import settings as s; "
    "print(json.dumps(s.DATABASES['default']['CONN_MAX_AGE']))"
)


def conn_max_age(module: str, **env) -> int:
    base = {k: v for k, v in os.environ.items()
            if k not in ("DB_CONN_MAX_AGE", "DANBYTE_WSGI_SERVER")}
    base.update(DJANGO_SETTINGS_MODULE="danbyte.settings")
    base.update(env)
    out = subprocess.run(  # noqa: S603
        [sys.executable, "-c", PROBE, module], env=base, cwd=settings.BASE_DIR,
        capture_output=True, text=True, timeout=120, check=True,
    )
    return json.loads(out.stdout.strip().splitlines()[-1])


class ConnMaxAgeTests(SimpleTestCase):
    def test_wsgi_app_keeps_connections_for_a_minute(self):
        self.assertEqual(conn_max_age("danbyte.wsgi"), 60)

    def test_wsgi_age_comes_from_the_environment(self):
        self.assertEqual(conn_max_age("danbyte.wsgi", DB_CONN_MAX_AGE="0"), 0)
        self.assertEqual(conn_max_age("danbyte.wsgi", DB_CONN_MAX_AGE="300"), 300)

    def test_asgi_app_opens_a_connection_per_request(self):
        self.assertEqual(conn_max_age("danbyte.asgi", DB_CONN_MAX_AGE="300"), 0)

    def test_tests_and_commands_keep_zero(self):
        self.assertEqual(settings.DATABASES["default"]["CONN_MAX_AGE"], 0)
