"""Migrate, verify and hold the site for an upgrade.

The upgrade stage (``scripts/upgrade/stage.sh``) runs these through
``manage.py upgrade_migrate`` and ``manage.py upgrade_verify`` with every
Danbyte process stopped:

* :func:`run_migrate` applies every pending migration in **one**
  transaction when all of them allow it, so a failure leaves the database
  exactly as it was and the stage only has to put the old code back. Django
  commits after each migration; inside one transaction the deferred
  foreign-key checks would pile up across migrations instead (and a later
  ``ALTER TABLE`` on such a table fails with "pending trigger events"), so
  the ``migrate`` command flushes them at every migration boundary while
  :func:`flushing` is on - the same checks, at the same points, as a run that
  commits in between.
* :func:`verify` proves the new code works on the migrated database before
  any service starts: nothing pending, nothing unknown applied, every table
  readable through its model, and a few list endpoints answering.
"""
from __future__ import annotations

import contextlib
import os
import re
from dataclasses import dataclass, field

from django.core.management import call_command
from django.db import DEFAULT_DB_ALIAS, connections, transaction

#: Errors of running everything in one transaction rather than of the
#: migrations themselves: pending trigger events (55006), out of lock slots
#: (53200, max_locks_per_transaction) and program limits (54000). The
#: transaction rolled back, so a plain run is tried once.
RETRY_SQLSTATES = {"55006", "53200", "54000"}

EXIT_OK = 0
#: The migration failed and the database is as it was before it.
EXIT_UNCHANGED = 3
#: The migration failed and may have applied part of the plan.
EXIT_PARTIAL = 4

_flush_alias: str | None = None


def flushing() -> str | None:
    """The alias whose deferred constraints are checked at each migration
    boundary, while :func:`run_migrate` holds one transaction."""
    return _flush_alias


@contextlib.contextmanager
def _flush_at_boundaries(alias: str):
    global _flush_alias
    _flush_alias = alias
    try:
        yield
    finally:
        _flush_alias = None


def flush_deferred(alias: str) -> None:
    """Check the deferred constraints now, then defer again: what a commit
    between two migrations would have checked."""
    with connections[alias].cursor() as cur:
        cur.execute("SET CONSTRAINTS ALL IMMEDIATE")
        cur.execute("SET CONSTRAINTS ALL DEFERRED")


def pending_plan(alias: str = DEFAULT_DB_ALIAS) -> list:
    """The migrations ``migrate`` would apply, in order."""
    from django.db.migrations.executor import MigrationExecutor

    executor = MigrationExecutor(connections[alias])
    targets = executor.loader.graph.leaf_nodes()
    return [m for m, backwards in executor.migration_plan(targets) if not backwards]


def atomic_allowed(plan: list, alias: str = DEFAULT_DB_ALIAS) -> tuple[bool, str]:
    """Can the whole plan run in one transaction, and if not, why not."""
    if (os.environ.get("DANBYTE_UPGRADE_ATOMIC_MIGRATE") or "1").strip() == "0":
        return False, "DANBYTE_UPGRADE_ATOMIC_MIGRATE=0"
    if not connections[alias].features.can_rollback_ddl:
        return False, "the database cannot roll back schema changes"
    loose = [f"{m.app_label}.{m.name}" for m in plan if not getattr(m, "atomic", True)]
    if loose:
        return False, f"non-atomic migration {loose[0]}"
    return True, ""


def sqlstate(exc: BaseException | None) -> str | None:
    """The PostgreSQL SQLSTATE behind a (wrapped) database error."""
    seen: set[int] = set()
    while exc is not None and id(exc) not in seen:
        seen.add(id(exc))
        code = getattr(exc, "sqlstate", None) or getattr(exc, "pgcode", None)
        if code:
            return str(code)
        exc = exc.__cause__ or exc.__context__
    return None


@dataclass
class MigrateResult:
    code: int
    #: "none" (nothing pending), "atomic", "plain" or "retried" (the one
    #: transaction hit a limit and the plan ran migration by migration).
    mode: str
    planned: int
    error: str = ""
    notes: list[str] = field(default_factory=list)


def _migrate(alias: str, verbosity: int, stdout) -> None:
    call_command("migrate", database=alias, interactive=False, verbosity=verbosity,
                 stdout=stdout)


