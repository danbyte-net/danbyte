"""Inventoried packages → installed software (#451).

An application that names packages (``Application.package_names``) is
installed on every host whose last read found one of them. After each read,
and when an application's package names change, :func:`sync_installs`
brings the installs in line, in bulk - a handful of statements whatever
the hosts and packages:

* no install of the application on the host: one is created with source
  ``discovery`` (the value the service-scan review queue uses), the
  package's upstream version, ``observed_version`` and ``last_seen``;
* a Discovery install: its version follows the package (a change-logged
  update), ``observed_version`` and ``last_seen`` are kept current;
* an install a person made (manual, import, group): never written over.
  Only ``observed_version`` and ``last_seen`` move, so the page can say
  "Discovery reads 1.26.0" when the two differ;
* the package is gone from a host that was read: a Discovery install the
  packages made (``observed_version`` set) is deleted - through the change
  log, which keeps the row as it was; the package itself keeps its
  ``removed_at`` history for 30 days. A person's install only loses its
  ``observed_version``. A Discovery install made from a service-scan
  finding (never linked to a package) is left alone.

Creates, version changes and deletes are change-logged (cause: the
package inventory); ``observed_version`` and ``last_seen`` are bookkeeping,
written by UPDATE outside the change log, like HostPackage's own fields.
"""
from __future__ import annotations

import re
from collections import defaultdict

from django.db import transaction
from django.db.models import Q
from django.utils import timezone

CAUSE = "Package inventory"
_EPOCH = re.compile(r"^\d+:")
_APK_REL = re.compile(r"-r\d+$")


def upstream_version(ptype: str, version: str) -> str:
    """The software's own version out of a package version: Debian's
    ``1:2.4.62-1~deb12u2`` → ``2.4.62``, RPM's ``1.20.1-14.el9`` →
    ``1.20.1``, Alpine's ``1.26.2-r0`` → ``1.26.2``; a Windows program's
    as it is."""
    v = (version or "").strip()
    if ptype in ("deb", "rpm"):
        v = _EPOCH.sub("", v)
        if "-" in v:
            v = v.rsplit("-", 1)[0]
    elif ptype == "apk":
        v = _APK_REL.sub("", v)
    return v[:64]


def _host_key(device_id, vm_id) -> tuple:
    return (device_id, vm_id)


def _hosts_q(hosts: dict | None, prefix: str = "") -> Q:
    if hosts is None:
        return Q()
    return (Q(**{f"{prefix}device_id__in": list(hosts.get("device") or [])})
            | Q(**{f"{prefix}virtual_machine_id__in": list(hosts.get("virtual_machine") or [])}))


def best_versions(tenant, matcher, hosts: dict | None) -> dict:
    """``{(device id, vm id, application id): (ptype, package name, version)}``
    - the package that best stands for each application on each host. One
    query over the hosts' current packages."""
    from .models import HostPackage

    best: dict = {}
    rows = HostPackage.objects.filter(tenant=tenant, removed_at__isnull=True).filter(
        _hosts_q(hosts)).values_list("device_id", "virtual_machine_id", "purl_type", "name",
                                     "version")
    for dev, vm, ptype, name, version in rows.iterator(chunk_size=5000):
        for app_id, rank in matcher.match(ptype, name):
            key = (dev, vm, app_id)
            score = (rank, len(name), name)
            have = best.get(key)
            if have is None or score < have[0]:
                best[key] = (score, ptype, name, version)
    return {k: (v[1], v[2], v[3]) for k, v in best.items()}


def _reserve_numids(tenant_id, label: str, n: int) -> list[int]:
    from api.models import NumIdSequence

    if n <= 0:
        return []
    NumIdSequence.objects.get_or_create(tenant_id=tenant_id, model_label=label)
    row = NumIdSequence.objects.select_for_update().get(tenant_id=tenant_id,
                                                        model_label=label)
    start = (row.last_value or 0) + 1
    row.last_value = start + n - 1
    row.save(update_fields=["last_value"])
    return list(range(start, start + n))


def _read_hosts(tenant, hosts: dict | None) -> set:
    """The hosts in scope discovery has read (an OS fact): only those may
    lose an install because a package is missing."""
    from .models import HostOsFact

    return {(d, v) for d, v in HostOsFact.objects.filter(tenant=tenant).filter(
        _hosts_q(hosts)).values_list("device_id", "virtual_machine_id")}


