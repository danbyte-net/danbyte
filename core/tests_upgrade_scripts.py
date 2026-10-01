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
STAGE_FILES = ("lib.sh", "stage.sh", "recover.sh", "dbtool.py", "STAGE_API", "legacy-resume.sh")
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
  restart) for u; do u="${u%.service}.service"; loaded "$u" && echo active >"$D/$u.active"; done ;;
  reset-failed) for u; do [ "$(cat "$D/$u.active" 2>/dev/null)" = failed ] && echo inactive >"$D/$u.active"; done ;;
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
  case "$1" in -o) out="$2"; shift 2 ;; -w) fmt="$2"; shift 2 ;; -H|-m|--resolve) shift 2 ;; -*) shift ;; *) url="$1"; shift ;; esac
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
  https://*/static/*)
    # nginx, as another user: every folder needs o+x and the file o+r
    d="$FAKE_APP/staticfiles"; rest="${url#*/static/}"
    if [ -n "${FAKE_STATIC_CODE:-}" ]; then code="$FAKE_STATIC_CODE"
    elif [ ! -f "$d/$rest" ]; then code=404
    else
      code=200
      while :; do
        [ -n "$(find "$d" -maxdepth 0 -perm -o=x)" ] || code=403
        case "$rest" in */*) d="$d/${rest%%/*}"; rest="${rest#*/}" ;; *) break ;; esac
      done
      [ -n "$(find "$d/$rest" -maxdepth 0 -perm -o=r)" ] || code=403
    fi ;;
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
      backup_now)
        cp .upgrade-status.json "$FAKE_ROOT/status-at-backup.json" 2>/dev/null
        [ -z "${FAKE_BACKUP_SLEEP:-}" ] || sleep "$FAKE_BACKUP_SLEEP"
        echo "11111111-2222-3333-4444-555555555555 /backups/pre.tar" ;;
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
      migrate)
        # --check: app/new.py stands for the release's migration files
        case " $* " in *" --check "*)
          [ -f app/new.py ] && [ "$(cat "$FAKE_ROOT/db.state")" != schema=v2 ] && exit 1
          exit 0 ;;
        esac
        [ -n "${FAKE_BRIDGE_RC:-}" ] || exit 0
        # core.upgrade_migrate.LegacyBridge: hand the restart over, stop, migrate
        r="$HOME/.danbyte-upgrade"
        mkdir -p "$r" && cp scripts/upgrade/legacy-resume.sh "$r/legacy-resume-T.sh"
        : >"$r/legacy-resume-T.units"
        for f in "$HOME/.config/systemd/user"/danbyte-*; do
          u=${f##*/}
          case "$u" in *.timer|danbyte-web.service|danbyte-ws.service|danbyte-frontend-prod.service|\
            danbyte-docs.service|danbyte-workers.service|danbyte-fastlane.service) ;; *) continue ;; esac
          if [ "$(cat "$FAKE_SD/$u.enabled" 2>/dev/null)" = enabled ] || [ "$(cat "$FAKE_SD/$u.active" 2>/dev/null)" = active ]; then
            echo "$u" >>"$r/legacy-resume-T.units"
          fi
          echo inactive >"$FAKE_SD/$u.active"
        done
        # what the overlay added, listed by the bridge's own code
        "$REAL_PY" -c 'import sys; sys.path.insert(0, sys.argv[1])
