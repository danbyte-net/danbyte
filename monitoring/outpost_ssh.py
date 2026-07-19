"""SSH transport — Danbyte dials **out** to the Outpost host and drives it.

For airgapped sites that only permit ``Danbyte → host`` on SSH (22). Danbyte
claims the engine's due checks (the same claim used by the HTTPS-pull
``/work`` endpoint), runs ``danbyte-outpost once`` on the host over SSH (work
JSON on stdin → results JSON on stdout), and ingests the results through the
same finalise path as every other transport. The site never opens a connection
to Danbyte.
"""
from __future__ import annotations

import asyncio
import json
import logging

from django.utils import timezone

from .checkers import CheckOutcome
from .models import MonitoringEngine
from .outpost_views import claim_and_build_work
from .worker import ingest_results

log = logging.getLogger("monitoring.outpost_ssh")

OUTPOST_ONCE_CMD = "danbyte-outpost once"
_STATUSES = {"up", "down", "degraded", "unknown"}


def _known_hosts_entry(engine) -> bytes | None:
    """A known_hosts line pinning the engine's host key, or None for
    trust-on-first-use. Non-standard ports use the ``[host]:port`` form."""
    key = (engine.ssh_host_key or "").strip()
    if not key:
        log.warning(
            "SSH outpost %s has no pinned host key — trusting on first use. "
            "Set ssh_host_key to verify the server.",
            engine.name,
        )
        return None
    port = engine.ssh_port or 22
    host = engine.ssh_host if port == 22 else f"[{engine.ssh_host}]:{port}"
    return f"{host} {key}\n".encode()


def _connect_kwargs(engine) -> dict:
    """asyncssh.connect kwargs for an engine — credential + host-key pinning.
    Factored out so it's testable without a live host."""
    import asyncssh

    cred = engine.ssh_credential or {}
    kwargs: dict = {
        "host": engine.ssh_host,
        "port": engine.ssh_port or 22,
        "username": engine.ssh_user,
        "known_hosts": _known_hosts_entry(engine),
    }
    if cred.get("private_key"):
        kwargs["client_keys"] = [asyncssh.import_private_key(cred["private_key"])]
    elif cred.get("password"):
        kwargs["password"] = cred["password"]
    return kwargs


async def _ssh_run(engine, checks: list[dict]) -> list[dict]:
    """Run the Outpost once over SSH and return its result rows."""
    import asyncssh

    async with asyncssh.connect(**_connect_kwargs(engine)) as conn:
        result = await conn.run(
            OUTPOST_ONCE_CMD, input=json.dumps({"checks": checks}), check=True
        )
    return json.loads(result.stdout or "{}").get("results", [])


def drive_ssh_engine(engine, now=None, *, run_ssh=None) -> dict:
    """Claim → run over SSH → ingest, for one SSH engine. ``run_ssh`` is
    injectable so the claim/ingest path is testable without a live host."""
    now = now or timezone.now()
    checks = claim_and_build_work(engine, now)
    if not checks:
        return {"engine": engine.name, "ran": 0, "ingested": 0}
    runner = run_ssh or (lambda c: asyncio.run(_ssh_run(engine, c)))
    rows = runner(checks) or []
    outcome_by_id = {}
    for r in rows:
        sid = str(r.get("state_id", ""))
        status = r.get("status")
        if sid and status in _STATUSES:
            outcome_by_id[sid] = CheckOutcome(
                status=status,
                latency_ms=r.get("latency_ms"),
                detail=r.get("detail") or {},
            )
    n = ingest_results(
        outcome_by_id, engine_id=engine.id, tenant_id=engine.tenant_id
    )
    engine.last_seen_at = now
    engine.save(update_fields=["last_seen_at"])
    return {"engine": engine.name, "ran": len(checks), "ingested": n}


def drive_ssh_outposts(now=None) -> dict:
    """Drive every enabled, configured SSH-transport engine — runs on a timer."""
    now = now or timezone.now()
    total = {"engines": 0, "ran": 0, "ingested": 0, "errors": 0}
    for engine in MonitoringEngine.objects.filter(
        kind=MonitoringEngine.REMOTE,
        enabled=True,
        transport=MonitoringEngine.SSH,
    ):
        if not engine.ssh_configured:
            continue
        total["engines"] += 1
        try:
            r = drive_ssh_engine(engine, now)
            total["ran"] += r["ran"]
            total["ingested"] += r["ingested"]
        except Exception as e:  # a dead host must not stall the others
            total["errors"] += 1
            log.warning("SSH outpost %s failed: %s", engine.name, e)
    return total
