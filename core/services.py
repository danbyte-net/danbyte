"""Service control — restart Danbyte's systemd **user** units from the UI, and
apply plugin changes (migrate + restart).

The web process can't restart itself synchronously, so a restart launches a
detached transient unit (``systemd-run --user``) that waits briefly — letting
the triggering HTTP response flush — then ``systemctl --user restart`` the
requested units. This is the same mechanism the in-app upgrade uses
(``core/upgrade.py``); we reuse its ``_systemd_env`` so the web (service) context
can reach the user systemd bus.

Superuser-only at the API layer — restarting production services is high-stakes.
Never manages the database. The set of manageable units is configurable via
``settings.MANAGEABLE_SERVICES`` and filtered to units that actually exist.
"""
from __future__ import annotations

import os
import subprocess
import uuid
from pathlib import Path

from django.conf import settings

from .upgrade import _systemd_env

RESTART_SCRIPT = settings.BASE_DIR / "scripts" / "danbyte-restart.sh"
APPLY_SCRIPT = settings.BASE_DIR / "scripts" / "danbyte-apply-plugins.sh"

WORKERS_UNIT = "danbyte-workers"
WORKER_MIN, WORKER_MAX = 1, 64

# key → {unit, label, core}. `core` units are what "Restart Danbyte" cycles.
# Overridable via settings.MANAGEABLE_SERVICES; only units that exist on the box
# are surfaced. Deliberately no database entry — never restart Postgres from here.
DEFAULT_MANAGEABLE_SERVICES: dict[str, dict] = {
    "web": {"unit": "danbyte-web", "label": "Web / API (gunicorn)", "core": True},
    "backend": {"unit": "danbyte-backend", "label": "Backend (dev runserver)", "core": True},
    "workers": {"unit": "danbyte-workers", "label": "Workers (RQ)", "core": True},
    "ws": {"unit": "danbyte-ws", "label": "WebSocket (presence)", "core": True},
    "frontend": {"unit": "danbyte-frontend-prod", "label": "Frontend (SSR)", "core": False},
    "docs": {"unit": "danbyte-docs", "label": "Docs", "core": False},
}


def _service_defs() -> dict[str, dict]:
    return getattr(settings, "MANAGEABLE_SERVICES", None) or DEFAULT_MANAGEABLE_SERVICES


def _unit_state(unit: str) -> str:
    """`systemctl --user is-active <unit>` → active | inactive | failed |
    missing | unknown (when systemd can't be reached)."""
    try:
        result = subprocess.run(
            ["systemctl", "--user", "is-active", f"{unit}.service"],
            capture_output=True, text=True, timeout=5, env=_systemd_env(),
        )
    except Exception:  # noqa: BLE001
        return "unknown"
    state = result.stdout.strip().lower()
    err = result.stderr.strip().lower()
    if state in {"active", "activating", "reloading"}:
        return "active"
    if state == "failed":
        return "failed"
    if "not found" in err or "could not be found" in err or "unknown unit" in err:
        return "missing"
    if state in {"inactive", "deactivating"}:
        return "inactive"
    return "unknown"


def list_services() -> list[dict]:
    """The manageable units that exist on this box, with live state."""
    out: list[dict] = []
    for key, spec in _service_defs().items():
        state = _unit_state(spec["unit"])
        if state == "missing":
            continue  # not installed in this environment (dev vs prod differ)
        out.append(
            {
                "key": key,
                "unit": spec["unit"],
                "label": spec["label"],
                "core": bool(spec.get("core")),
                "state": state,
            }
        )
    return out


def _resolve_units(keys: list[str]) -> list[str]:
    defs = _service_defs()
    existing = {s["key"] for s in list_services()}
    return [defs[k]["unit"] for k in keys if k in defs and k in existing]


def _launch_detached(script, unit_args: list[str], *, extra_setenv: dict | None = None) -> bool:
    """Run ``script unit_args…`` in a detached transient user unit so it outlives
    the web restart. Returns True if systemd-run accepted the launch."""
    name = f"danbyte-svc-{uuid.uuid4().hex[:8]}"
    cmd = [
        "systemd-run", "--user", "--collect", "--unit", name,
        f"--setenv=DANBYTE_DIR={settings.BASE_DIR}",
    ]
    for k, v in (extra_setenv or {}).items():
        cmd.append(f"--setenv={k}={v}")
    cmd += ["bash", str(script), *unit_args]
    try:
        result = subprocess.run(
            cmd, capture_output=True, text=True, timeout=15, env=_systemd_env()
        )
    except Exception:  # noqa: BLE001
        return False
    return result.returncode == 0


