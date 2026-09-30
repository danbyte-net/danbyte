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


class LegacyBridge:
    """``manage.py migrate`` run by an upgrader from before the upgrade stage
    (0.16.x, 0.17.0-dev1), which put the new code in place and then migrates
    with every service still running.

    Before migrating it stops the timers, the workers and everything that
    serves - new code must not run on the old schema, nor old code on the new
    one - and hands the restart of all of it to a transient unit
    (``scripts/upgrade/legacy-resume.sh``, copied out of the tree) that starts
    them once that upgrader has exited, whether it succeeded or rolled back.
    Then it migrates all or nothing, so the old upgrader's rollback never
    lands on a half-migrated database, and collects static files, which the
    old git upgrader never did.

    It steps in only for exactly that call: ``manage.py migrate`` with no
    app, plan or check, from the app directory, while the status file says
    an upgrade is at its migrate step - never for tests, a restore, the plugin
    apply or a person migrating by hand, and never under the new stage."""

    def __init__(self, stdout=None):
        import sys

        self.stdout = stdout or sys.stdout

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
            return False
        self.say(f"danbyte-upgrade-resume-{stamp} starts {len(wanted)} unit(s) when the "
                 "upgrader is done")
        return True

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

            state = ("the database is unchanged" if result.code == EXIT_UNCHANGED
                     else "part of it may be applied")
            print(f"migration failed ({state}): {result.error}", file=sys.stderr)
            return result.code
        self.say(f"migrated ({result.mode}, {result.planned} migration(s))")
        try:
            call_command("collectstatic", interactive=False, verbosity=0)
        except Exception as exc:  # noqa: BLE001 - the old flow never had it
            self.say(f"collectstatic failed: {exc}")
        return EXIT_OK
