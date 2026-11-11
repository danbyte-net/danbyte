"""One Redis configuration for every consumer (#502): how the environment
is read, that the cache, every RQ queue and the Channels layer are built
from it, and that the password never shows."""
from __future__ import annotations

import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from unittest import skipUnless

from django.conf import settings
from django.test import SimpleTestCase

from danbyte.redis_conf import RedisConf, RedisConfigError, from_env

SECRET = "s3cret-Pw_42"


def _no_secret(test, *values):
    for v in values:
        test.assertNotIn(SECRET, repr(v))


class ParsingTests(SimpleTestCase):
    def test_nothing_set_is_localhost_without_auth(self):
        c = from_env({})
        self.assertEqual((c.scheme, c.host, c.port, c.db, c.username, c.password),
                         ("redis", "localhost", 6379, 0, "", ""))
        cache = c.cache()
        self.assertEqual(cache["LOCATION"], "redis://localhost:6379/0")
        self.assertNotIn("PASSWORD", cache["OPTIONS"])
        self.assertEqual(cache["OPTIONS"]["SOCKET_TIMEOUT"], 2)
        rq = c.rq(0, "1h")
        self.assertEqual({k: rq[k] for k in ("HOST", "PORT", "DB", "DEFAULT_TIMEOUT")},
                         {"HOST": "localhost", "PORT": 6379, "DB": 0, "DEFAULT_TIMEOUT": "1h"})
        self.assertNotIn("PASSWORD", rq)
        self.assertNotIn("SSL", rq)
        self.assertEqual(c.channels()["CONFIG"]["hosts"], [{"address": "redis://localhost:6379/0"}])

    def test_what_existing_installs_set_keeps_working(self):
        # install.sh writes REDIS_URL alone; the compose files set all three;
        # a second instance on the same Redis moves its queues with RQ_REDIS_DB
        # and its cache with the URL's database.
        self.assertEqual(from_env({"REDIS_URL": "redis://localhost:6379/0"}), from_env({}))
        docker = from_env({"REDIS_URL": "redis://redis:6379/0", "REDIS_HOST": "redis",
                           "REDIS_PORT": "6379"})
        self.assertEqual((docker.host, docker.port, docker.db), ("redis", 6379, 0))
        dev = from_env({"REDIS_URL": "redis://localhost:6379/1"})
        self.assertEqual(dev.cache()["LOCATION"], "redis://localhost:6379/1")
        self.assertEqual(dev.rq(2, "1h")["DB"], 2)
        self.assertEqual(dev.channels()["CONFIG"]["hosts"][0]["address"], "redis://localhost:6379/0")
        hp = from_env({"REDIS_HOST": "cache.internal", "REDIS_PORT": "6380"})
        self.assertEqual(hp.cache()["LOCATION"], "redis://cache.internal:6380/0")
        self.assertEqual((hp.rq(0, "1h")["HOST"], hp.rq(0, "1h")["PORT"]), ("cache.internal", 6380))
        # the loopback spelled two ways is one server
        self.assertEqual(from_env({"REDIS_URL": "redis://127.0.0.1:6379/0",
                                   "REDIS_HOST": "localhost"}).host, "127.0.0.1")

    def test_password(self):
        c = from_env({"REDIS_PASSWORD": SECRET})
        self.assertEqual(c.cache()["OPTIONS"]["PASSWORD"], SECRET)
        self.assertEqual(c.rq(0, "1h")["PASSWORD"], SECRET)
        self.assertEqual(c.channels()["CONFIG"]["hosts"][0]["password"], SECRET)
        self.assertNotIn("USERNAME", c.rq(0, "1h"))
        _no_secret(self, c.url(), c.redacted(), c, c.cache()["LOCATION"],
                   c.channels()["CONFIG"]["hosts"][0]["address"])
        self.assertEqual(c.redacted(), "redis://:***@localhost:6379/0")

    def test_username_and_password(self):
        c = from_env({"REDIS_USERNAME": "danbyte", "REDIS_PASSWORD": SECRET})
        self.assertEqual(c.cache()["OPTIONS"]["USERNAME"], "danbyte")
        self.assertEqual((c.rq(0, "1h")["USERNAME"], c.rq(0, "1h")["PASSWORD"]), ("danbyte", SECRET))
        self.assertEqual(c.channels()["CONFIG"]["hosts"][0]["username"], "danbyte")
        self.assertEqual(c.redacted(), "redis://danbyte:***@localhost:6379/0")

    def test_credentials_in_the_url(self):
        c = from_env({"REDIS_URL": "redis://danbyte:s3cret-Pw_42%40x@db-redis:6390/3"})
        self.assertEqual((c.username, c.password, c.host, c.port, c.db),
                         ("danbyte", SECRET + "@x", "db-redis", 6390, 3))
        self.assertEqual(c.cache()["LOCATION"], "redis://db-redis:6390/3")
        _no_secret(self, c.cache()["LOCATION"], c.channels()["CONFIG"]["hosts"][0]["address"],
                   c.redacted(), c)
        # the same password set twice is one setting; two different are refused
        same = from_env({"REDIS_URL": f"redis://:{SECRET}@localhost/0", "REDIS_PASSWORD": SECRET})
        self.assertEqual(same.password, SECRET)
        with self.assertRaises(RedisConfigError) as e:
            from_env({"REDIS_URL": "redis://:other-pw@localhost/0", "REDIS_PASSWORD": SECRET})
        self.assertNotIn(SECRET, str(e.exception))
        self.assertNotIn("other-pw", str(e.exception))
        with self.assertRaises(RedisConfigError):
            from_env({"REDIS_URL": "redis://alice:x@localhost/0", "REDIS_USERNAME": "bob"})

    def test_tls_url(self):
        c = from_env({"REDIS_URL": "rediss://redis.example.net:6380/0?ssl_ca_certs=/etc/danbyte/ca.pem",
                      "REDIS_PASSWORD": SECRET})
        self.assertTrue(c.tls)
        self.assertEqual(c.cache()["LOCATION"],
                         "rediss://redis.example.net:6380/0?ssl_ca_certs=%2Fetc%2Fdanbyte%2Fca.pem")
        rq = c.rq(0, "1h")
        self.assertTrue(rq["SSL"])
        self.assertEqual(rq["SSL_CERT_REQS"], "required")   # verified unless said otherwise
        self.assertEqual(rq["REDIS_CLIENT_KWARGS"], {"ssl_ca_certs": "/etc/danbyte/ca.pem"})
        self.assertTrue(c.channels()["CONFIG"]["hosts"][0]["address"].startswith("rediss://"))
        with self.assertRaises(RedisConfigError):
            from_env({"REDIS_URL": "redis://localhost/0?ssl_ca_certs=/x"})

    def test_unix_socket(self):
        for env in ({"REDIS_SOCKET": "/run/redis/redis-server.sock"},
                    {"REDIS_URL": "unix:///run/redis/redis-server.sock?db=0"}):
            with self.subTest(env=env):
                c = from_env({**env, "REDIS_PASSWORD": SECRET})
                self.assertTrue(c.unix)
                self.assertEqual(c.cache()["LOCATION"], "unix:///run/redis/redis-server.sock?db=0")
                rq = c.rq(4, "1h")
                self.assertEqual(rq["REDIS_CLIENT_KWARGS"],
                                 {"unix_socket_path": "/run/redis/redis-server.sock"})
                self.assertEqual((rq["DB"], rq["PASSWORD"]), (4, SECRET))
                self.assertEqual(c.channels()["CONFIG"]["hosts"][0]["address"],
                                 "unix:///run/redis/redis-server.sock?db=0")
        self.assertEqual(from_env({"REDIS_URL": "unix:///tmp/r.sock?db=5"}).db, 5)

    def test_contradictions_are_refused(self):
        bad = (
            {"REDIS_URL": "redis://localhost/0", "REDIS_SOCKET": "/run/r.sock"},
            {"REDIS_URL": "redis://redis-a:6379/0", "REDIS_HOST": "redis-b"},
            {"REDIS_URL": "redis://localhost:6379/0", "REDIS_PORT": "6380"},
            {"REDIS_URL": "unix:///run/r.sock", "REDIS_HOST": "localhost"},
            {"REDIS_SOCKET": "/run/r.sock", "REDIS_HOST": "localhost"},
            {"REDIS_SOCKET": "run/r.sock"},
            {"REDIS_URL": "http://localhost:6379/0"},
            {"REDIS_URL": "redis://localhost:notaport/0"},
            {"REDIS_URL": "redis:///0"},
            {"REDIS_URL": "unix://"},
            {"REDIS_URL": "redis://localhost/0?timeout=3"},
            {"REDIS_PORT": "0"},
            {"REDIS_URL": "redis://localhost/x"},
        )
        for env in bad:
            with self.subTest(env=env), self.assertRaises(RedisConfigError):
                from_env(env)

    def test_the_password_is_never_in_a_repr(self):
        c = from_env({"REDIS_PASSWORD": SECRET})
        _no_secret(self, c, [c])
        self.assertIsInstance(c, RedisConf)


