"""Django settings for the danbyte project."""
import os
import sys
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent.parent

# True while the Django test runner is executing. The test DB runs migrations
# with DEBUG off, so guards that fail-closed on missing prod config (the
# monitoring secrets key below) would otherwise abort the suite; tests get a
# fixed key instead of forcing every developer/CI to configure one.
TESTING = "test" in sys.argv

_DEV_SECRET_KEY = "dev-key-change-in-prod"
SECRET_KEY = os.getenv("DJANGO_SECRET_KEY", _DEV_SECRET_KEY)
# Default-closed: production must not accidentally run in debug (tracebacks leak
# source/settings, ALLOWED_HOSTS is bypassed). Dev sets DEBUG=True explicitly
# (see .env / .env.example).
DEBUG = os.getenv("DEBUG", "False") == "True"

# Fail closed: never run the public dev key outside DEBUG. Session cookies,
# invite/reset tokens, and the derived monitoring encryption key all hang off
# SECRET_KEY, so a default key in prod means forgeable sessions.
if not DEBUG and SECRET_KEY == _DEV_SECRET_KEY:
    from django.core.exceptions import ImproperlyConfigured

    raise ImproperlyConfigured(
        "DJANGO_SECRET_KEY must be set to a unique value when DEBUG is off."
    )

ALLOWED_HOSTS = os.getenv(
    "ALLOWED_HOSTS",
    # In DEBUG, allow loopback + every RFC1918 host on the LAN (phones / other
    # boxes hitting the dev server). The `*` wildcard is dev-only — production
    # must set ALLOWED_HOSTS explicitly so it can't accept arbitrary Host headers.
    "localhost,127.0.0.1,*" if DEBUG else "localhost,127.0.0.1",
).split(",")

INSTALLED_APPS = [
    # NOTE: `daphne` + `channels` are intentionally NOT enabled here. Putting
    # daphne first makes `runserver` serve everything over ASGI, which routes all
    # sync Django/ORM work through asgiref's single thread-sensitive executor — a
    # single slow/blocked request then wedges *all* HTTP (the dev server hung
    # repeatedly). The WebSocket presence layer (danbyte/asgi.py, the
    # PresenceConsumer, CHANNEL_LAYERS) stays in the tree but must run as a
    # SEPARATE daphne process for `/ws/` (behind nginx), with WSGI/gunicorn still
    # serving HTTP — not by replacing runserver. Until that split exists, presence
    # uses its polling fallback (usePresence degrades automatically). See P4 notes.
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    # Third-party
    "rest_framework",
    "drf_spectacular",
    "drf_spectacular_sidecar",  # local Swagger UI / ReDoc assets (airgapped-safe)
    "django_filters",
    "corsheaders",
    "django_rq",
    "taggit",
    # Local apps
    "core.apps.CoreConfig",
    "api.apps.ApiConfig",
    "customization.apps.CustomizationConfig",
    "compliance.apps.ComplianceConfig",
    "audit.apps.AuditConfig",
    "auth_api.apps.AuthApiConfig",
    "integrations.apps.IntegrationsConfig",
    "search.apps.SearchConfig",
    "monitoring.apps.MonitoringConfig",
]

# ─── Plugins ─────────────────────────────────────────────────────────────────
# NetBox-style trusted plugins: a comma-separated list of importable plugin
# packages, applied on restart. Each is discovered + version-gated at import
# time here (before Django builds the app registry) and appended to
# INSTALLED_APPS; a broken/incompatible one is skipped and reported via
# /api/plugins/ rather than aborting boot. PLUGINS_CONFIG holds per-plugin
# settings overrides (keyed by plugin slug), NetBox-style.
PLUGINS = [p for p in os.getenv("PLUGINS", "").split(",") if p.strip()]
PLUGINS_CONFIG: dict = {}

