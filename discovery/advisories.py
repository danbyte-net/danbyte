"""Whether the vulnerability store has advisory data for a host's packages
yet (#451), so the Packages tab and a run's summary can say why no CVEs
show.

Cheap by design: no per-package lookup. The store records every update
as a :class:`~vulnerabilities.models.SyncRun`; one that finished ``ok``
with an OSV part (a server or browser sync that asked OSV, or an OSV
upload) is an advisory fetch. Packages read after the last one are not
covered yet - their advisories, if any, are not in the store. Two queries:
the last such fetch, and whether an update is running.

``state``: ``fetched`` (the last fetch is newer than the packages),
``not_fetched`` (browser or upload mode: someone has to sync or import),
``queued`` (server mode: the fetch for new packages is queued after a read,
or the daily run takes them), ``running`` (an update is running now).
None while vulnerability data is off or nothing is matched (Windows
programs only).
"""
from __future__ import annotations

from django.db.models import Q


def last_fetch():
    """When the last advisory fetch finished, or None."""
    from vulnerabilities.models import SyncRun

    return SyncRun.objects.filter(status="ok").filter(
        Q(via__in=("server", "browser"), counts__has_key="osv")
        | Q(via="upload", plan__kind="osv")).order_by("-finished_at").values_list(
        "finished_at", flat=True).first()


def state(newest, request=None) -> dict | None:
    """The advisory state for packages first seen at ``newest`` (a datetime;
    None = nothing matched)."""
    from vulnerabilities.models import SyncRun, VulnerabilitySettings

    if newest is None:
        return None
    vs = VulnerabilitySettings.objects.filter(pk=1).only("enabled", "update_source").first()
    if vs is None or not vs.enabled:
        return None
    last = last_fetch()
    mode = vs.update_source
    if last is not None and last >= newest:
        st = "fetched"
    elif SyncRun.objects.filter(status="running").exists():
        st = "running"
    else:
        st = "queued" if mode == "server" else "not_fetched"
    out = {"mode": mode, "state": st, "last_fetch": last}
    if request is not None:
        from auth_api.permissions import can_manage_deployment

        out["can_sync"] = can_manage_deployment(request.user)
    return out


def host_state(tenant, kind: str, host, request=None) -> dict | None:
    """:func:`state` for one host's current matched packages (one aggregate)."""
    from django.db.models import Max

    from .models import MATCHED_TYPES, HostPackage

    newest = HostPackage.objects.filter(
        tenant=tenant, removed_at__isnull=True, purl_type__in=MATCHED_TYPES,
        **{kind: host}).aggregate(n=Max("first_seen"))["n"]
    return state(newest, request)


def run_state(run, request=None) -> dict | None:
    """:func:`state` for a finished inventory run that brought packages new
    to the host (``counts["new_packages"]``); its start stands for them."""
    counts = run.counts or {}
    if run.kind != "inventory" or not counts.get("new_packages") or run.finished_at is None:
        return None
    return state(run.started_at or run.finished_at, request)