def run_migrate(*, alias: str = DEFAULT_DB_ALIAS, atomic: bool = True, verbosity: int = 1,
                stdout=None) -> MigrateResult:
    plan = pending_plan(alias)
    if not plan:
        return MigrateResult(EXIT_OK, "none", 0)
    notes: list[str] = []
    allowed, why = atomic_allowed(plan, alias)
    mode = "plain"
    if atomic and allowed:
        try:
            with transaction.atomic(using=alias), _flush_at_boundaries(alias):
                _migrate(alias, verbosity, stdout)
            return MigrateResult(EXIT_OK, "atomic", len(plan))
        except Exception as exc:  # noqa: BLE001 - reported through the exit code
            code = sqlstate(exc)
            if code not in RETRY_SQLSTATES:
                return MigrateResult(EXIT_UNCHANGED, "atomic", len(plan),
                                     error=f"{type(exc).__name__}: {exc}")
            notes.append(f"one transaction failed with SQLSTATE {code}; the database "
                         "was rolled back and the migrations run one by one")
            mode = "retried"
    elif atomic:
        notes.append(f"one transaction is not possible: {why}")
    try:
        _migrate(alias, verbosity, stdout)
    except Exception as exc:  # noqa: BLE001
        return MigrateResult(EXIT_PARTIAL, mode, len(plan),
                             error=f"{type(exc).__name__}: {exc}", notes=notes)
    return MigrateResult(EXIT_OK, mode, len(plan), notes=notes)


# ─── verify ──────────────────────────────────────────────────────────────────

#: List endpoints the verify step calls in-process. A 5xx or an exception
#: fails the upgrade; a 4xx (no tenant, no access) does not.
VERIFY_ENDPOINTS = (
    "/api/ips/",
    "/api/prefixes/",
    "/api/devices/",
    "/api/monitoring/assignments/",
)


def _probe_host() -> str:
    from django.conf import settings

    for host in settings.ALLOWED_HOSTS:
        host = (host or "").strip()
        if host and host != "*":
            return host.lstrip(".")
    return "localhost"


def _check_models(alias: str) -> list[str]:
    """Read one row of every table through its model: a column the model
    expects and the database lacks fails here, not on a user's request."""
    from django.apps import apps

    problems = []
    for model in apps.get_models():
        opts = model._meta
        if not opts.managed or opts.proxy or opts.swapped:
            continue
        try:
            with transaction.atomic(using=alias):
                list(model._base_manager.using(alias).all()[:1])
        except Exception as exc:  # noqa: BLE001
            problems.append(f"{opts.label}: {type(exc).__name__}: {str(exc).strip()[:200]}")
    return problems


def _check_endpoints() -> tuple[list[str], list[str]]:
    from importlib import import_module

    from django.conf import settings
    from django.contrib.auth import get_user_model
    from django.test import RequestFactory
    from django.urls import resolve
    from rest_framework.test import force_authenticate

    user = get_user_model().objects.filter(is_superuser=True, is_active=True).order_by("pk").first()
    if user is None:
        return [], ["no active superuser - the endpoint checks were skipped"]
    factory = RequestFactory(HTTP_HOST=_probe_host())
    session_store = import_module(settings.SESSION_ENGINE).SessionStore
    problems, notes = [], []
    for path in VERIFY_ENDPOINTS:
        try:
            match = resolve(path)
        except Exception:  # noqa: BLE001 - an endpoint a later release renamed
            notes.append(f"{path} is not routed - skipped")
            continue
        request = factory.get(path, {"page_size": 5}, secure=True)
        request.session = session_store()
        request.user = user
        force_authenticate(request, user=user)
        try:
            response = match.func(request, *match.args, **match.kwargs)
            if hasattr(response, "render"):
                response.render()
        except Exception as exc:  # noqa: BLE001
            problems.append(f"GET {path}: {type(exc).__name__}: {str(exc).strip()[:200]}")
            continue
        if response.status_code >= 500:
            problems.append(f"GET {path}: HTTP {response.status_code}")
        elif response.status_code >= 400:
            notes.append(f"GET {path}: HTTP {response.status_code} (not counted)")
    return problems, notes


