"""The unit files in the repo carry nothing that belongs to one host, and the
app units' sandboxing drop-ins (#500) hold what a user manager can apply."""
from __future__ import annotations

import os
import re
import subprocess
import tempfile
from pathlib import Path

from django.test import SimpleTestCase

REPO = Path(__file__).resolve().parent.parent
UNITS = sorted((REPO / "services").glob("*")) + sorted((REPO / "deploy" / "systemd").glob("*"))
HARDENING = REPO / "services" / "hardening"
SCRIPT = REPO / "scripts" / "unit-hardening.sh"

# Loopback and the wildcard are the only addresses a shared unit may name.
ALLOWED_ADDRESSES = {"127.0.0.1", "0.0.0.0"}
SECRET_KEYS = re.compile(r"(?m)^\s*Environment=.*(PASSWORD|SECRET|TOKEN|API_KEY)\w*=")
HOST_KEYS = re.compile(r"(?m)^\s*Environment=.*(ALLOWED_HOSTS|CSRF_TRUSTED_ORIGINS)=")
ADDRESS = re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}\b")

# Units that get no drop-in, and why: development servers and the compose
# infra, never linked on a production host (Makefile DEV_ONLY_SERVICES).
DEV_ONLY = {"danbyte-backend", "danbyte-frontend", "danbyte-mockups", "danbyte-infra"}
# Units that write the code tree or start what does (the upgrade, the ACME
# renewal's certificate drop): the baseline only, never the filesystem lines.
CODE_WRITING = {"danbyte-auto-upgrade", "danbyte-acme-renew"}
# Directives that stop a user unit from starting on a host whose user
# namespaces have no capabilities (Ubuntu 24.04+: status 218/CAPABILITIES or
# 226/NAMESPACE, seen on systemd 259), or that systemd ignores in a user unit
# on every supported release (systemd.exec(5): "only available for system
# services") and would only flatter systemd-analyze.
BREAKS_IN_USER_MODE = {
    "PrivateDevices", "ProtectClock", "ProtectKernelLogs", "ProtectKernelModules",
    "CapabilityBoundingSet", "AmbientCapabilities", "PrivateUsers", "PrivatePIDs",
    "DynamicUser", "RootDirectory", "RootImage", "BindPaths", "BindReadOnlyPaths",
    "TemporaryFileSystem", "MountImages", "PrivateNetwork",
}
NO_OP_IN_USER_MODE = {"ProtectControlGroups", "ProtectProc", "ProcSubset"}
# Every app unit's drop-in carries these (services/hardening/base.conf).
BASELINE = {
    "NoNewPrivileges": "yes", "LockPersonality": "yes", "RestrictRealtime": "yes",
    "RestrictSUIDSGID": "yes", "SystemCallArchitectures": "native", "UMask": "0027",
}
FILESYSTEM = ("ProtectSystem", "PrivateTmp", "ReadWritePaths", "InaccessiblePaths")


def directives(path: Path) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith(("#", ";", "[")) or "=" not in line:
            continue
        key, value = line.split("=", 1)
        out.setdefault(key.strip(), []).append(value.strip())
    return out


def script_list(name: str) -> set[str]:
    m = re.search(rf'(?m)^{name}="([^"]*)"', SCRIPT.read_text())
    assert m, name
    return set(m.group(1).split())


def make_list(name: str) -> set[str]:
    m = re.search(rf"(?m)^{name}\s*:?=\s*(.*)$", (REPO / "Makefile").read_text())
    assert m, name
    return set(m.group(1).split())


class UnitFilesTests(SimpleTestCase):
    def test_no_credentials_hosts_or_addresses(self):
        self.assertTrue(UNITS)
        for path in UNITS:
            if not path.is_file():
                continue
            text = path.read_text()
            self.assertIsNone(SECRET_KEYS.search(text), f"{path.name}: a credential in a unit")
            self.assertIsNone(HOST_KEYS.search(text), f"{path.name}: hosts belong in .env")
            extra = set(ADDRESS.findall(text)) - ALLOWED_ADDRESSES
            self.assertEqual(extra, set(), f"{path.name}: an address in a unit")