class ConsumersTests(SimpleTestCase):
    """What each library builds from its part of the configuration."""

    def setUp(self):
        self.c = from_env({"REDIS_URL": "redis://danbyte@127.0.0.1:6390/1",
                           "REDIS_PASSWORD": SECRET})

    def test_rq_connection(self):
        from django_rq.connection_utils import get_redis_connection

        kw = get_redis_connection(self.c.rq(7, "1h")).connection_pool.connection_kwargs
        self.assertEqual((kw["host"], kw["port"], kw["db"], kw["username"], kw["password"]),
                         ("127.0.0.1", 6390, 7, "danbyte", SECRET))
        unix = from_env({"REDIS_SOCKET": "/run/r.sock", "REDIS_PASSWORD": SECRET})
        pool = get_redis_connection(unix.rq(2, "1h")).connection_pool
        self.assertEqual((pool.connection_kwargs["path"], pool.connection_kwargs["db"],
                          pool.connection_kwargs["password"]), ("/run/r.sock", 2, SECRET))
        tls = from_env({"REDIS_URL": "rediss://redis.example.net:6380/0"})
        conn_class = get_redis_connection(tls.rq(0, "1h")).connection_pool.connection_class
        self.assertEqual(conn_class.__name__, "SSLConnection")

    def test_cache_connection(self):
        import redis
        from django_redis.pool import ConnectionFactory

        cache = self.c.cache()
        params = ConnectionFactory(cache["OPTIONS"]).make_connection_params(cache["LOCATION"])
        pool = redis.ConnectionPool.from_url(params["url"], **{
            k: v for k, v in params.items() if k not in ("url", "parser_class")})
        kw = pool.connection_kwargs
        self.assertEqual((kw["host"], kw["port"], kw["db"], kw["username"], kw["password"]),
                         ("127.0.0.1", 6390, 1, "danbyte", SECRET))

    def test_channel_layer_connection(self):
        from channels_redis.utils import create_pool

        kw = create_pool(self.c.channels()["CONFIG"]["hosts"][0]).connection_kwargs
        self.assertEqual((kw["host"], kw["port"], kw["db"], kw["username"], kw["password"]),
                         ("127.0.0.1", 6390, 0, "danbyte", SECRET))

    def test_every_consumer_comes_from_the_one_setting(self):
        # The running settings: cache, every queue (discovery included) and
        # the channel layer are DANBYTE_REDIS's, so none can drift apart.
        from django_rq.connection_utils import filter_connection_params

        conf = settings.DANBYTE_REDIS
        self.assertEqual(settings.CACHES["default"], conf.cache())
        self.assertEqual(settings.CHANNEL_LAYERS["default"], conf.channels())
        self.assertEqual(set(settings.RQ_QUEUES), {"default", "high", "low", "discovery"})
        connections = {repr(sorted(filter_connection_params(q).items()))
                       for q in settings.RQ_QUEUES.values()}
        self.assertEqual(len(connections), 1)
        db = int(os.getenv("RQ_REDIS_DB", "0"))
        for name, q in settings.RQ_QUEUES.items():
            with self.subTest(queue=name):
                self.assertEqual({k: v for k, v in q.items() if k != "DEFAULT_TIMEOUT"},
                                 {k: v for k, v in conf.rq(db, "").items() if k != "DEFAULT_TIMEOUT"})

    def test_sandboxed_scripts_still_cannot_reach_redis(self):
        from scripting import sandbox

        self.assertIn(settings.DANBYTE_REDIS.port, sandbox.blocked_ports())