def verify(alias: str = DEFAULT_DB_ALIAS) -> tuple[list[str], list[str]]:
    """``(problems, notes)``: an empty problem list means the code on disk
    runs on this database."""
    from . import version

    version._pending_cache = None
    version._drift_cache = None
    problems: list[str] = []
    pending = [f"{m.app_label}.{m.name}" for m in pending_plan(alias)]
    if pending:
        problems.append(f"{len(pending)} migration(s) not applied: {', '.join(pending[:5])}")
    drift = version.migration_drift()
    if drift:
        problems.append(f"{len(drift)} applied migration(s) this code does not ship: "
                        f"{', '.join(drift[:5])}")
    problems += _check_models(alias)
    endpoint_problems, notes = _check_endpoints()
    return problems + endpoint_problems, notes


# ─── legacy bridge ───────────────────────────────────────────────────────────

#: Units the bridge stops, in stop order after the timers. The same list as
#: scripts/upgrade/lib.sh; never the upgrade's own units, the compose infra
#: or the mockups.
BRIDGE_WORK_UNITS = ("danbyte-workers", "danbyte-fastlane")
BRIDGE_WEB_UNITS = ("danbyte-web", "danbyte-ws", "danbyte-backend", "danbyte-frontend-prod",
                    "danbyte-frontend", "danbyte-docs")
BRIDGE_DEV_UNITS = ("danbyte-backend", "danbyte-frontend")
BRIDGE_STATUS_AGE = 600
#: Beside the resume unit's list of units: the migration failed and the
#: database is as it was, so the previous release may start again on it.
UNCHANGED_SUFFIX = ".db-unchanged"
#: Beside the resume unit's list of units: the files the old upgrader's
#: overlay added (in the tree, not in its rollback archive), which the
#: resume removes when that upgrader rolled the code back.
ADDED_SUFFIX = ".added"
#: How old an old bundle upgrader's rollback archive may be to belong to
#: this run: it writes it just before the overlay, minutes before migrating.
BRIDGE_ARCHIVE_AGE = 3600
#: Never listed as added: the trees that archive leaves out, the upgrade's
#: own folder and bytecode caches.
_NOT_ARCHIVED = {".venv", "vendor", "frontend/node_modules", "media", ".git", ".danbyte-upgrade"}
#: Beside the resume unit's list of units: the release tag this upgrade was
#: asked for. 0.16's bundle upgrader writes every bundle as "uploaded", and
#: 0.16's auto-upgrade stops retrying a failed release only when the failed
#: status names its tag: the resume writes it in.
TARGET_SUFFIX = ".target"
#: Beside the resume unit's list of units: who started this upgrade, when,
#: and from and to what - the fields the stage writes in its status and an
#: old upgrader never does. The resume merges them into a finished upgrade's
#: status (``manage.py upgrade_report --merge-legacy``), so it is reported.
REPORT_SUFFIX = ".report.json"
_TAG = re.compile(r"[A-Za-z0-9][A-Za-z0-9._+-]{0,63}")


def _read_json(path) -> dict:
    import json

    try:
        with open(path) as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _when(value):
    import datetime

    try:
        return datetime.datetime.fromtimestamp(float(value), tz=datetime.UTC)
    except (TypeError, ValueError, OverflowError, OSError):
        return None


def asked_for(acquired_at) -> str | None:
    """The release tag an old auto-upgrade tick started this upgrade for: the
    one its ``auto-upgrade`` run names, that run being open when the upgrade
    lock was taken. None when no tick started it (a button, an upload)."""
    from core.models import ScheduledRun

    when = _when(acquired_at)
    if when is None:
        return None
    # Only columns 0.16 has: this runs before the migration.
    detail = (ScheduledRun.objects
              .filter(name="auto-upgrade", detail__has_key="upgrading",
                      started_at__lte=when, finished_at__gte=when)
              .order_by("-started_at").values_list("detail", flat=True).first())
    tag = detail.get("upgrading") if isinstance(detail, dict) else None
    return tag if isinstance(tag, str) and _TAG.fullmatch(tag) else None


def pre_upgrade_backup(since) -> str:
    """The id of the pre-upgrade backup the old upgrader took after ``since``
    (the lock's time), or ""."""
    from backups.models import Backup

    when = _when(since)
    if when is None:
        return ""
    found = (Backup.objects.filter(kind="pre_upgrade", created_at__gte=when)
             .order_by("-created_at").values_list("id", flat=True).first())
    return str(found or "")