# Offline / airgapped installs: uploaded plugin archives are extracted here (a
# writable dir on the import path), and their module names recorded in
# `<dir>/installed.json`. Keep it OUTSIDE the app tree in production so an
# upgrade never wipes it (DANBYTE_PLUGIN_DIR). Read the manifest at import time
# and treat those names exactly like PLUGINS entries.
PLUGIN_UPLOAD_DIR = Path(os.getenv("DANBYTE_PLUGIN_DIR", BASE_DIR / "plugins_local"))
if PLUGIN_UPLOAD_DIR.is_dir() and str(PLUGIN_UPLOAD_DIR) not in sys.path:
    sys.path.insert(0, str(PLUGIN_UPLOAD_DIR))
try:
    _manifest = PLUGIN_UPLOAD_DIR / "installed.json"
    if _manifest.is_file():
        import json as _json

        _uploaded = _json.loads(_manifest.read_text() or "{}").get("plugins", [])
        PLUGINS += [p for p in _uploaded if p and p not in PLUGINS]
except Exception:  # a corrupt manifest must never block boot
    pass

# The bundled reference plugin is loaded in the test environment (only) so the
# whole plugin framework is exercised end to end by the normal suite. It never
# loads in production unless an operator names it in PLUGINS explicitly.
if TESTING and "danbyte_example_plugin" not in PLUGINS:
    PLUGINS.append("danbyte_example_plugin")

if PLUGINS:
    from danbyte import __version__ as _danbyte_version
    from danbyte.plugin_loader import discover as _discover_plugins

    _plugin_load = _discover_plugins(PLUGINS, _danbyte_version)
    INSTALLED_APPS += _plugin_load.enabled
    # Read back by plugins.registry / the /api/plugins/ endpoint.
    _PLUGIN_LOAD_REPORT = _plugin_load.report
else:
    _PLUGIN_LOAD_REPORT = []

# The framework app is appended LAST so its ready() (which autodiscovers each
# plugin's danbyte_plugin module) runs after every plugin app has loaded.
INSTALLED_APPS.append("plugins.apps.PluginsConfig")

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    # GZip sits high so it compresses responses after every other middleware
    # has written them. Cuts the space-map picker's ~300 KB Tailwind HTML
    # down to ~30 KB on the wire (the dense cells repeat the same class
    # strings so they compress extremely well).
    "django.middleware.gzip.GZipMiddleware",
    "corsheaders.middleware.CorsMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    # Captures the request user for the change-log signals.
    "audit.middleware.AuditContextMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "danbyte.urls"
WSGI_APPLICATION = "danbyte.wsgi.application"
ASGI_APPLICATION = "danbyte.asgi.application"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.debug",
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
                "api.context_processors.sidebar_tenants",
                "api.context_processors.user_settings",
            ],
        },
    },
]

DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": os.getenv("DB_NAME", "danbyte"),
        "USER": os.getenv("DB_USER", "danbyte"),
        "PASSWORD": os.getenv("DB_PASSWORD", "danbyte"),
        "HOST": os.getenv("DB_HOST", "127.0.0.1"),
        "PORT": os.getenv("DB_PORT", "5432"),
    }
}

CACHES = {
    "default": {
        "BACKEND": "django_redis.cache.RedisCache",
        "LOCATION": os.getenv("REDIS_URL", "redis://127.0.0.1:6379/0"),
        "OPTIONS": {
            "CLIENT_CLASS": "django_redis.client.DefaultClient",
        },
    }
}

# Channels — the channel layer for real-time presence WebSockets. Redis-backed
# (same Redis as RQ/cache). In-memory fallback keeps tests/single-process dev
# working even if Redis is unreachable for the layer.
CHANNEL_LAYERS = {
    "default": {
        "BACKEND": "channels_redis.core.RedisChannelLayer",
        "CONFIG": {
            "hosts": [
                (
                    os.getenv("REDIS_HOST", "localhost"),
                    int(os.getenv("REDIS_PORT", "6379")),
                )
            ]
        },
    }
}

