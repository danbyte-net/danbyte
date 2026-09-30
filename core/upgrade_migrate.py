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
