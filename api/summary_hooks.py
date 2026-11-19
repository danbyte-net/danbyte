"""The writers of the stored list summaries (#527, #535) mark what they change.

Model saves and deletes are caught by the signals here; the bulk paths that
skip them report through ``audit.bulk.bulk_updated`` (every audited
``queryset.update()`` sends it), and the rest call ``api.mac_summary`` /
``api.port_stats`` by hand (a poll's learned MACs, the OUI registry sync,
component instantiation). Each mark is a row rebuilt from its sources
later (``api.list_summaries``), so a mark too many costs a refresh, never a
wrong number; the nightly reconcile catches a writer nobody hooked.

To see what a save changed, the tracked fields' loaded values are kept on
each instance read from the database (``_summary_loaded``).
"""
from __future__ import annotations

from django.db.models.signals import post_delete, post_save, pre_delete, pre_save

#: Interface fields the uplink rules of the learned Location read.
_UPLINK_FIELDS = ("is_uplink", "never_uplink", "lag_id", "type")


def _remember_loaded(model, fields: tuple[str, ...]) -> None:
    """Keep ``fields``' values as loaded on every instance of ``model`` read
    from the database - what a later save compares against."""
    _TRACKED[model] = fields
    base = model.from_db.__func__

    def from_db(cls, db, field_names, values):
        inst = base(cls, db, field_names, values)
        d = inst.__dict__
        inst._summary_loaded = {f: d[f] for f in fields if f in d}
        return inst

    model.from_db = classmethod(from_db)


def _loaded(instance) -> dict:
    return getattr(instance, "_summary_loaded", None) or {}


#: Each tracked model's fields, kept as loaded (:func:`_remember_loaded`).
_TRACKED: dict = {}


def _resnapshot(sender, instance, raw=False, **kwargs):
    """After every receiver here has compared: the saved values are the
    loaded ones for the instance's next save. Connected last."""
    fields = _TRACKED.get(sender)
    if fields:
        instance._summary_loaded = {f: getattr(instance, f, None) for f in fields}


def _cached(instance, name):
    return instance._state.fields_cache.get(name)


def _device_tenant(device_id):
    from .models import Device

    if device_id is None:
        return None
    return Device.objects.filter(pk=device_id).values_list("tenant_id", flat=True).first()


def _vm_tenant(vm_id):
    from .models import VirtualMachine

    if vm_id is None:
        return None
    return VirtualMachine.objects.filter(pk=vm_id).values_list("tenant_id", flat=True).first()


def mac_tenant(instance):
    """The tenant a MAC source row belongs to."""
    from .models import Interface, VMInterface

    if isinstance(instance, Interface):
        dev = _cached(instance, "device")
        return dev.tenant_id if dev is not None else _device_tenant(instance.device_id)
    if isinstance(instance, VMInterface):
        vm = _cached(instance, "vm")
        return vm.tenant_id if vm is not None else _vm_tenant(instance.vm_id)
    return instance.tenant_id


# ─── MAC list (#527) ─────────────────────────────────────────────────────────

_MAC_TRACKED = ("mac_address", "vendor_override")


def _mac_saved(sender, instance, created, update_fields=None, raw=False, **kwargs):
    from . import mac_summary

    if raw:
        return
    fields = ("mac_address", "vendor_override") if hasattr(instance, "vendor_override") \
        else ("mac_address",)
    if update_fields is not None and not set(fields) & set(update_fields) \
            and not set(_UPLINK_FIELDS) & set(update_fields):
        return
    before = _loaded(instance)
    tenant_id = None
    macs = set()
    if created or any(f not in before or before[f] != getattr(instance, f) for f in fields):
        macs = {instance.mac_address, before.get("mac_address") if not created else None}
        macs.discard(None)
    if macs - {""}:
        tenant_id = mac_tenant(instance)
        mac_summary.touch(tenant_id, macs)
    from .models import Interface

    if isinstance(instance, Interface) and not created and any(
        f in before and before[f] != getattr(instance, f) for f in _UPLINK_FIELDS
    ):
        _touch_learned_on_device(tenant_id or mac_tenant(instance), instance.device_id)


def _mac_saving(sender, instance, raw=False, update_fields=None, **kwargs):
    """A row read without its MAC (``only()``/``defer()``) is about to be
    saved: read the stored value first, so the old key is marked too."""
    if raw or instance._state.adding or "mac_address" in _loaded(instance):
        return
    if update_fields is not None and "mac_address" not in update_fields:
        return
    old = sender.objects.filter(pk=instance.pk).values_list("mac_address", flat=True).first()
    instance._summary_loaded = {**_loaded(instance), "mac_address": old}


def _mac_deleted(sender, instance, **kwargs):
    from . import mac_summary

    if instance.mac_address:
        tenant_id = mac_tenant(instance)
        mac_summary.touch(tenant_id, [instance.mac_address])