RQ_QUEUES = {
    "default": {
        "HOST": os.getenv("REDIS_HOST", "localhost"),
        "PORT": int(os.getenv("REDIS_PORT", "6379")),
        "DB": 0,
        "DEFAULT_TIMEOUT": "1h",
    },
    "high": {
        "HOST": os.getenv("REDIS_HOST", "localhost"),
        "PORT": int(os.getenv("REDIS_PORT", "6379")),
        "DB": 0,
        "DEFAULT_TIMEOUT": "1h",
    },
    "low": {
        "HOST": os.getenv("REDIS_HOST", "localhost"),
        "PORT": int(os.getenv("REDIS_PORT", "6379")),
        "DB": 0,
        "DEFAULT_TIMEOUT": "24h",
    },
}

REST_FRAMEWORK = {
    # Converts an uncaught IntegrityError (a duplicate/constraint hit a
    # serializer didn't validate) into a 409 instead of a raw 500.
    "EXCEPTION_HANDLER": "api.exception_handler.exception_handler",
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "auth_api.token_auth.ApiTokenAuthentication",
        "rest_framework.authentication.SessionAuthentication",
        # (No JWT: there's no obtain/refresh endpoint and no SIMPLE_JWT config,
        # so the class was dead surface with weak defaults — removed.)
    ],
    # Default-closed: a DRF view with no explicit permission_classes requires
    # auth, so the next forgotten one isn't world-open. Intentionally-public
    # endpoints (the share-link resolve) set AllowAny explicitly; the login/MFA
    # flow is plain Django (not DRF), so it's unaffected.
    "DEFAULT_PERMISSION_CLASSES": [
        "rest_framework.permissions.IsAuthenticated",
    ],
    # High default page size: the SPA loads full result sets and filters
    # client-side, so a small page silently hides rows. ?limit= still overrides.
    "DEFAULT_PAGINATION_CLASS": "api.pagination.StandardResultsSetPagination",
    "PAGE_SIZE": 10000,
    "DEFAULT_FILTER_BACKENDS": [
        "django_filters.rest_framework.DjangoFilterBackend",
        "rest_framework.filters.SearchFilter",
    ],
    # OpenAPI 3 schema generation (drf-spectacular) — powers /api/schema/ and the
    # interactive reference at /api/docs/.
    "DEFAULT_SCHEMA_CLASS": "drf_spectacular.openapi.AutoSchema",
}

# ── OpenAPI / API reference (drf-spectacular) ────────────────────────────────
# Assets are served from drf-spectacular-sidecar (bundled locally), so the
# interactive docs work on airgapped installs with no CDN access.
from danbyte import __version__  # noqa: E402 — version string for the schema

SPECTACULAR_SETTINGS = {
    "TITLE": "Danbyte API",
    "DESCRIPTION": (
        "REST API for Danbyte — IPAM / DCIM and network operations. "
        "Authenticate with a scoped **API token** (`Authorization: Token <key>`) "
        "or, from a browser session, the logged-in session cookie. Every request "
        "is scoped to your active tenant and enforced by RBAC."
    ),
    "VERSION": __version__,
    "SERVE_INCLUDE_SCHEMA": False,  # don't advertise the raw schema endpoint in itself
    # Default-closed, like the rest of the API: you must be logged in (or hold a
    # token) to read the schema / open the docs.
    "SERVE_PERMISSIONS": ["rest_framework.permissions.IsAuthenticated"],
    "SWAGGER_UI_DIST": "SIDECAR",
    "SWAGGER_UI_FAVICON_HREF": "SIDECAR",
    "REDOC_DIST": "SIDECAR",
    # Group operations by domain object; endpoints are auto-tagged by their first
    # path segment, and this orders/labels the common top-level groups.
    "TAGS": [
        {"name": "prefixes", "description": "IP prefixes and the subnet tree."},
        {"name": "ips", "description": "Individual IP addresses and assignments."},
        {"name": "ip-ranges", "description": "Contiguous IP ranges."},
        {"name": "aggregates", "description": "RIR aggregates."},
        {"name": "vrfs", "description": "VRFs and route targets."},
        {"name": "vlans", "description": "VLANs and VLAN groups."},
        {"name": "devices", "description": "Devices, roles, and types."},
        {"name": "interfaces", "description": "Device interfaces and cabling."},
        {"name": "racks", "description": "Racks and rack roles."},
        {"name": "sites", "description": "Sites, regions, and locations."},
        {"name": "circuits", "description": "Circuits, providers, and terminations."},
        {"name": "tunnels", "description": "Tunnels, IPSec, and L2VPNs."},
        {"name": "virtual-machines", "description": "VMs, clusters, and VM interfaces."},
        {"name": "power-panels", "description": "Power panels and feeds."},
        {"name": "monitoring", "description": "Checks, status, alerts, and SNMP."},
        {"name": "tenants", "description": "Tenants and tenant groups."},
    ],
    # Keep operationIds and component names stable/readable.
    "COMPONENT_SPLIT_REQUEST": True,
    "SORT_OPERATIONS": True,
}

