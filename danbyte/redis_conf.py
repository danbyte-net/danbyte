"""The one Redis connection every consumer is built from (#502).

The cache, the RQ queues (``discovery`` included) and the Channels layer all
read :func:`from_env`, so a password, a TLS URL or a unix socket set once
reaches every one of them. Django-free: settings.py calls it before Django is
configured.

Where the server is, first match wins:

1. ``REDIS_URL`` - ``redis://``, ``rediss://`` (TLS) or ``unix:///path``;
2. ``REDIS_SOCKET`` - a unix socket path;
3. ``REDIS_HOST`` / ``REDIS_PORT`` - ``localhost`` / ``6379``.

``REDIS_URL`` with ``REDIS_SOCKET``, or with a ``REDIS_HOST``/``REDIS_PORT``
naming another server, is refused rather than guessed at: before this, the
cache read the URL while RQ and Channels read the host and port.

Credentials come from the URL (``redis://user:pass@host``) or from
``REDIS_USERNAME`` / ``REDIS_PASSWORD``; both set and different is refused.
The cache keeps the URL's database (default 0), RQ uses ``RQ_REDIS_DB``
(default 0) and Channels database 0, as before.

The URLs handed to the consumers never carry the password: it travels as a
separate ``PASSWORD``/``password`` setting, which Django's error reports
mask. Errors name the server through :meth:`RedisConf.redacted`.
"""
from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from urllib.parse import parse_qsl, quote, unquote, urlencode, urlsplit

SCHEMES = ("redis", "rediss", "unix")
_LOOPBACK = {"localhost", "127.0.0.1", "::1"}
#: URL query options a connection may carry (redis-py's names), with how to
#: read each. Anything else is refused: a typo should not pass silently.
_OPTIONS = {
    "ssl_ca_certs": str,
    "ssl_ca_path": str,
    "ssl_certfile": str,
    "ssl_keyfile": str,
    "ssl_cert_reqs": str,
    "ssl_check_hostname": lambda v: v.strip().lower() in ("1", "true", "yes", "on"),
}


class RedisConfigError(ValueError):
    """The Redis environment is contradictory or malformed. The message never
    holds a password."""


@dataclass(frozen=True)
class RedisConf:
    scheme: str = "redis"
    host: str = "localhost"
    port: int = 6379
    path: str = ""
    db: int = 0
    username: str = ""
    password: str = field(default="", repr=False)
    options: tuple[tuple[str, str], ...] = ()

    @property
    def tls(self) -> bool:
        return self.scheme == "rediss"

    @property
    def unix(self) -> bool:
        return self.scheme == "unix"

    def url(self, db: int | None = None) -> str:
        """The server as a URL for database ``db`` (default: the cache's),
        without credentials."""
        db = self.db if db is None else db
        if self.unix:
            query = urlencode([("db", str(db)), *self.options])
            return f"unix://{quote(self.path)}?{query}"
        host = f"[{self.host}]" if ":" in self.host else self.host
        query = f"?{urlencode(self.options)}" if self.options else ""
        return f"{self.scheme}://{host}:{self.port}/{db}{query}"

    def redacted(self, db: int | None = None) -> str:
        """:meth:`url` with the user named and the password as ``***``: safe
        for logs and error messages."""
        url = self.url(db)
        if not (self.username or self.password):
            return url
        who = quote(self.username, safe="") + (":***" if self.password else "")
        scheme, rest = url.split("://", 1)
        return f"{scheme}://{who}@{rest}"

    def _auth(self, upper: bool) -> dict:
        out = {}
        if self.username:
            out["USERNAME" if upper else "username"] = self.username
        if self.password:
            out["PASSWORD" if upper else "password"] = self.password
        return out

    def cache(self) -> dict:
        """``CACHES["default"]`` for django-redis."""
        return {
            "BACKEND": "django_redis.cache.RedisCache",
            "LOCATION": self.url(),
            "OPTIONS": {
                "CLIENT_CLASS": "django_redis.client.DefaultClient",
                # Explicit, so a stalled Redis costs a request two seconds
                # rather than whatever the client stack defaults to (#230).
                "SOCKET_CONNECT_TIMEOUT": 2,
                "SOCKET_TIMEOUT": 2,
                **self._auth(upper=True),
            },
        }

    def rq(self, db: int, timeout: str) -> dict:
        """One ``RQ_QUEUES`` entry for django-rq. No socket timeout: a worker
        blocks on the queue for minutes at a time."""
        kwargs: dict = {}
        if self.unix:
            kwargs["unix_socket_path"] = self.path
        for name, value in self.options:
            if name not in ("ssl_cert_reqs",):
                kwargs[name] = _OPTIONS[name](value)
        conf = {
            # A unix socket shows as its path wherever django-rq names the host.
            "HOST": self.path if self.unix else self.host,
            "PORT": self.port,
            "DB": db,
            "DEFAULT_TIMEOUT": timeout,
            **self._auth(upper=True),
        }
        if self.tls:
            conf["SSL"] = True
            conf["SSL_CERT_REQS"] = dict(self.options).get("ssl_cert_reqs", "required")
        if kwargs:
            conf["REDIS_CLIENT_KWARGS"] = kwargs
        return conf

    def channels(self) -> dict:
        """``CHANNEL_LAYERS["default"]`` for channels-redis, on database 0."""
        return {
            "BACKEND": "channels_redis.core.RedisChannelLayer",
            "CONFIG": {"hosts": [{"address": self.url(0), **self._auth(upper=False)}]},
        }