from pathlib import Path
from django.conf import settings
settings.configure(BASE_DIR=Path.cwd())
from core.upgrade_migrate import LegacyBridge
LegacyBridge().record_added(sys.argv[2])
' "$FAKE_REPO" "$r/legacy-resume-T.units"
        # the release it was for and who started it (no tick: a person)
        tag="v$(sed -n 's/^__version__ *= *"\(.*\)"/\1/p' danbyte/__init__.py)"
        echo "$tag" >"$r/legacy-resume-T.units.target"
        printf '{"trigger":"button","version_from":"0.16.13","version_to":"%s","kind":"bundle"}' \
          "$tag" >"$r/legacy-resume-T.units.report.json"
        case "$FAKE_BRIDGE_RC" in
          0) echo schema=v2 >"$FAKE_ROOT/db.state" ;;
          3) : >"$r/legacy-resume-T.units.db-unchanged" ;;
          *) echo schema=partial >"$FAKE_ROOT/db.state" ;;
        esac
        exit "$FAKE_BRIDGE_RC" ;;
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
            "FAKE_APP": str(self.app), "FAKE_REPO": str(REPO), "DANBYTE_UPGRADE_SETTLE": "0",
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

    def install(self, *, extra_units: dict | None = None, version: str = "0.17.0-dev1") -> None:
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
            self.write_tree(self.app, version)
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
        # Collected with the private media modes, as bundles 0.16.12 to 0.17.0-dev1 were.
        (top / "staticfiles" / "admin" / "css").mkdir(parents=True)
        (top / "staticfiles" / "admin" / "css" / "base.css").write_text("body {}\n")
        for p in (top / "staticfiles").rglob("*"):
            p.chmod(0o750 if p.is_dir() else 0o640)
        (top / "staticfiles").chmod(0o750)
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

    def stage(self, version: str, *, env: dict | None = None):
        """What install.sh does: the bundle's tree beside the app and its
        stage.sh run straight, with no launcher in front of it."""
        self.bundle(version)
        work = self.home / ".danbyte-upgrade" / f"20990101T000000Z-{version}"
        work.mkdir(parents=True)
        shutil.copytree(self.root / "bundle-src" / f"danbyte-{version}-linux-x86_64", work / "src",
                        symlinks=True)
        from_ = re.search(r'"(.*)"', (self.app / "danbyte" / "__init__.py").read_text()).group(1)
        return subprocess.run(
            ["/bin/sh", str(work / "src" / "scripts" / "upgrade" / "stage.sh"), "--kind", "bundle"],
            env={**self.env, "DANBYTE_UPGRADE_WORK": str(work), "DANBYTE_UPGRADE_SRC": str(work / "src"),
                 "DANBYTE_UPGRADE_VERSION": version, "DANBYTE_UPGRADE_FROM": from_,
                 "DANBYTE_UPGRADE_TRIGGER": "installer", **(env or {})},
            cwd=str(self.app), capture_output=True, text=True, timeout=180)

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
            r"^systemctl --user daemon-reload",
            r"^py -m pip install -q --no-index",
            r"^py manage.py check",
            r"^py dbtool snapshot ",
            r"^py manage.py upgrade_migrate$",
            r"^py manage.py collectstatic",
            r"^curl .*https://danbyte\.example\.test/static/admin/css/base\.css",
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
        # nginx reads the static files as another user.
        static = h.app / "staticfiles"
        self.assertEqual(static.stat().st_mode & 0o777, 0o755)
        self.assertEqual((static / "admin" / "css").stat().st_mode & 0o777, 0o755)
        self.assertEqual((static / "admin" / "css" / "base.css").stat().st_mode & 0o777, 0o644)
        self.assertFalse(any("static" in w for w in st["warnings"]), st["warnings"])
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
        # Nothing left behind, not even the empty scratch folder.
        self.assertFalse((h.home / ".danbyte-upgrade").exists())
        self.assertFalse((h.units / "danbyte-upgrade-recover.service").exists())
        self.assertFalse(Path(h.root / "danbyte-0.17.0-dev2-linux-x86_64.tar.gz").exists())
        self.assertTrue((h.app / ".upgrade.log").exists())
        self.assertEqual((h.root / "flag").read_text().strip(), "off")

    def test_version_comes_from_the_tree_not_the_file_name(self):
        h = self.host()
        r = h.upgrade(str(h.bundle(name=".upgrade-bundle.tar.gz")))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(h.status()["version_to"], "0.17.0-dev2")

    def test_static_files_nginx_cannot_read_are_a_warning_not_a_rollback(self):
        h = self.host()
        r = h.upgrade(env={"FAKE_STATIC_CODE": "403"})
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        st = h.status()
        self.assertEqual(st["outcome"]["code"], "new", st)
        self.assertTrue(any("HTTP 403 for /static/" in w for w in st["warnings"]), st["warnings"])

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

    def test_the_stage_refuses_a_downgrade_however_it_was_started(self):
        # install.sh runs the stage without a launcher; a pre-release is
        # older than the next one and than its final.
        for running, bundle in (("0.17.0-dev91", "0.17.0-dev90"), ("0.17.0", "0.17.0-dev91")):
            with self.subTest(running=running, bundle=bundle):
                h = self.host(version=running)
                r = h.stage(bundle)
                self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
                st = h.status()
                self.assertEqual(st["outcome"]["code"], "unchanged", st)
                self.assertIn(f"this release is {bundle} and the install runs {running} - "
                              "downgrades are not supported", st["error"])
                self.assertFalse(h.called(r"^systemctl --user stop"))
                self.assertFalse(h.called(r"^py manage.py backup_now"))
                self.assertEqual(h.snapshot(), h.before)
        # the next pre-release goes ahead
        h = self.host(version="0.17.0-dev90")
        r = h.stage("0.17.0-dev91")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual((h.status()["state"], h.status()["version_to"]), ("done", "0.17.0-dev91"))

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

    def test_a_recovery_timer_that_fired_during_the_upgrade_leaves_nothing_behind(self):
        # The timer runs every five minutes while an upgrade runs; each run
        # finds the stage alive and leaves its lock file.
        h = self.host()
        proc = h.upgrade(env={"FAKE_MIGRATE_SLEEP": "3"}, background=True)
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            works = list((h.home / ".danbyte-upgrade").glob("*/journal"))
            if works and "migrating=1" in works[0].read_text():
                break
            time.sleep(0.2)
        r = h.recover()
        self.assertIn("still running", r.stdout)
        self.assertTrue((h.home / ".danbyte-upgrade" / ".recover.lock").exists())
        out, _ = proc.communicate(timeout=120)
        self.assertEqual(proc.returncode, 0, out)
        self.assertEqual(h.status()["state"], "done")
        self.assertFalse((h.home / ".danbyte-upgrade").exists())

    def test_a_recovery_with_nothing_to_do_tidies_its_lock_away(self):
        h = self.host()
        self.assertEqual(h.upgrade().returncode, 0)
        kept = h.root / "recover-copy"
        shutil.copytree(REPO / "scripts" / "upgrade", kept)
        root = h.home / ".danbyte-upgrade"
        root.mkdir()
        (root / ".recover.lock").write_text("")
        env = {**h.env, "DANBYTE_UPGRADE_ROOT": str(root)}
        r = subprocess.run(["/bin/sh", str(kept / "recover.sh")], env=env, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("no unfinished upgrade", r.stdout)
        self.assertFalse(root.exists())
        # ...and one that finds no folder at all says so, without an error
        r = subprocess.run(["/bin/sh", str(kept / "recover.sh")], env=env, capture_output=True, text=True)
        self.assertEqual((r.returncode, r.stderr), (0, ""))
        self.assertIn("no unfinished upgrade", r.stdout)

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


class LauncherBackupTests(StageTestCase):
    def test_the_launchers_backup_is_the_stages_backup_step(self):
        # The bar does not go back when the stage takes over, and the step
        # list shows when the backup ran and how long it took.
        for kind in ("bundle", "git"):
            with self.subTest(kind):
                h = Host(self, kind)
                h.install()
                r = h.upgrade(env={"FAKE_BACKUP_SLEEP": "1"})
                self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
                during = json.loads((h.root / "status-at-backup.json").read_text())
                self.assertEqual((during["step"], during["pct"]), ("backup", 4))
                steps = {s["name"]: s for s in h.status()["steps"]}
                self.assertEqual(steps["backup"]["detail"], "11111111-2222-3333-4444-555555555555")
                self.assertGreaterEqual(steps["backup"]["ended"] - steps["backup"]["started"], 1)
                self.assertLessEqual(steps["backup"]["ended"], steps["preflight"]["started"])
                self.assertFalse((h.home / ".danbyte-upgrade").exists())


class UnitFileTests(SimpleTestCase):
    def test_a_stopped_frontend_is_not_a_failed_one(self):
        # Node exits with 143 on SIGTERM; every upgrade and restart stops it.
        # The stage's link-units and the older upgraders' install-services
        # both daemon-reload, so an install picks this up on its next upgrade.
        for name in ("danbyte-frontend-prod.service", "danbyte-frontend.service"):
            text = (REPO / "services" / name).read_text()
            service = text.split("[Service]", 1)[1].split("\n[", 1)[0]
            self.assertRegex(service, r"(?m)^SuccessExitStatus=143$", name)


class BundleOwnershipTests(SimpleTestCase):
    def test_the_guides_unpack_the_bundle_as_root(self):
        # install.sh warns when the bundle's files are not root's: whoever
        # owns them could change what root runs. Bundles are packed with root
        # as the owner, so tar run by root extracts root's files.
        self.assertRegex((REPO / "scripts" / "build-release.sh").read_text(),
                         r"tar -czf .*--owner=0 --group=0")
        for rel in ("docs/getting-started/upgrading.md", "docs/getting-started/installation.md",
                    "scripts/install.sh"):
            found = [line.strip().lstrip("#").strip() for line in (REPO / rel).read_text().splitlines()
                     if re.search(r"\btar -?x\w*f? danbyte-", line)]
            self.assertTrue(found, rel)
            for line in found:
                self.assertTrue(line.startswith("sudo tar "), f"{rel}: {line}")


class VersionOrderTests(SimpleTestCase):
    """lib.sh's ver_cmp, the order install.sh and the stage refuse a
    downgrade by: the app's own (core.version.compare_versions), in plain awk,
    with every awk a host may have - mawk on Debian and Ubuntu, gawk, busybox."""

    LIB = REPO / "scripts" / "upgrade" / "lib.sh"
    VERSIONS = ("0.17.0-dev90", "0.17.0-dev91", "0.17.0-beta.1", "0.17.0-rc1", "0.17.0", "v0.17.0",
                "0.17", "0.17.0.post1", "0.17.1-dev1", "0.16.13", "0.16.0-beta.1", "0.16.0-dev4",
                "0.9.17", "0.10.0", "0.17.0-dev2-5-gabc1234", "0.17.0-dirty", "1.0rc1.dev3", "1.0-1",
                "uploaded", "")

    def sh(self, script: str, *args: str, path: str | None = None, stdin: str = ""):
        env = {**os.environ, "PATH": f"{path}:{os.environ['PATH']}" if path else os.environ["PATH"]}
        return subprocess.run(["/bin/sh", "-c", f'. "$0"; {script}', str(self.LIB), *args], input=stdin,
                              env=env, capture_output=True, text=True, timeout=120)

    def awks(self) -> dict[str, str | None]:
        found: dict[str, str | None] = {"default": None}
        for name, argv in (("mawk", ("mawk",)), ("gawk", ("gawk",)), ("busybox", ("busybox", "awk"))):
            exe = shutil.which(argv[0])
            if exe and subprocess.run([exe, *argv[1:], "BEGIN {}"], capture_output=True).returncode == 0:
                d = Path(tempfile.mkdtemp())
                self.addCleanup(shutil.rmtree, d, ignore_errors=True)
                (d / "awk").write_text(f'#!/bin/sh\nexec {" ".join([exe, *argv[1:]])} "$@"\n')
                (d / "awk").chmod(0o755)
                found[name] = str(d)
        return found

    def test_releases_order_as_the_app_orders_them(self):
        from core.version import compare_versions

        pairs = [(a, b) for a in self.VERSIONS for b in self.VERSIONS]
        stdin = "".join(f"{a}|{b}\n" for a, b in pairs)
        for name, path in self.awks().items():
            with self.subTest(awk=name):
                r = self.sh('while IFS="|" read -r a b; do ver_cmp "$a" "$b"; done', path=path, stdin=stdin)
                got = r.stdout.split()
                self.assertEqual(len(got), len(pairs), r.stderr)
                wrong = [(a, b, g, compare_versions(a, b)) for (a, b), g in zip(pairs, got, strict=True)
                         if int(g) != compare_versions(a, b)]
                self.assertEqual(wrong, [])

    def test_a_pre_release_is_older_than_the_next_and_than_its_final(self):
        chain = ("0.16.13", "0.17.0-dev90", "0.17.0-dev91", "0.17.0-rc1", "0.17.0", "0.17.1-dev1")
        for older, newer in zip(chain, chain[1:], strict=False):
            self.assertEqual(self.sh('ver_cmp "$1" "$2"', older, newer).stdout.strip(), "-1")
            self.assertEqual(self.sh('ver_cmp "$1" "$2"', newer, older).stdout.strip(), "1")
            r = self.sh('downgrade_refused "$1" "$2"', older, newer)
            self.assertEqual(r.returncode, 0)
            self.assertIn(f"this release is {older} and the install runs {newer}", r.stdout)
            self.assertEqual(self.sh('downgrade_refused "$1" "$2"', newer, older).returncode, 1)
        for to, from_ in (("0.17.0", "0.17.0"), ("v0.17.0", "0.17.0"), ("0.17.0", "")):
            r = self.sh('downgrade_refused "$1" "$2"', to, from_)
            self.assertEqual((r.returncode, r.stdout), (1, ""), (to, from_))

    def test_install_sh_asks_the_bundles_stage_and_force_does_not_cover_it(self):
        text = (REPO / "scripts" / "install.sh").read_text()
        start = text.index("if /bin/sh -c '. \"$1\" && downgrade_refused")
        guard = text[start:text.index("\n  fi\n", start)]
        self.assertIn('"$BUNDLE/scripts/upgrade/lib.sh" "$ver" "$from"', guard)
        self.assertIn("downgrades are not supported", guard)
        self.assertNotIn("FORCE", guard)


OLD_RELEASE = "v0.16.13"


def _old_upgrader() -> str | None:
    r = subprocess.run(["git", "-C", str(REPO), "show", f"{OLD_RELEASE}:scripts/danbyte-upgrade-bundle.sh"],
                       capture_output=True, text=True)
    return r.stdout if r.returncode == 0 and r.stdout.startswith("#!") else None


class LegacyUpgraderTests(StageTestCase):
    """The first upgrade off 0.16: 0.16.13's own bundle upgrader runs this
    release's ``manage.py migrate``. The Python shim answers it the way the
    bridge does (hand the restart over, stop, migrate, and on a full
    rollback say so); legacy-resume.sh then runs for real on what that
    upgrader left behind."""

    def setUp(self):
        self.old = _old_upgrader()
        if self.old is None:
            self.skipTest(f"{OLD_RELEASE} is not in this checkout")

    def run_legacy(self, bridge_rc: str, *, upload: bool = False, git: bool = False):
        h = Host(self, "bundle")
        h.install(version="0.16.13")
        (h.app / "scripts" / "danbyte-upgrade-bundle.sh").write_text(self.old)
        if git:   # a checkout of 0.16.13 that takes an uploaded bundle
            _run(["git", "init", "-q", "-b", "main", str(h.app)], env=h.env)
            (h.app / ".git" / "info" / "exclude").write_text("__pycache__/\n")   # as the repo does
            _run(["git", "-C", str(h.app), "add", "-A"], env=h.env)
            _run(["git", "-C", str(h.app), "commit", "-qm", "0.16.13"], env=h.env)
        self.before = self.tree(h)
        bundle = h.bundle()
        if upload:   # where the Updates page puts an uploaded bundle
            bundle = shutil.move(bundle, h.app / ".upgrade-bundle.tar.gz")
        r = h.upgrade(str(bundle), env={"FAKE_BRIDGE_RC": bridge_rc})
        root = h.home / ".danbyte-upgrade"
        units = root / "legacy-resume-T.units"
        self.assertTrue(units.exists(), r.stdout + r.stderr)
        # a timer that fired between the old upgrader's overlay and the
        # bridge ran the new code on the old schema
        (h.sd / "danbyte-drift-dispatch.service.active").write_text("failed\n")
        # the upgrader has exited: its pid is gone
        resume = subprocess.run(["/bin/sh", str(root / "legacy-resume-T.sh"), str(h.app), str(units),
                                 "999999999", ""], env=h.env, capture_output=True, text=True,
                                timeout=120)
        return h, r, resume

    @staticmethod
    def tree(h: Host) -> set[str]:
        """The files an archive of the code holds (what the old upgrader's
        rollback archive leaves out, its own files and caches aside)."""
        skip = {".venv", "vendor", "media", ".git", "__pycache__"}
        out = set()
        for p in h.app.rglob("*"):
            rel = p.relative_to(h.app)
            if p.is_dir() or skip & set(rel.parts) or rel.parts[:2] == ("frontend", "node_modules") \
                    or rel.name.startswith(".upgrade"):
                continue
            out.add(str(rel))
        return out

    def version_on_disk(self, h: Host) -> str:
        return re.search(r'"(.*)"', (h.app / "danbyte" / "__init__.py").read_text()).group(1)

    def test_a_failed_upgrade_that_changed_no_data_starts_everything_again(self):
        h, r, resume = self.run_legacy("3", upload=True)
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertEqual(h.status()["state"], "failed")
        # 0.16.13's rollback put its code back and left the new files there
        self.assertEqual(self.version_on_disk(h), "0.16.13")
        self.assertEqual(h.db(), "schema=v1")
        self.assertEqual(resume.returncode, 0, resume.stdout + resume.stderr)
        self.assertIn("0.16.13 is back", resume.stdout)
        # the code is exactly the release that ran before, migrations and all
        self.assertRegex(resume.stdout, r"removed [1-9][0-9]* file\(s\) the failed release had added")
        self.assertNotIn("still fails", resume.stdout)
        self.assertFalse((h.app / "app" / "new.py").exists())
        self.assertEqual(self.tree(h), self.before)
        for unit in PROD_UNITS:
            self.assertEqual(h.state(f"{unit}.service")[1], "active", unit)
        for t in h.timers:
            if t != "danbyte-digest":
                self.assertEqual(h.state(f"{t}.timer")[1], "active", t)
        self.assertEqual(h.state("danbyte-digest.timer"), ("disabled", "inactive"))
        self.assertEqual(h.state("danbyte-drift-dispatch.service")[1], "inactive")
        # 0.16's auto-upgrade sees the failed release by its tag, not "uploaded";
        # the restored release reports nothing
        self.assertEqual(h.status()["version_to"], "v0.17.0-dev2")
        self.assertFalse(h.called(r"upgrade_report"))
        # nothing left: the restart's files, its folder, the uploaded bundle
        self.assertFalse((h.home / ".danbyte-upgrade").exists())
        self.assertFalse((h.app / ".upgrade-bundle.tar.gz").exists())

    def test_a_git_checkout_that_took_an_uploaded_bundle_is_left_as_it_was(self):
        # 0.16 offers the upload on a git checkout too; the files its rollback
        # leaves would stay as untracked ones, in the way of a later checkout
        h, r, resume = self.run_legacy("3", upload=True, git=True)
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertEqual(self.version_on_disk(h), "0.16.13")
        self.assertEqual(resume.returncode, 0, resume.stdout + resume.stderr)
        self.assertRegex(resume.stdout, r"removed [1-9][0-9]* file\(s\) the failed release had added")
        self.assertEqual(self.tree(h), self.before)
        git = subprocess.run(["git", "-C", str(h.app), "status", "--porcelain"], env=h.env,
                             capture_output=True, text=True, check=True)
        self.assertEqual(git.stdout, "")
        self.assertEqual(h.state("danbyte-dispatch.timer")[1], "active")

    def test_a_partly_applied_migration_starts_nothing_more(self):
        h, r, resume = self.run_legacy("4")
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertEqual(resume.returncode, 1, resume.stdout)
        self.assertIn("not starting anything", resume.stdout)
        self.assertEqual(h.state("danbyte-dispatch.timer")[1], "inactive")
        # the files stay for whoever finishes it, and the status says so
        self.assertTrue((h.app / "app" / "new.py").exists())
        st = h.status()
        self.assertIn("nothing the upgrade stopped was started again", st["error"])
        self.assertFalse((h.home / ".danbyte-upgrade").exists())

    def test_a_finished_upgrade_leaves_no_upgrade_folder(self):
        h, r, resume = self.run_legacy("0")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(h.status()["state"], "done")
        self.assertEqual(self.version_on_disk(h), "0.17.0-dev2")
        # its install-services reloads the units: the new unit files apply
        self.assertOrder(h, r"^make -C .* install-services", r"^systemctl --user daemon-reload")
        self.assertEqual(resume.returncode, 0, resume.stdout + resume.stderr)
        self.assertEqual(h.state("danbyte-dispatch.timer")[1], "active")
        # recorded for its report before anything the migrate stopped starts
        self.assertTrue(h.called(r"^py manage.py upgrade_report --merge-legacy "
                                 r".*/legacy-resume-T\.units\.report\.json$"))
        self.assertLess(resume.stdout.index("recorded the upgrade"), resume.stdout.index("starting:"))
        self.assertFalse((h.home / ".danbyte-upgrade").exists())
