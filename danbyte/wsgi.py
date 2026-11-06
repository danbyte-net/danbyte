"""WSGI config for danbyte project."""
import os

from django.core.wsgi import get_wsgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "danbyte.settings")
# gunicorn imports this module before Django reads settings: the marker turns on
# persistent database connections (DB_CONN_MAX_AGE) for the WSGI app only.
# runserver loads settings before it imports this, so it never sees the marker.
os.environ.setdefault("DANBYTE_WSGI_SERVER", "1")

application = get_wsgi_application()
