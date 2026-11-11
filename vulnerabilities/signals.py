"""What queues a recompute (#451).

* A device's or VM's ``software_version``, ``platform`` or (device)
  ``device_type`` changes, or one is created: that host.
* An install is created, deleted, or its ``version`` / ``application`` /
  ``purl`` (a distro release or source package) / host changes: its host (both hosts when it moved).
* A mapping is saved or deleted: the whole tenant. A mapping created,
  enabled or pointed at another product also asks the server-mode fetch for
  that product at once (no-op in other modes; once per product per
  ``PRODUCT_DEBOUNCE`` seconds, hardware CPEs are never fetched).
* A policy is saved: the tenant's open matches are re-prioritised.

Changes are collected per transaction and queued once it commits, so a bulk
edit of 500 devices queues one job. Nothing is queued for a tenant without
an enabled mapping, or while the feature is off; the check runs at commit,
once per tenant, never per save. Detecting a change costs no query: the
watched fields are remembered when the row is loaded.
"""
from __future__ import annotations

import threading
from collections import defaultdict

from django.db import transaction
from django.db.models.signals import post_delete, post_init, post_save

HOST_FIELDS = {
    "device": ("software_version", "platform_id", "device_type_id"),
    "virtualmachine": ("software_version", "platform_id"),
}
INSTALL_FIELDS = ("version", "application_id", "device_id", "virtual_machine_id", "purl")
MAPPING_FIELDS = ("enabled", "kind", "part", "vendor", "product")
#: A product asked for once is not asked for again within this window.
PRODUCT_DEBOUNCE = 300
_SNAP = "_vuln_snapshot"

_local = threading.local()


def _fresh() -> dict:
    return {"objects": defaultdict(lambda: defaultdict(set)), "tenants": set(),
            "policies": set(), "products": set()}


def _add(mutate) -> None:
    """Record a change; flush when the transaction commits (at once outside
    one). Pending changes whose transaction rolled back are dropped: their
    flush is no longer registered."""
    conn = transaction.get_connection()
    if not conn.in_atomic_block:
        p = _fresh()
        mutate(p)
        _local.pending = p
        _flush()
        return
    registered = any(entry[1] is _flush for entry in conn.run_on_commit)
    p = getattr(_local, "pending", None) if registered else None
    if p is None:
        p = _local.pending = _fresh()
    mutate(p)
    if not registered:
        transaction.on_commit(_flush)


def _flush() -> None:
    from . import jobs
    from .models import ProductMapping, VulnerabilitySettings

    p = getattr(_local, "pending", None)
    _local.pending = None
    if not p:
        return
    tenants = set(p["objects"]) | p["tenants"] | p["policies"]
    if not tenants or not VulnerabilitySettings.load().enabled:
        return
    mapped = set(ProductMapping.objects.filter(tenant_id__in=tenants, enabled=True)
                 .values_list("tenant_id", flat=True).distinct())
    for tenant_id in p["tenants"]:
        # A mapping change also covers one that was just disabled or deleted.
        jobs.enqueue_recompute(tenant_id)
    for tenant_id in p["policies"] - p["tenants"]:
        if tenant_id in mapped:
            jobs._push(jobs.run_reprioritise, str(tenant_id))
    for tenant_id, objects in p["objects"].items():
        if tenant_id in mapped and tenant_id not in p["tenants"]:
            jobs.enqueue_objects(tenant_id, objects)
    if p["products"]:
        _fetch_products(p["products"])


def _fetch_products(keys) -> bool:
    """Fetch newly mapped products now in server mode, debounced per product
    key so a burst of saves (or two tenants mapping the same product) queues
    one fetch. Returns whether a job was queued."""
    import hashlib

    from django.core.cache import cache

    from . import fetch

    if not fetch.server_mode():
        return False
    fresh = []
    for key in sorted(keys):
        digest = hashlib.sha256("\n".join(key).encode()).hexdigest()[:32]
        try:
            claimed = cache.add(f"vuln:fetch-product:{digest}", 1, PRODUCT_DEBOUNCE)
        except Exception:  # noqa: BLE001 - cache down: ask anyway, the job is idempotent
            claimed = True
        if claimed:
            fresh.append(key)
    return bool(fresh) and fetch.enqueue_products(fresh)


fetch_products = _fetch_products


def _snapshot(instance, fields) -> tuple:
    # __dict__, never getattr: a deferred field must not load here.
    return tuple(instance.__dict__.get(f, _MISSING) for f in fields)


_MISSING = object()