def sync_installs(tenant, hosts: dict | None = None, now=None) -> dict:
    """Bring the installs of package-named applications in line with the
    packages of ``hosts`` (``{"device": ids, "virtual_machine": ids}``; None =
    every host the tenant's discovery has read). Returns counts."""
    from api.applications import _product, drop_unused_mappings, mapping_for
    from api.models import Application, InstalledSoftware
    from api.package_names import matcher_for
    from audit import bulk as audit_bulk
    from audit.context import cause
    from audit.models import ChangeAction, ChangeLogEntry
    from audit.signals import _field_dict
    from compliance.eol import suggest_cycle

    now = now or timezone.now()
    counts = {"created": 0, "updated": 0, "observed": 0, "removed": 0}
    matcher = matcher_for(tenant)
    read = _read_hosts(tenant, hosts)
    if not read:
        return counts
    best = best_versions(tenant, matcher, hosts) if matcher else {}
    existing: dict = defaultdict(list)
    inst_q = Q(source="discovery", observed_version__gt="") | Q(observed_version__gt="")
    if matcher:
        inst_q |= Q(application_id__in=list(matcher.app_ids))
    for inst in InstalledSoftware.objects.filter(tenant=tenant).filter(inst_q).filter(
            _hosts_q(hosts)).only("pk", "application_id", "device_id", "virtual_machine_id",
                                  "version", "source", "observed_version", "last_seen",
                                  "cycle", "cycle_manual", "eol_mapping_id", "tenant_id"):
        existing[(inst.device_id, inst.virtual_machine_id, inst.application_id)].append(inst)

    apps = {a.pk: a for a in Application.objects.filter(
        tenant=tenant, pk__in={k[2] for k in best} | {k[2] for k in existing})}
    products: dict = {}
    mappings: dict = {}

    def cycle_and_mapping(app, version):
        if app.pk not in products:
            products[app.pk] = _product(app) if app.eol_source and app.eol_product else None
        product = products[app.pk]
        cycle = suggest_cycle(product, version) if product is not None and version else ""
        if not cycle:
            return "", None
        if (app.pk, cycle) not in mappings:
            mappings[(app.pk, cycle)] = mapping_for(app, cycle, product)
        return cycle, mappings[(app.pk, cycle)]

    new, version_moved, observed, gone, cleared = [], [], [], [], []
    old_mappings = set()
    for key, (ptype, _name, raw) in best.items():
        app = apps.get(key[2])
        if app is None:
            continue
        version = upstream_version(ptype, raw)
        rows = existing.pop(key, [])
        owned = [r for r in rows if r.source != "discovery"]
        if owned:
            for r in owned:
                if r.observed_version != version or r.last_seen is None or r.last_seen < now:
                    observed.append((r, version))
            continue
        if rows:
            row = next((r for r in rows if r.version == version), rows[0])
            if row.version != version:
                version_moved.append((row, version))
            else:
                observed.append((row, version))
            continue
        dev, vm, _app = key
        cycle, mapping = cycle_and_mapping(app, version)
        new.append(InstalledSoftware(
            tenant=tenant, application=app, device_id=dev, virtual_machine_id=vm,
            version=version, observed_version=version, source="discovery", last_seen=now,
            cycle=cycle, eol_mapping=mapping))
    for key, rows in existing.items():
        if (key[0], key[1]) not in read:
            continue
        for r in rows:
            if r.source == "discovery" and r.observed_version:
                gone.append(r)
            elif r.observed_version:
                cleared.append(r)

    if not (new or version_moved or observed or gone or cleared):
        return counts
    # The hosts of the change-logged rows, in two queries: an entry records
    # the host's site, and its text names the application.
    from api.models import Device, VirtualMachine

    logged = [*new, *(r for r, _v in version_moved)]
    host_objs = {("device", d.pk): d for d in Device.objects.filter(
        pk__in={i.device_id for i in logged if i.device_id}).only(
        "pk", "tenant_id", "site_id", "name")}
    host_objs.update({("virtual_machine", v.pk): v for v in VirtualMachine.objects.filter(
        pk__in={i.virtual_machine_id for i in logged if i.virtual_machine_id}).only(
        "pk", "tenant_id", "site_id", "name")})

    def attach(inst):
        inst.tenant = tenant
        if inst.device_id:
            inst.device = host_objs.get(("device", inst.device_id))
        if inst.virtual_machine_id:
            inst.virtual_machine = host_objs.get(("virtual_machine", inst.virtual_machine_id))
    with transaction.atomic(), cause(CAUSE):
        if new:
            for inst, numid in zip(new, _reserve_numids(
                    tenant.pk, InstalledSoftware._meta.label_lower, len(new)), strict=True):
                inst.numid = numid
            InstalledSoftware.objects.bulk_create(new, batch_size=1000)
            entries = []
            for inst in new:
                attach(inst)
                e = audit_bulk._entry(inst, ChangeAction.CREATE, {},
                                      None, "")
                e.post_change = _field_dict(inst)
                e.via = "system"
                entries.append(e)
            ChangeLogEntry.objects.bulk_create(entries, batch_size=1000)
            counts["created"] = len(new)
        if version_moved:
            rows = []
            per_row = {}
            for r, version in version_moved:
                old = type(r)(pk=r.pk, application=apps[r.application_id],
                              device_id=r.device_id, virtual_machine_id=r.virtual_machine_id,
                              version=r.version, cycle=r.cycle,
                              eol_mapping_id=r.eol_mapping_id)
                attach(old)
                rows.append(old)
                if r.eol_mapping_id:
                    old_mappings.add(r.eol_mapping_id)
                r.version = version
                r.observed_version = version
                r.last_seen = now
                if not r.cycle_manual:
                    r.cycle, mapping = cycle_and_mapping(apps[r.application_id], version)
                    r.eol_mapping = mapping
                per_row[r.pk] = {"version": r.version, "cycle": r.cycle,
                                 "eol_mapping_id": r.eol_mapping_id}
            InstalledSoftware.objects.bulk_update(
                [r for r, _v in version_moved],
                ["version", "observed_version", "last_seen", "cycle", "eol_mapping"],
                batch_size=1000)
            audit_bulk.log_bulk_update(rows, {}, per_row)
            counts["updated"] = len(version_moved)
        if observed:
            for r, version in observed:
                r.observed_version = version
                r.last_seen = now
            InstalledSoftware.objects.bulk_update(
                [r for r, _v in observed], ["observed_version", "last_seen"], batch_size=1000)
            counts["observed"] = len(observed)
        if cleared:
            InstalledSoftware.objects.filter(pk__in=[r.pk for r in cleared]).update(
                observed_version="")
        if gone:
            old_mappings |= {r.eol_mapping_id for r in gone if r.eol_mapping_id}
            # A queryset delete sends post_delete per row: each goes to the
            # change log with its fields, as a person's delete would.
            InstalledSoftware.objects.filter(pk__in=[r.pk for r in gone]).delete()
            counts["removed"] = len(gone)
        if old_mappings:
            drop_unused_mappings(ids=old_mappings)
    return counts


def run_sync(tenant_id: str) -> dict | None:
    """RQ entry point: a tenant-wide sync (an application's package names
    changed). Skips quietly while Discovery is off for the tenant."""
    from core.models import Tenant

    from .gate import active

    tenant = Tenant.objects.filter(pk=tenant_id).first()
    if tenant is None or not active(tenant):
        return None
    counts = sync_installs(tenant)
    if counts["created"] or counts["updated"] or counts["removed"]:
        from vulnerabilities import jobs
        from vulnerabilities.models import VulnerabilitySettings

        if VulnerabilitySettings.objects.filter(pk=1, enabled=True).exists():
            jobs.enqueue_recompute(tenant.pk)
    return counts


def enqueue_sync(tenant_id) -> None:
    """Queue :func:`run_sync` once the transaction commits; inline when the
    queue is down."""
    tenant_id = str(tenant_id)

    def push():
        try:
            import django_rq

            django_rq.get_queue("low").enqueue(run_sync, tenant_id, job_timeout=1800)
        except Exception:  # noqa: BLE001 - Redis down: do it now
            run_sync(tenant_id)

    transaction.on_commit(push)