class UnitHardeningTests(SimpleTestCase):
    """services/hardening/*.conf and scripts/unit-hardening.sh."""

    def confs(self) -> dict[str, dict[str, list[str]]]:
        found = {p.stem: directives(p) for p in sorted(HARDENING.glob("*.conf"))}
        self.assertEqual(set(found), {"base", "service", "workers"})
        return found

    def test_every_unit_is_classified(self):
        services = {p.stem for p in (REPO / "services").glob("*.service")}
        app = script_list("SERVICES") | make_list("TIMERS")
        self.assertEqual(services - app - DEV_ONLY, set(), "a unit with no hardening group")
        self.assertEqual(app - services, set(), "a hardening entry with no unit file")
        self.assertEqual(DEV_ONLY & app, set())
        self.assertTrue(make_list("PROD_SERVICES") - {"$(SHARED_SERVICES)"}
                        <= script_list("SERVICES"))
        self.assertTrue(make_list("SHARED_SERVICES") <= script_list("SERVICES"))
        self.assertEqual(script_list("CODE_UNITS"), CODE_WRITING)

    def test_every_drop_in_carries_the_baseline(self):
        for name, conf in self.confs().items():
            for key, value in BASELINE.items():
                self.assertEqual(conf.get(key), [value], f"{name}.conf: {key}")

    def test_nothing_that_breaks_or_does_nothing_in_a_user_unit(self):
        files = [*HARDENING.glob("*.conf"), *(REPO / "services").glob("*.service")]
        for path in files:
            found = set(directives(path))
            self.assertEqual(found & BREAKS_IN_USER_MODE, set(), f"{path.name}: breaks a user unit")
            self.assertEqual(found & NO_OP_IN_USER_MODE, set(), f"{path.name}: a no-op in a user unit")

    def test_the_unit_files_themselves_stay_unsandboxed(self):
        # The drop-ins carry it all, so an operator can override or remove
        # a group, and the code-writing units cannot pick it up by accident.
        for path in (REPO / "services").glob("*.service"):
            found = set(directives(path))
            self.assertEqual(found & (set(BASELINE) | set(FILESYSTEM) | {"SystemCallFilter",
                             "RestrictNamespaces", "RestrictAddressFamilies"}), set(), path.name)

    def test_baseline_has_no_namespace_or_filesystem_lines(self):
        base = self.confs()["base"]
        self.assertEqual(set(base), set(BASELINE))

    def test_bwrap_keeps_its_namespaces_and_mounts(self):
        confs = self.confs()
        self.assertNotIn("RestrictNamespaces", confs["workers"])
        calls = " ".join(confs["workers"]["SystemCallFilter"]).split()
        for needed in ("@system-service", "@mount", "@sandbox", "pivot_root", "sethostname"):
            self.assertIn(needed, calls)
        self.assertEqual(confs["service"]["RestrictNamespaces"], ["yes"])
        for name in ("service", "workers"):
            conf = confs[name]
            # A refused call fails with EPERM instead of killing the process.
            self.assertEqual(conf["SystemCallErrorNumber"], ["EPERM"])
            families = conf["RestrictAddressFamilies"][0].split()
            self.assertEqual(set(families), {"AF_UNIX", "AF_INET", "AF_INET6", "AF_NETLINK"})
            self.assertNotIn("~@resources", " ".join(conf["SystemCallFilter"]), "rlimits")
        self.assertEqual(confs["service"]["ProtectSystem"], ["strict"])
        # Any of these puts a user unit in systemd's user namespace, where
        # (Ubuntu 24.04+ AppArmor) bubblewrap cannot build its own.
        for key in ("ProtectSystem", "PrivateTmp", "ProtectHostname", "ProtectKernelTunables",
                    *FILESYSTEM):
            self.assertNotIn(key, confs["workers"])

    def test_code_writing_units_get_the_baseline(self):
        text = SCRIPT.read_text()
        self.assertIn('case " $CODE_UNITS " in *" $1 "*) echo base; return ;; esac', text)

    def test_gunicorn_control_socket_off(self):
        text = (REPO / "deploy" / "gunicorn.conf.py").read_text()
        self.assertIn("control_socket_disable = True", text)

    def test_script_is_posix_sh(self):
        subprocess.run(["sh", "-n", str(SCRIPT)], check=True)

    def paths(self, pathset: str, **env: str) -> str:
        base = {k: v for k, v in os.environ.items()
                if not k.startswith("DANBYTE_") and k != "HOME"}
        done = subprocess.run(["sh", str(SCRIPT), "paths", pathset], check=True,
                              capture_output=True, text=True, env={**base, **env})
        return done.stdout

    def test_paths_from_the_environment(self):
        with tempfile.TemporaryDirectory() as home:
            out = self.paths("data", HOME=home, DANBYTE_LOG_DIR="/var/log/danbyte",
                             DANBYTE_BACKUP_DIR="/srv/backups 100%",
                             DANBYTE_UNIT_WRITABLE_PATHS="/mnt/nas:/srv/extra")
        self.assertTrue(out.startswith("# Written by Danbyte's scripts/unit-hardening.sh"))
        for path in (f"{REPO}/media", f"{REPO}/plugins_local", "/var/log/danbyte",
                     "/srv/backups 100%%", "/mnt/nas", "/srv/extra"):
            self.assertIn(f'ReadWritePaths="-{path}"', out)
        self.assertNotIn("ReadOnlyPaths", out)
        self.assertNotIn(f'"-{REPO}"\n', out)

    def test_tree_paths_keep_the_code_read_only(self):
        out = self.paths("tree", HOME="/opt/danbyte")
        self.assertIn(f'ReadWritePaths="-{REPO}"', out)
        for code in ("manage.py", "core", "scripts", "services", "deploy", "Makefile"):
            self.assertIn(f'ReadOnlyPaths="-{REPO}/{code}"', out)
        for writable in ("media", ".upgrade-status.json"):
            self.assertNotIn(f'ReadOnlyPaths="-{REPO}/{writable}"', out)
        self.assertIn(f'ReadWritePaths="-{REPO}/deploy/nginx/certs"', out)
        # The certificate folder is writable inside the read-only deploy/.
        self.assertLess(out.index(f'ReadOnlyPaths="-{REPO}/deploy"'),
                        out.index(f'ReadWritePaths="-{REPO}/deploy/nginx/certs"'))
        self.assertIn("InaccessiblePaths=-/root", out)

    def test_ui_and_logs_paths_are_narrow(self):
        out = self.paths("logs", HOME="/opt/danbyte", DANBYTE_LOG_DIR="/var/log/danbyte")
        self.assertEqual([ln for ln in out.splitlines() if ln.startswith("ReadWritePaths")],
                         ['ReadWritePaths="-/var/log/danbyte"'])
        out = self.paths("frontend", HOME="/opt/danbyte")
        self.assertIn(f'ReadWritePaths="-{REPO}/frontend/node_modules/.vite-temp"', out)
        self.assertNotIn("/media", out)
        out = self.paths("docs", HOME="/opt/danbyte")
        self.assertNotIn("/media", out)
        self.assertIn(f'ReadWritePaths="-{REPO}/site"', out)

    def test_home_under_home_is_not_hidden(self):
        out = self.paths("data", HOME="/home/someone")
        self.assertNotIn("InaccessiblePaths", out)