CORS_ALLOWED_ORIGINS = os.getenv(
    "CORS_ALLOWED_ORIGINS", "http://localhost:3000"
).split(",")
# CSRF trusted origins. In DEBUG, allow any RFC1918 host on port 3000
# (matches the Vite dev server reachable from phones / other LAN boxes).
# Django's CSRF_TRUSTED_ORIGINS doesn't support wildcards on the host
# portion, so we enumerate explicit /24s up to the host the user is on,
# plus accept whatever is passed via env.
CSRF_TRUSTED_ORIGINS = os.getenv(
    "CSRF_TRUSTED_ORIGINS",
    "http://localhost:3000,http://127.0.0.1:3000",
).split(",")
if DEBUG:
    import ipaddress as _ip
    import socket as _s
    _addrs = {"127.0.0.1"}
    # Trick: open a UDP socket "towards" a public IP — Linux fills in the
    # outbound source IP without sending a packet. Catches the LAN
    # interface(s) instead of the loopback-only hostname mapping.
    try:
        _sock = _s.socket(_s.AF_INET, _s.SOCK_DGRAM)
        _sock.connect(("8.8.8.8", 1))
        _addrs.add(_sock.getsockname()[0])
        _sock.close()
    except Exception:
        pass
    try:
        _hostname = _s.gethostname()
        _addrs.update(a[4][0] for a in _s.getaddrinfo(_hostname, None) if a[0] == _s.AF_INET)
    except Exception:
        pass
    for _addr in _addrs:
        try:
            _ip.ip_address(_addr)
        except ValueError:
            continue
        CSRF_TRUSTED_ORIGINS.append(f"http://{_addr}:3000")
        CSRF_TRUSTED_ORIGINS.append(f"http://{_addr}:8000")
        # Behind the nginx reverse proxy the app is same-origin on 443, so the
        # browser sends Origin: https://<addr> (no port) on writes.
        CSRF_TRUSTED_ORIGINS.append(f"https://{_addr}")
        CSRF_TRUSTED_ORIGINS.append(f"http://{_addr}")
    # CORS in DEBUG: same scope so the React dev server can call the API.
    CORS_ALLOWED_ORIGIN_REGEXES = [
        r"^https?://localhost(:\d+)?$",
        r"^https?://127\.0\.0\.1(:\d+)?$",
        r"^https?://10\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(:\d+)?$",
        r"^https?://192\.168\.(\d{1,3})\.(\d{1,3})(:\d+)?$",
        r"^https?://172\.(1[6-9]|2\d|3[01])\.(\d{1,3})\.(\d{1,3})(:\d+)?$",
    ]

# Trust the reverse proxy's scheme header so request.is_secure() (and thus the
# CSRF https/Origin handling) reflects the original HTTPS request. The nginx
# site sets X-Forwarded-Proto and overwrites any client-supplied value.
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")

# The session cookie IS the auth mechanism, so keep it off JavaScript always.
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"

