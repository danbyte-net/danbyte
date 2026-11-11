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
OUTSIDE_WINDOW = "Outside the profile's window."


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
    if profile.runs_on == "outpost" and profile.outpost_id is None:
        return "Pick the Outpost this profile runs on."
    if not in_window(profile):
        return OUTSIDE_WINDOW
    return ""


def start(profile, *, user=None, trigger="manual", accept_new_host_keys=False):
    """Queue a run of ``profile``. Raises :class:`RunRefused`.
    ``accept_new_host_keys`` is for Run now only; the caller has checked
    the person may accept host keys (the job checks again)."""
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
            started_by_name=user.get_username() if user is not None else "",
            kind=profile.kind,
            accept_new_host_keys=bool(accept_new_host_keys and trigger == "manual"
                                      and profile.kind == "inventory"))
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


def _still_allowed(run, *, window: bool = True) -> str:
    """Why a queued run must not go ahead now; "" when it may. ``window``:
    also the profile's window (a run on Outposts is checked again when an
    Outpost picks its work up, and a run that started inside its window may
    finish after it)."""
    from auth_api import rbac

    profile = run.profile
    reason = can_run(profile)
    if reason and (window or reason != OUTSIDE_WINDOW):
        return reason
    if run.trigger == "manual":
        user = run.started_by
        if user is None or not user.is_active:
            return "The person who started it no longer has an account."
        if not user.is_superuser and not rbac.can_act_on(
                user, profile.tenant, "inventoryprofile", "scan", profile):
            return "The person who started it may no longer run this profile."
    return ""


def _credential(login, known_hosts) -> dict | None:
    """The connect arguments for one login, secret included, or None when
    its secret cannot be read."""
    from monitoring.secret_store import SecretStoreDisabled, SecretStoreError

    cred = login.credential
    try:
        secret = cred.resolve_secret() or {}
    except (SecretStoreDisabled, SecretStoreError):
        return None
    if cred.kind == "winrm_cert":
        return {"certificate": secret.get("certificate") or "",
                "private_key": secret.get("private_key") or "",
                "passphrase": secret.get("passphrase") or None}
    out = {"username": cred.username or "root", "known_hosts": known_hosts}
    if cred.kind == "ssh_key":
        out.update(private_key=secret.get("private_key") or "",
                   passphrase=secret.get("passphrase") or None)
    else:
        out["password"] = secret.get("password") or ""
    return out


def transport_of(login) -> str:
    from .scope import KIND_TRANSPORT

    return KIND_TRANSPORT.get(login.kind, "")


def try_next(login, status: str, nxt) -> bool:
    """After ``login`` answered ``status``, may ``nxt`` be tried? The rule
    is ``danbyte_checks.inventory.may_try_next``, shared with Outposts."""
    from danbyte_checks.inventory import may_try_next

    return may_try_next(transport_of(login), login.fall_through, status,
                        transport_of(nxt) if nxt is not None else None)


def login_dicts(creds) -> list[dict]:
    """``[(Login, cred)]`` as the plain logins
    ``danbyte_checks.inventory.read_with_logins`` takes."""
    return [{"transport": transport_of(login), "port": login.credential.port,
             "fall_through": login.fall_through, "credential": cred}
            for login, cred in creds]


async def _read_all(work: list, concurrency: int, timeout: float, collect, observe,
                    collect_winrm=None):
    """``work``: ``(target, mode)`` - ``read`` tries the target's logins
    most secure transport first (``danbyte_checks.inventory.read_with_logins``,
    the loop Outposts run too), ``observe`` only reads the host key (a key
    exchange, no login). Returns ``(target, result, observed, login,
    attempts)``."""
    from danbyte_checks.inventory import read_with_logins

    sem = asyncio.Semaphore(concurrency)

    async def read(target):
        creds = target.extra["creds"]
        result, observed, used, tried = await read_with_logins(
            target.address, login_dicts(creds), known_hosts=target.known_hosts,
            first_use=bool(target.extra.get("first_use")), timeout=timeout,
            collect=collect, observe=observe, collect_winrm=collect_winrm,
            server_name=target.extra.get("server_name") or "")
        return target, result, observed, creds[used][0] if used is not None else None, tried

    async def one(target, mode):
        async with sem:
            if mode == "observe":
                port = target.extra.get("port") or 22
                return target, None, await observe(target.address, port=port,
                                                   timeout=min(timeout, 10)), None, []
            return await read(target)

    return await asyncio.gather(*(one(t, m) for t, m in work))


