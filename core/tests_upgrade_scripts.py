"""The upgrade launchers and stage, run for real against a fake host.

Every test builds a throwaway install - an app tree, a virtualenv, unit
links, a git origin or a release bundle - and runs the real
``scripts/danbyte-upgrade.sh`` / ``scripts/danbyte-upgrade-bundle.sh``, which
hand over to the real ``scripts/upgrade/stage.sh`` of the target tree. Only
the edges are fake, as shims first on PATH: ``systemctl`` (unit state in
files), ``curl`` (the health endpoint answers from that state and the
version on disk), ``npm``, ``uv`` and the Python interpreter, which logs
``manage.py`` and ``dbtool.py`` calls and keeps "the database" in a file.
Every shim appends to one call log, so the tests read the order of events.

No database and no real systemd: safe anywhere, fast enough for CI.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
import textwrap
import time
from pathlib import Path

from django.conf import settings
from django.test import SimpleTestCase

REPO = Path(settings.BASE_DIR)
STAGE_FILES = ("lib.sh", "stage.sh", "recover.sh", "dbtool.py", "STAGE_API")
PROD_UNITS = ("danbyte-web", "danbyte-ws", "danbyte-frontend-prod", "danbyte-docs",
              "danbyte-workers", "danbyte-fastlane")

SYSTEMCTL = r"""#!/bin/sh
D="$FAKE_SD"
U="$HOME/.config/systemd/user"
echo "systemctl $*" >>"$FAKE_CALLS"
[ "${1:-}" = --user ] && shift
cmd="$1"; shift
loaded() { [ -e "$U/$1" ] || [ -L "$U/$1" ]; }
case "$cmd" in
  show)
    prop=""; unit=""
    while [ $# -gt 0 ]; do
      case "$1" in -p) prop="$2"; shift 2 ;; --value) shift ;; *) unit="$1"; shift ;; esac
    done
    case "$prop" in
      LoadState) if loaded "$unit"; then echo loaded; else echo not-found; fi ;;
      ActiveState) cat "$D/$unit.active" 2>/dev/null || echo inactive ;;
      NRestarts)
        n=$(cat "$D/$unit.restarts" 2>/dev/null || echo 0)
        case " ${FAKE_CRASHLOOP:-} " in *" $unit "*) n=$((n + 1)); echo "$n" >"$D/$unit.restarts" ;; esac
        echo "$n" ;;
    esac ;;
  is-enabled)
    loaded "$1" || { echo not-found; exit 1; }
    s=$(cat "$D/$1.enabled" 2>/dev/null || echo linked); echo "$s"; [ "$s" = enabled ] ;;
  is-active)
    [ "$1" = -q ] && shift
    s=$(cat "$D/$1.active" 2>/dev/null || echo inactive); echo "$s"; [ "$s" = active ] ;;
  stop) for u; do echo inactive >"$D/$u.active"; done ;;
  start)
    for u; do
      [ "$u" = --no-block ] && continue
      case " ${FAKE_START_FAIL:-} " in *" $u "*) exit 1 ;; esac
      echo active >"$D/$u.active"
    done ;;
  enable|disable)
    now=0
    for u; do
      case "$u" in
        --now) now=1 ;;
        *) if [ "$cmd" = enable ]; then echo enabled >"$D/$u.enabled"; [ $now = 1 ] && echo active >"$D/$u.active"
           else echo disabled >"$D/$u.enabled"; [ $now = 1 ] && echo inactive >"$D/$u.active"; fi ;;
      esac
    done ;;
  list-unit-files)
    for f in "$U"/danbyte-*; do [ -e "$f" ] || [ -L "$f" ] || continue; echo "${f##*/} enabled"; done ;;