def _touch_learned_on_device(tenant_id, device_id) -> None:
    """A port's uplink setting or LAG changed: the MACs learned on its
    device may sit elsewhere now."""
    from django.db.models import Q

    from monitoring.models import MacSighting

    from . import mac_summary

    if tenant_id is None or device_id is None:
        return
    mac_summary.touch_sighted(tenant_id, MacSighting.objects.filter(
        Q(device_id=device_id) | Q(polled_device_id=device_id), tenant_id=tenant_id,
        gone_at__isnull=True))


def _device_deleting(sender, instance, **kwargs):
    """A switch goes: the MACs learned on it are learned elsewhere, or not
    at all. Marked before its sightings and the summary's link go."""
    from . import list_summaries, mac_summary
    from .models import MacSummary

    list_summaries.touch_query(mac_summary.KIND, instance.tenant_id, MacSummary.objects.filter(
        tenant_id=instance.tenant_id, learned_device_id=instance.pk).values_list("key", flat=True))


def _oui_changed(sender, instance, **kwargs):
    from . import mac_summary

    mac_summary.touch_vendors(instance.tenant_id, instance.prefix)


def _mac_settings_saved(sender, instance, **kwargs):
    """The uplink threshold or the LLDP rule changed: every learned MAC of
    the tenant may sit elsewhere now."""
    from monitoring.models import MacSighting

    from . import list_summaries, mac_summary
    from .models import MacSummary

    tid = instance.tenant_id
    mac_summary.touch_sighted(tid, MacSighting.objects.filter(tenant_id=tid, gone_at__isnull=True))
    list_summaries.touch_query(mac_summary.KIND, tid, MacSummary.objects.filter(
        tenant_id=tid, learned_device__isnull=False).values_list("key", flat=True))


def _bulk_updated(sender, rows=(), updates=None, per_row=None, **kwargs):
    """An audited ``queryset.update()`` (``audit.bulk.log_bulk_update``):
    ``rows`` hold the values from before it."""
    from . import mac_summary
    from .models import Interface, IPAddress, MACAddress, VMInterface

    updates = updates or {}
    if sender in (Interface, VMInterface, IPAddress, MACAddress):
        changed = {"mac_address", "vendor_override"} & set(updates)
        per = per_row or {}
        if changed or any(set(v) & {"mac_address", "vendor_override"} for v in per.values()):
            by_tenant: dict = {}
            for r in rows:
                new = (per.get(r.pk) or {}).get("mac_address", updates.get("mac_address"))
                by_tenant.setdefault(mac_tenant(r), set()).update(
                    m for m in (r.mac_address, new) if m)
            for tid, macs in by_tenant.items():
                mac_summary.touch(tid, macs)
        if sender is Interface and set(_UPLINK_FIELDS) & set(updates):
            for dev in {r.device_id for r in rows}:
                _touch_learned_on_device(mac_tenant(next(iter(rows))), dev)


# ─── Port utilization (#535) ─────────────────────────────────────────────────

#: What a port's save can change about its device's counts.
_PORT_TRACKED = {
    "interface": ("device_id", "type", "virtual", "status_id", "mark_connected"),
    "frontport": ("device_id", "mark_connected"),
}


def _port_saved(sender, instance, created, raw=False, update_fields=None, **kwargs):
    from . import port_stats

    if raw:
        return
    tracked = _PORT_TRACKED[sender._meta.model_name]
    before = _loaded(instance)
    if not created:
        if update_fields is not None and not {f.removesuffix("_id") for f in tracked} \
                & {f.removesuffix("_id") for f in update_fields}:
            return
        if all(f in before and before[f] == getattr(instance, f) for f in tracked):
            return
    devices = {instance.device_id, before.get("device_id")}
    port_stats.touch(mac_tenant(instance) if sender._meta.model_name == "interface"
                     else _device_tenant(instance.device_id), devices)


def _port_deleted(sender, instance, **kwargs):
    from . import port_stats

    port_stats.touch(_device_tenant(instance.device_id), [instance.device_id])


def _point_devices(instance) -> set:
    """The devices of the interface or front port a cable end or a
    reservation names."""
    from .models import FrontPort, Interface

    out = set()
    if getattr(instance, "interface_id", None):
        out |= set(Interface.objects.filter(pk=instance.interface_id)
                   .values_list("device_id", flat=True))
    if getattr(instance, "front_port_id", None):
        out |= set(FrontPort.objects.filter(pk=instance.front_port_id)
                   .values_list("device_id", flat=True))
    return out


def _point_changed(sender, instance, raw=False, **kwargs):
    from . import port_stats
    from .models import Device

    if raw:
        return
    devices = _point_devices(instance)
    for tid, did in Device.objects.filter(pk__in=devices).values_list("tenant_id", "pk"):
        port_stats.touch(tid, [did])


def _cable_devices_qs(cable_ids):
    from django.db.models import F
    from django.db.models.functions import Coalesce

    from .models import CableTermination

    return (CableTermination.objects.filter(cable_id__in=cable_ids)
            .annotate(_d=Coalesce(F("interface__device_id"), F("front_port__device_id")))
            .exclude(_d=None))


