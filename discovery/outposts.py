"""Discovery on Outposts: package inventory and service scans for hosts the
server cannot reach.

A profile's **Runs on** is ``server`` (the default), ``outpost`` (one
named Outpost) or ``host`` (each host's Outpost, by the monitoring engine
bindings: device, location, prefix, site, the tenant default). A run on
Outposts goes like this:

1. **Dispatch** (the RQ job, :func:`dispatch`). The scope, every skip rule
   (exempt, deny subnets, maintenance, the authorisation, the window, the
   person's view) and the logins are resolved here, exactly as for a server
   run. Each host that passes gets a :class:`~discovery.models.DiscoveryWorkItem`
   for its Outpost. **No secret is read or stored**: an item names its
   credentials by id. A host whose Outpost is offline, disabled, driven
   over SSH, or runs an agent that does not advertise the work kind (or
   nmap) is left alone with a host result that says so. It is **never**
   read from the server instead: an Outpost exists because the server sees
   the network from another place (or not at all), and the scope a person
   authorised for one vantage point is not an authorisation to scan from
   another.
2. **Claim** (``GET /api/outpost/discovery-work/``, :func:`claim`). The
   Outpost's token names the engine; it is handed only its own tenant's
   pending items, a batch of one run at a time. The run, the profile, the
   gates and the starter's ``scan`` permission are checked again; the
   credentials are re-read by id inside the tenant (a host credential must
   still belong to the host, a shared one must still be enabled), resolved
   from the secret store and sent in that one answer - the same delivery
   as the SNMP credentials an Outpost already receives. An item is claimed
   once and is then due back by a deadline.
3. **Ingest** (``POST /api/outpost/discovery-results/``, :func:`ingest`).
   Untrusted input: only an item this engine claimed and has not reported
   is accepted, the result must parse with the same checks the collectors
   apply (``result_from_dict``, ``host_result_from_dict``: the address and
   ports it was given, capped strings, packages that pass the parsers'
   name and version rules, host keys whose fingerprint is computed here),
   and it is stored by the same functions as a server run
   (``runner.inventory_row``, ``services.host_row``). Host results record
   the engine as ``outpost: <name>``.
4. **Expire** (:func:`expire`, on the discovery timer): an item not claimed
   in :data:`UNCLAIMED_MINUTES`, or claimed and not reported by its
   deadline, becomes a host result and the run finishes.

An Outpost advertises what it can do in its hello (``capabilities``, stored
on ``MonitoringEngine.agent_capabilities``). An agent that predates this
sends nothing and is never handed discovery work: its hosts say which
agent version they need (:data:`AGENT_VERSION`).
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
import uuid
from dataclasses import dataclass, field
from datetime import timedelta

from django.db import transaction
from django.utils import timezone

log = logging.getLogger(__name__)

#: The first Outpost agent that runs discovery work.
AGENT_VERSION = "0.10.0"
KINDS = ("inventory", "service_scan")
KIND_LABELS = {"inventory": "package inventory", "service_scan": "service scans"}
#: A pending item no Outpost claimed in this long is given up.
UNCLAIMED_MINUTES = 30
#: Items handed out per claim, at most.
CLAIM_MAX = 256
#: A service-scan batch is sized to take about this long at the run's rate.
SCAN_BATCH_SECONDS = 600
#: Results accepted in one post, at most.
RESULTS_MAX = 200
OPEN = ("pending", "claimed")
#: Statuses that mean the host was never contacted (a rule, or an Outpost).
_NOT_CONTACTED = ("no_credential", "no_address", "exempt", "denied", "maintenance",
                  "no_outpost", "outpost_offline", "outpost_unsupported")


def label(engine) -> str:
    return f"outpost: {engine.name}"[:64]


def capabilities(engine) -> dict:
    caps = (getattr(engine, "agent_capabilities", None) or {}).get("discovery")
    return caps if isinstance(caps, dict) else {}


def clean_capabilities(value) -> dict:
    """What an agent's hello says it can do, as stored: known keys only,
    bounded. Anything else (an older agent sends nothing) is ``{}``."""
    if not isinstance(value, dict):
        return {}
    disc = value.get("discovery")
    if not isinstance(disc, dict):
        return {}
    kinds = [k for k in (disc.get("kinds") or []) if isinstance(k, str) and k in KINDS] \
        if isinstance(disc.get("kinds"), list) else []
    out: dict = {"kinds": sorted(set(kinds)), "nmap": None, "nmap_reason": ""}
    nm = disc.get("nmap")
    if isinstance(nm, dict) and isinstance(nm.get("version"), str):
        version = nm["version"].strip()[:20]
        if version and all(c.isalnum() or c == "." for c in version):
            out["nmap"] = {"version": version}
    reason = disc.get("nmap_reason")
    if isinstance(reason, str):
        out["nmap_reason"] = reason.strip()[:200]
    proto = disc.get("protocol")
    out["protocol"] = proto if isinstance(proto, int) and not isinstance(proto, bool) \
        and 0 < proto < 1000 else 1
    return {"discovery": out}


def online(engine, now=None) -> bool:
    """Whether the Outpost was seen recently: the tenant's "offline after"
    setting, else three poll intervals (at least three minutes) - the rule
    the engine health check uses."""
    from monitoring.models import MonitoringSettings

    now = now or timezone.now()
    if engine.last_seen_at is None:
        return False
    minutes = MonitoringSettings.for_tenant(engine.tenant).engine_offline_after_minutes
    threshold = timedelta(minutes=minutes) if minutes else timedelta(
        seconds=max(3 * (engine.poll_interval_seconds or 60), 180))
    return now - engine.last_seen_at <= threshold


def why_not(engine, kind: str, scan_engine: str = "builtin", *, now=None,
            check_online: bool = True) -> tuple[str, str]:
    """``("", "")`` when ``engine`` can take ``kind`` work now, else the host
    status and the reason."""
    from monitoring.models import MonitoringEngine

    if engine is None:
        return "no_outpost", "No Outpost is bound to this host."
    if engine.kind != MonitoringEngine.REMOTE:
        return "no_outpost", "No Outpost is bound to this host; its checks run on " \
                             f"{'the server' if engine.kind == MonitoringEngine.LOCAL else engine.name}."
    name = engine.name
    if not engine.enabled:
        return "outpost_offline", f"Outpost {name} is disabled."
    if engine.transport != MonitoringEngine.PULL:
        return "outpost_unsupported", (f"Outpost {name} is driven over SSH; discovery runs "
                                       "only on Outposts that dial out.")
    if check_online and not online(engine, now):
        seen = engine.last_seen_at
        when = timezone.localtime(seen).strftime("%Y-%m-%d %H:%M") if seen else "never"
        return "outpost_offline", f"Outpost {name} is offline (last seen {when})."
    caps = capabilities(engine)
    if kind not in (caps.get("kinds") or []):
        agent = f"agent {engine.agent_version}" if engine.agent_version else "an agent"
        return "outpost_unsupported", (
            f"Outpost {name} runs {agent} that cannot run {KIND_LABELS.get(kind, kind)}; "
            f"it needs {AGENT_VERSION} or later.")
    if kind == "service_scan" and scan_engine == "nmap" and not (caps.get("nmap") or {}).get(
            "version"):
        why = caps.get("nmap_reason") or "none found"
        return "outpost_unsupported", f"Outpost {name} has no nmap it may run ({why})."[:300]
    return "", ""


def nmap_why_not(tenant) -> str:
    """Why a run on Outposts may not use nmap; "" when it may. The deployment
    switch and the tenant's nmap switch apply; the binary is the Outpost's."""
    from . import nmap as nmap_engine
    from .models import DiscoverySettings

    if not nmap_engine.allowed():
        return "nmap: Forbidden by the deployment."
    if not DiscoverySettings.for_tenant(tenant).nmap_enabled:
        return "nmap is switched off on the Discovery card."
    return ""


# ─── which Outpost a host goes to ────────────────────────────────────────────


def _engines_for(profile, kind, targets) -> dict:
    """``{id(target): engine or None}`` for the targets that need work."""
    if profile.runs_on == "outpost":
        return {id(t): profile.outpost for t in targets}
    tenant = profile.tenant
    if kind == "inventory":
        from monitoring.engines import engines_for_targets
        from monitoring.snmp_target import SnmpTarget

        resolved = engines_for_targets(tenant, [t.host for t in targets])
        return {id(t): resolved.get(SnmpTarget.of(t.host).key) for t in targets}
    from monitoring.engines import engine_for_ip

    out, cache = {}, {}
    for t in targets:
        ip = t.ip
        dev = getattr(ip, "assigned_device", None)
        key = (getattr(dev, "pk", None), getattr(dev, "location_id", None), ip.prefix_id,
               ip.site_id or (ip.prefix.site_id if ip.prefix_id else None))
        if key not in cache:
            cache[key] = engine_for_ip(ip)
        out[id(t)] = cache[key]
    return out


def preview(profile, targets) -> dict:
    """For the scope preview of a profile that runs on Outposts: each ready
    target's Outpost (``{id(target): "outpost: <name>"}``), and a target
    whose Outpost cannot take the work now gets that as its status."""
    ready = [t for t in targets if not t.skip]
    engines = _engines_for(profile, profile.kind, ready)
    out = {}
    for t in ready:
        engine = engines.get(id(t))
        if profile.runs_on == "outpost" and engine is None:
            status, message = "no_outpost", "The profile names no Outpost."
        else:
            status, message = why_not(engine, profile.kind, profile.scan_engine)
        if status:
            t.skip, t.message = status, message
        if engine is not None and engine.kind == "remote":
            out[id(t)] = label(engine)
    return out


def ports_digest(ports) -> str:
    return hashlib.sha256(json.dumps(list(ports)).encode()).hexdigest()[:16]


# ─── dispatch ────────────────────────────────────────────────────────────────


def _login_refs(t) -> list[dict]:
    from monitoring.models import SharedCredential

    from .runner import transport_of

    return [{"credential": str(x.credential.pk),
             "model": "shared" if isinstance(x.credential, SharedCredential) else "host",
             "transport": transport_of(x), "port": x.credential.port,
             "fall_through": bool(x.fall_through), "source": x.source[:140]}
            for x in t.logins]


def dispatch(run, profile, *, user=None, now=None) -> dict:
    """The RQ job's part for a run on Outposts: resolve, decide per host,
    queue the work. Returns the counts so far; the run stays ``running``
    until the last item is reported or expires."""
    from . import runner, services
    from .models import DiscoveryWorkItem, InventoryHostResult, InventoryRun

    tenant = profile.tenant
    now = now or timezone.now()
    kind = run.kind
    errors: list[str] = []
    counts: dict = {}
    plan = None
    if kind == "inventory":
        targets, work, errors = runner.inventory_work(run, profile, user=user, now=now,
                                                      outpost=True)
        mode = {id(t): m for t, m in work}
        counts = {"hosts": len(targets), "ok": 0, "packages": 0, "changed": 0}
    else:
        from .scope import MAX_HOSTS

        targets = services.resolve(profile, user=user, now=now, outpost=True)
        if services.truncated(profile, user=user):
            errors.append(f"More than {MAX_HOSTS} addresses in scope; the rest were not "
                          "scanned.")
        try:
            plan = services.plan(profile)
        except ValueError as exc:
            return _finish_now(run, {"hosts": len(targets)},
                               [f"The port list is not valid: {exc}"[:300]], "failed")
        if profile.scan_engine == "nmap":
            reason = nmap_why_not(tenant)
            if reason:
                return _finish_now(run, {"hosts": len(targets)}, [reason], "failed")
        mode = {id(t): "scan" for t in targets if not t.skip}
        counts = {"hosts": len(targets), "ok": 0, "services": 0, "new": 0, "gone": 0,
                  "connects": 0, "ports": len(plan["ports"]), "rate": plan["rate"],
                  "hosts_parallel": plan["hosts_parallel"]}
    engines = _engines_for(profile, kind, [t for t in targets if id(t) in mode])
    rows, items, outpost_reasons = [], [], []
    changed: dict = {"device": set(), "virtual_machine": set()}
    deadline = now + timedelta(minutes=UNCLAIMED_MINUTES)
    for t in targets:
        m = mode.get(id(t))
        engine = engines.get(id(t)) if m else None
        if m:
            if profile.runs_on == "outpost" and engine is None:
                status, message = "no_outpost", "The Outpost this profile ran on was deleted."
            else:
                status, message = why_not(engine, kind, profile.scan_engine, now=now)
            if status:
                # A host only to be observed keeps the reason it was not
                # read; its Outpost not taking the key read changes nothing.
                if m != "observe":
                    t.skip, t.message = status, message
                if message not in outpost_reasons:
                    outpost_reasons.append(message)
                m = None
        where = label(engine) if engine is not None and engine.kind == "remote" else ""
        if not m:
            if kind == "inventory":
                rows.append(runner.inventory_row(run, t, None, None, user=user, counts=counts,
                                                 changed_hosts=changed, engine=where))
            else:
                rows.append(services.host_row(tenant, run, t, None, now, counts, engine=where))
            continue
        if kind == "inventory":
            payload = {"mode": m, "skipped": t.extra.get("skipped", []),
                       "skip": t.skip, "message": t.message}
            if m == "observe":
                payload["port"] = t.extra.get("port") or 22
            else:
                payload.update(logins=_login_refs(t), first_use=bool(t.extra.get("first_use")),
                               known_hosts=(t.known_hosts or b"").decode() or None)
            host_kw = {t.kind: t.host}
        else:
            payload = {"ports_digest": ports_digest(plan["ports"])}
            host_kw = {"ip_address": t.ip, **({t.kind: t.host} if t.host is not None else {})}
        items.append(DiscoveryWorkItem(tenant=tenant, run=run, engine=engine, kind=kind,
                                       address=t.address, payload=payload, deadline=deadline,
                                       **host_kw))
    errors += outpost_reasons[:5]
    InventoryHostResult.objects.bulk_create(rows, batch_size=1000)
    where = label(profile.outpost) if profile.runs_on == "outpost" and profile.outpost \
        else "outposts"
    # The counts are written before any item exists: an Outpost's results
    # add to them from then on.
    InventoryRun.objects.filter(pk=run.pk).update(engine=where, counts=counts,
                                                  errors=errors[:50])
    DiscoveryWorkItem.objects.bulk_create(items, batch_size=1000)
    if any(changed.values()):
        runner._recompute(tenant, changed)
    if not items:
        finish_if_done(run.pk)
    return counts


def _finish_now(run, counts, errors, status) -> dict:
    from .models import InventoryRun

    InventoryRun.objects.filter(pk=run.pk).update(status=status, finished_at=timezone.now(),
                                                  counts=counts, errors=errors[:50])
    return counts


def _contacted(kind, status, transport) -> bool:
    if kind == "service_scan":
        return status == "failed"
    if status in _NOT_CONTACTED or status == "blocked":
        return False
    return not (status == "host_key_refused" and not transport)


def finish_if_done(run_id) -> bool:
    """Close a run on Outposts once none of its items is open. Returns
    whether it closed."""
    from .models import OUTPOST_STATUSES, DiscoveryWorkItem, InventoryHostResult, InventoryRun
    from .runner import DELIBERATE, run_outcome

    with transaction.atomic():
        run = InventoryRun.objects.select_for_update().filter(pk=run_id,
                                                              status="running").first()
        if run is None or DiscoveryWorkItem.objects.filter(run=run, status__in=OPEN).exists():
            return False
        rows = list(InventoryHostResult.objects.filter(run=run).values_list("status",
                                                                            "transport"))
        problems = [st for st, _t in rows if st not in ("ok", *DELIBERATE)]
        if problems and not any(st == "ok" for st, _t in rows) \
                and all(st in OUTPOST_STATUSES for st in problems):
            status = "skipped"
        elif rows:
            status = run_outcome([(st, _contacted(run.kind, st, tr)) for st, tr in rows])
        else:
            status = "ok"
        InventoryRun.objects.filter(pk=run.pk).update(status=status,
                                                      finished_at=timezone.now())
    return True


# ─── claim ───────────────────────────────────────────────────────────────────


def _run_refusal(run, engine) -> str:
    """Why a run's items may not be handed to ``engine`` now; "" when they
    may."""
    from .runner import _still_allowed

    profile = run.profile
    if run.status != "running":
        return "The run is no longer running."
    reason = _still_allowed(run, window=False)
    if reason:
        return reason
    if profile.runs_on == "server":
        return "The profile runs on the server now."
    if profile.runs_on == "outpost" and profile.outpost_id != engine.pk:
        return "The profile runs on another Outpost now."
    return ""


def _close_items(items, status: str, message: str, *, now=None) -> None:
    """Turn open items into host results (``status``, ``message``) and mark
    them expired; then close their runs if that was the last."""
    from . import runner, services
    from .models import DiscoveryWorkItem, InventoryHostResult, InventoryRun
    from .scope import Target

    now = now or timezone.now()
    by_run: dict = {}
    for item in items:
        by_run.setdefault(item.run_id, []).append(item)
    for run_id, group in by_run.items():
        with transaction.atomic():
            run = InventoryRun.objects.select_for_update().select_related("tenant").get(
                pk=run_id)
            live = list(DiscoveryWorkItem.objects.select_for_update(of=("self",)).filter(
                pk__in=[i.pk for i in group], status__in=OPEN).select_related(
                "engine", "device", "virtual_machine", "ip_address"))
            counts = dict(run.counts or {})
            rows = []
            for item in live:
                where = label(item.engine)
                if item.kind == "inventory":
                    host = item.device or item.virtual_machine
                    t = Target(kind="device" if item.device_id else "virtual_machine", host=host,
                               address=item.address, skip=status, message=message,
                               extra={"skipped": (item.payload or {}).get("skipped", [])})
                    rows.append(runner.inventory_row(run, t, None, None, user=None,
                                                     counts=counts, changed_hosts={},
                                                     engine=where))
                else:
                    rows.append(services.host_row(run.tenant, run,
                                                  _address_target(item, status, message), None,
                                                  now, counts, engine=where))
            InventoryHostResult.objects.bulk_create(rows, batch_size=1000)
            DiscoveryWorkItem.objects.filter(pk__in=[i.pk for i in live]).update(
                status="expired")
            InventoryRun.objects.filter(pk=run.pk).update(counts=counts)
        finish_if_done(run_id)


def _address_target(item, skip: str = "", message: str = ""):
    from .services import AddressTarget

    host = item.device or item.virtual_machine
    kind = "device" if item.device_id else ("virtual_machine" if item.virtual_machine_id else "")
    return AddressTarget(ip=item.ip_address, address=item.address, kind=kind, host=host,
                         skip=skip, message=message)


def _batch(run, profile, kind, plan) -> tuple[int, float]:
    """``(items, seconds)``: how many items one claim hands out and how
    long the Outpost has to report them."""
    from . import nmap as nmap_engine
    from .runner import CONCURRENCY_MAX, host_timeout

    if kind == "inventory":
        concurrency = max(1, min(CONCURRENCY_MAX, profile.max_concurrency or 1))
        n = concurrency * 2
        per_host = host_timeout(profile) * 3 + 15  # up to three logins, then a key read
        return n, math.ceil(n / concurrency) * per_host + 120
    ports, rate, hp = len(plan["ports"]), plan["rate"], plan["hosts_parallel"]
    if profile.scan_engine == "nmap":
        n = hp * 2
        return n, 60 + nmap_engine.HOST_TIMEOUT * math.ceil(n / hp) + 120
    n = max(1, min(CLAIM_MAX, int(SCAN_BATCH_SECONDS * rate / max(1, ports))))
    return n, (n * ports / rate) * 1.5 + 180


@dataclass
class _Claimed:
    run: object
    items: list = field(default_factory=list)
    plan: dict | None = None


def claim(engine, now=None) -> list[dict]:
    """Claim and build this engine's next batch of discovery work (one run's
    items), secrets resolved. ``[]`` when there is none it may take."""
    from .models import DiscoveryWorkItem, InventoryRun

    now = now or timezone.now()
    refused = None
    with transaction.atomic():
        first = DiscoveryWorkItem.objects.select_for_update(skip_locked=True).filter(
            engine=engine, tenant_id=engine.tenant_id, status="pending").order_by(
            "created_at").first()
        if first is None:
            return []
        run = InventoryRun.objects.select_related(
            "profile", "profile__tenant", "started_by", "tenant").get(pk=first.run_id)
        profile = run.profile
        reason = _run_refusal(run, engine)
        status, message = ("", "")
        if not reason:
            status, message = why_not(engine, run.kind, profile.scan_engine, now=now,
                                      check_online=False)
        plan = None
        if not reason and not status and run.kind == "service_scan":
            from . import services

            try:
                plan = services.plan(profile)
            except ValueError:
                reason = "The profile's port list is no longer valid."
            else:
                if ports_digest(plan["ports"]) != (first.payload or {}).get("ports_digest"):
                    reason = "The profile's ports changed after the run started."
        if reason or status:
            refused = (list(DiscoveryWorkItem.objects.filter(
                run=run, engine=engine, status="pending")),
                status or "failed", message or f"Not run: {reason}")
        else:
            n, seconds = _batch(run, profile, run.kind, plan)
            batch = list(DiscoveryWorkItem.objects.select_for_update(skip_locked=True).filter(
                run=run, engine=engine, status="pending").order_by("created_at")[:n])
            DiscoveryWorkItem.objects.filter(pk__in=[i.pk for i in batch]).update(
                status="claimed", claimed_at=now, deadline=now + timedelta(seconds=seconds))
            # The Outpost is working through the run: the rest wait for it
            # (it comes back for them once this batch is done).
            DiscoveryWorkItem.objects.filter(run=run, engine=engine, status="pending").update(
                deadline=now + timedelta(seconds=seconds) + timedelta(
                    minutes=UNCLAIMED_MINUTES))
    if refused is not None:
        items, status, message = refused
        _close_items(items, status, message, now=now)
        return []
    return [_job(run, profile, batch, plan, now)]


def _secret_login(ref: dict, item, tenant):
    """The connect arguments of one login reference, re-read inside the
    tenant and resolved from the secret store; ``None`` when it no longer
    applies or its secret cannot be read."""
    from monitoring.credentials import Login
    from monitoring.models import DeviceCredential, SharedCredential

    from .runner import _credential
    from .scope import SSH_KINDS

    try:
        pk = uuid.UUID(str(ref.get("credential")))
    except ValueError:
        return None
    if ref.get("model") == "shared":
        cred = SharedCredential.objects.filter(tenant=tenant, pk=pk, enabled=True).first()
    else:
        cred = DeviceCredential.objects.filter(
            tenant=tenant, pk=pk, device_id=item.device_id,
            virtual_machine_id=item.virtual_machine_id).first()
    # SSH only: an Outpost never gets a WinRM certificate.
    if cred is None or cred.kind not in SSH_KINDS or cred.kind != ref.get("transport"):
        return None
    out = _credential(Login(credential=cred, source=ref.get("source") or ""), None)
    if out is None:
        return None
    out.pop("known_hosts", None)
    return {"transport": cred.kind, "port": cred.port,
            "fall_through": bool(getattr(cred, "fall_through", False)), "credential": out}


def _job(run, profile, items, plan, now) -> dict:
    from .runner import CONCURRENCY_MAX, host_timeout

    tenant = run.tenant
    if run.kind == "service_scan":
        from . import nmap as nmap_engine

        return {"run_id": str(run.pk), "kind": "service_scan", "engine": profile.scan_engine,
                "ports": plan["ports"], "rate": plan["rate"],
                "hosts_parallel": plan["hosts_parallel"],
                "nmap": {"intensity": profile.nmap_version_intensity,
                         "timing": profile.nmap_timing, "host_timeout": nmap_engine.HOST_TIMEOUT},
                "items": [{"item_id": str(i.pk), "address": i.address} for i in items]}
    out, unreadable = [], []
    for item in items:
        p = item.payload or {}
        if p.get("mode") == "observe":
            out.append({"item_id": str(item.pk), "mode": "observe", "address": item.address,
                        "port": int(p.get("port") or 22)})
            continue
        logins = [x for x in (_secret_login(r, item, tenant) for r in p.get("logins") or [])
                  if x is not None]
        if not logins:
            unreadable.append(item)
            continue
        out.append({"item_id": str(item.pk), "mode": "read", "address": item.address,
                    "known_hosts": p.get("known_hosts"), "first_use": bool(p.get("first_use")),
                    "logins": logins})
    if unreadable:
        _close_items(unreadable, "no_credential", "The credential's secret cannot be read.",
                     now=now)
    return {"run_id": str(run.pk), "kind": "inventory",
            "concurrency": max(1, min(CONCURRENCY_MAX, profile.max_concurrency or 1)),
            "timeout": host_timeout(profile), "items": out}


# ─── ingest ──────────────────────────────────────────────────────────────────


def _attempts(value, logins) -> list[dict]:
    """The per-login attempts an Outpost reports, kept only in the shape the
    collector writes them."""
    known = {x.get("transport") for x in logins}
    out = []
    for a in (value if isinstance(value, list) else [])[:10]:
        if not isinstance(a, dict) or a.get("transport") not in known:
            continue
        outcome, reason = a.get("outcome"), a.get("reason")
        if not isinstance(outcome, str) or not isinstance(reason, str):
            continue
        out.append({"transport": a["transport"], "outcome": outcome[:20],
                    "reason": reason.replace("\x00", "")[:200]})
    return out


def ingest(engine, data) -> dict:
    """Store what an Outpost reports for the items it claimed. Returns
    ``{accepted, refused}``; a result for an item this engine did not claim
    (another engine's, another tenant's, one already reported or expired)
    is refused without a trace, a malformed one for its own item fails that
    host with the reason."""
    from .models import DiscoveryWorkItem

    rows = data.get("results") if isinstance(data, dict) else None
    if not isinstance(rows, list):
        raise ValueError("results is a list.")
    if len(rows) > RESULTS_MAX:
        raise ValueError(f"At most {RESULTS_MAX} results per post.")
    ids = {}
    for r in rows:
        try:
            ids[str(uuid.UUID(str(r.get("item_id"))))] = r
        except (AttributeError, ValueError, TypeError):
            continue
    items = DiscoveryWorkItem.objects.filter(
        pk__in=list(ids), engine=engine, tenant_id=engine.tenant_id,
        status="claimed").select_related("run", "run__profile", "run__started_by",
                                         "run__tenant", "device", "virtual_machine",
                                         "ip_address")
    accepted = refused = 0
    runs, changed = set(), {}
    plans: dict = {}
    for item in items:
        r = ids.pop(str(item.pk))
        ok = _ingest_one(engine, item, r, plans, changed)
        accepted += ok
        refused += not ok
        runs.add(item.run_id)
    # Unknown ids, other engines' or tenants' items, ones already reported.
    refused = len(rows) - accepted
    for run_id in runs:
        finish_if_done(run_id)
    for tenant_id, hosts in changed.items():
        if any(hosts.values()):
            from core.models import Tenant

            from .runner import _recompute

            _recompute(Tenant.objects.get(pk=tenant_id), hosts)
    return {"accepted": accepted, "refused": refused}


def _ingest_one(engine, item, r, plans, changed) -> bool:
    from danbyte_checks import inventory, service_scan

    from . import runner, services
    from .models import DiscoveryWorkItem, InventoryRun
    from .scope import Target

    run = item.run
    p = item.payload or {}
    where = label(engine)
    now = timezone.now()
    bad = ""
    result = observed = None
    tried, used = [], None
    try:
        raw = r.get("result") if isinstance(r, dict) else None
        if item.kind == "inventory":
            observed = inventory.verify_host_key(r.get("observed"))
            if p.get("mode") != "observe":
                result = inventory.result_from_dict(raw)
                if result.host_key is not None and not p.get("first_use"):
                    result.host_key = None  # a key is taken only on first use
                logins = p.get("logins") or []
                u = r.get("used")
                used = u if isinstance(u, int) and not isinstance(u, bool) \
                    and 0 <= u < len(logins) else None
                tried = _attempts(r.get("attempts"), logins)
        else:
            if run.pk not in plans:
                plans[run.pk] = services.plan(run.profile)["ports"]
            result = service_scan.host_result_from_dict(raw, address=item.address,
                                                        ports=plans[run.pk])
    except (inventory.WireError, service_scan.WireError, ValueError, AttributeError) as exc:
        bad = f"The Outpost's answer was refused: {exc}"[:300]
        log.warning("discovery: refused a result from Outpost %s for item %s", engine.pk,
                    item.pk)
    with transaction.atomic():
        locked = InventoryRun.objects.select_for_update().filter(pk=run.pk,
                                                                 status="running").first()
        if locked is None or not DiscoveryWorkItem.objects.select_for_update().filter(
                pk=item.pk, status="claimed").update(status="done"):
            return False
        counts = dict(locked.counts or {})
        user = run.started_by if run.trigger == "manual" else None
        hosts = changed.setdefault(run.tenant_id, {"device": set(), "virtual_machine": set()})
        if item.kind == "inventory":
            host = item.device or item.virtual_machine
            t = Target(kind="device" if item.device_id else "virtual_machine", host=host,
                       address=item.address, skip=p.get("skip") or "",
                       message=p.get("message") or "",
                       extra={"skipped": p.get("skipped") or [],
                              "first_use": bool(p.get("first_use"))})
            if bad:
                t.skip, t.message, result, observed = "failed", bad, None, None
            ref = (p.get("logins") or [])[used] if used is not None else {}
            windows_products: set[str] = set()
            row = runner.inventory_row(
                run, t, result, observed, user=user, counts=counts, changed_hosts=hosts,
                transport=ref.get("transport", "") if result is not None else "",
                credential_source=ref.get("source", ""), tried=tried, engine=where,
                windows_products=windows_products)
            if windows_products:
                # A Windows release new to the store: one debounced fetch.
                runner._fetch_windows(windows_products)
        else:
            t = _address_target(item, *(("failed", bad) if bad else ("", "")))
            row = services.host_row(run.tenant, run, t, result if not bad else None, now,
                                    counts, engine=where)
        row.save()
        InventoryRun.objects.filter(pk=run.pk).update(counts=counts)
    return not bad


# ─── expiry ──────────────────────────────────────────────────────────────────


def expire(now=None) -> int:
    """Give up items past their deadline: never claimed (the Outpost did not
    come for them) or claimed and not reported. Returns how many."""
    from .models import DiscoveryWorkItem

    now = now or timezone.now()
    due = DiscoveryWorkItem.objects.filter(status__in=OPEN, deadline__lt=now)
    pending = list(due.filter(status="pending"))
    claimed = list(due.filter(status="claimed"))
    if pending:
        _close_items(pending, "outpost_offline",
                     f"The Outpost did not pick the work up within {UNCLAIMED_MINUTES} "
                     "minutes.", now=now)
    if claimed:
        _close_items(claimed, "timeout", "The Outpost did not report back in time.", now=now)
    return len(pending) + len(claimed)