esac
exit 0
"""

CURL = r"""#!/bin/sh
echo "curl $*" >>"$FAKE_CALLS"
out=/dev/null; fmt=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in -o) out="$2"; shift 2 ;; -w) fmt="$2"; shift 2 ;; -H|-m) shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac
done
D="$FAKE_SD"
up() { [ "$(cat "$D/$1.active" 2>/dev/null)" = active ]; }
code=000; body=""
case "$url" in
  *:8000/api/health/*)
    if up danbyte-web.service || up danbyte-backend.service; then
      ver=$(sed -n 's/^__version__ *= *"\([^"]*\)".*/\1/p' "$FAKE_APP/danbyte/__init__.py")
      st=ok; [ "${FAKE_BAD_VERSION:-}" = "$ver" ] && st=degraded
      code=200; body="{\"status\":\"$st\",\"database\":true,\"version\":\"$ver\"}"
    fi ;;
  *:8000/admin/login/*) { up danbyte-web.service || up danbyte-backend.service; } && code=200 ;;
  *:3000/*) up danbyte-frontend-prod.service && code=200 ;;
  *:8002/*) up danbyte-ws.service && code=404 ;;
esac
[ "$out" != /dev/null ] && printf '%s' "$body" >"$out"
[ -n "$fmt" ] && printf '%s' "$code"
[ "$code" = 000 ] && exit 7
exit 0
"""

NPM = r"""#!/bin/sh
echo "npm $*" >>"$FAKE_CALLS"
case "$1" in
  ci) mkdir -p node_modules && echo new >node_modules/.marker ;;
  run) mkdir -p dist && echo new >dist/.marker ;;
esac
"""

UV = r"""#!/bin/sh
echo "uv $*" >>"$FAKE_CALLS"
py=""; last=""
for a; do [ "$last" = --python ] && py="$a"; last="$a"; done
case "$1 $2" in
  "venv "*) mkdir -p "$last/bin" && cp "$FAKE_ROOT/fakepy" "$last/bin/python" ;;
  "pip install") echo v2 >"$(dirname "$(dirname "$py")")/installed" ;;
esac
"""

FAKEPY = r"""#!/bin/sh
[ "${1:-}" = -c ] && exec "$REAL_PY" "$@"
log() { echo "py $*" >>"$FAKE_CALLS"; }
if [ "$1" = -m ]; then
  log "$@"
  case "$2" in
    pip) case " $* " in *" --dry-run "*) exit 0 ;; esac
         echo v2 >"$(cd "$(dirname "$0")/.." && pwd)/installed" ;;
  esac
  exit 0
fi
case "$1" in
  */dbtool.py)
    shift; log "dbtool $*"
    case "$1" in
      probe)
        echo "python=${FAKE_PYVER:-$("$REAL_PY" -c 'import sys;print("%d.%d" % sys.version_info[:2])')}"
        echo db_size=1000; echo "db_rollback=${FAKE_DB_ROLLBACK:-1}"; echo redis=1
        echo "pip_plugins=${FAKE_PLUGINS:-}"; echo superuser=1; echo mail=0 ;;
      wait-db)
        if [ -n "${FAKE_KILL_RECOVERY:-}" ]; then
          kill -9 "$(ps -o ppid= -p "$PPID" | tr -d ' ')"
          exit 1
        fi ;;
      snapshot) cp "$FAKE_ROOT/db.state" "$2" ;;
      restore)
        [ -n "${FAKE_RESTORE_FAIL:-}" ] && { echo "pg_restore: connection lost" >&2; exit 1; }
        cp "$2" "$FAKE_ROOT/db.state" ;;
    esac
    exit 0 ;;
  manage.py)
    shift
    if [ "$1" = bootstrap ]; then log "manage.py bootstrap su=[${DJANGO_SUPERUSER_USERNAME-unset}]"; else log "manage.py $*"; fi
    case "$1" in
      backup_now) echo "11111111-2222-3333-4444-555555555555 /backups/pre.tar" ;;
      check) exit "${FAKE_CHECK_RC:-0}" ;;
      upgrade_migrate)
        if [ "${2:-}" = --plan ]; then echo "pending: ${FAKE_PENDING:-1}"; echo "mode: atomic"; exit 0; fi
        if [ -n "${FAKE_KILL_STAGE:-}" ]; then
          echo "schema=partial" >"$FAKE_ROOT/db.state"
          kill -9 "$(sed -n 's/^PID=//p' "$HOME/.danbyte-upgrade/active")"
          exit 1
        fi
        if [ -n "${FAKE_MIGRATE_SLEEP:-}" ]; then echo "schema=partial" >"$FAKE_ROOT/db.state"; sleep "$FAKE_MIGRATE_SLEEP"; fi
        rc=${FAKE_MIGRATE_RC:-0}
        [ "$rc" = 3 ] || echo "schema=v2" >"$FAKE_ROOT/db.state"
        echo "mode: atomic"
        exit "$rc" ;;
      upgrade_verify) exit "${FAKE_VERIFY_RC:-0}" ;;
      upgrade_maintenance) echo "$2" >"$FAKE_ROOT/flag" ;;
    esac
    exit 0 ;;