def _first_use_allowed(run, user) -> tuple[bool, str]:
    """Whether a run may accept new host keys on first use now: Run now
    only, the deployment allows it, the starter still holds ``change`` on
    SSH host keys. Returns ``(allowed, why_not)``."""
    from django.conf import settings

    from auth_api import rbac

    if not run.accept_new_host_keys:
        return False, ""
    if run.trigger != "manual" or user is None:
        return False, "Scheduled runs never accept new host keys."
    if not getattr(settings, "DISCOVERY_ALLOW_FIRST_USE_KEYS", True):
        return False, "This deployment does not allow accepting host keys on first use."
    if not user.is_superuser and not rbac.has_action(
            user, run.tenant, "sshhostkey", "change"):
        return False, "The person who started it may no longer accept host keys."
    return True, ""


def _key_sites(user, tenant):
    """Sites whose host keys ``user`` may change (``None`` = any)."""
    from auth_api import rbac

    if user is None or user.is_superuser:
        return None
    return rbac.site_scope(user, tenant, "sshhostkey", "change")


def _accept_first_use(run, tenant, host, key: dict, user) -> bool:
    """Record ``key`` for ``host`` and mark it accepted, change-logged as
    the person who started the run, with the run named as the cause. Only
    while the host still has no accepted key."""
    from audit import context as audit_context
    from monitoring.models import SSHHostKey
    from monitoring.ssh_host_keys import _host_kwargs, accept_observed, record_host_key

    if SSHHostKey.objects.filter(tenant=tenant, uploaded=True, **_host_kwargs(host)).exists():
        return False
    audit_context.set_context(user, str(run.pk), "")
    try:
        with audit_context.cause(f"Accepted on first use by discovery run {run.pk}"):
            row = record_host_key(tenant, host, key)
            if row is None:
                return False
            accept_observed(row)
    finally:
        audit_context.clear_context()
    return True


def run_outcome(rows) -> str:
    """The run status from its host results, ``[(status, contacted)]``:

    * ``ok`` - every host was read or left alone on purpose;
    * ``nothing_read`` - no host was logged in to, because each was left
      alone before a login (no credential, no accepted key, no address …):
      nothing failed, there was nothing to read with;
    * ``failed`` - logins were tried and none read;
    * ``partial`` - some read, some not.
    """
    ok = sum(1 for status, _c in rows if status == "ok")
    problems = [(st, c) for st, c in rows if st not in ("ok", *DELIBERATE)]
    if not problems:
        return "ok"
    if ok:
        return "partial"
    if not any(c for _st, c in problems):
        return "nothing_read"
    return "failed"


SUMMARY_LABELS = {
    "no_credential": "without a credential",
    "host_key_refused": "without an accepted host key",
    "no_address": "without an address",
    "exempt": "exempt",
    "denied": "in a deny subnet",
    "maintenance": "in maintenance",
    "blocked": "refused by the target policy",
    "auth_failed": "refused the login",
    "tls_refused": "with an untrusted TLS certificate",
    "unreachable": "unreachable",
    "timeout": "timed out",
    "unsupported": "unsupported",
    "failed": "failed",
}


def summary(counts: dict) -> str:
    """One line by reason: "61 without a credential, 3 unreachable"."""
    parts = []
    if "services" in counts:
        # A service scan.
        if counts.get("ok"):
            parts.append(f"{counts['ok']} scanned")
        parts.append(f"{counts.get('services', 0)} open ports")
        if counts.get("new"):
            parts.append(f"{counts['new']} new")
        if counts.get("gone"):
            parts.append(f"{counts['gone']} closed since")
    elif counts.get("ok"):
        parts.append(f"{counts['ok']} read")
    for status, label in SUMMARY_LABELS.items():
        n = counts.get(status)
        if n:
            parts.append(f"{n} {label}")
    if counts.get("keys_accepted"):
        parts.append(f"{counts['keys_accepted']} keys accepted on first use")
    return ", ".join(parts)


