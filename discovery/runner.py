"""Run a profile: queue it, re-check it, read the hosts, store the result.

Runs on the RQ ``discovery`` queue (decision 8). The job trusts nothing it
was queued with but the run's id: when it starts it reads the run, the
profile and the tenant again and stops (status ``skipped``) unless
Discovery is still on, the profile is still enabled and authorised, a
scheduled run is inside the profile's window, and the person who pressed
Run now still holds ``scan`` on it. The scope is resolved then too
(``scope.resolve``), so a host that left the tenant, became exempt or went
into maintenance since is not contacted.

Credentials are resolved from the secret store at this point, held in
memory for the connection and dropped; nothing secret is written to the
run, its host results or the log.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, time, timedelta

from django.db import transaction
from django.utils import timezone

log = logging.getLogger(__name__)

QUEUE = "discovery"
JOB_TIMEOUT = 6 * 3600
#: A queued or running run older than this is given up (its worker died).
STALE_AFTER = timedelta(hours=6)
CONCURRENCY_MAX = 16
TIMEOUT_RANGE = (10, 600)
OPEN = ("queued", "running")
#: Host results that mean "left alone by a rule", not "something is wrong".
DELIBERATE = ("exempt", "denied", "maintenance")


class RunRefused(Exception):
    def __init__(self, message: str, status: int = 409):
        super().__init__(message)
        self.message = message
        self.status = status


def in_window(profile, now: datetime | None = None) -> bool:
    """Whether ``now`` (server time) is inside the profile's daily window;
    no window = always. An end before the start spans midnight."""
    start, end = profile.window_start, profile.window_end
    if start is None and end is None:
        return True
    now = timezone.localtime(now or timezone.now()).time()
    start = start or time(0, 0)
    end = end or time(23, 59, 59)
    if start <= end:
        return start <= now <= end
    return now >= start or now <= end


def can_run(profile) -> str:
    """Why the profile cannot run now; "" when it can."""
    from .gate import active

    if not active(profile.tenant):
        return "Discovery is off."
    if not profile.enabled:
        return "The profile is disabled."
    if not profile.authorised:
        return "Record who authorised this profile before it runs."
    if not in_window(profile):
        return "Outside the profile's window."
    return ""


def start(profile, *, user=None, trigger="manual"):
    """Queue a run of ``profile``. Raises :class:`RunRefused`."""
    from .models import InventoryRun

    reason = can_run(profile)
    if reason:
        raise RunRefused(reason)
    with transaction.atomic():
        # One open run per profile.
        type(profile).objects.select_for_update().filter(pk=profile.pk).first()
        if InventoryRun.objects.filter(profile=profile, status__in=OPEN).exists():
            raise RunRefused("This profile is already running.")
        run = InventoryRun.objects.create(
            tenant=profile.tenant, profile=profile, trigger=trigger,
            started_by=user if user is not None and user.is_authenticated else None,
            started_by_name=user.get_username() if user is not None else "")
    transaction.on_commit(lambda: enqueue(run))
    return run


def enqueue(run) -> None:
    from .models import InventoryRun

    try:
        import django_rq

        django_rq.get_queue(QUEUE).enqueue(execute, str(run.pk), job_timeout=JOB_TIMEOUT)
    except Exception:  # noqa: BLE001 - Redis down: never run hosts inside a request
        log.warning("RQ unavailable; discovery run %s not started", run.pk)
        InventoryRun.objects.filter(pk=run.pk, status="queued").update(
            status="failed", finished_at=timezone.now(),
            errors=["The background workers are not reachable."])


def _skip(run, message: str) -> None:
    from .models import InventoryRun

    InventoryRun.objects.filter(pk=run.pk).update(
        status="skipped", finished_at=timezone.now(), errors=[message])


def _still_allowed(run) -> str:
    """Why a queued run must not go ahead now; "" when it may."""
    from auth_api import rbac

    profile = run.profile
    reason = can_run(profile)
    if reason:
        return reason
    if run.trigger == "manual":
        user = run.started_by
        if user is None or not user.is_active:
            return "The person who started it no longer has an account."
        if not user.is_superuser and not rbac.can_act_on(
                user, profile.tenant, "inventoryprofile", "scan", profile):
            return "The person who started it may no longer run this profile."
    return ""


def _credential(target) -> dict | None:
    """The connect arguments for a target, secret included, or None when
    the secret cannot be read (the reason goes on the host result)."""
    from monitoring.secret_store import SecretStoreDisabled, SecretStoreError

    cred = target.credential
    try:
        secret = cred.resolve_secret() or {}
    except (SecretStoreDisabled, SecretStoreError):
        target.skip, target.message = "no_credential", "The credential's secret cannot be read."
        return None
    out = {"username": cred.username or "root", "known_hosts": target.known_hosts}
    if cred.kind == "ssh_key":
        out.update(private_key=secret.get("private_key") or "",
                   passphrase=secret.get("passphrase") or None)
    else:
        out["password"] = secret.get("password") or ""
    return out


async def _read_all(work: list, concurrency: int, timeout: float, collect, observe):
    sem = asyncio.Semaphore(concurrency)

    async def one(target, cred):
        async with sem:
            port = target.credential.port or 22
            result = await collect(target.address, port=port, timeout=timeout, **cred)
            observed = None
            if result.status == "host_key_refused":
                observed = await observe(target.address, port=port, timeout=min(timeout, 10))
            return target, result, observed

    return await asyncio.gather(*(one(t, c) for t, c in work))


def execute(run_id: str, *, collect=None, observe=None) -> dict | None:
    """The RQ job. ``collect``/``observe`` are injectable for tests (the
    defaults are :func:`danbyte_checks.inventory.collect` and
    ``observe_host_key``)."""
    from danbyte_checks import inventory

    from . import packages, scope
    from .models import InventoryHostResult, InventoryProfile, InventoryRun

    collect = collect or inventory.collect
    observe = observe or inventory.observe_host_key
    run = InventoryRun.objects.select_related("profile", "profile__tenant", "started_by").filter(
        pk=run_id, status="queued").first()
    if run is None:
        return None
    reason = _still_allowed(run)
    if reason:
        _skip(run, reason)
        return None
    profile = run.profile
    tenant = profile.tenant
    now = timezone.now()
    InventoryRun.objects.filter(pk=run.pk).update(status="running", started_at=now)
    InventoryProfile.objects.filter(pk=profile.pk).update(last_run_at=now)

    user = run.started_by if run.trigger == "manual" else None
    targets = scope.resolve(profile, user=user, now=now)
    errors: list[str] = []
    if scope.truncated(profile, user=user):
        errors.append(f"More than {scope.MAX_HOSTS} hosts in scope; the rest were not read.")
    work = []
    for t in targets:
        if t.skip:
            continue
        cred = _credential(t)
        if cred is not None:
            work.append((t, cred))
    concurrency = max(1, min(CONCURRENCY_MAX, profile.max_concurrency or 1))
    timeout = float(max(TIMEOUT_RANGE[0], min(TIMEOUT_RANGE[1], profile.timeout_seconds or 60)))
    try:
        results = asyncio.run(_read_all(work, concurrency, timeout, collect, observe)) \
            if work else []
    finally:
        # The secrets go with the work list.
        work.clear()

    counts = {"hosts": len(targets), "ok": 0, "packages": 0, "changed": 0}
    by_target = {id(t): (r, o) for t, r, o in results}
    rows, changed_hosts = [], {"device": set(), "virtual_machine": set()}
    for t in targets:
        r, observed = by_target.get(id(t), (None, None))
        status, message = (t.skip, t.message) if r is None else (r.status, r.message)
        row = InventoryHostResult(
            tenant=tenant, run=run, address=t.address, status=status or "failed",
            message=(message or "")[:300], finished_at=timezone.now(),
            transport="ssh" if r is not None else "",
            **{t.kind: t.host})
        if r is not None and r.status == "ok":
            try:
                stored = packages.store(tenant, t.host, run, r)
            except Exception:  # noqa: BLE001 - one bad host never fails the run
                log.exception("discovery: storing packages for %s failed", t.host.pk)
                row.status, row.message = "failed", "Its packages could not be stored."
            else:
                row.packages, row.added = stored["packages"], stored["added"]
                row.removed, row.updated = stored["removed"], stored["updated"]
                counts["ok"] += 1
                counts["packages"] += stored["packages"]
                if stored["changed"]:
                    counts["changed"] += 1
                    changed_hosts[t.kind].add(t.host.pk)
                if r.truncated:
                    row.message = f"Only the first {inventory.MAX_PACKAGES} packages were kept."
        if observed:
            _record_key(tenant, t.host, observed)
        if row.status != "ok":
            # Per-host reasons live on the host results, which read with
            # the host's own view; the run's errors name no host.
            counts[row.status] = counts.get(row.status, 0) + 1
        rows.append(row)
    InventoryHostResult.objects.bulk_create(rows, batch_size=1000)

    # Left alone on purpose is not a failure; anything else that was not
    # read is.
    problems = [r for r in rows if r.status not in ("ok", *DELIBERATE)]
    if not problems:
        status = "ok"
    else:
        status = "partial" if counts["ok"] else "failed"
    InventoryRun.objects.filter(pk=run.pk).update(
        status=status, finished_at=timezone.now(), counts=counts, errors=errors)
    if any(changed_hosts.values()):
        _recompute(tenant, changed_hosts)
    return counts


def _record_key(tenant, host, observed: dict) -> None:
    """Fold the key a refused host presented into the host-key inventory as
    *observed* - never accepted; a person accepts it."""
    from monitoring.ssh_host_keys import record_host_key

    try:
        record_host_key(tenant, host, observed)
    except Exception:  # noqa: BLE001 - inventory bookkeeping never fails the run
        log.exception("discovery: recording the observed host key failed")


def _recompute(tenant, hosts: dict) -> None:
    """Re-match the hosts whose packages changed (vulnerability data on)."""
    from vulnerabilities import jobs
    from vulnerabilities.models import VulnerabilitySettings

    if not VulnerabilitySettings.objects.filter(pk=1, enabled=True).exists():
        return
    jobs.enqueue_objects(tenant.pk, {k: v for k, v in hosts.items() if v})


def abandon_stale(now=None) -> int:
    from .models import InventoryRun

    now = now or timezone.now()
    return InventoryRun.objects.filter(status__in=OPEN, created_at__lt=now - STALE_AFTER).update(
        status="failed", finished_at=now, errors=["The run did not finish; given up."])


def dispatch(now=None) -> dict:
    """The timer's beat: purge long-removed packages, give up stale runs,
    queue every due profile in a tenant with Discovery on."""
    from . import packages
    from .gate import active_tenant_ids
    from .models import InventoryProfile, InventoryRun

    now = now or timezone.now()
    out = {"purged": packages.purge_removed(now), "abandoned": abandon_stale(now), "queued": 0}
    tenants = active_tenant_ids()
    if not tenants:
        return out
    busy = set(InventoryRun.objects.filter(status__in=OPEN).values_list("profile_id", flat=True))
    for profile in InventoryProfile.objects.filter(
            tenant_id__in=tenants, enabled=True, authorised_at__isnull=False,
            interval_hours__gt=0).select_related("tenant"):
        if profile.pk in busy or not profile.authorised:
            continue
        if profile.last_run_at and profile.last_run_at > now - timedelta(
                hours=profile.interval_hours):
            continue
        if not in_window(profile, now):
            continue
        try:
            start(profile, trigger="schedule")
        except RunRefused:
            continue
        out["queued"] += 1
    return out