esac
log "other $*"
exit 0
"""


def _run(argv, **kw):
    return subprocess.run(argv, check=True, capture_output=True, text=True, **kw)


class Host:
    """A fake install in a temp dir: tree, venv, units, shims."""

    def __init__(self, test, kind: str):
        self.test = test
        self.kind = kind
        self.root = Path(tempfile.mkdtemp(prefix="dbupg-"))
        test.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
        self.home = self.root / "home"
        self.app = self.home / "danbyte"
        self.units = self.home / ".config" / "systemd" / "user"
        self.sd = self.root / "sd"
        self.bin = self.root / "bin"
        self.calls = self.root / "calls.log"
        for d in (self.units, self.sd, self.bin):
            d.mkdir(parents=True)
        self.calls.write_text("")
        (self.root / "db.state").write_text("schema=v1\n")
        self.fakepy = self.root / "fakepy"
        self._exe(self.fakepy, FAKEPY)
        for name, body in (("systemctl", SYSTEMCTL), ("curl", CURL), ("npm", NPM), ("uv", UV)):
            self._exe(self.bin / name, body)
        self._exe(self.bin / "loginctl", "#!/bin/sh\necho yes\n")
        real_make = shutil.which("make")
        self._exe(self.bin / "make", f'#!/bin/sh\necho "make $*" >>"$FAKE_CALLS"\nexec {real_make} "$@"\n')
        self.env = {
            "PATH": f"{self.bin}:{os.environ.get('PATH', '/usr/bin:/bin')}",
            "HOME": str(self.home), "LANG": "C.UTF-8",
            "DANBYTE_DIR": str(self.app), "REAL_PY": sys.executable,
            "FAKE_SD": str(self.sd), "FAKE_CALLS": str(self.calls), "FAKE_ROOT": str(self.root),
            "FAKE_APP": str(self.app), "DANBYTE_UPGRADE_SETTLE": "0",
            "DANBYTE_UPGRADE_HEALTH_WAIT": "4", "DANBYTE_UPGRADE_FRONTEND_WAIT": "4",
            "DANBYTE_UPGRADE_ONESHOT_WAIT": "2", "DANBYTE_UPGRADE_TRIGGER": "button",
            "DANBYTE_UPGRADE_CGROUP": str(self.root / "cgroup"),
            "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.test",
            "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.test",
        }
        (self.root / "cgroup").write_text("0::/user.slice/user-1000.slice/session-1.scope\n")
        self.timers = re.search(r"^TIMERS\s*:=\s*(.*)$", (REPO / "Makefile").read_text(), re.M).group(1).split()

    @staticmethod
    def _exe(path: Path, body: str) -> None:
        path.write_text(body)
        path.chmod(0o755)

    # ── trees ────────────────────────────────────────────────────────────────
    def write_tree(self, dest: Path, version: str) -> None:
        """The source of a release: real Makefile, units and upgrade scripts."""
        v2 = version.endswith("dev2")
        (dest / "danbyte").mkdir(parents=True, exist_ok=True)
        (dest / "danbyte" / "__init__.py").write_text(f'__version__ = "{version}"\n')
        (dest / "manage.py").write_text("# fake\n")
        (dest / "requirements.txt").write_text("django\n")
        (dest / "app").mkdir(exist_ok=True)
        (dest / "app" / "a.py").write_text(f"VERSION = {version!r}\n")
        if v2:
            (dest / "app" / "new.py").write_text("NEW = 1\n")
        else:
            (dest / "app" / "old.py").write_text("OLD = 1\n")
        (dest / "frontend").mkdir(exist_ok=True)
        (dest / "frontend" / "package.json").write_text("{}\n")
        makefile = (REPO / "Makefile").read_text()
        shutil.copytree(REPO / "services", dest / "services", dirs_exist_ok=True)
        if v2:
            makefile = re.sub(r"^(TIMERS\s*:=.*)$", r"\1 danbyte-newtimer", makefile, count=1, flags=re.M)
            (dest / "services" / "danbyte-newtimer.service").write_text("[Service]\nType=oneshot\n")
            (dest / "services" / "danbyte-newtimer.timer").write_text("[Timer]\nOnCalendar=daily\n")
        (dest / "Makefile").write_text(makefile)
        (dest / "scripts" / "upgrade").mkdir(parents=True, exist_ok=True)
        for name in ("danbyte-upgrade.sh", "danbyte-upgrade-bundle.sh"):
            shutil.copy2(REPO / "scripts" / name, dest / "scripts" / name)
        for name in STAGE_FILES:
            shutil.copy2(REPO / "scripts" / "upgrade" / name, dest / "scripts" / "upgrade" / name)
        (dest / ".gitignore").write_text(textwrap.dedent("""\
            .venv/
            vendor/
            frontend/dist/
            frontend/node_modules/
            staticfiles/
            .env
            .upgrade*
            .release-files
            .danbyte-upgrade/
            """))

    def install(self, *, extra_units: dict | None = None) -> None:
        """The running release (dev1): tree, .env, venv, built frontend,
        linked and running units."""
        if self.kind == "git":
            origin = self.root / "origin.git"
            work = self.root / "authoring"
            _run(["git", "init", "-q", "-b", "main", str(work)], env=self.env)
            self.write_tree(work, "0.17.0-dev1")
            _run(["git", "-C", str(work), "add", "-A"], env=self.env)
            _run(["git", "-C", str(work), "commit", "-qm", "dev1"], env=self.env)
            _run(["git", "-C", str(work), "tag", "v0.17.0-dev1"], env=self.env)
            _run(["git", "clone", "-q", "--bare", str(work), str(origin)], env=self.env)
            _run(["git", "clone", "-q", str(origin), str(self.app)], env=self.env)
            _run(["git", "-C", str(work), "rm", "-q", "app/old.py"], env=self.env)
            self.write_tree(work, "0.17.0-dev2")
            _run(["git", "-C", str(work), "add", "-A"], env=self.env)
            _run(["git", "-C", str(work), "commit", "-qm", "dev2"], env=self.env)
            _run(["git", "-C", str(work), "tag", "v0.17.0-dev2"], env=self.env)
            _run(["git", "-C", str(work), "push", "-q", str(origin), "main", "--tags"], env=self.env)
        else:
            self.app.mkdir(parents=True)
            self.write_tree(self.app, "0.17.0-dev1")
            files = sorted("./" + str(p.relative_to(self.app)) for p in self.app.rglob("*")
                           if p.is_file())
            (self.app / ".release-files").write_text("\n".join(files) + "\n")
            (self.app / "vendor" / "python" / "bin").mkdir(parents=True)
            shutil.copy2(self.fakepy, self.app / "vendor" / "python" / "bin" / "python3")
            (self.app / "vendor" / "wheels").mkdir()
            (self.app / "vendor" / "wheels" / "old.whl").write_text("old\n")
        (self.app / ".env").write_text("ALLOWED_HOSTS=danbyte.example.test,127.0.0.1\n"
                                       "DJANGO_SECRET_KEY=x\n")
        (self.app / ".venv" / "bin").mkdir(parents=True)
        shutil.copy2(self.fakepy, self.app / ".venv" / "bin" / "python")
        (self.app / ".venv" / "installed").write_text("v1\n")
        for d in ("frontend/dist", "frontend/node_modules", "staticfiles"):
            (self.app / d).mkdir(parents=True, exist_ok=True)
            (self.app / d / ".marker").write_text("old\n")
        for unit in PROD_UNITS:
            self.link(f"{unit}.service", enabled=True, active=True)
        for t in self.timers:
            self.link(f"{t}.service", enabled=False, active=False)
            self.link(f"{t}.timer", enabled=True, active=True)
        # An admin switched the digest off; the upgrade must leave it off.
        self.set_state("danbyte-digest.timer", enabled=False, active=False)
        self.link("danbyte-infra.service", enabled=True, active=True)
        for unit, (enabled, active) in (extra_units or {}).items():
            self.link(unit, enabled=enabled, active=active)
        self.before = self.snapshot()

    def link(self, unit: str, *, enabled: bool, active: bool) -> None:
        target = self.app / "services" / unit
        (self.units / unit).symlink_to(target)
        self.set_state(unit, enabled=enabled, active=active)

    def set_state(self, unit: str, *, enabled: bool, active: bool) -> None:
        (self.sd / f"{unit}.enabled").write_text("enabled\n" if enabled else "disabled\n")
        (self.sd / f"{unit}.active").write_text("active\n" if active else "inactive\n")

    def state(self, unit: str) -> tuple[str, str]:
        def read(suffix):
            p = self.sd / f"{unit}.{suffix}"
            return p.read_text().strip() if p.exists() else ""
        return read("enabled"), read("active")

    def bundle(self, version: str = "0.17.0-dev2", name: str | None = None) -> Path:
        top = self.root / "bundle-src" / f"danbyte-{version}-linux-x86_64"
        self.write_tree(top, version)
        (top / "app" / "old.py").unlink(missing_ok=True)
        (top / "install.sh").write_text("#!/bin/sh\n")
        (top / "BUNDLE_INFO").write_text(f"danbyte {version}\nplatform: linux-{os.uname().machine}\n")
        (top / "vendor" / "python" / "bin").mkdir(parents=True)
        shutil.copy2(self.fakepy, top / "vendor" / "python" / "bin" / "python3")
        (top / "vendor" / "wheels").mkdir()
        (top / "vendor" / "wheels" / "new.whl").write_text("new\n")
        for d in ("frontend/dist", "frontend/node_modules", "staticfiles"):
            (top / d).mkdir(parents=True, exist_ok=True)
            (top / d / ".marker").write_text("new\n")
        path = self.root / (name or f"danbyte-{version}-linux-x86_64.tar.gz")
        with tarfile.open(path, "w:gz") as tar:
            tar.add(top, arcname=top.name)
        return path

    # ── running ──────────────────────────────────────────────────────────────
    def upgrade(self, *args: str, env: dict | None = None, background: bool = False):
        script = "danbyte-upgrade.sh" if self.kind == "git" else "danbyte-upgrade-bundle.sh"
        if not args:
            args = ("v0.17.0-dev2",) if self.kind == "git" else (str(self.bundle()),)
        argv = ["/bin/sh", str(self.app / "scripts" / script), *args]
        full_env = {**self.env, **(env or {})}
        if background:
            return subprocess.Popen(argv, env=full_env, cwd=str(self.app),
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        return subprocess.run(argv, env=full_env, cwd=str(self.app), capture_output=True,
                              text=True, timeout=180)

    def recover(self, *args: str, env: dict | None = None):
        script = self.home / ".danbyte-upgrade" / "recover" / "recover.sh"
        return subprocess.run(["/bin/sh", str(script), *args], env={**self.env, **(env or {})},
                              cwd=str(self.app), capture_output=True, text=True, timeout=120)

    def status(self) -> dict:
        return json.loads((self.app / ".upgrade-status.json").read_text())

    def calls_list(self) -> list[str]:
        return self.calls.read_text().splitlines()

    def first(self, pattern: str, after: int = -1) -> int:
        rx = re.compile(pattern)
        for i, line in enumerate(self.calls_list()):
            if i > after and rx.search(line):
                return i
        raise AssertionError(f"no call matches {pattern!r}:\n" + "\n".join(self.calls_list()))

    def called(self, pattern: str) -> bool:
        rx = re.compile(pattern)
        return any(rx.search(line) for line in self.calls_list())

    def db(self) -> str:
        return (self.root / "db.state").read_text().strip()

    def snapshot(self) -> str:
        """A hash of the app tree as an operator would see it (not .git)."""
        h = hashlib.sha256()
        skip = {".upgrade-status.json", ".upgrade.log", ".upgrade-status.json.tmp"}
        for p in sorted(self.app.rglob("*")):
            rel = p.relative_to(self.app)
            if rel.parts[0] == ".git" or p.name in skip or p.is_dir():
                continue
            h.update(str(rel).encode())
            h.update(os.readlink(p).encode() if p.is_symlink() else p.read_bytes())
        if self.kind == "git":
            h.update(subprocess.run(["git", "-C", str(self.app), "rev-parse", "HEAD"],
                                    capture_output=True, text=True).stdout.encode())
        return h.hexdigest()


class StageTestCase(SimpleTestCase):
    kind = "bundle"

    def host(self, **kw) -> Host:
        h = Host(self, self.kind)
        h.install(**kw)
        return h

    def assertOrder(self, h: Host, *patterns: str) -> None:
        last = -1
        for p in patterns:
            last = h.first(p, after=last)

    def assertRolledBack(self, h: Host, *, restored_db: bool) -> None:
        st = h.status()
        self.assertEqual(st["state"], "failed", st)
        self.assertEqual(st["outcome"]["code"], "restored", st)
        self.assertEqual(st["outcome"]["database"], "restored" if restored_db else "unchanged", st)
        self.assertIn("rolled back", st["error"])
        self.assertEqual(h.snapshot(), h.before, "the app tree is not what it was")
        self.assertEqual(h.db(), "schema=v1")
        self.assertEqual(h.called(r"^py dbtool restore "), restored_db)
        for unit in PROD_UNITS:
            self.assertEqual(h.state(f"{unit}.service"), ("enabled", "active"), unit)
        self.assertEqual(h.state("danbyte-dispatch.timer"), ("enabled", "active"))
        self.assertEqual(h.state("danbyte-digest.timer"), ("disabled", "inactive"))
        self.assertFalse((h.home / ".danbyte-upgrade" / "active").exists())
        self.assertFalse((h.units / "danbyte-upgrade-recover.service").exists())
        self.assertFalse((h.units / "danbyte-newtimer.timer").exists())


class BundleStageTests(StageTestCase):
    def test_upgrade_runs_in_order_and_hands_over_to_the_target(self):
        h = self.host()
        r = h.upgrade()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        st = h.status()
        self.assertEqual((st["state"], st["version_to"], st["version_from"]),
                         ("done", "0.17.0-dev2", "0.17.0-dev1"), st)
        self.assertEqual(st["outcome"], {"code": "new", "database": "migrated", "services": "running",
                                         "backup": "11111111-2222-3333-4444-555555555555"})
        self.assertEqual([s["name"] for s in st["steps"]],
                         ["preflight", "backup", "prepare", "quiesce", "swap", "deps", "check",
                          "snapshot", "migrate", "static", "verify", "start", "resume", "done"])
        self.assertOrder(
            h,
            r"^py manage.py backup_now",
            r"^systemctl --user stop .*danbyte-dispatch\.timer",
            r"^systemctl --user stop .*danbyte-workers\.service",
            r"^systemctl --user stop .*danbyte-web\.service",
            r"^make -s -C .* link-units",
            r"^py -m pip install -q --no-index",
            r"^py manage.py check",
            r"^py dbtool snapshot ",
            r"^py manage.py upgrade_migrate$",
            r"^py manage.py collectstatic",
            r"^py manage.py upgrade_verify",
            r"^py manage.py upgrade_maintenance on",
            r"^systemctl --user start .*danbyte-web\.service",
            r"^curl .*:8000/api/health/",
            r"^systemctl --user start .*danbyte-workers\.service",
            r"^py manage.py upgrade_maintenance off",
            r"^systemctl --user start .*danbyte-dispatch\.timer",
        )
        # The target's tree is in place, the old one's leftovers are not.
        self.assertEqual((h.app / "app" / "a.py").read_text(), "VERSION = '0.17.0-dev2'\n")
        self.assertTrue((h.app / "app" / "new.py").exists())
        self.assertFalse((h.app / "app" / "old.py").exists())
        self.assertFalse((h.app / "install.sh").exists())
        for d in ("frontend/dist", "frontend/node_modules", "staticfiles"):
            self.assertEqual((h.app / d / ".marker").read_text(), "new\n", d)
        self.assertTrue((h.app / "vendor" / "wheels" / "new.whl").exists())
        self.assertFalse((h.app / "vendor" / "wheels" / "old.whl").exists())
        self.assertIn("./app/new.py", (h.app / ".release-files").read_text())
        self.assertEqual((h.app / ".venv" / "installed").read_text(), "v2\n")
        self.assertEqual(h.db(), "schema=v2")
        # Units: what ran runs; the admin's choice stands; the release's new
        # timer is on; the upgrade's own and the infra units are never touched.
        for unit in PROD_UNITS:
            self.assertEqual(h.state(f"{unit}.service"), ("enabled", "active"), unit)
        self.assertEqual(h.state("danbyte-digest.timer"), ("disabled", "inactive"))
        self.assertEqual(h.state("danbyte-newtimer.timer"), ("enabled", "active"))
        self.assertFalse(h.called(r"stop .*danbyte-infra"))
        self.assertFalse(h.called(r"stop .*danbyte-upgrade\.service"))
        # New seeds, never a superuser.
        self.assertTrue(h.called(r"^py manage.py bootstrap su=\[\]$"))
        # Nothing left behind.
        self.assertEqual(list((h.home / ".danbyte-upgrade").iterdir()), [])
        self.assertFalse((h.units / "danbyte-upgrade-recover.service").exists())
        self.assertFalse(Path(h.root / "danbyte-0.17.0-dev2-linux-x86_64.tar.gz").exists())
        self.assertTrue((h.app / ".upgrade.log").exists())
        self.assertEqual((h.root / "flag").read_text().strip(), "off")

    def test_version_comes_from_the_tree_not_the_file_name(self):
        h = self.host()
        r = h.upgrade(str(h.bundle(name=".upgrade-bundle.tar.gz")))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(h.status()["version_to"], "0.17.0-dev2")

    def test_a_bundle_that_does_not_match_its_release_is_refused(self):
        h = self.host()
        r = h.upgrade(str(h.bundle()), "--version", "v0.17.0-dev3")
        self.assertEqual(r.returncode, 1)
        self.assertIn("contains 0.17.0-dev2", h.status()["error"])
        self.assertEqual(h.snapshot(), h.before)

    def test_a_downgrade_is_refused(self):
        h = self.host()
        r = h.upgrade(str(h.bundle(version="0.16.13")))
        self.assertEqual(r.returncode, 1)
        st = h.status()
        self.assertIn("downgrades are not supported", st["error"])
        self.assertIn("nothing was changed", st["error"])
        self.assertFalse(h.called(r"^systemctl --user stop"))

    def test_refuses_to_run_inside_an_app_unit(self):
        h = self.host()
        (h.root / "cgroup").write_text(
            "0::/user.slice/user-1000.slice/user@1000.service/app.slice/danbyte-web.service\n")
        r = h.upgrade()
        self.assertEqual(r.returncode, 1)
        st = h.status()
        self.assertEqual(st["outcome"]["code"], "unchanged", st)
        self.assertIn("danbyte-web.service", st["error"])
        self.assertFalse(h.called(r"^systemctl --user stop"))
        self.assertEqual(h.snapshot(), h.before)

    def test_failures_before_the_migration_put_everything_back(self):
        for fault in ("quiesce", "swap", "deps", "check"):
            with self.subTest(fault=fault):
                h = self.host()
                r = h.upgrade(env={"DANBYTE_UPGRADE_TEST": "1", "DANBYTE_UPGRADE_FAULT": fault})
                self.assertEqual(r.returncode, 1, r.stdout)
                self.assertRolledBack(h, restored_db=False)
                self.assertEqual(h.status()["step"], fault)
                # the bundle's new file is gone, the dropped one back
                self.assertFalse((h.app / "app" / "new.py").exists())
                self.assertTrue((h.app / "app" / "old.py").exists())

    def test_a_migration_that_rolled_back_needs_no_restore(self):
        h = self.host()
        r = h.upgrade(env={"FAKE_MIGRATE_RC": "3"})
        self.assertEqual(r.returncode, 1)
        self.assertRolledBack(h, restored_db=False)
        self.assertIn("rolled back in full", h.status()["error"])

    def test_failures_after_the_migration_restore_the_snapshot(self):
        cases = {
            "partial migrate": {"FAKE_MIGRATE_RC": "4"},
            "verify": {"FAKE_VERIFY_RC": "1"},
            "static": {"DANBYTE_UPGRADE_TEST": "1", "DANBYTE_UPGRADE_FAULT": "static"},
            "unhealthy": {"FAKE_BAD_VERSION": "0.17.0-dev2"},
            "crash loop": {"FAKE_CRASHLOOP": "danbyte-workers.service"},
        }
        for name, env in cases.items():
            with self.subTest(name):
                h = self.host()
                r = h.upgrade(env=env)
                self.assertEqual(r.returncode, 1, r.stdout)
                self.assertRolledBack(h, restored_db=True)
                self.assertOrder(h, r"^py dbtool snapshot ", r"^py manage.py upgrade_migrate$",
                                 r"^py dbtool restore .*snapshot\.dump")

    def test_a_failed_restore_leaves_danbyte_stopped_and_says_so(self):
        h = self.host()
        r = h.upgrade(env={"FAKE_VERIFY_RC": "1", "FAKE_RESTORE_FAIL": "1"})
        self.assertEqual(r.returncode, 1)
        st = h.status()
        self.assertEqual(st["outcome"]["code"], "restore_failed", st)
        self.assertEqual(st["outcome"]["services"], "stopped")
        self.assertIn("danbyte-admin upgrade recover", st["error"])
        for unit in PROD_UNITS:
            self.assertEqual(h.state(f"{unit}.service"), ("disabled", "inactive"), unit)
        # The journal and the recovery stay for the operator.
        self.assertTrue((h.home / ".danbyte-upgrade" / "active").exists())
        self.assertFalse(h.recover().returncode)          # the timer waits for a person
        self.assertEqual(h.state("danbyte-web.service"), ("disabled", "inactive"))
        # ...who retries once the database is reachable again.
        r = h.recover("--retry")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(h.db(), "schema=v1")
        self.assertEqual(h.state("danbyte-web.service")[0], "enabled")
        self.assertEqual(h.status()["outcome"]["code"], "restored")
        self.assertFalse((h.home / ".danbyte-upgrade" / "active").exists())

    def test_unattended_upgrade_needs_a_database_it_can_roll_back(self):
        h = self.host()
        r = h.upgrade(env={"FAKE_DB_ROLLBACK": "0", "DANBYTE_UPGRADE_TRIGGER": "auto"})
        self.assertEqual(r.returncode, 1)
        self.assertRolledBack(h, restored_db=False)
        self.assertFalse(h.called(r"^py manage.py upgrade_migrate$"))
        # a person may go ahead, warned
        h2 = self.host()
        r = h2.upgrade(env={"FAKE_DB_ROLLBACK": "0"})
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertTrue(any("cannot be rolled back" in w for w in h2.status()["warnings"]))

    def test_a_new_python_with_pip_plugins_is_refused(self):
        h = self.host()
        r = h.upgrade(env={"FAKE_PYVER": "3.12", "FAKE_PLUGINS": "acme_plugin"})
        self.assertEqual(r.returncode, 1)
        self.assertIn("acme_plugin", h.status()["error"])
        self.assertFalse(h.called(r"^systemctl --user stop"))

    def test_a_stray_dev_server_on_a_production_host_is_disabled(self):
        h = self.host(extra_units={"danbyte-backend.service": (True, True)})
        r = h.upgrade()
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertEqual(h.state("danbyte-backend.service"), ("disabled", "inactive"))
        self.assertTrue(any("danbyte-backend" in w for w in h.status()["warnings"]))
        self.assertFalse(h.called(r"^systemctl --user start .*danbyte-backend"))

    def test_an_unfinished_upgrade_blocks_the_next_one(self):
        h = self.host()
        marker = h.home / ".danbyte-upgrade" / "active"
        marker.parent.mkdir(parents=True)
        marker.write_text("WORK=/nonexistent\nPID=1\nSTART=0\n")
        r = h.upgrade()
        self.assertEqual(r.returncode, 1)
        self.assertIn("unfinished", h.status()["error"])
        self.assertTrue(marker.exists())

    def test_a_killed_upgrade_is_recovered_and_recovery_is_idempotent(self):
        h = self.host()
        r = h.upgrade(env={"FAKE_KILL_STAGE": "1"})
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(h.status()["state"], "running")
        self.assertTrue((h.home / ".danbyte-upgrade" / "active").exists())
        self.assertEqual(h.db(), "schema=partial")
        # The first recovery dies too, after putting the files back...
        r = h.recover(env={"FAKE_KILL_RECOVERY": "1"})
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(h.db(), "schema=partial")
        # ...and the next one finishes the job from the same journal.
        kept = h.root / "recover-copy"
        shutil.copytree(h.home / ".danbyte-upgrade" / "recover", kept)
        # (a child of the killed run may hold the lock for a moment - as the
        # timer would, try again)
        deadline = time.monotonic() + 20
        while True:
            r = h.recover()
            if "another recovery is running" not in r.stdout or time.monotonic() > deadline:
                break
            time.sleep(0.5)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertRolledBack(h, restored_db=True)
        self.assertTrue(h.called(r"^systemctl --user start --no-block"))
        again = subprocess.run(["/bin/sh", str(kept / "recover.sh")], capture_output=True, text=True,
                               env={**h.env, "DANBYTE_UPGRADE_ROOT": str(h.home / ".danbyte-upgrade")})
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertIn("no unfinished upgrade", again.stdout)
        self.assertEqual(h.snapshot(), h.before)

    def test_a_stop_during_the_migration_leaves_the_restore_to_recovery(self):
        h = self.host()
        proc = h.upgrade(env={"FAKE_MIGRATE_SLEEP": "30"}, background=True)
        journal = None
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            works = [p for p in (h.home / ".danbyte-upgrade").glob("*/journal")]
            if works and "migrating=1" in works[0].read_text():
                journal = works[0]
                break
            time.sleep(0.2)
        self.assertIsNotNone(journal, "the stage never reached the migration")
        time.sleep(0.5)
        os.kill(proc.pid, signal.SIGTERM)
        out, _ = proc.communicate(timeout=60)
        self.assertEqual(proc.returncode, 143, out)
        self.assertFalse(h.called(r"^py dbtool restore "))    # not under a stop timeout
        self.assertEqual(h.status()["step"], "recover")
        for unit in PROD_UNITS:
            self.assertEqual(h.state(f"{unit}.service")[1], "inactive", unit)
        r = h.recover()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertRolledBack(h, restored_db=True)


class GitStageTests(StageTestCase):
    kind = "git"

    def test_upgrade_builds_before_the_downtime_and_checks_out_the_tag(self):
        h = self.host()
        r = h.upgrade()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        st = h.status()
        self.assertEqual((st["state"], st["kind"], st["version_to"]), ("done", "git", "0.17.0-dev2"))
        self.assertOrder(
            h,
            r"^py manage.py backup_now",
            r"^npm ci",
            r"^npm run build",
            r"^uv pip install -q --python .*/depcheck/bin/python",
            r"^systemctl --user stop .*danbyte-web\.service",
            r"^uv pip install -q --python .*/danbyte/\.venv/bin/python",
            r"^py manage.py upgrade_migrate$",
            r"^systemctl --user start .*danbyte-web\.service",
        )
        head = subprocess.run(["git", "-C", str(h.app), "describe", "--tags"],
                              capture_output=True, text=True).stdout.strip()
        self.assertEqual(head, "v0.17.0-dev2")
        self.assertFalse((h.app / "app" / "old.py").exists())
        self.assertEqual((h.app / "frontend" / "dist" / ".marker").read_text(), "new\n")
        self.assertFalse((h.app / "staticfiles" / ".marker").exists())    # collected afresh
        self.assertEqual(subprocess.run(["git", "-C", str(h.app), "status", "--porcelain"],
                                        capture_output=True, text=True).stdout, "")

    def test_a_failure_goes_back_to_the_branch_it_was_on(self):
        for env in ({"DANBYTE_UPGRADE_TEST": "1", "DANBYTE_UPGRADE_FAULT": "deps"},
                    {"FAKE_VERIFY_RC": "1"}):
            with self.subTest(env=env):
                h = self.host()
                r = h.upgrade(env=env)
                self.assertEqual(r.returncode, 1, r.stdout)
                self.assertRolledBack(h, restored_db="FAKE_VERIFY_RC" in env)
                branch = subprocess.run(["git", "-C", str(h.app), "symbolic-ref", "--short", "HEAD"],
                                        capture_output=True, text=True).stdout.strip()
                self.assertEqual(branch, "main")
                self.assertEqual((h.app / ".venv" / "installed").read_text(), "v1\n")

    def test_refuses_a_working_branch(self):
        h = self.host()
        subprocess.run(["git", "-C", str(h.app), "checkout", "-qb", "feature"], check=True)
        r = h.upgrade()
        self.assertEqual(r.returncode, 1)
        self.assertIn("working branch 'feature'", h.status()["error"])
