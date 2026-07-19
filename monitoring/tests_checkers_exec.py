"""M20 — exec / script checker: exit-code mapping + safety gates."""
from __future__ import annotations

import asyncio
import os
import stat
import tempfile

from django.test import TestCase, override_settings

from .checkers import get_checker
from .checkers import CheckConfigError


def _make_plugin(dir_, name, exit_code, message="OK - all good"):
    path = os.path.join(dir_, name)
    with open(path, "w") as f:
        f.write(f"#!/bin/sh\necho '{message}'\nexit {exit_code}\n")
    os.chmod(path, os.stat(path).st_mode | stat.S_IEXEC | stat.S_IXGRP)
    return path


class ExecCheckerTests(TestCase):
    def setUp(self):
        self.checker = get_checker("exec")
        self.dir = tempfile.mkdtemp()

    def _run(self, params, target="10.0.0.1"):
        return asyncio.run(self.checker.run(target, params, {}, 5000))

    def test_disabled_by_default(self):
        # No MONITORING_EXEC_ENABLED → unknown, never executes.
        out = self._run({"command": "check_x"})
        self.assertEqual(out.status, "unknown")
        self.assertIn("disabled", out.detail["error"])

    def test_exit_code_maps_to_status(self):
        _make_plugin(self.dir, "ok", 0)
        _make_plugin(self.dir, "warn", 1)
        _make_plugin(self.dir, "crit", 2)
        _make_plugin(self.dir, "weird", 7)
        with override_settings(MONITORING_EXEC_ENABLED=True, MONITORING_PLUGIN_DIR=self.dir):
            self.assertEqual(self._run({"command": "ok"}).status, "up")
            self.assertEqual(self._run({"command": "warn"}).status, "degraded")
            self.assertEqual(self._run({"command": "crit"}).status, "down")
            self.assertEqual(self._run({"command": "weird"}).status, "unknown")

    def test_captures_message_and_exit_code(self):
        _make_plugin(self.dir, "ok", 0, message="OK - 12ms")
        with override_settings(MONITORING_EXEC_ENABLED=True, MONITORING_PLUGIN_DIR=self.dir):
            out = self._run({"command": "ok"})
        self.assertEqual(out.detail["exit_code"], 0)
        self.assertEqual(out.detail["message"], "OK - 12ms")

    def test_host_substitution(self):
        # A plugin that echoes its first arg; {host} must be the target IP.
        path = os.path.join(self.dir, "echohost")
        with open(path, "w") as f:
            f.write('#!/bin/sh\necho "host=$1"\nexit 0\n')
        os.chmod(path, 0o755)
        with override_settings(MONITORING_EXEC_ENABLED=True, MONITORING_PLUGIN_DIR=self.dir):
            out = self._run({"command": "echohost", "args": ["{host}"]}, target="192.0.2.9")
        self.assertEqual(out.detail["message"], "host=192.0.2.9")

    def test_path_traversal_rejected(self):
        with override_settings(MONITORING_EXEC_ENABLED=True, MONITORING_PLUGIN_DIR=self.dir):
            out = self._run({"command": "../bin/sh"})
        self.assertEqual(out.status, "unknown")

    def test_validate_rejects_path_in_command(self):
        with self.assertRaises(CheckConfigError):
            self.checker.validate_params({"command": "/usr/bin/uptime"})
        with self.assertRaises(CheckConfigError):
            self.checker.validate_params({})  # missing command

    def test_timeout_is_down(self):
        path = os.path.join(self.dir, "slow")
        with open(path, "w") as f:
            f.write("#!/bin/sh\nsleep 5\nexit 0\n")
        os.chmod(path, 0o755)
        with override_settings(MONITORING_EXEC_ENABLED=True, MONITORING_PLUGIN_DIR=self.dir):
            out = asyncio.run(self.checker.run("10.0.0.1", {"command": "slow"}, {}, 300))
        self.assertEqual(out.status, "down")
        self.assertIn("timeout", out.detail["error"])
