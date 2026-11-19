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
    base = model.from_db.__func__

    def from_db(cls, db, field_names, values):
        inst = base(cls, db, field_names, values)
        d = inst.__dict__
        inst._summary_loaded = {f: d[f] for f in fields if f in d}
        return inst

    model.from_db = classmethod(from_db)


def _loaded(instance) -> dict:
    return getattr(instance, "_summary_loaded", None) or {}


def _reloaded(instance, fields) -> None:
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
    _reloaded(instance, _MAC_TRACKED + _UPLINK_FIELDS if isinstance(instance, Interface)
              else fields)


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


def connect() -> None:
    from audit.bulk import bulk_updated
    from monitoring.models import MonitoringSettings

    from .models import Device, Interface, IPAddress, MACAddress, OuiPrefix, VMInterface

    _remember_loaded(Interface, ("mac_address", *_UPLINK_FIELDS))
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