def version_at(base, rev: str) -> str | None:
    """``__version__`` of a git revision of ``base`` (an old git upgrader
    records the commit it came from)."""
    import subprocess

    if not re.fullmatch(r"[0-9a-f]{7,40}", rev or ""):
        return None
    try:
        r = subprocess.run(["git", "-C", str(base), "show", f"{rev}:danbyte/__init__.py"],
                           capture_output=True, text=True, timeout=15)
    except (OSError, subprocess.SubprocessError):
        return None
    m = re.search(r"""^__version__\s*=\s*["']([^"']+)["']""", r.stdout, re.M)
    return m.group(1) if r.returncode == 0 and m else None


def rollback_archive(dirs, now: float | None = None):
    """The newest ``code-pre-*.tgz`` in ``dirs`` - the rollback archive an
    old bundle upgrader writes before its overlay - or None when there is
    none from the last :data:`BRIDGE_ARCHIVE_AGE` seconds."""
    import time
    from pathlib import Path

    now = time.time() if now is None else now
    found = []
    for d in dict.fromkeys(str(d) for d in dirs if d):
        try:
            found += [(p.stat().st_mtime, p) for p in Path(d).glob("code-pre-*.tgz")]
        except OSError:
            continue
    if not found:
        return None
    mtime, newest = max(found)
    return newest if 0 <= now - mtime < BRIDGE_ARCHIVE_AGE else None


def files_added(base, archive) -> tuple[list[str], int]:
    """Files under ``base`` that ``archive`` (an old bundle upgrader's
    ``tar -C base -czf``, written just before its overlay) does not hold:
    what the overlay put there. Only files older than the archive count -
    the overlay keeps the release's own timestamps, while a file a running
    process wrote since is newer and is left alone. Returns the paths,
    relative to ``base``, and how many newer ones were left out."""
    import stat
    import tarfile

    with tarfile.open(archive, "r:gz") as tar:
        old = {os.path.normpath(m.name) for m in tar}
    cutoff = os.stat(archive).st_mtime
    added: list[str] = []
    newer = 0
    for dirpath, dirnames, filenames in os.walk(base):
        rel_dir = os.path.relpath(dirpath, base)
        dirnames[:] = [d for d in dirnames if d != "__pycache__"
                       and os.path.normpath(os.path.join(rel_dir, d)) not in _NOT_ARCHIVED]
        for name in filenames:
            rel = os.path.normpath(os.path.join(rel_dir, name))
            if rel in old or rel.startswith(".upgrade") or rel == ".maintenance" \
                    or "\n" in rel or "\r" in rel:
                continue
            try:
                st = os.lstat(os.path.join(dirpath, name))
            except OSError:
                continue
            if not (stat.S_ISREG(st.st_mode) or stat.S_ISLNK(st.st_mode)):
                continue
            if st.st_mtime >= cutoff:
                newer += 1
                continue
            added.append(rel)
    return sorted(added), newer


def open_static(root) -> int:
    """``chmod -R u=rwX,go=rX`` on the collected static files, which nginx
    reads from disk as another user. collectstatic skips files that did not
    change, so copies an earlier release wrote with the private media modes
    stay closed without this. Links are left alone. Returns how many entries
    could not be changed."""
    import stat

    failed = 0

    def fix(path: str, is_dir: bool) -> None:
        nonlocal failed
        try:
            st = os.lstat(path)
            if stat.S_ISLNK(st.st_mode):
                return
            mode = stat.S_IMODE(st.st_mode)
            want = 0o755 if is_dir or mode & 0o111 else 0o644
            if mode != want:
                os.chmod(path, want)
        except OSError:
            failed += 1

    if not root or not os.path.isdir(root):
        return 0
    fix(str(root), True)
    for dirpath, dirnames, filenames in os.walk(root):
        for name in dirnames:
            fix(os.path.join(dirpath, name), True)
        for name in filenames:
            fix(os.path.join(dirpath, name), False)
    return failed