# Referrer + clickjacking defaults apply in every mode (defense-in-depth for a
# direct hit on /api that doesn't pass through nginx). X_FRAME_OPTIONS defaults
# to DENY via XFrameOptionsMiddleware (already in MIDDLEWARE); make it explicit.
SECURE_REFERRER_POLICY = "same-origin"
SECURE_CONTENT_TYPE_NOSNIFF = True
X_FRAME_OPTIONS = "DENY"

# ─── Transport hardening ────────────────────────────────────────────────────
# Is this deployment served over TLS? That is a DIFFERENT question from DEBUG,
# and must be configured on its own.
#
# These settings used to hang off `if not DEBUG`. That coupling is a footgun: it
# means changing the DEBUG default silently changes transport requirements for
# every install that never set DEBUG. When it flipped, those installs started
# 301-redirecting every request to https and marking the session cookie
# `Secure` — so on a plain-http server the browser silently DROPS the session
# cookie and login just bounces back to the form with no error.
#
# So: explicit opt-in, default off. Turning it on when you are NOT behind TLS
# locks you out; leaving it off when you ARE behind TLS only forgoes the
# app-level backstop (nginx already sets HSTS + the redirect at the edge, and
# scripts/install.sh — which configures nginx+TLS — writes DANBYTE_HTTPS=True).
HTTPS_DEPLOYMENT = os.getenv("DANBYTE_HTTPS", "False") == "True"
if HTTPS_DEPLOYMENT:
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True
    SECURE_SSL_REDIRECT = True
    SECURE_HSTS_SECONDS = 31536000  # 1 year
    SECURE_HSTS_INCLUDE_SUBDOMAINS = True
    SECURE_HSTS_PRELOAD = True

EMAIL_BACKEND = os.getenv(
    "EMAIL_BACKEND", "django.core.mail.backends.console.EmailBackend"
)
EMAIL_HOST = os.getenv("EMAIL_HOST", "smtp.gmail.com")
EMAIL_PORT = int(os.getenv("EMAIL_PORT", "587"))
EMAIL_USE_TLS = os.getenv("EMAIL_USE_TLS", "True") == "True"
EMAIL_HOST_USER = os.getenv("EMAIL_HOST_USER", "")
EMAIL_HOST_PASSWORD = os.getenv("EMAIL_HOST_PASSWORD", "")
DEFAULT_FROM_EMAIL = os.getenv("DEFAULT_FROM_EMAIL", "noreply@danbyte.com")

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator"},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "verbose": {
            "format": "{asctime} {levelname} {name}: {message}",
            "style": "{",
        },
    },
    "handlers": {
        "console": {
            "class": "logging.StreamHandler",
        },
    },
    # propagate=False on every logger so a record is emitted once per logger
    # (no bubbling to a parent that also has a handler — otherwise the file
    # handler injected below would double every line).
    "loggers": {
        "django": {"handlers": ["console"], "level": "INFO", "propagate": False},
        "rq.worker": {
            "handlers": ["console"], "level": "INFO", "propagate": False,
        },
        # The app's own namespaces — parents so monitoring.* / danbyte.* land
        # here (and, in production, in the file below).
        "monitoring": {
            "handlers": ["console"], "level": "INFO", "propagate": False,
        },
        "danbyte": {
            "handlers": ["console"], "level": "INFO", "propagate": False,
        },
        # LDAP failures must be visible — a directory login that dies inside
        # django-auth-ldap otherwise surfaces only as a generic "Invalid
        # username or password" with nothing logged (issue #152).
        "danbyte.ldap": {
            "handlers": ["console"], "level": "INFO", "propagate": False,
        },
        "django_auth_ldap": {
            "handlers": ["console"],
            "level": os.getenv("LDAP_LOG_LEVEL", "WARNING"),
            "propagate": False,
        },
    },
}