def _touch_cable_devices(cable_ids) -> None:
    from . import port_stats

    ends = _cable_devices_qs(cable_ids)
    for tid in set(ends.values_list("cable__tenant_id", flat=True)):
        port_stats.touch_query(tid, ends.filter(cable__tenant_id=tid).values_list("_d", flat=True))


def _cable_saved(sender, instance, created, raw=False, **kwargs):
    if raw or created:
        return
    before = _loaded(instance)
    if "status_id" in before and before["status_id"] == instance.status_id:
        return
    _touch_cable_devices([instance.pk])


def _status_saved(sender, instance, created, raw=False, **kwargs):
    """An interface status now counts as capacity, or stops: every device
    with an interface in it."""
    from . import port_stats
    from .models import Interface

    before = _loaded(instance)
    if raw or created or before.get("excludes_capacity") == instance.excludes_capacity:
        return
    port_stats.touch_query(instance.tenant_id, Interface.objects.filter(
        status=instance, device__tenant_id=instance.tenant_id).values_list("device_id", flat=True))


def _bulk_ports(sender, rows=(), updates=None, per_row=None, **kwargs):
    from . import port_stats
    from .models import Cable, FrontPort, Interface

    keys = set(updates or {}) | {k for v in (per_row or {}).values() for k in v}
    keys = {k.removesuffix("_id") for k in keys}
    if sender in (Interface, FrontPort):
        tracked = {f.removesuffix("_id") for f in _PORT_TRACKED[sender._meta.model_name]}
        if keys & tracked:
            devices = {r.device_id for r in rows} | {
                (updates or {}).get("device_id"), (updates or {}).get("device")}
            devices = {getattr(d, "pk", d) for d in devices if d}
            from .models import Device

            for tid, did in Device.objects.filter(pk__in=devices).values_list("tenant_id", "pk"):
                port_stats.touch(tid, [did])
    elif sender is Cable and "status" in keys:
        _touch_cable_devices([r.pk for r in rows])


def connect() -> None:
    from audit.bulk import bulk_updated
    from monitoring.models import MonitoringSettings

    from .models import Device, Interface, IPAddress, MACAddress, OuiPrefix, VMInterface

    _remember_loaded(Interface, ("mac_address", *_UPLINK_FIELDS,
                                 *_PORT_TRACKED["interface"]))
    _remember_loaded(VMInterface, ("mac_address",))
    _remember_loaded(IPAddress, ("mac_address",))
    _remember_loaded(MACAddress, _MAC_TRACKED)
    for model in (Interface, VMInterface, IPAddress, MACAddress):
        label = model._meta.label_lower
        pre_save.connect(_mac_saving, sender=model, dispatch_uid=f"summary.mac_saving.{label}")
        post_save.connect(_mac_saved, sender=model, dispatch_uid=f"summary.mac_saved.{label}")
        post_delete.connect(_mac_deleted, sender=model,
                            dispatch_uid=f"summary.mac_deleted.{label}")
    pre_delete.connect(_device_deleting, sender=Device, dispatch_uid="summary.device_deleting")
    post_save.connect(_oui_changed, sender=OuiPrefix, dispatch_uid="summary.oui_saved")
    post_delete.connect(_oui_changed, sender=OuiPrefix, dispatch_uid="summary.oui_deleted")
    post_save.connect(_mac_settings_saved, sender=MonitoringSettings,
                      dispatch_uid="summary.mac_settings")
    bulk_updated.connect(_bulk_updated, dispatch_uid="summary.bulk_updated")
    bulk_updated.connect(_bulk_ports, dispatch_uid="summary.bulk_ports")

    from .models import Cable, CableTermination, FrontPort, PortReservation, Status

    _remember_loaded(FrontPort, _PORT_TRACKED["frontport"])
    _remember_loaded(Cable, ("status_id",))
    _remember_loaded(Status, ("excludes_capacity",))
    for model in (Interface, FrontPort):
        label = model._meta.label_lower
        post_save.connect(_port_saved, sender=model, dispatch_uid=f"summary.port_saved.{label}")
        post_delete.connect(_port_deleted, sender=model,
                            dispatch_uid=f"summary.port_deleted.{label}")
    for model in (CableTermination, PortReservation):
        label = model._meta.label_lower
        post_save.connect(_point_changed, sender=model,
                          dispatch_uid=f"summary.point_saved.{label}")
        post_delete.connect(_point_changed, sender=model,
                            dispatch_uid=f"summary.point_deleted.{label}")
    post_save.connect(_cable_saved, sender=Cable, dispatch_uid="summary.cable_saved")
    post_save.connect(_status_saved, sender=Status, dispatch_uid="summary.status_saved")
    for model in _TRACKED:
        post_save.connect(_resnapshot, sender=model,
                          dispatch_uid=f"summary.resnapshot.{model._meta.label_lower}")