class LegacyBridge:
    """``manage.py migrate`` run by an upgrader from before the upgrade stage
    (0.16.x, 0.17.0-dev1), which put the new code in place and then migrates
    with every service still running.

    Before migrating it stops the timers, the workers and everything that
    serves - new code must not run on the old schema, nor old code on the new
    one - and hands the restart of all of it to a transient unit
    (``scripts/upgrade/legacy-resume.sh``, copied out of the tree) that starts
    them once that upgrader has exited, whether it succeeded or rolled back,
    with the list of files this release added for it to remove after a
    rollback, and what that upgrader's status lacks: the release tag it was
    asked for and who started it (for the report). Then it migrates all or
    nothing, so the old upgrader's rollback never lands on a half-migrated
    database (and says so to that unit), and collects static files, which
    the old git upgrader never did, readable for the web server.

    It steps in only for exactly that call: ``manage.py migrate`` with no
    app, plan or check, from the app directory, while the status file says
    an upgrade is at its migrate step - never for tests, a restore, the plugin
    apply or a person migrating by hand, and never under the new stage."""

    def __init__(self, stdout=None):
        import sys

        self.stdout = stdout or sys.stdout
        #: The resume unit's list of units, once it is arranged.
        self.units_file = None

    # detection
    @staticmethod
    def applies(options: dict, argv: list[str] | None = None) -> bool:
        import json
        import sys
        import time
        from pathlib import Path

        from django.conf import settings

        argv = sys.argv if argv is None else argv
        if os.environ.get("DANBYTE_UPGRADE_STAGE") or getattr(settings, "TESTING", False):
            return False
        if argv[1:2] != ["migrate"]:
            return False
        if options.get("app_label") or options.get("migration_name") or options.get("plan") \
                or options.get("check_unapplied") or options.get("fake") \
                or options.get("fake_initial") or options.get("prune"):
            return False
        if options.get("database", DEFAULT_DB_ALIAS) != DEFAULT_DB_ALIAS:
            return False
        base = Path(settings.BASE_DIR).resolve()
        try:
            if Path.cwd().resolve() != base:
                return False
            status_file = base / ".upgrade-status.json"
            age = time.time() - status_file.stat().st_mtime
            status = json.loads(status_file.read_text())
        except (OSError, ValueError):
            return False
        return (isinstance(status, dict) and status.get("state") == "running"
                and status.get("step") == "migrate" and "stage_api" not in status
                and 0 <= age < BRIDGE_STATUS_AGE)

    def say(self, text: str) -> None:
        self.stdout.write(f"upgrade bridge: {text}\n")
        self.stdout.flush()

    # systemd
    def systemctl(self, *args: str, timeout: int = 180):
        import subprocess

        from .upgrade import _systemd_env

        return subprocess.run(["systemctl", "--user", *args], capture_output=True, text=True,
                              timeout=timeout, env=_systemd_env())

    def unit_info(self, unit: str) -> dict:
        try:
            r = self.systemctl("show", unit, "-p", "LoadState", "-p", "ActiveState",
                               "-p", "UnitFileState", "-p", "ControlGroup", timeout=10)
        except Exception:  # noqa: BLE001
            return {}
        return dict(line.split("=", 1) for line in r.stdout.splitlines() if "=" in line)

    @staticmethod
    def own_cgroup() -> str:
        try:
            with open("/proc/self/cgroup") as fh:
                for line in fh:
                    if line.startswith("0::"):
                        return line.strip()[3:]
        except OSError:
            pass
        return ""

    def timers(self) -> list[str]:
        import re

        from django.conf import settings

        try:
            text = (settings.BASE_DIR / "Makefile").read_text()
        except OSError:
            return []
        m = re.search(r"^TIMERS\s*:=\s*(.*)$", text, re.M)
        return [f"{t}.timer" for t in (m.group(1).split() if m else [])]

    def plan(self) -> tuple[list[str], list[str], list[str], list[str]]:
        """``(timers, work, web, wanted)``: loaded units to stop, by group,
        and the ones to start again (enabled or active before), leaving out
        a unit this process runs inside - stopping it would stop us."""
        mine = self.own_cgroup()
        info = {u: self.unit_info(u) for u in (
            *self.timers(), *(f"{u}.service" for u in BRIDGE_WORK_UNITS + BRIDGE_WEB_UNITS))}
        prod = info.get("danbyte-web.service", {}).get("UnitFileState") == "enabled"
        groups: dict[str, list[str]] = {"timer": [], "work": [], "web": []}
        wanted: list[str] = []
        for unit, props in info.items():
            if props.get("LoadState") != "loaded":
                continue
            cg = props.get("ControlGroup", "")
            if cg and mine and (mine == cg or mine.startswith(cg + "/")):
                self.say(f"leaving {unit} running: this upgrade runs inside it")
                continue
            name = unit.rsplit(".", 1)[0]
            group = ("timer" if unit.endswith(".timer")
                     else "work" if name in BRIDGE_WORK_UNITS else "web")
            groups[group].append(unit)
            before = props.get("UnitFileState") in ("enabled", "enabled-runtime") or \
                props.get("ActiveState") in ("active", "activating", "reloading")
            if before and not (prod and name in BRIDGE_DEV_UNITS):
                wanted.append(unit)
        return groups["timer"], groups["work"], groups["web"], wanted

    def stop(self, timers: list[str], work: list[str], web: list[str]) -> None:
        import time

        if timers:
            self.systemctl("stop", *timers)
            deadline = time.monotonic() + 120
            services = [t[:-len(".timer")] + ".service" for t in timers]
            while time.monotonic() < deadline:
                busy = [s for s in services
                        if self.unit_info(s).get("ActiveState") in ("active", "activating")]
                if not busy:
                    break
                time.sleep(2)
            else:
                self.systemctl("stop", *busy)
        for group in (work, web):
            if group:
                self.systemctl("stop", *group)
        self.say(f"stopped {len(timers)} timer(s) and {len(work) + len(web)} service(s)")

    def hand_over(self, wanted: list[str]) -> bool:
        """The restart outlives the old upgrader: a transient unit running a
        copy of legacy-resume.sh from outside the tree (a bundle rollback
        rewrites the tree). False when it could not be arranged."""
        import shutil
        import subprocess
        import time

        from django.conf import settings

        from .upgrade import UPGRADE_ROOTS, _process_identity, _systemd_env

        base = settings.BASE_DIR
        try:
            same_fs = os.stat(base.parent).st_dev == os.stat(base).st_dev
            root = UPGRADE_ROOTS[0] if same_fs else UPGRADE_ROOTS[1]
            root.mkdir(parents=True, exist_ok=True)
            stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
            script = root / f"legacy-resume-{stamp}.sh"
            units = root / f"legacy-resume-{stamp}.units"
            shutil.copy2(base / "scripts" / "upgrade" / "legacy-resume.sh", script)
            units.write_text("".join(f"{u}\n" for u in wanted))
            pid = os.getppid()
            _, started = _process_identity(pid)
            result = subprocess.run(
                ["systemd-run", "--user", "--collect", "--unit",
                 f"danbyte-upgrade-resume-{stamp}",
                 "/bin/sh", str(script), str(base), str(units), str(pid), str(started or "")],
                capture_output=True, text=True, timeout=30, env=_systemd_env())
        except Exception as exc:  # noqa: BLE001
            self.say(f"could not arrange the restart ({exc}); services keep running")
            return False
        if result.returncode != 0:
            self.say("could not arrange the restart "
                     f"({(result.stderr or result.stdout).strip()[:200]}); services keep running")
            for p in (script, units):
                p.unlink(missing_ok=True)
            return False
        self.units_file = units
        self.say(f"danbyte-upgrade-resume-{stamp} starts {len(wanted)} unit(s) when the "
                 "upgrader is done")
        self.record_added(units)
        self.record_target(units)
        return True

    def record_target(self, units) -> None:
        """For the resume unit: the tag this upgrade was asked for, and the
        status fields the stage would have written (who started it, when,
        from what), which the old upgrader's status lacks."""
        import json
        from pathlib import Path

        from django.conf import settings

        import danbyte

        base = Path(settings.BASE_DIR)
        lock = _read_json(base / ".upgrade.lock")
        status = _read_json(base / ".upgrade-status.json")
        tag = backup = None
        try:
            tag = asked_for(lock.get("acquired_at"))
            backup = pre_upgrade_backup(lock.get("acquired_at"))
        except Exception as exc:  # noqa: BLE001 - best effort; the database is the old one
            self.say(f"could not read who started this upgrade ({exc})")
        trigger = "auto" if tag else "button"
        if tag is None:
            # A git upgrader names the tag; a bundle one only says "uploaded".
            to = str(status.get("version_to") or "")
            tag = to if _TAG.fullmatch(to) and to != "uploaded" else f"v{danbyte.__version__}"
        frm = str(status.get("version_from") or "")
        report = {"trigger": trigger, "version_from": version_at(base, frm) or frm,
                  "version_to": tag, "kind": "git" if (base / ".git").exists() else "bundle",
                  "backup": backup or ""}
        started = lock.get("status_started_at") or lock.get("acquired_at")
        if isinstance(started, (int, float)):
            report["started_at"] = float(started)
        try:
            Path(f"{units}{TARGET_SUFFIX}").write_text(f"{tag}\n")
            Path(f"{units}{REPORT_SUFFIX}").write_text(json.dumps(report))
        except OSError as exc:
            self.say(f"could not record the upgrade for the restart ({exc})")
            return
        self.say(f"an upgrade to {tag}, started by "
                 f"{'the auto-upgrade timer' if trigger == 'auto' else 'a person'}")

    def record_added(self, units) -> None:
        """List the files the old bundle upgrader's overlay added, for the
        resume unit. Its rollback extracts its archive over the tree, which
        removes nothing: this release's migrations would stay behind, break
        the restored release's migration graph and be applied by the next
        upgrade (with this release's error, if one of them is what failed)."""
        from pathlib import Path

        from django.conf import settings

        base = Path(settings.BASE_DIR)
        if (base / ".git").exists():
            self.say("a git checkout: the old upgrader's rollback is a checkout, which "
                     "removes the files this release added")
            return
        archive = rollback_archive((os.environ.get("DANBYTE_BACKUP_DIR", ""),
                                    getattr(settings, "DANBYTE_BACKUP_DIR", ""),
                                    base.parent / "danbyte-backups"))
        if archive is None:
            self.say("no rollback archive from this upgrade; if it is rolled back, the files "
                     "this release added stay")
            return
        try:
            added, newer = files_added(base, archive)
            Path(f"{units}{ADDED_SUFFIX}").write_text("".join(f"{p}\n" for p in added))
        except Exception as exc:  # noqa: BLE001 - best effort; the resume then removes nothing
            self.say(f"could not list the files this release added ({exc})")
            return
        kept = f" ({newer} newer than it left alone)" if newer else ""
        self.say(f"{len(added)} file(s) are not in {archive.name}{kept}; a rollback of the "
                 "code removes them")

    def mark_unchanged(self) -> None:
        """Tell the resume unit the database is as it was: an old bundle
        upgrader's rollback leaves this release's migration files on disk,
        and its ``migrate --check`` would then refuse to start anything."""
        if self.units_file is None:
            return
        try:
            with open(f"{self.units_file}{UNCHANGED_SUFFIX}", "w") as fh:
                fh.write("the migration failed and was rolled back in full\n")
        except OSError as exc:
            self.say(f"could not tell the restart the database is unchanged ({exc})")

    def run(self, verbosity: int = 1) -> int:
        from django.core.management import call_command

        self.say("an upgrader from before 0.17 is migrating; stopping the services first")
        timers, work, web, wanted = self.plan()
        if self.hand_over(wanted):
            self.stop(timers, work, web)
        os.environ["DANBYTE_UPGRADE_STAGE"] = "bridge"
        result = run_migrate(verbosity=verbosity, stdout=self.stdout)
        for note in result.notes:
            self.say(note)
        if result.code != EXIT_OK:
            import sys

            if result.code == EXIT_UNCHANGED:
                self.mark_unchanged()
            state = ("the database is unchanged" if result.code == EXIT_UNCHANGED
                     else "part of it may be applied")
            print(f"migration failed ({state}): {result.error}", file=sys.stderr)
            return result.code
        self.say(f"migrated ({result.mode}, {result.planned} migration(s))")
        try:
            call_command("collectstatic", interactive=False, verbosity=0)
        except Exception as exc:  # noqa: BLE001 - the old flow never had it
            self.say(f"collectstatic failed: {exc}")
        from django.conf import settings

        if open_static(settings.STATIC_ROOT):
            self.say("some static files could not be made readable for the web server")
        return EXIT_OK