# Production file logging: when DANBYTE_LOG_DIR is set and writable (the
# installer points it at /var/log/danbyte), mirror every logger to a rotating
# danbyte.log there — in addition to the console, which systemd still captures
# in the journal. Silently skipped in dev, where the directory doesn't exist.
_log_dir = os.getenv("DANBYTE_LOG_DIR", "").strip()
if _log_dir and os.path.isdir(_log_dir) and os.access(_log_dir, os.W_OK):
    LOGGING["handlers"]["file"] = {
        "class": "logging.handlers.RotatingFileHandler",
        "filename": os.path.join(_log_dir, "danbyte.log"),
        "maxBytes": 10 * 1024 * 1024,
        "backupCount": 5,
        "formatter": "verbose",
    }
    for _logger in LOGGING["loggers"].values():
        _logger["handlers"].append("file")

LANGUAGE_CODE = "en-us"
TIME_ZONE = "UTC"
USE_I18N = True
USE_TZ = True

# Auth flow targets the Django admin login (the templates for the legacy
# auth_api login page are archived in reference/). The React SPA is the
# only user-facing surface — admin login → cookie set on the shared host
# → React proxies /api calls and uses that cookie.
LOGIN_URL = "/admin/login/"
LOGIN_REDIRECT_URL = "/prefixes"   # the React route — Vite serves it after admin login
LOGOUT_REDIRECT_URL = "/admin/login/"

# Auth backends: try the (optional, DB-driven) LDAP façade first — it returns
# None when ldap_enabled is off or the directory doesn't know the user, so local
# accounts fall through to ModelBackend. Configuration lives on
# DeploymentSettings, not here; see auth_api/ldap.py.
AUTHENTICATION_BACKENDS = [
    "auth_api.ldap.DanbyteLDAPBackend",
    "django.contrib.auth.backends.ModelBackend",
]

STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
# The repo-root design/ mockups moved into docs/reference/design/, so there is
# no extra static dir to collect — Django's app static/ + collectstatic cover
# admin + DRF. (An entry pointing at a missing dir raises staticfiles.W004.)
STATICFILES_DIRS: list = []

# Uploaded media (device-type rack images, …).
MEDIA_URL = "/media/"
MEDIA_ROOT = BASE_DIR / "media"

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"

# ─── Monitoring / check engine ─────────────────────────────────────────────
# Encryption key for check credentials at rest (SNMP/SSH/Telnet). When unset,
# a key is derived from SECRET_KEY so dev works out of the box; production
# should set a dedicated key so rotating SECRET_KEY doesn't invalidate stored
# secrets. Point MONITORING_SECRETS_BACKEND at a dotted factory path to swap in
# an external store (OpenBao/Vault) later.
MONITORING_SECRET_KEY = os.getenv("MONITORING_SECRET_KEY", "")
if not MONITORING_SECRET_KEY and TESTING:
    # Deterministic key for the test DB (DEBUG is off under the test runner, so
    # the fail-closed derivation guard would otherwise abort migrations).
    MONITORING_SECRET_KEY = "test-monitoring-secret-key-not-for-production"
MONITORING_SECRETS_BACKEND = os.getenv("MONITORING_SECRETS_BACKEND", "")

# SSRF policy for the CENTRAL check runner. When True, a check target that
# resolves to loopback / RFC1918 / reserved is refused (a tenant-defined target
# would otherwise probe the server's own internal services — set this on a
# cloud, multi-tenant deployment). Default False keeps self-hosted deployments
# that monitor their own LAN from the central box working. The cloud-metadata
# endpoint is refused regardless. DANBYTE_SSRF_ALLOWLIST (shared with the
# outbound guard in core/ssrf.py) lists CIDRs permitted even when this is on.
CHECK_BLOCK_INTERNAL = os.getenv("DANBYTE_CHECK_BLOCK_INTERNAL", "False") == "True"
SSRF_ALLOWLIST = [
    p.strip() for p in os.getenv("DANBYTE_SSRF_ALLOWLIST", "").split(",") if p.strip()
]

# Max concurrent check attempts inside a single worker job's asyncio loop.
# Mirrors a common ping-monitor default; raising it needs a matching LimitNOFILE bump
# on the worker systemd unit (see services/danbyte-workers.service).
MONITORING_CONCURRENCY = int(os.getenv("MONITORING_CONCURRENCY", "100"))

