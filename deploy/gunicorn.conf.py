"""Gunicorn config for Danbyte's WSGI app (the HTTP path).

WebSockets are served separately by daphne (danbyte-ws.service) so channels
never sits in the HTTP request path — putting the ASGI server in front of all
HTTP wedges plain requests (a hard-won lesson). Gunicorn here is sync WSGI.

Tune worker count with WEB_CONCURRENCY; bind with GUNICORN_BIND.
"""
import multiprocessing
import os

bind = os.getenv("GUNICORN_BIND", "127.0.0.1:8000")
workers = int(os.getenv("WEB_CONCURRENCY", str(multiprocessing.cpu_count() * 2 + 1)))
timeout = int(os.getenv("GUNICORN_TIMEOUT", "60"))
# Long GET URLs (bulk id lists, deep filters) exceed the 4094 default and get
# a bare 400 before Django ever sees them. 8190 is gunicorn's maximum.
limit_request_line = int(os.getenv("GUNICORN_LIMIT_REQUEST_LINE", "8190"))
# Recycle workers periodically to cap memory creep on a long-lived server.
max_requests = int(os.getenv("GUNICORN_MAX_REQUESTS", "1000"))
max_requests_jitter = 100
# Logs: to files under DANBYTE_LOG_DIR (/var/log/danbyte) when set + writable,
# else stdout/stderr → journald via the systemd unit (the dev default).
_log_dir = os.getenv("DANBYTE_LOG_DIR", "").strip()
if _log_dir and os.path.isdir(_log_dir) and os.access(_log_dir, os.W_OK):
    accesslog = os.path.join(_log_dir, "gunicorn-access.log")
    errorlog = os.path.join(_log_dir, "gunicorn-error.log")
else:
    accesslog = "-"
    errorlog = "-"
proc_name = "danbyte-web"