def _changed(instance, fields, update_fields) -> bool:
    before = getattr(instance, _SNAP, None)
    after = _snapshot(instance, fields)
    setattr(instance, _SNAP, after)
    if before is None:
        return True
    for name, old, new in zip(fields, before, after, strict=True):
        if update_fields is not None and name.removesuffix("_id") not in update_fields \
                and name not in update_fields:
            continue
        if old is _MISSING or new is _MISSING or old != new:
            return True
    return False


def _host_init(sender, instance, **kwargs):
    setattr(instance, _SNAP, _snapshot(instance, HOST_FIELDS[sender._meta.model_name]))


def _host_saved(sender, instance, created, update_fields=None, raw=False, **kwargs):
    if raw or not instance.tenant_id:
        return
    fields = HOST_FIELDS[sender._meta.model_name]
    if created:
        setattr(instance, _SNAP, _snapshot(instance, fields))
    elif not _changed(instance, fields, update_fields):
        return
    kind = "device" if sender._meta.model_name == "device" else "virtual_machine"
    tenant_id, pk = instance.tenant_id, instance.pk
    _add(lambda p: p["objects"][tenant_id][kind].add(pk))


def _install_init(sender, instance, **kwargs):
    setattr(instance, _SNAP, _snapshot(instance, INSTALL_FIELDS))


def _install_hosts(instance, snap=None) -> list:
    out = []
    values = dict(zip(INSTALL_FIELDS, snap, strict=True)) if snap else {
        "device_id": instance.device_id, "virtual_machine_id": instance.virtual_machine_id}
    if values.get("device_id") not in (None, _MISSING):
        out.append(("device", values["device_id"]))
    if values.get("virtual_machine_id") not in (None, _MISSING):
        out.append(("virtual_machine", values["virtual_machine_id"]))
    return out


def _add_hosts(tenant_id, hosts) -> None:
    def mutate(p):
        for kind, pk in hosts:
            p["objects"][tenant_id][kind].add(pk)

    _add(mutate)


def _install_saved(sender, instance, created, update_fields=None, raw=False, **kwargs):
    if raw or not instance.tenant_id:
        return
    before = getattr(instance, _SNAP, None)
    if not created and not _changed(instance, INSTALL_FIELDS, update_fields):
        return
    if created:
        setattr(instance, _SNAP, _snapshot(instance, INSTALL_FIELDS))
    hosts = _install_hosts(instance)
    if before and not created:
        hosts += _install_hosts(instance, before)
    _add_hosts(instance.tenant_id, hosts)


def _install_deleted(sender, instance, **kwargs):
    if not instance.tenant_id:
        return
    _add_hosts(instance.tenant_id, _install_hosts(instance))


def _mapping_init(sender, instance, **kwargs):
    setattr(instance, _SNAP, _snapshot(instance, MAPPING_FIELDS))


def _mapping_changed(sender, instance, raw=False, created=False, **kwargs):
    if raw:
        return
    tenant_id = instance.tenant_id
    key = None
    if kwargs.get("signal") is post_save:
        before = getattr(instance, _SNAP, None)
        after = _snapshot(instance, MAPPING_FIELDS)
        setattr(instance, _SNAP, after)
        if instance.enabled and instance.part != "h" and (created or before != after):
            key = (instance.kind, instance.part or "", instance.vendor, instance.product)

    def mutate(p):
        p["tenants"].add(tenant_id)
        if key is not None:
            p["products"].add(key)

    _add(mutate)


def _policy_saved(sender, instance, raw=False, **kwargs):
    if raw:
        return
    tenant_id = instance.tenant_id
    _add(lambda p: p["policies"].add(tenant_id))


def connect() -> None:
    from api.models import Device, InstalledSoftware, VirtualMachine

    from .models import ProductMapping, VulnerabilityPolicy

    for model in (Device, VirtualMachine):
        post_init.connect(_host_init, sender=model, dispatch_uid=f"vuln-init-{model.__name__}")
        post_save.connect(_host_saved, sender=model, dispatch_uid=f"vuln-save-{model.__name__}")
    post_init.connect(_install_init, sender=InstalledSoftware, dispatch_uid="vuln-init-inst")
    post_save.connect(_install_saved, sender=InstalledSoftware, dispatch_uid="vuln-save-inst")
    post_delete.connect(_install_deleted, sender=InstalledSoftware, dispatch_uid="vuln-del-inst")
    post_init.connect(_mapping_init, sender=ProductMapping, dispatch_uid="vuln-init-map")
    post_save.connect(_mapping_changed, sender=ProductMapping, dispatch_uid="vuln-save-map")
    post_delete.connect(_mapping_changed, sender=ProductMapping, dispatch_uid="vuln-del-map")
    post_save.connect(_policy_saved, sender=VulnerabilityPolicy, dispatch_uid="vuln-save-pol")