class SettingsStartupTests(SimpleTestCase):
    """settings.py itself, in a fresh interpreter with a given environment."""

    def _import(self, **env):
        clean = {k: v for k, v in os.environ.items() if not k.startswith("REDIS_")}
        clean.pop("RQ_REDIS_DB", None)
        code = ("import json, danbyte.settings as s; print(json.dumps({"
                "'cache': s.CACHES['default']['LOCATION'], 'rq': s.RQ_QUEUES['discovery']['DB'],"
                "'pw': bool(s.RQ_QUEUES['low'].get('PASSWORD'))}))")
        return subprocess.run([sys.executable, "-c", code], cwd=settings.BASE_DIR,
                              env={**clean, **env}, capture_output=True, text=True, timeout=60)

    def test_a_contradiction_stops_startup_without_the_password(self):
        r = self._import(REDIS_URL="redis://:other-pw@localhost:6379/0", REDIS_PASSWORD=SECRET)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("ImproperlyConfigured: Redis:", r.stderr)
        self.assertNotIn(SECRET, r.stderr + r.stdout)
        self.assertNotIn("other-pw", r.stderr + r.stdout)

    def test_the_dev_units_queue_database(self):
        import json

        r = self._import(REDIS_URL="redis://localhost:6379/1", RQ_REDIS_DB="2",
                         REDIS_PASSWORD=SECRET)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads(r.stdout), {"cache": "redis://localhost:6379/1", "rq": 2,
                                                "pw": True})


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@skipUnless(shutil.which("redis-server"), "redis-server needed")
class ThrowawayRedisTests(SimpleTestCase):
    """Against a redis-server of this test's own, on a free port and a unix
    socket in a scratch directory - never the host's Redis."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.tmp = tempfile.TemporaryDirectory()
        cls.port = _free_port()
        cls.sock = str(Path(cls.tmp.name) / "redis.sock")
        cls.proc = subprocess.Popen(
            ["redis-server", "--port", str(cls.port), "--bind", "127.0.0.1",
             "--unixsocket", cls.sock, "--unixsocketperm", "700", "--dir", cls.tmp.name,
             "--save", "", "--appendonly", "no", "--requirepass", SECRET,
             "--user", "danbyte", "on", ">acl-" + SECRET, "~*", "&*", "+@all"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            if os.path.exists(cls.sock):
                break
            time.sleep(0.05)

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait(10)
        cls.tmp.cleanup()
        super().tearDownClass()

    def _ping_all(self, conf: RedisConf) -> None:
        import asyncio

        import redis
        from channels_redis.utils import create_pool
        from django_redis.pool import ConnectionFactory
        from django_rq.connection_utils import get_redis_connection

        rq_conn = get_redis_connection(conf.rq(3, "1h"))
        self.assertTrue(rq_conn.ping())
        # rqworker-pool's children rebuild the connection from its pool's
        # kwargs (rq.connections.parse_connection): the password goes along.
        from rq.connections import parse_connection

        cls, pool_cls, kwargs = parse_connection(rq_conn)
        self.assertTrue(cls(connection_pool=redis.ConnectionPool(connection_class=pool_cls,
                                                                 **kwargs)).ping())
        cache = conf.cache()
        params = ConnectionFactory(cache["OPTIONS"]).make_connection_params(cache["LOCATION"])
        self.assertTrue(redis.Redis(connection_pool=redis.ConnectionPool.from_url(
            params["url"], **{k: v for k, v in params.items()
                              if k not in ("url", "parser_class")})).ping())

        async def channels_ping():
            from redis import asyncio as aioredis

            client = aioredis.Redis(connection_pool=create_pool(conf.channels()["CONFIG"]["hosts"][0]))
            try:
                return await client.ping()
            finally:
                await client.aclose()

        self.assertTrue(asyncio.run(channels_ping()))

    def test_password_over_tcp(self):
        self._ping_all(from_env({"REDIS_URL": f"redis://127.0.0.1:{self.port}/0",
                                 "REDIS_PASSWORD": SECRET}))

    def test_acl_user_over_tcp(self):
        self._ping_all(from_env({"REDIS_HOST": "127.0.0.1", "REDIS_PORT": str(self.port),
                                 "REDIS_USERNAME": "danbyte", "REDIS_PASSWORD": "acl-" + SECRET}))

    def test_password_over_the_unix_socket(self):
        self._ping_all(from_env({"REDIS_SOCKET": self.sock, "REDIS_PASSWORD": SECRET}))
        self._ping_all(from_env({"REDIS_URL": f"unix://:{SECRET}@{self.sock}?db=1"}))

    def test_without_or_with_a_wrong_password_redis_refuses(self):
        import redis
        from django_rq.connection_utils import get_redis_connection

        for env in ({}, {"REDIS_PASSWORD": "wrong"}):
            conf = from_env({"REDIS_HOST": "127.0.0.1", "REDIS_PORT": str(self.port), **env})
            with self.subTest(env=env), self.assertRaises(redis.exceptions.AuthenticationError) as e:
                get_redis_connection(conf.rq(0, "1h")).ping()
            self.assertNotIn(SECRET, str(e.exception))


@skipUnless(shutil.which("redis-server") and shutil.which("redis-cli"), "redis-server needed")
class InstallerRedisPasswordTests(SimpleTestCase):
    """install.sh --redis-password's step, against a redis.conf and a
    redis-server of this test's own: systemctl and redis-cli are stand-ins
    that start that server and talk to its port, never the host's Redis."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.port = _free_port()
        self.conf = self.tmp / "redis.conf"
        self.conf.write_text(f"port {self.port}\nbind 127.0.0.1\ndir {self.tmp}\nsave \"\"\n"
                             "appendonly no\n")
        bin_ = self.tmp / "bin"
        bin_.mkdir()
        pid = self.tmp / "redis.pid"
        calls = self.tmp / "calls"
        (bin_ / "systemctl").write_text(
            f'#!/bin/sh\necho "systemctl $*" >>{calls}\n'
            f'[ -f {pid} ] && kill "$(cat {pid})" && sleep 0.3\n'
            f'exec redis-server {self.conf} --daemonize yes --pidfile {pid} --logfile {self.tmp}/log\n')
        real_cli = shutil.which("redis-cli")
        (bin_ / "redis-cli").write_text(
            f'#!/bin/sh\necho "redis-cli $*" >>{calls}\nexec {real_cli} -p {self.port} "$@"\n')
        for f in ("systemctl", "redis-cli"):
            (bin_ / f).chmod(0o755)
        self.calls, self.pid = calls, pid
        self.env = {**os.environ, "PATH": f"{bin_}:{os.environ['PATH']}",
                    "REDIS_CONF": str(self.conf),
                    "REDIS_GROUP": subprocess.run(["id", "-gn"], capture_output=True,
                                                  text=True).stdout.strip()}
        self.addCleanup(self._stop)

    def _stop(self):
        if self.pid.exists():
            subprocess.run(["kill", self.pid.read_text().strip()], capture_output=True)

    def _step(self):
        import re

        text = (Path(settings.BASE_DIR) / "scripts" / "install.sh").read_text()
        funcs = [re.search(r"^redis_require_password\(\) \{.*?^\}$", text, re.M | re.S).group(0),
                 re.search(r"^warn\(\) \{.*\}$", text, re.M).group(0)]
        script = ('REDIS_CONF="${REDIS_CONF:-/etc/redis/redis.conf}"\n' + "\n".join(funcs)
                  + f"\nprintf '%s' '{SECRET}' | redis_require_password\n")
        return subprocess.run(["bash", "-c", "set -euo pipefail\n" + script], env=self.env,
                              capture_output=True, text=True, timeout=60)

    def _ping(self, password: str | None) -> str:
        env = {**os.environ, **({"REDISCLI_AUTH": password} if password else {})}
        return subprocess.run([shutil.which("redis-cli"), "-p", str(self.port), "ping"], env=env,
                              capture_output=True, text=True, timeout=10).stdout.strip()

    def test_redis_then_asks_for_the_password(self):
        r = self._step()
        self.assertEqual(r.returncode, 0, r.stderr)
        auth = self.tmp / "danbyte-auth.conf"
        self.assertEqual(auth.read_text(), f"requirepass {SECRET}\n")
        self.assertEqual(oct(auth.stat().st_mode & 0o777), "0o640")
        self.assertTrue(self.conf.read_text().endswith(f"include {auth}\n"))
        self.assertIn("NOAUTH", self._ping(None))
        self.assertEqual(self._ping(SECRET), "PONG")
        # never on a command line, never printed
        self.assertNotIn(SECRET, self.calls.read_text() + r.stdout + r.stderr)
        # a second run keeps one include line
        r = self._step()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.conf.read_text().count("include "), 1)

    def test_a_redis_conf_with_its_own_password_is_left_alone(self):
        self.conf.write_text(self.conf.read_text() + "requirepass theirs\n")
        before = self.conf.read_text()
        r = self._step()
        self.assertEqual(r.returncode, 1)
        self.assertIn("already sets a password", r.stderr)
        self.assertEqual(self.conf.read_text(), before)
        self.assertFalse((self.tmp / "danbyte-auth.conf").exists())
        self.assertFalse(self.calls.exists())

    def test_only_a_fresh_install_takes_the_flag(self):
        text = (Path(settings.BASE_DIR) / "scripts" / "install.sh").read_text()
        self.assertIn("--redis-password) REDIS_AUTH=1; shift ;;", text)
        self.assertRegex(text, r'\[ "\$REDIS_AUTH" -eq 0 \] \|\| \[ "\$EXISTING" -eq 0 \] \\\n'
                               r'\s+\|\| die "--redis-password is for a fresh install')
        # the password reaches .env through the heredoc on stdin, as the others
        self.assertIn("REDIS_PASSWORD=$REDIS_PASSWORD", text)
        self.assertIn("\n$REDIS_ENV\n", text)