def _int(value: str, name: str, low: int, high: int) -> int:
    try:
        n = int(str(value).strip())
    except ValueError:
        raise RedisConfigError(f"{name} must be a number, not {value!r}") from None
    if not low <= n <= high:
        raise RedisConfigError(f"{name} must be between {low} and {high}")
    return n


def _options(query: str, where: str) -> tuple[tuple[str, str], ...]:
    out = []
    for name, value in parse_qsl(query, keep_blank_values=True):
        if name == "db":
            continue
        if name not in _OPTIONS:
            raise RedisConfigError(f"{where}: unknown option {name!r} (known: {', '.join(_OPTIONS)})")
        out.append((name, value))
    return tuple(out)


def _from_url(raw: str) -> dict:
    try:
        u = urlsplit(raw)
        port = u.port
    except ValueError:
        raise RedisConfigError("REDIS_URL is not a valid URL") from None
    scheme = u.scheme.lower()
    if scheme not in SCHEMES:
        raise RedisConfigError(
            f"REDIS_URL must start with redis://, rediss:// or unix://, not {scheme or '(none)'}://")
    query = dict(parse_qsl(u.query))
    if scheme != "rediss" and any(k.startswith("ssl_") for k in query):
        raise RedisConfigError("REDIS_URL: ssl_ options need a rediss:// URL")
    out = {
        "scheme": scheme,
        "username": unquote(u.username or ""),
        "password": unquote(u.password or ""),
        "options": _options(u.query, "REDIS_URL"),
    }
    if scheme == "unix":
        if not u.path:
            raise RedisConfigError("REDIS_URL: a unix:// URL needs the socket path, unix:///run/redis/redis.sock")
        out["path"] = unquote(u.path)
        out["db"] = _int(query.get("db", "0"), "REDIS_URL's db", 0, 1 << 20)
        out["host"] = ""
        return out
    if not u.hostname:
        raise RedisConfigError("REDIS_URL names no host")
    out["host"] = u.hostname
    out["port"] = port or 6379
    path_db = u.path.strip("/")
    out["db"] = _int(query.get("db", path_db or "0"), "REDIS_URL's database", 0, 1 << 20)
    return out


def from_env(env: Mapping[str, str]) -> RedisConf:
    """The Redis connection ``env`` (``os.environ``) describes."""
    get = lambda k: (env.get(k) or "").strip()  # noqa: E731
    url, socket = get("REDIS_URL"), get("REDIS_SOCKET")
    host, port = get("REDIS_HOST"), get("REDIS_PORT")
    if url and socket:
        raise RedisConfigError("set REDIS_URL or REDIS_SOCKET, not both")
    if socket and (host or port):
        raise RedisConfigError("REDIS_SOCKET is set, so remove REDIS_HOST and REDIS_PORT")
    if url:
        parts = _from_url(url)
        if host or port:
            same_host = not host or host == parts["host"] or (
                host in _LOOPBACK and parts["host"] in _LOOPBACK)
            same_port = not port or (
                parts["scheme"] != "unix" and _int(port, "REDIS_PORT", 1, 65535) == parts["port"])
            if parts["scheme"] == "unix" or not (same_host and same_port):
                raise RedisConfigError(
                    "REDIS_URL and REDIS_HOST/REDIS_PORT name different Redis servers; "
                    "remove REDIS_HOST and REDIS_PORT, REDIS_URL is enough")
    elif socket:
        if not socket.startswith("/"):
            raise RedisConfigError("REDIS_SOCKET must be an absolute path")
        parts = {"scheme": "unix", "host": "", "path": socket, "db": 0}
    else:
        parts = {"host": host or "localhost",
                 "port": _int(port, "REDIS_PORT", 1, 65535) if port else 6379}

    username, password = get("REDIS_USERNAME"), env.get("REDIS_PASSWORD") or ""
    for name, value, key in (("REDIS_USERNAME", username, "username"),
                             ("REDIS_PASSWORD", password, "password")):
        if not value:
            continue
        if parts.get(key) and parts[key] != value:
            raise RedisConfigError(f"REDIS_URL and {name} disagree; set it in one place")
        parts[key] = value
    return RedisConf(**parts)
