"""Script / exec checker — Nagios-plugin style.

Runs a **local plugin** on the worker host and maps its exit code to a status,
following the Nagios plugin convention:

    0 → OK        → up
    1 → WARNING   → degraded
    2 → CRITICAL  → down
    3 / other     → UNKNOWN  → unknown

The plugin's first stdout line is captured as the human message (Nagios plugins
print ``OK - …`` etc).

**Safety.** Running arbitrary commands from the web UI would be a remote-code-
execution footgun, so this checker is locked down:

* It is **disabled** unless ``settings.MONITORING_EXEC_ENABLED`` is true.
* The command must be a **bare plugin name** (no ``/`` or ``..``) resolved inside
  ``settings.MONITORING_PLUGIN_DIR`` — you can only run vetted plugins you've
  placed there, never arbitrary system binaries.
* Arguments are passed as a real argv list to ``create_subprocess_exec`` —
  **no shell**, so there is no shell-injection surface. ``{host}`` in any
  argument is replaced with the target IP as a single argv element.
"""
from __future__ import annotations

import asyncio
import os
import time

from django.conf import settings

from danbyte_checks.base import CheckConfigError, CheckOutcome, register

_EXIT_STATUS = {0: "up", 1: "degraded", 2: "down"}  # 3/other → unknown


def _plugin_path(command: str) -> str:
    """Resolve a plugin name within the configured plugin dir, or raise."""
    plugin_dir = getattr(settings, "MONITORING_PLUGIN_DIR", "") or ""
    if not plugin_dir:
        raise CheckConfigError("MONITORING_PLUGIN_DIR is not configured")
    if not command or "/" in command or "\\" in command or command.startswith("."):
        raise CheckConfigError("command must be a bare plugin name (no path)")
    path = os.path.join(plugin_dir, command)
    # Defence in depth: the resolved path must still live inside plugin_dir.
    real = os.path.realpath(path)
    if os.path.commonpath([real, os.path.realpath(plugin_dir)]) != os.path.realpath(
        plugin_dir
    ):
        raise CheckConfigError("command escapes the plugin directory")
    return real


@register
class ExecChecker:
    kind = "exec"

    def validate_params(self, params: dict) -> None:
        command = params.get("command")
        if not command:
            raise CheckConfigError("'command' (plugin name) is required")
        if "/" in command or "\\" in command or command.startswith("."):
            raise CheckConfigError("command must be a bare plugin name (no path)")
        args = params.get("args", [])
        if args and not isinstance(args, list):
            raise CheckConfigError("'args' must be a list of strings")

    async def run(
        self, target: str, params: dict, secret_params: dict, timeout_ms: int
    ) -> CheckOutcome:
        if not getattr(settings, "MONITORING_EXEC_ENABLED", False):
            return CheckOutcome.unknown("exec checks are disabled (MONITORING_EXEC_ENABLED)")
        try:
            path = _plugin_path(params.get("command", ""))
        except CheckConfigError as e:
            return CheckOutcome.unknown(str(e))

        argv = [path]
        for a in params.get("args", []) or []:
            argv.append(str(a).replace("{host}", target))

        timeout_s = max(timeout_ms / 1000, 0.2)
        started = time.monotonic()
        try:
            proc = await asyncio.create_subprocess_exec(
                *argv,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except (OSError, ValueError) as e:
            return CheckOutcome.unknown(f"could not run plugin: {e}")

        try:
            async with asyncio.timeout(timeout_s):
                stdout, stderr = await proc.communicate()
        except (asyncio.TimeoutError, TimeoutError):
            proc.kill()
            await proc.wait()
            return CheckOutcome("down", None, {"error": "plugin timeout", "command": params.get("command")})

        latency = (time.monotonic() - started) * 1000
        code = proc.returncode
        status = _EXIT_STATUS.get(code, "unknown")
        first_line = (stdout or b"").decode("utf-8", "replace").strip().splitlines()
        detail = {
            "command": params.get("command"),
            "exit_code": code,
            "message": first_line[0][:500] if first_line else "",
        }
        err = (stderr or b"").decode("utf-8", "replace").strip()
        if err:
            detail["stderr"] = err[:500]
        return CheckOutcome(status, latency, detail)