# Sharding: a due check set is split into shards, one RQ job each, so fan-out
# parallelises across worker processes. ICMP shards are large (one multiping
# call each); generic (TCP/HTTP/…) shards are smaller since each target is its
# own connection.
MONITORING_SHARD_SIZE = int(os.getenv("MONITORING_SHARD_SIZE", "2000"))
MONITORING_GENERIC_SHARD_SIZE = int(os.getenv("MONITORING_GENERIC_SHARD_SIZE", "200"))
# ICMP sweeps fire cheap echo probes, so they run at much higher concurrency
# than the generic-check limit (MONITORING_CONCURRENCY=100, which protects
# heavier TCP/HTTP/SSH connections). At 2000 a full 2000-host shard pings in
# ~1s instead of ~20s — a /16 sweep drops from ~11min to ~35s.
MONITORING_SWEEP_CONCURRENCY = int(os.getenv("MONITORING_SWEEP_CONCURRENCY", "2000"))
# Manual "Discover now": prefixes with at most this many host addresses sweep
# synchronously (instant summary, ~2-3s at the sweep concurrency above); larger
# ones are enqueued onto a worker so the request returns immediately instead of
# timing out behind the proxy.
MONITORING_DISCOVER_SYNC_LIMIT = int(os.getenv("MONITORING_DISCOVER_SYNC_LIMIT", "4096"))

# Global default schedule (seconds) for assignments in follow_global mode.
MONITORING_GLOBAL_INTERVAL_SECONDS = int(
    os.getenv("MONITORING_GLOBAL_INTERVAL_SECONDS", "300")
)
# Whether the global schedule runs checks at all (the global on/off switch
# that follow_global assignments obey).
MONITORING_GLOBAL_ENABLED = os.getenv("MONITORING_GLOBAL_ENABLED", "True") == "True"

# Notifications: per-channel webhook POST timeout (seconds).
MONITORING_WEBHOOK_TIMEOUT = int(os.getenv("MONITORING_WEBHOOK_TIMEOUT", "5"))

# Retention: the pruning job deletes CheckResult rows older than this many days
# (time-series, high volume) and StateTransition rows older than the second
# value (kept longer — they're the audit timeline). Run by danbyte-prune.timer.
# Default 30d: raw results run ~600k rows/day in production (issue #155); the
# rolled-up CheckState + StateTransition carry the long-term story.
MONITORING_RESULT_RETENTION_DAYS = int(
    os.getenv("MONITORING_RESULT_RETENTION_DAYS", "30")
)
MONITORING_TRANSITION_RETENTION_DAYS = int(
    os.getenv("MONITORING_TRANSITION_RETENTION_DAYS", "365")
)
# Change-log (audit) retention — kept long by default; 0 disables pruning.
CHANGELOG_RETENTION_DAYS = int(os.getenv("CHANGELOG_RETENTION_DAYS", "730"))

# Prefix-utilization alerts: warn (via notification channels) when a prefix
# reaches THRESHOLD% full; re-arm once it drops back below CLEAR% (hysteresis).
MONITORING_UTIL_ALERT_THRESHOLD = int(os.getenv("MONITORING_UTIL_ALERT_THRESHOLD", "90"))
MONITORING_UTIL_ALERT_CLEAR = int(os.getenv("MONITORING_UTIL_ALERT_CLEAR", "80"))

# Script / exec checks (Nagios-plugin style). These run a local command on the
# worker host, so they are a privileged capability — DISABLED by default. To use
# them, set MONITORING_EXEC_ENABLED=True *and* point MONITORING_PLUGIN_DIR at a
# directory of trusted plugins. Only plugins inside that dir can be run (by bare
# name, no path traversal), and arguments are passed without a shell — so the
# web UI can pick a plugin + args but can't execute arbitrary system commands.
MONITORING_EXEC_ENABLED = os.getenv("MONITORING_EXEC_ENABLED", "False") == "True"
MONITORING_PLUGIN_DIR = os.getenv("MONITORING_PLUGIN_DIR", "")