def restart_services(keys: list[str]) -> dict:
    """Restart the named service keys (detached). Returns what was launched."""
    units = _resolve_units(keys)
    if not units:
        return {"ok": False, "detail": "No matching installed services.", "units": []}
    ok = _launch_detached(RESTART_SCRIPT, units)
    return {"ok": ok, "units": units,
            "detail": "Restart scheduled." if ok else "Could not reach user systemd."}


def restart_danbyte() -> dict:
    """Restart the core Danbyte units together."""
    core_keys = [s["key"] for s in list_services() if s["core"]]
    return restart_services(core_keys)


# ── Worker pool size ─────────────────────────────────────────────────────────
# The worker count is RQ_WORKERS in the danbyte-workers unit. We persist the
# desired value on DeploymentSettings and apply it by writing a systemd drop-in
# (RQ_WORKERS=N), reloading systemd, and restarting *only* the workers unit —
# which, unlike the web unit, can be restarted straight from the web process.

def _worker_dropin_path() -> Path:
    base = Path(os.path.expanduser("~/.config/systemd/user")) / f"{WORKERS_UNIT}.service.d"
    return base / "override.conf"


def worker_config() -> dict:
    """Configured worker count + bounds + whether this environment manages it."""
    from core.models import DeploymentSettings

    managed = "workers" in {s["key"] for s in list_services()}
    return {
        "rq_workers": DeploymentSettings.load().rq_workers,
        "min": WORKER_MIN,
        "max": WORKER_MAX,
        "managed": managed,
    }


def set_worker_count(n: int) -> dict:
    """Persist + apply the RQ worker-pool size. Saves the setting always; only
    writes the drop-in / restarts when the workers unit is managed here."""
    from core.models import DeploymentSettings

    try:
        n = int(n)
    except (TypeError, ValueError):
        return {"ok": False, "detail": "Worker count must be a whole number."}
    if n < WORKER_MIN or n > WORKER_MAX:
        return {"ok": False, "detail": f"Worker count must be {WORKER_MIN}–{WORKER_MAX}."}

    ds = DeploymentSettings.load()
    ds.rq_workers = n
    ds.save(update_fields=["rq_workers", "updated_at"])

    if "workers" not in {s["key"] for s in list_services()}:
        return {"ok": False, "saved": True, "rq_workers": n,
                "detail": "Saved, but the workers service isn't managed in this environment."}

    try:
        path = _worker_dropin_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"[Service]\nEnvironment=RQ_WORKERS={n}\n")
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "saved": True, "rq_workers": n,
                "detail": f"Saved, but could not write the systemd drop-in: {exc}"}

    # Re-read units so the new RQ_WORKERS is picked up, then restart the pool.
    try:
        subprocess.run(
            ["systemctl", "--user", "daemon-reload"],
            capture_output=True, text=True, timeout=15, env=_systemd_env(),
        )
    except Exception:  # noqa: BLE001 — restart below still applies on next boot
        pass
    result = restart_services(["workers"])
    result["saved"] = True
    result["rq_workers"] = n
    return result


# ── plugin apply (migrate + restart) ─────────────────────────────────────────
def pending_migrations_by_app() -> dict[str, list[str]]:
    """Unapplied migrations keyed by app_label (used to flag plugins needing an
    apply). Safe to call per request — reads the migration graph, no writes."""
    from django.db import connections
    from django.db.migrations.executor import MigrationExecutor

    executor = MigrationExecutor(connections["default"])
    targets = executor.loader.graph.leaf_nodes()
    out: dict[str, list[str]] = {}
    for migration, _backwards in executor.migration_plan(targets):
        out.setdefault(migration.app_label, []).append(migration.name)
    return out


def apply_plugins() -> dict:
    """Run ``migrate --noinput`` then restart the core units — detached, so a
    long migration + the restart survive independent of this request."""
    ok = _launch_detached(
        APPLY_SCRIPT,
        [s["unit"] for s in list_services() if s["core"]],
    )
    return {"ok": ok,
            "detail": "Apply (migrate + restart) scheduled." if ok
            else "Could not reach user systemd."}
