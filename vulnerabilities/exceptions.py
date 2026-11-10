"""Which exception covers which match (#451, decision 13).

An exception covers the tenant's open matches of its record within its
scope:

=================== =====================================================
``device``          the device's matches (platform and installs)
``virtual_machine`` the VM's matches
``platform``        matches through a mapping of that platform
``application``     matches through a mapping of that application
``tenant``          every match of the record in the tenant
=================== =====================================================

It applies through ``expires_on`` (no date: until it is removed). When
several apply, the most specific wins (host, then platform/application,
then tenant; newest first among equals), and ``VulnerabilityMatch.excepted``
points at it.

``excepted`` is kept current by:

* the recompute, for every row it writes (``Resolver`` below);
* :func:`apply`, when an exception is saved or deleted (signals, in the
  same transaction) and from the daily expiry job.

``apply`` takes the recompute's per-tenant advisory lock, so a recompute
inserting rows cannot slip past it.
"""
from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable

from django.db import transaction
from django.db.models import Q
from django.db.models.signals import post_delete, post_save
from django.utils import timezone

CHUNK = 5000
#: Lower wins.
_RANK = {"device": 0, "virtual_machine": 0, "platform": 1, "application": 1, "tenant": 2}


def active_q(today=None) -> Q:
    today = today or timezone.localdate()
    return Q(expires_on__isnull=True) | Q(expires_on__gte=today)


class Resolver:
    """The tenant's active exceptions, indexed per record, answering which
    one covers a match. ``cve_pks`` narrows the load to some records."""

    def __init__(self, tenant_id, cve_pks: Iterable | None = None, today=None):
        from .models import VulnerabilityException

        qs = VulnerabilityException.objects.filter(tenant_id=tenant_id).filter(
            active_q(today))
        if cve_pks is not None:
            qs = qs.filter(cve_id__in=list(cve_pks))
        self._by_cve: dict = defaultdict(list)
        rows = qs.values_list("pk", "cve_id", "device_id", "virtual_machine_id",
                              "platform_id", "application_id", "created_at")
        for pk, cve_id, dev, vm, plat, app, created in rows:
            scope = ("device" if dev else "virtual_machine" if vm else "platform" if plat
                     else "application" if app else "tenant")
            self._by_cve[cve_id].append((_RANK[scope], -created.timestamp(), pk,
                                         dev, vm, plat, app))
        for v in self._by_cve.values():
            v.sort()

    def __bool__(self) -> bool:
        return bool(self._by_cve)

    def covering(self, cve_id, device_id, vm_id, platform_id, application_id):
        """The id of the exception that covers this match, or None."""
        for _rank, _age, pk, dev, vm, plat, app in self._by_cve.get(cve_id, ()):
            if dev is not None:
                if dev == device_id:
                    return pk
            elif vm is not None:
                if vm == vm_id:
                    return pk
            elif plat is not None:
                if plat == platform_id:
                    return pk
            elif app is not None:
                if app == application_id:
                    return pk
            else:
                return pk
        return None


def apply(tenant_id, cve_pks: Iterable | None = None, today=None) -> int:
    """Bring ``excepted`` up to date on the tenant's open matches (of
    ``cve_pks`` only, when given). Returns how many rows changed."""
    from .matching import _lock
    from .models import VulnerabilityMatch

    cve_pks = None if cve_pks is None else list(set(cve_pks))
    if cve_pks is not None and not cve_pks:
        return 0
    changed = 0
    with transaction.atomic():
        _lock(tenant_id)
        resolver = Resolver(tenant_id, cve_pks, today)
        rows = VulnerabilityMatch.objects.filter(tenant_id=tenant_id, resolved_at__isnull=True)
        if cve_pks is not None:
            rows = rows.filter(cve_id__in=cve_pks)
        if not resolver:
            # Nothing applies: one statement clears what is set.
            return rows.filter(excepted__isnull=False).update(excepted=None)
        by_target: dict = defaultdict(list)
        for pk, cve_id, dev, vm, plat, app, have in rows.values_list(
                "pk", "cve_id", "device_id", "virtual_machine_id", "mapping__platform_id",
                "mapping__application_id", "excepted_id"):
            want = resolver.covering(cve_id, dev, vm, plat, app)
            if want != have:
                by_target[want].append(pk)
        for target, pks in by_target.items():
            for i in range(0, len(pks), CHUNK):
                changed += VulnerabilityMatch.objects.filter(pk__in=pks[i:i + CHUNK]).update(
                    excepted_id=target)
    return changed


def cyclonedx_analysis(exc) -> dict:
    """The exception as a CycloneDX 1.5 ``vulnerabilities[].analysis``
    (addendum C): not applicable → ``not_affected`` with its justification,
    risk accepted → ``exploitable`` with ``will_not_fix``, the expiry in
    ``detail``."""
    from .models import STATUS_STATES

    state = exc.analysis_state or STATUS_STATES[exc.status][0]
    out = {"state": state}
    if exc.analysis_justification and state == "not_affected":
        out["justification"] = exc.analysis_justification
    response = list(exc.analysis_response or [])
    if not response and exc.status == "risk_accepted":
        response = ["will_not_fix"]
    if response:
        out["response"] = response
    detail = exc.reason.strip()
    if exc.expires_on:
        detail = f"{detail}\n\nAccepted until {exc.expires_on.isoformat()}.".strip()
    out["detail"] = detail
    return out


# ─── signals: re-resolve the record's matches after a save or delete ─────────
# In the same transaction, so the flags commit (or roll back) with the
# exception. Only the one record's open matches are read.


def _changed(sender, instance, raw=False, **kwargs):
    if raw or not instance.tenant_id or not instance.cve_id:
        return
    apply(instance.tenant_id, [instance.cve_id])


def connect() -> None:
    from .models import VulnerabilityException

    post_save.connect(_changed, sender=VulnerabilityException, dispatch_uid="vuln-exc-save")
    post_delete.connect(_changed, sender=VulnerabilityException, dispatch_uid="vuln-exc-del")
