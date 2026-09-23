"""Gunicorn config for Danbyte's WSGI app (the HTTP path).

WebSockets are served separately by daphne (danbyte-ws.service) so channels
never sits in the HTTP request path - putting the ASGI server in front of all
HTTP wedges plain requests (a hard-won lesson). Gunicorn here is sync WSGI.

Tune worker count with WEB_CONCURRENCY; bind with GUNICORN_BIND.
"""
import multiprocessing
import os
from pathlib import Path

from dotenv import load_dotenv

# The units start gunicorn without the app's .env, which Django loads for
# itself but this file never saw - so DANBYTE_LOG_DIR below was always unset
# and the documented gunicorn-*.log files never appeared (#231).
load_dotenv(Path(__file__).resolve().parent.parent / ".env")

bind = os.getenv("GUNICORN_BIND", "127.0.0.1:8000")
# Twice the cores plus one, but never more than 8 by default: each sync worker
# holds a database connection, and on a big host the formula alone outgrew
# Postgres's default of 100 connections - with RQ workers and daphne holding
# theirs too, the overflow surfaced as intermittent 500s (#230). Raise it with
# WEB_CONCURRENCY together with max_connections.
workers = int(os.getenv(
    "WEB_CONCURRENCY", str(min(multiprocessing.cpu_count() * 2 + 1, 8))
))
timeout = int(os.getenv("GUNICORN_TIMEOUT", "60"))
# Long GET URLs (bulk id lists, deep filters) exceed the 4094 default and get
# a bare 400 before Django ever sees them. 8190 is gunicorn's maximum.
limit_request_line = int(os.getenv("GUNICORN_LIMIT_REQUEST_LINE", "8190"))
# Recycle workers periodically to cap memory creep on a long-lived server.
max_requests = int(os.getenv("GUNICORN_MAX_REQUESTS", "1000"))
max_requests_jitter = 100
# Logs: to files under DANBYTE_LOG_DIR (/var/log/danbyte) when it is set and
# writable and something rotates them, else stdout/stderr → journald via the
# systemd unit (the dev default). An access log with nothing rotating it
# grows until the disk is full, so no rotation means no file.
_log_dir = os.getenv("DANBYTE_LOG_DIR", "").strip()
_rotated = os.path.exists("/etc/logrotate.d/danbyte")
if _log_dir and _rotated and os.path.isdir(_log_dir) and os.access(_log_dir, os.W_OK):
    accesslog = os.path.join(_log_dir, "gunicorn-access.log")
    errorlog = os.path.join(_log_dir, "gunicorn-error.log")
else:
    accesslog = "-"
    errorlog = "-"
proc_name = "danbyte-web"