def execute(run_id: str, *, collect=None, observe=None, collect_winrm=None,
            scanner=None) -> dict | None:
    """The RQ job. ``collect``/``observe``/``collect_winrm`` are injectable
    for tests (the defaults are :func:`danbyte_checks.inventory.collect`,
    ``observe_host_key`` and :func:`discovery.winrm.collect`); ``scanner``
    for a service scan (``services.execute``)."""
    from danbyte_checks import inventory

    from . import winrm
    from .models import InventoryHostResult, InventoryProfile, InventoryRun

    collect = collect or inventory.collect
    observe = observe or inventory.observe_host_key
    collect_winrm = collect_winrm or winrm.collect
    run = InventoryRun.objects.select_related(
        "profile", "profile__tenant", "profile__shared_credential", "started_by").filter(
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
    if profile.runs_on != "server":
        # On Outposts: the scope and its rules are resolved here, the work
        # is queued for the Outposts, and the run finishes as their results
        # come back (``discovery.outposts``). Never on the server instead.
        from . import outposts

        return outposts.dispatch(run, profile, user=user, now=now)
    if run.kind == "service_scan":
        from . import services

        counts, errors = services.execute(run, profile, user=user, now=now, scanner=scanner)
        rows = list(InventoryHostResult.objects.filter(run=run).values_list("status", flat=True))
        # "failed" was contacted (or meant to be); the rest are rules.
        status = run_outcome([(st, st == "failed") for st in rows]) if rows else (
            "failed" if errors else "ok")
        InventoryRun.objects.filter(pk=run.pk).update(
            status=status, finished_at=timezone.now(), counts=counts, errors=errors[:50])
        return counts
    targets, work, errors = inventory_work(run, profile, user=user, now=now)
    read = []
    for t, mode in work:
        if mode == "observe":
            read.append((t, mode))
            continue
        creds = []
        for login in t.logins:
            cred = _credential(login, t.known_hosts)
            if cred is not None:
                creds.append((login, cred))
        if not creds:
            t.skip, t.message = "no_credential", "The credential's secret cannot be read."
            continue
        t.extra["creds"] = creds
        read.append((t, "read"))
    work = read
    concurrency = max(1, min(CONCURRENCY_MAX, profile.max_concurrency or 1))
    timeout = host_timeout(profile)
    try:
        results = asyncio.run(_read_all(work, concurrency, timeout, collect, observe,
                                        collect_winrm)) if work else []
    finally:
        # The secrets go with the work list.
        for t, _mode in work:
            t.extra.pop("creds", None)
        work.clear()

    counts = {"hosts": len(targets), "ok": 0, "packages": 0, "changed": 0}
    by_target = {id(t): (r, o, login, tried) for t, r, o, login, tried in results}
    rows, outcome, changed_hosts = [], [], {"device": set(), "virtual_machine": set()}
    windows_products: set[str] = set()
    for t in targets:
        r, observed, login, tried = by_target.get(id(t), (None, None, None, []))
        row = inventory_row(
            run, t, r, observed, user=user, counts=counts, changed_hosts=changed_hosts,
            transport=transport_of(login) if (r is not None and login is not None) else "",
            credential_source=login.source if login is not None else "", tried=tried,
            windows_products=windows_products)
        rows.append(row)
        outcome.append((row.status, r is not None))
    InventoryHostResult.objects.bulk_create(rows, batch_size=1000)

    InventoryRun.objects.filter(pk=run.pk).update(
        status=run_outcome(outcome), finished_at=timezone.now(), counts=counts,
        errors=errors)
    if any(changed_hosts.values()):
        _recompute(tenant, changed_hosts)
    if windows_products:
        _fetch_windows(windows_products)
    return counts


def host_timeout(profile) -> float:
    return float(max(TIMEOUT_RANGE[0], min(TIMEOUT_RANGE[1], profile.timeout_seconds or 60)))


def inventory_work(run, profile, *, user=None, now=None, outpost: bool = False):
    """Resolve an inventory run's scope and say what to do with each host:
    ``(targets, work, errors)`` with ``work`` a list of ``(target, mode)``,
    ``read`` (log in with ``target.logins``) or ``observe`` (only read the
    key it presents). First-use acceptance is decided here. Shared by server
    runs and runs on Outposts; no secret is read."""
    from . import scope

    tenant = profile.tenant
    targets = scope.resolve(profile, user=user, now=now, outpost=outpost)
    errors: list[str] = []
    if scope.truncated(profile, user=user):
        errors.append(f"More than {scope.MAX_HOSTS} hosts in scope; the rest were not read.")
    first_use, why_not = _first_use_allowed(run, user)
    if why_not:
        errors.append(why_not)
    key_sites = _key_sites(user, tenant) if first_use else None
    work = []
    for t in targets:
        if t.skip == "host_key_refused" and t.extra.get("no_key") and first_use \
                and (key_sites is None or getattr(t.host, "site_id", None) in key_sites):
            t.skip, t.message = "", ""
            t.extra["first_use"] = True
        if t.address and (t.skip == "no_credential" or t.extra.get("no_key")) and t.skip:
            # Every rule before these passed: read the key it presents (a
            # key exchange, no login) so a person can review and accept it.
            t.extra["port"] = (t.credential.port if t.credential is not None else None) or 22
            work.append((t, "observe"))
            continue
        if t.skip:
            continue
        work.append((t, "read"))
    return targets, work, errors


def inventory_row(run, t, r, observed, *, user, counts: dict, changed_hosts: dict,
                  transport: str = "", credential_source: str = "", tried=(),
                  engine: str = "server", windows_products: set | None = None):
    """The (unsaved) host result for target ``t`` and its read ``r`` (an
    ``InventoryResult``, ``None`` when it was never contacted): accepts a
    first-use key, stores the packages of a read host, records an observed
    key, and adds to ``counts`` / ``changed_hosts``. Shared by server runs
    and the Outpost ingest, so both store a host the same way."""
    from danbyte_checks import inventory

    from . import packages
    from .models import InventoryHostResult

    tenant = run.tenant
    status, message = (t.skip, t.message) if r is None else (r.status, r.message)
    row = InventoryHostResult(
        tenant=tenant, run=run, address=t.address, status=status or "failed",
        message=(message or "")[:300], finished_at=timezone.now(),
        transport=transport if r is not None else "",
        credential_source=(credential_source or "")[:140],
        attempts=[*t.extra.get("skipped", []), *tried][:10], engine=engine[:64],
        **{t.kind: t.host})
    if r is not None and t.extra.get("first_use") and r.host_key:
        try:
            row.key_first_use = _accept_first_use(run, tenant, t.host, r.host_key, user)
        except Exception:  # noqa: BLE001 - bookkeeping never fails the run
            log.exception("discovery: accepting a first-use key failed")
        if row.key_first_use:
            counts["keys_accepted"] = counts.get("keys_accepted", 0) + 1
    if r is not None and r.status == "ok":
        try:
            stored = packages.store(tenant, t.host, run, r, transport=row.transport)
        except Exception:  # noqa: BLE001 - one bad host never fails the run
            log.exception("discovery: storing packages for %s failed", t.host.pk)
            row.status, row.message = "failed", "Its packages could not be stored."
        else:
            row.packages, row.added = stored["packages"], stored["added"]
            row.removed, row.updated = stored["removed"], stored["updated"]
            counts["ok"] = counts.get("ok", 0) + 1
            counts["packages"] = counts.get("packages", 0) + stored["packages"]
            if windows_products is not None:
                windows_products.update(stored.get("windows_products") or ())
            if stored["changed"]:
                counts["changed"] = counts.get("changed", 0) + 1
                changed_hosts[t.kind].add(t.host.pk)
            if r.truncated:
                row.message = f"Only the first {inventory.MAX_PACKAGES} packages were kept."
    if observed:
        _record_key(tenant, t.host, observed)
    if row.status != "ok":
        # Per-host reasons live on the host results, which read with
        # the host's own view; the run's errors name no host.
        counts[row.status] = counts.get(row.status, 0) + 1
    return row


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


def _fetch_windows(keys: set[str]) -> None:
    """A Windows release no Microsoft month was read for: ask the server
    fetch for it now (one job per run; nothing outside server mode)."""
    from vulnerabilities import fetch

    try:
        fetch.fetch_new_windows(keys)
    except Exception:  # noqa: BLE001 - best effort; the daily run covers it
        log.exception("discovery: queueing the Microsoft fetch failed")


def abandon_stale(now=None) -> int:
    from .models import DiscoveryWorkItem, InventoryRun

    now = now or timezone.now()
    # A run on Outposts whose items are still within their deadlines is
    # not stale: they expire on their own (``outposts.expire``).
    stale = InventoryRun.objects.filter(
        status__in=OPEN, created_at__lt=now - STALE_AFTER).exclude(
        work_items__status__in=("pending", "claimed"), work_items__deadline__gte=now)
    DiscoveryWorkItem.objects.filter(run__in=stale, status__in=OPEN).update(status="expired")
    return stale.update(
        status="failed", finished_at=now, errors=["The run did not finish; given up."])


def dispatch(now=None) -> dict:
    """The timer's beat: purge long-removed packages, give up stale runs,
    queue every due profile in a tenant with Discovery on."""
    from . import outposts, packages
    from .gate import active_tenant_ids
    from .models import InventoryProfile, InventoryRun

    now = now or timezone.now()
    out = {"purged": packages.purge_removed(now), "expired": outposts.expire(now),
           "abandoned": abandon_stale(now), "queued": 0}
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
