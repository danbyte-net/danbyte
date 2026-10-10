"""What a running script can and cannot do.

These are the security tests for the feature: the sandboxed child must
hold no secret, the timeout must take the whole process tree with it, and
the run token must die with the run.
"""
from __future__ import annotations

import os
import tempfile
import unittest
from unittest import mock

from django.contrib.auth import get_user_model
from django.test import TestCase, override_settings

from auth_api.models import ApiToken
from core.models import Organization, Tenant
from scripting import sandbox, tokens
from scripting.models import Script, ScriptRun
from scripting.runner import base_env, create_run, run_script, trusted_env


class _Base(TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.override = override_settings(MEDIA_ROOT=self.tmp.name)
        self.override.enable()
        self.addCleanup(self.override.disable)
        org = Organization.objects.create(name="O", slug="o")
        self.tenant = Tenant.objects.create(org=org, name="T", slug="t")
        self.user = get_user_model().objects.create_user("scripter", "s@e.com", "x")

    def _script(self, source: str, **kw) -> Script:
        return Script.objects.create(
            tenant=self.tenant, name=kw.pop("name", "S"), source=source,
            owner=self.user, **kw,
        )

    def _run(self, source: str, params=None, **kw) -> ScriptRun:
        script = self._script(source, **kw)
        run = create_run(script, user=self.user, params=params or {})
        return run_script(str(run.id))


class EnvironmentTests(_Base):
    def test_sandboxed_env_carries_no_secret(self):
        script = self._script("pass")
        run = create_run(script, user=self.user)
        env = base_env(run, "dbt_key", "/tmp/work", "/tmp/work/outputs")
        self.assertEqual(env["DANBYTE_TOKEN"], "dbt_key")
        for leak in ("DJANGO_SETTINGS_MODULE", "DB_PASSWORD", "MONITORING_SECRET_KEY",
                     "DJANGO_SECRET_KEY", "PYTHONPATH", "REDIS_URL"):
            self.assertNotIn(leak, env, leak)
        # and nothing from the worker's own environment rides along
        self.assertEqual(env["HOME"], "/tmp/work")

    def test_trusted_env_adds_django(self):
        script = self._script("pass", trusted=True)
        run = create_run(script, user=self.user)
        env = trusted_env(run, base_env(run, "k", "/tmp/w", "/tmp/w/o"))
        self.assertEqual(env["DJANGO_SETTINGS_MODULE"], "danbyte.settings")
        self.assertEqual(env["DANBYTE_RUN_AS_ID"], str(self.user.id))
        self.assertEqual(env["DANBYTE_TENANT_ID"], str(self.tenant.id))

    def test_sandboxed_child_cannot_import_django_settings(self):
        run = self._run(
            "import os\n"
            "print('SETTINGS', os.environ.get('DJANGO_SETTINGS_MODULE', 'none'))\n"
            "print('DBPASS', os.environ.get('DB_PASSWORD', 'none'))\n"
            "import django\n"
            "from django.conf import settings\n"
            "print('DB', settings.DATABASES['default']['NAME'])\n"
        )
        self.assertEqual(run.status, "failed", run.log)
        self.assertIn("SETTINGS none", run.log)
        self.assertIn("DBPASS none", run.log)
        # django is importable from the venv, but unconfigured, so reading
        # settings raises rather than handing over credentials
        self.assertIn("ImproperlyConfigured", run.log)


class ExecutionTests(_Base):
    def test_success_captures_the_log(self):
        run = self._run("print('hello')\nprint('world')\n")
        self.assertEqual(run.status, "success", run.log)
        self.assertEqual(run.exit_code, 0)
        self.assertIn("hello", run.log)
        self.assertIn("world", run.log)
        self.assertIsNotNone(run.finished_at)
        self.assertGreaterEqual(run.duration_seconds, 0)

    def test_failure_records_the_traceback(self):
        run = self._run("raise ValueError('nope')\n")
        self.assertEqual(run.status, "failed")
        self.assertEqual(run.exit_code, 1)
        self.assertIn("ValueError: nope", run.log)
        self.assertIn("exited with code 1", run.error)

    def test_run_fail_is_a_clean_failure(self):
        run = self._run("from danbyte_sdk import run\nrun.fail('no devices matched')\n")
        self.assertEqual(run.status, "failed")
        self.assertEqual(run.exit_code, 2)
        self.assertIn("no devices matched", run.log)
        self.assertNotIn("Traceback", run.log)

    def test_params_reach_the_script(self):
        run = self._run(
            "from danbyte_sdk import run\nprint('SITE', run.param('site'), run.param('n', 5))\n",
            params={"site": "aarhus"},
        )
        self.assertEqual(run.status, "success", run.log)
        self.assertIn("SITE aarhus 5", run.log)

    # Unconfined, so the grandchild could write the marker if it survived:
    # this checks the process-tree kill, not the sandbox.
    @override_settings(SCRIPT_SANDBOX="none")
    def test_timeout_kills_the_whole_process_tree(self):
        marker = os.path.join(self.tmp.name, "child-survived")
        source = (
            "import subprocess, sys, time\n"
            f"subprocess.Popen([sys.executable, '-c', \"import time; time.sleep(30); "
            f"open({marker!r}, 'w').write('x')\"])\n"
            "print('forked', flush=True)\n"
            "time.sleep(30)\n"
        )
        run = self._run(source, timeout_seconds=5)
        self.assertEqual(run.status, "timeout")
        self.assertIn("longer than 5s", run.error)
        self.assertIn("forked", run.log)
        self.assertFalse(os.path.exists(marker), "the forked grandchild outlived the run")

    def test_log_is_capped(self):
        run = self._run("for i in range(200000):\n    print('x' * 40)\n", timeout_seconds=60)
        self.assertLess(len(run.log), 600 * 1024)
        self.assertTrue(run.truncated)
        self.assertIn("log truncated", run.log)

    def test_memory_limit_stops_a_runaway(self):
        run = self._run("x = bytearray(4 * 1024 * 1024 * 1024)\nprint('allocated')\n",
                        timeout_seconds=30)
        self.assertNotEqual(run.status, "success")
        self.assertNotIn("allocated", run.log)

    def test_language_that_cannot_run_yet_fails_clearly(self):
        script = self._script("Write-Host hi", name="ps")
        Script.objects.filter(pk=script.pk).update(language="powershell")
        run = create_run(Script.objects.get(pk=script.pk), user=self.user)
        run = run_script(str(run.id))
        self.assertEqual(run.status, "failed")
        self.assertIn("powershell", run.error)


class OutputTests(_Base):
    def test_outputs_become_downloadable_rows(self):
        run = self._run(
            "from danbyte_sdk import run\n"
            "run.output_csv('missing', [{'name': 'r1', 'site': 'aarhus'}], fields=['name', 'site'])\n"
            "run.output('notes.txt', 'two lines\\nhere\\n')\n"
        )
        self.assertEqual(run.status, "success", run.log)
        outs = {o.name: o for o in run.outputs.all()}
        self.assertEqual(sorted(outs), ["missing.csv", "notes.txt"])
        self.assertEqual(outs["missing.csv"].content_type, "text/csv")
        self.assertGreater(outs["missing.csv"].size, 0)
        with outs["missing.csv"].file.open("rb") as fh:
            body = fh.read().decode()
        self.assertIn("name,site", body)
        self.assertIn("r1,aarhus", body)

    def test_output_name_cannot_escape_the_run_directory(self):
        run = self._run(
            "from danbyte_sdk import run\nrun.output('../../escaped.txt', 'x')\n"
        )
        self.assertEqual(run.status, "success", run.log)
        self.assertEqual([o.name for o in run.outputs.all()], ["escaped.txt"])
        self.assertFalse(os.path.exists(os.path.join(self.tmp.name, "..", "escaped.txt")))


class TokenTests(_Base):
    def test_token_is_minted_hidden_scoped_and_revoked(self):
        script = self._script("pass", token_scope="read")
        run = create_run(script, user=self.user)
        token, key = tokens.mint(run)
        self.assertEqual(token.kind, "run")
        self.assertEqual(token.scope, "read")
        self.assertTrue(token.read_only)
        self.assertEqual(token.user, self.user)
        self.assertEqual(token.tenant, self.tenant)
        self.assertIsNotNone(token.expires_at)
        self.assertTrue(key.startswith("dbt_"))
        # hidden from the owner's own token list (that queryset filters kind="user")
        self.assertFalse(ApiToken.objects.filter(user=self.user, kind="user").exists())
        tokens.revoke(token)
        self.assertFalse(ApiToken.objects.filter(pk=token.pk).exists())

    def test_the_run_leaves_no_token_behind(self):
        run = self._run("print('done')")
        self.assertEqual(run.status, "success")
        self.assertFalse(ApiToken.objects.filter(kind="run").exists())

    def test_purge_removes_only_expired_run_tokens(self):
        from django.utils import timezone

        script = self._script("pass")
        run = create_run(script, user=self.user)
        live, _ = tokens.mint(run)
        stale, _ = tokens.mint(run)
        ApiToken.objects.filter(pk=stale.pk).update(
            expires_at=timezone.now() - timezone.timedelta(hours=1)
        )
        mine = ApiToken.objects.create(
            user=self.user, tenant=self.tenant, name="mine", key_hash="a" * 64, prefix="dbt_x",
            kind="user", expires_at=timezone.now() - timezone.timedelta(hours=1),
        )
        self.assertEqual(tokens.purge_expired(), 1)
        self.assertTrue(ApiToken.objects.filter(pk=live.pk).exists())
        self.assertTrue(ApiToken.objects.filter(pk=mine.pk).exists())
        self.assertFalse(ApiToken.objects.filter(pk=stale.pk).exists())


class RunAsTests(_Base):
    def test_run_as_owner_uses_the_owner_not_the_caller(self):
        other = get_user_model().objects.create_user("other", "o@e.com", "x")
        script = self._script("pass", run_as="owner")
        run = create_run(script, user=other)
        self.assertEqual(run.started_by, other)
        self.assertEqual(run.run_as_user, self.user)
        caller_script = self._script("pass", name="C", run_as="caller")
        run = create_run(caller_script, user=other)
        self.assertEqual(run.run_as_user, other)

    def test_the_run_snapshots_the_code_it_executed(self):
        script = self._script("print('v1')")
        run = create_run(script, user=self.user)
        script.source = "print('v2')"
        script.save()
        done = run_script(str(run.id))
        self.assertIn("v1", done.log)
        self.assertNotIn("v2", done.log)


_PROBE = """
import os, socket


def probe(label, fn):
    try:
        fn()
        print(label, "OPEN")
    except OSError as exc:
        print(label, "DENIED", exc.errno)


probe("environ", lambda: open(f"/proc/{{os.getppid()}}/environ").read())
probe("dotenv", lambda: open({dotenv!r}).read())
probe("secret", lambda: open({secret!r}).read())
probe("checkout", lambda: os.listdir({base!r}))
probe("sdk-dotenv", lambda: open(os.path.join(os.environ["DANBYTE_SDK_PATH"], ".env")).read())
probe("work", lambda: open("mine.txt", "w").write("x"))
probe("redis", lambda: socket.create_connection(("127.0.0.1", {redis}), 2).close())
probe("unix", lambda: socket.socket(socket.AF_UNIX).close())
probe("signal", lambda: os.kill(os.getppid(), 0))
socket.socketpair()
from danbyte_sdk import run
run.log("sdk ok")
"""


@unittest.skipUnless(sandbox.abi_version() >= 1, "the kernel has no Landlock")
class ConfinementTests(_Base):
    """A sandboxed run cannot reach the worker's secrets (#316)."""

    def setUp(self):
        super().setUp()
        self.secret = os.path.join(self.tmp.name, "worker.env")
        with open(self.secret, "w") as fh:
            fh.write("DB_PASSWORD=fake-secret-316\n")

    def _probe(self, **kw):
        from django.conf import settings

        base = str(settings.BASE_DIR)
        return self._run(_PROBE.format(
            dotenv=os.path.join(base, ".env"), secret=self.secret, base=base,
            redis=sorted(sandbox.blocked_ports() - {5432})[0],
        ), **kw)

    def _lines(self, run):
        return dict(line.split(" ", 1) for line in run.log.splitlines() if " " in line)

    def test_a_sandboxed_run_reads_nothing_of_the_worker(self):
        run = self._probe()
        self.assertEqual(run.status, "success", run.log)
        seen = self._lines(run)
        for label in ("environ", "dotenv", "secret", "checkout", "sdk-dotenv"):
            self.assertTrue(seen[label].startswith("DENIED"), (label, run.log))
        self.assertEqual(seen["work"], "OPEN")
        self.assertIn("sdk ok", run.log)
        self.assertNotIn("fake-secret-316", run.log)

    @unittest.skipUnless(sandbox.abi_version() >= 6, "needs Landlock ABI 6")
    def test_a_sandboxed_run_reaches_neither_redis_unix_sockets_nor_the_worker(self):
        seen = self._lines(self._probe())
        self.assertTrue(seen["redis"].startswith("DENIED"), seen)
        self.assertTrue(seen["unix"].startswith("DENIED"), seen)
        self.assertTrue(seen["signal"].startswith("DENIED"), seen)

    def test_the_sdk_is_a_copy_outside_the_checkout(self):
        from django.conf import settings

        run = self._run("import os\nprint('SDK', os.environ['DANBYTE_SDK_PATH'])\n")
        self.assertEqual(run.status, "success", run.log)
        path = run.log.split("SDK ", 1)[1].split()[0]
        self.assertFalse(path.startswith(str(settings.BASE_DIR)), path)

    def test_a_trusted_run_is_not_confined(self):
        from django.conf import settings

        run = self._run(
            f"import os\nprint('LISTED', len(os.listdir({str(settings.BASE_DIR)!r})) > 0)\n"
            f"print('SECRET', open({self.secret!r}).read().strip())\n",
            trusted=True,
        )
        self.assertEqual(run.status, "success", run.log)
        self.assertIn("LISTED True", run.log)
        self.assertIn("SECRET DB_PASSWORD=fake-secret-316", run.log)

    def test_a_host_that_cannot_confine_refuses_the_run(self):
        with mock.patch.object(sandbox, "abi_version", return_value=0):
            run = self._run("print('ran')\n")
        self.assertEqual(run.status, "failed")
        self.assertIn("cannot confine", run.error)
        self.assertNotIn("ran", run.log)
        self.assertFalse(ApiToken.objects.filter(kind="run").exists())

    def test_a_confinement_the_child_cannot_apply_stops_the_launch(self):
        def refuse(self):
            raise OSError(1, "refused")

        with mock.patch.object(sandbox.Confinement, "restrict_child", refuse):
            run = self._run("print('ran')\n")
        self.assertEqual(run.status, "failed")
        self.assertNotIn("ran", run.log)

    @override_settings(SCRIPT_SANDBOX="none")
    def test_turning_the_sandbox_off_is_said_in_the_log(self):
        with mock.patch.object(sandbox, "abi_version", return_value=0):
            run = self._run("print('ran')\n")
        self.assertEqual(run.status, "success", run.log)
        self.assertIn("Sandbox: off", run.log)
        self.assertIn("ran", run.log)

    def test_a_checkout_inside_a_granted_directory_is_refused(self):
        with override_settings(BASE_DIR="/usr/share/danbyte"):
            with self.assertRaises(sandbox.SandboxUnavailable):
                sandbox.prepare(self.tmp.name)

    @override_settings(SCRIPT_SANDBOX="auto")
    def test_auto_without_bubblewrap_runs_under_landlock_and_says_so(self):
        bad = sandbox.BwrapProbe(path="/usr/bin/bwrap", reason="setting up uid map refused")
        with mock.patch.object(sandbox, "bwrap_probe", return_value=bad):
            run = self._probe()
        seen = self._lines(run)
        self.assertEqual(run.status, "success", run.log)
        self.assertIn("Sandbox: Landlock", run.log)
        self.assertIn("bubblewrap is not used - setting up uid map refused", run.log)
        # never weaker than Landlock alone
        for label in ("environ", "dotenv", "secret", "checkout", "sdk-dotenv"):
            self.assertTrue(seen[label].startswith("DENIED"), (label, run.log))

    @override_settings(SCRIPT_SANDBOX="bwrap")
    def test_bwrap_mode_without_bubblewrap_refuses_the_run(self):
        bad = sandbox.BwrapProbe(path="/usr/bin/bwrap", reason="setting up uid map refused")
        with mock.patch.object(sandbox, "bwrap_probe", return_value=bad):
            run = self._run("print('ran')\n")
        self.assertEqual(run.status, "failed")
        self.assertIn("cannot run sandboxed scripts under bubblewrap", run.error)
        self.assertNotIn("ran", run.log)
        self.assertFalse(ApiToken.objects.filter(kind="run").exists())

    @override_settings(SCRIPT_SANDBOX="landlock")
    def test_landlock_mode_never_tries_bubblewrap(self):
        with mock.patch.object(sandbox, "bwrap_probe") as probe:
            run = self._run("print('ran')\n")
        probe.assert_not_called()
        self.assertEqual(run.status, "success", run.log)
        self.assertIn("Sandbox: Landlock", run.log)
        self.assertNotIn("bubblewrap", run.log)


@override_settings(SCRIPT_SANDBOX="landlock")
class LandlockOnlyConfinementTests(ConfinementTests):
    """The same guarantees with bubblewrap off: the floor every level keeps."""


class SandboxModeTests(TestCase):
    """DANBYTE_SCRIPT_SANDBOX values (#316)."""

    def test_values(self):
        cases = {"auto": "auto", "": "auto", "bwrap": "bwrap", " BWRAP ": "bwrap",
                 "landlock": "landlock", "none": "none", "off": "none", "false": "none",
                 "something-else": "auto"}
        for value, expected in cases.items():
            with self.subTest(value=value), override_settings(SCRIPT_SANDBOX=value):
                self.assertEqual(sandbox.mode(), expected)

    def test_default_is_auto(self):
        from django.conf import settings

        with override_settings():
            del settings.SCRIPT_SANDBOX
            self.assertEqual(sandbox.mode(), "auto")


class BwrapProbeTests(TestCase):
    """Detecting a working bubblewrap, once, and falling back (#316)."""

    def setUp(self):
        sandbox._probe_memo.clear()
        self.addCleanup(sandbox._probe_memo.clear)
        from django.core.cache import cache

        self.cache = cache
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def _fake_bwrap(self, body: str) -> str:
        path = os.path.join(self.tmp.name, "bwrap")
        with open(path, "w") as fh:
            fh.write("#!/bin/sh\n" + body)
        os.chmod(path, 0o755)
        self.addCleanup(self.cache.delete, sandbox._probe_key(path))
        return path

    def test_missing_binary_is_reported(self):
        with mock.patch.object(sandbox, "find_bwrap", return_value=""):
            probe = sandbox.bwrap_probe()
        self.assertFalse(probe.usable)
        self.assertIn("not installed", probe.reason)

    def test_a_bwrap_that_cannot_build_the_sandbox_is_unusable(self):
        path = self._fake_bwrap(
            "echo 'bwrap: No permissions to create a new namespace, likely because the "
            "kernel does not allow it. See <https://example>.' >&2\nexit 1\n"
        )
        with mock.patch.object(sandbox, "find_bwrap", return_value=path):
            probe = sandbox.bwrap_probe(refresh=True)
        self.assertFalse(probe.usable)
        self.assertEqual(probe.reason, "No permissions to create a new namespace, likely "
                                       "because the kernel does not allow it")

    def test_a_bwrap_that_exits_cleanly_without_running_the_probe_is_unusable(self):
        path = self._fake_bwrap("exit 0\n")
        with mock.patch.object(sandbox, "find_bwrap", return_value=path):
            self.assertFalse(sandbox.bwrap_probe(refresh=True).usable)

    def test_the_probe_runs_once_per_process_and_is_shared_through_the_cache(self):
        path = self._fake_bwrap("exit 1\n")
        good = sandbox.BwrapProbe(path=path, usable=True)
        with mock.patch.object(sandbox, "find_bwrap", return_value=path), \
                mock.patch.object(sandbox, "_run_probe", return_value=good) as run:
            self.assertTrue(sandbox.bwrap_probe(refresh=True).usable)
            self.assertTrue(sandbox.bwrap_probe().usable)
            self.assertEqual(run.call_count, 1)
            # another worker process: no memo, but the cache has it
            sandbox._probe_memo.clear()
            self.assertTrue(sandbox.bwrap_probe().usable)
            self.assertEqual(run.call_count, 1)
            sandbox.bwrap_probe(refresh=True)
            self.assertEqual(run.call_count, 2)

    def test_a_cache_outage_still_probes(self):
        path = self._fake_bwrap("exit 1\n")
        with mock.patch.object(sandbox, "find_bwrap", return_value=path), \
                mock.patch.object(self.cache, "get", side_effect=ConnectionError), \
                mock.patch.object(self.cache, "set", side_effect=ConnectionError):
            probe = sandbox.bwrap_probe()
        self.assertFalse(probe.usable)

    def _landlock_conf(self):
        return sandbox.Confinement(abi=1, ruleset_fd=-1)

    def test_auto_falls_back_to_landlock_and_says_why(self):
        bad = sandbox.BwrapProbe(path="/usr/bin/bwrap", reason="uid map refused")
        conf = self._landlock_conf()
        with mock.patch.object(sandbox, "bwrap_probe", return_value=bad):
            sandbox.with_bwrap(conf, "auto")
        self.assertIsNone(conf.bwrap)
        self.assertEqual(conf.skipped, "uid map refused")
        self.assertEqual(conf.layers[0], "Landlock")

    def test_bwrap_mode_refuses_instead_of_falling_back(self):
        bad = sandbox.BwrapProbe(path="/usr/bin/bwrap", reason="uid map refused")
        with mock.patch.object(sandbox, "bwrap_probe", return_value=bad):
            with self.assertRaisesMessage(sandbox.SandboxUnavailable, "uid map refused"):
                sandbox.with_bwrap(self._landlock_conf(), "bwrap")

    def test_a_working_bwrap_becomes_the_outer_layer(self):
        good = sandbox.BwrapProbe(path="/usr/bin/bwrap", usable=True)
        conf = self._landlock_conf()
        with mock.patch.object(sandbox, "bwrap_probe", return_value=good):
            sandbox.with_bwrap(conf, "auto")
        self.assertEqual(conf.bwrap, good)
        self.assertEqual(conf.layers[:2], ["bubblewrap", "Landlock"])


class ApiRouteTests(TestCase):
    def test_a_loopback_url_keeps_its_port(self):
        route = sandbox.api_route("http://127.0.0.1:8000")
        self.assertEqual(route.url, "http://127.0.0.1:8000")
        self.assertEqual(route.target, ("127.0.0.1", 8000))
        self.assertEqual(route.alias, "")

    def test_a_host_name_is_kept_for_tls_and_pointed_at_loopback(self):
        route = sandbox.api_route("https://danbyte.example.com/sub/")
        self.assertEqual(route.url, "https://danbyte.example.com:8080/sub")
        self.assertEqual(route.target, ("danbyte.example.com", 443))
        self.assertIn("danbyte.example.com", sandbox.hosts_file(route).split("\n")[0])

    def test_an_address_becomes_loopback_inside(self):
        route = sandbox.api_route("http://10.0.0.41:8001")
        self.assertEqual(route.url, "http://127.0.0.1:8001")
        self.assertEqual(route.target, ("10.0.0.41", 8001))

    def test_a_blocked_port_is_not_used_inside(self):
        route = sandbox.api_route("http://backend:6379")
        self.assertEqual(route.port, 8080)
        self.assertEqual(route.target, ("backend", 6379))


class ApiRelayTests(TestCase):
    def test_a_handed_over_connection_reaches_the_target_and_back(self):
        import socket
        import threading

        target = socket.create_server(("127.0.0.1", 0))
        self.addCleanup(target.close)

        def echo():
            conn, _ = target.accept()
            with conn:
                conn.sendall(b"api:" + conn.recv(100))

        threading.Thread(target=echo, daemon=True).start()
        relay = sandbox.ApiRelay(target.getsockname())
        launcher_end = relay.child.dup()
        relay.start()
        self.addCleanup(relay.stop)
        # what the launcher does with a connection the script opened
        inner = socket.create_server(("127.0.0.1", 0))
        script = socket.create_connection(inner.getsockname())
        accepted, _ = inner.accept()
        socket.send_fds(launcher_end, [b"c"], [accepted.fileno()])
        accepted.close()
        script.sendall(b"ping")
        script.settimeout(5)
        self.assertEqual(script.recv(100), b"api:ping")
        for sock in (script, inner, launcher_end):
            sock.close()


def _bwrap_usable() -> bool:
    try:
        path = sandbox.find_bwrap()
        return bool(path) and sandbox.abi_version() >= 1 and sandbox._run_probe(path).usable
    except Exception:  # noqa: BLE001 - treat anything odd as "not here"
        return False


_BWRAP_PROBE = """
import os, socket


def probe(label, fn):
    try:
        print(label, "OPEN", fn())
    except OSError as exc:
        print(label, "DENIED", exc.errno)


probe("uid", os.getuid)
probe("host", socket.gethostname)
probe("pid", os.getpid)
probe("nics", lambda: ",".join(n for _, n in socket.if_nameindex()))
probe("proc", lambda: os.listdir("/proc"))
probe("root", lambda: os.listdir("/"))
probe("tmp", lambda: os.listdir("/tmp"))
probe("checkout", lambda: os.listdir({base!r}))
probe("outside-tcp", lambda: socket.create_connection(("192.0.2.1", 80), 2).close())
probe("outside-udp", lambda: socket.socket(socket.AF_INET, socket.SOCK_DGRAM).sendto(
    b"x", ("192.0.2.1", 53)))
probe("own-script", lambda: open(os.environ["DANBYTE_SCRIPT_PATH"], "a").write("x"))
probe("work", lambda: open("mine.txt", "w").write("x"))
probe("signal", lambda: os.kill(os.getppid(), 0))
server = socket.create_server(("127.0.0.1", {redis}))
probe("landlock-port", lambda: socket.create_connection(("127.0.0.1", {redis}), 2).close())
"""


@unittest.skipUnless(_bwrap_usable(), "bubblewrap cannot build a sandbox here")
class BwrapConfinementTests(_Base):
    """bubblewrap around Landlock (#316)."""

    def setUp(self):
        super().setUp()
        sandbox._probe_memo.clear()
        self.override_mode = override_settings(SCRIPT_SANDBOX="bwrap")
        self.override_mode.enable()
        self.addCleanup(self.override_mode.disable)

    def _lines(self, run):
        return dict(line.split(" ", 1) for line in run.log.splitlines() if " " in line)

    def test_the_run_log_names_the_layers(self):
        run = self._run("print('ran')\n")
        self.assertEqual(run.status, "success", run.log)
        self.assertIn("Sandbox: bubblewrap, Landlock", run.log)

    def test_the_run_is_in_its_own_namespaces_with_landlock_inside(self):
        from django.conf import settings

        run = self._run(_BWRAP_PROBE.format(
            base=str(settings.BASE_DIR), redis=sorted(sandbox.blocked_ports() - {5432})[0],
        ))
        self.assertEqual(run.status, "success", run.log)
        seen = self._lines(run)
        self.assertEqual(seen["uid"], f"OPEN {sandbox.SANDBOX_ID}")
        self.assertEqual(seen["host"], f"OPEN {sandbox.SANDBOX_HOSTNAME}")
        self.assertLess(int(seen["pid"].split()[1]), 10, "not in its own pid namespace")
        self.assertEqual(seen["nics"], "OPEN lo")
        for label in ("proc", "tmp", "checkout", "outside-tcp", "outside-udp", "own-script"):
            self.assertTrue(seen[label].startswith("DENIED"), (label, run.log))
        # Landlock still applies inside: the sandbox root is not in its rules
        self.assertEqual(seen["root"], "DENIED 13", run.log)
        self.assertTrue(seen["work"].startswith("OPEN"), run.log)
        if sandbox.abi_version() >= 4:
            self.assertEqual(seen["landlock-port"], "DENIED 13", run.log)
        if sandbox.abi_version() >= 6:
            self.assertTrue(seen["signal"].startswith("DENIED"), run.log)

    def test_the_api_is_reachable_through_the_relay(self):
        import threading
        from http.server import BaseHTTPRequestHandler, HTTPServer

        seen = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                seen.append((self.path, self.headers.get("Authorization", "")))
                body = b"pong"
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        port = server.server_address[1]
        with override_settings(DANBYTE_INTERNAL_URL=f"http://127.0.0.1:{port}"):
            run = self._run(
                "import os, urllib.request\n"
                "for _ in range(3):\n"
                "    req = urllib.request.Request(os.environ['DANBYTE_URL'] + '/api/ping/',\n"
                "        headers={'Authorization': 'Token ' + os.environ['DANBYTE_TOKEN']})\n"
                "    print('API', urllib.request.urlopen(req, timeout=10).read().decode())\n"
            )
        self.assertEqual(run.status, "success", run.log)
        self.assertEqual(run.log.count("API pong"), 3, run.log)
        self.assertEqual(len(seen), 3)
        self.assertEqual(seen[0][0], "/api/ping/")
        self.assertTrue(seen[0][1].startswith("Token dbt_"))

    def test_the_sdk_works_inside(self):
        run = self._run("from danbyte_sdk import run\nrun.log('sdk ok ' + run.param('x'))\n",
                        params={"x": "1"})
        self.assertEqual(run.status, "success", run.log)
        self.assertIn("sdk ok 1", run.log)

    def test_a_landlock_the_launcher_cannot_apply_stops_the_script(self):
        real_wrap = sandbox.Confinement.wrap

        def bad_ruleset(conf, cmd, route, relay_fd):
            argv, fds = real_wrap(conf, cmd, route, relay_fd)
            at = argv.index(str(conf.ruleset_fd), argv.index("--"))
            argv[at] = "999"  # not a ruleset: landlock_restrict_self fails
            return argv, fds

        with mock.patch.object(sandbox.Confinement, "wrap", bad_ruleset):
            run = self._run("print('ran')\n")
        self.assertEqual(run.status, "failed", run.log)
        self.assertIn("could not be confined", run.log)
        self.assertNotIn("\nran", run.log)

    def test_timeout_kills_everything_in_the_sandbox(self):
        import uuid

        marker = f"bwrap-sleeper-{uuid.uuid4().hex}"
        source = (
            "import subprocess, sys, time\n"
            "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)', "
            f"{marker!r}])\n"
            "print('forked', flush=True)\n"
            "time.sleep(60)\n"
        )
        run = self._run(source, timeout_seconds=5)
        self.assertEqual(run.status, "timeout", run.log)
        self.assertIn("forked", run.log)
        survivors = []
        for pid in filter(str.isdigit, os.listdir("/proc")):
            try:
                with open(f"/proc/{pid}/cmdline", "rb") as fh:
                    if marker.encode() in fh.read():
                        survivors.append(pid)
            except OSError:
                continue
        self.assertEqual(survivors, [], "a process outlived the sandbox")
