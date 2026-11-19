"""Stored port counts per device (#535): what the Port utilization list pages,
sorts and filters on.

A :class:`~api.models.DevicePortStat` row holds a device's ports by kind
(physical interfaces, virtual interfaces, front ports) and state (total,
connected, reserved, marked), counted by the one rule every port count reads
(``api.port_utilization.port_kinds``). The headline - with virtual
interfaces or without, by the deployment's setting - and the percentage are
summed in SQL at read (:func:`annotate`), so changing the setting needs no
rebuild. A device with no port of these kinds has no row.

Rows are rebuilt from the ports by :func:`refresh` for the devices a write
marked (``api.summary_hooks``: interfaces, front ports, cable ends, cable
statuses, reservations, the capacity flag of an interface status, component
instantiation, audited bulk updates), and in full by :func:`build_batch`
(``api.list_summaries``).
"""
from __future__ import annotations

import uuid

from django.db.models import Case, F, IntegerField, Q, Value, When
from django.db.models.functions import Coalesce, Mod

from . import list_summaries

KIND = "port"
#: A tenant with at most this many devices is built on its first read.
SMALL = 2000

_KINDS = (("interfaces", "if"), ("virtual", "virt"), ("front_ports", "fp"))
_METRICS = ("total", "connected", "reserved", "marked")
FIELDS = tuple(f"{p}_{m}" for _, p in _KINDS for m in _METRICS)


def compute(tenant, device_ids) -> dict:
    """``{device id: {field: n}}`` for those of ``device_ids`` in ``tenant``
    with a counted port - the twelve grouped queries of ``port_kinds``
    however many devices."""
    from .models import Device
    from .port_utilization import port_kinds

    ids = [i for i in device_ids if i]
    if not ids:
        return {}
    devices = Device.objects.filter(tenant=tenant, pk__in=ids)
    out = {}
    for device_id, kinds in port_kinds(devices, rear_ports=False).items():
        row = {f"{p}_{m}": kinds[k][m] for k, p in _KINDS for m in _METRICS}
        if any(row[f"{p}_total"] for _, p in _KINDS):
            out[device_id] = row
    return out


def _uuids(keys) -> list:
    out = []
    for k in keys:
        try:
            out.append(uuid.UUID(str(k)))
        except ValueError:
            continue
    return out


def refresh(tenant, keys) -> int:
    """Bring the rows of the devices ``keys`` names in line with their
    ports; a device that left the tenant or has no port loses its row."""
    from .models import DevicePortStat

    ids = _uuids(keys)
    if not ids:
        return 0
    want = compute(tenant, ids)
    have = {r.device_id: r for r in DevicePortStat.objects.filter(device_id__in=ids)}
    new, changed = [], []
    for did, fields in want.items():
        row = have.pop(did, None)
        if row is None:
            new.append(DevicePortStat(device_id=did, tenant=tenant, **fields))
        elif row.tenant_id != tenant.pk or any(getattr(row, f) != v for f, v in fields.items()):
            row.tenant = tenant
            for f, v in fields.items():
                setattr(row, f, v)
            changed.append(row)
    # A device of another tenant keeps its row there: only this tenant's go.
    gone = [r.pk for r in have.values() if r.tenant_id == tenant.pk]
    DevicePortStat.objects.bulk_create(new, batch_size=1000)
    DevicePortStat.objects.bulk_update(changed, [*FIELDS, "tenant", "refreshed_at"],
                                       batch_size=1000)
    if gone:
        DevicePortStat.objects.filter(pk__in=gone).delete()
    return len(new) + len(changed) + len(gone)


def build_batch(tenant, cursor: str, limit: int):
    """The next ``limit`` devices of the tenant by id after ``cursor``, and
    the rows in that stretch whose device is no longer the tenant's."""
    from .models import Device, DevicePortStat

    ids = list(
        Device.objects.filter(tenant=tenant, **({"pk__gt": cursor} if cursor else {}))
        .order_by("pk").values_list("pk", flat=True)[:limit]
    )
    written = refresh(tenant, ids)
    stale = DevicePortStat.objects.filter(tenant=tenant)
    if cursor:
        stale = stale.filter(device_id__gt=cursor)
    done = len(ids) < limit
    if not done:
        stale = stale.filter(device_id__lte=ids[-1])
    written += stale.exclude(device_id__in=ids).delete()[0]
    return len(ids), written, None if done else str(ids[-1])


def check(tenant, batch: int = 5000) -> int:
    """How many of the tenant's rows differ from their ports."""
    from .models import Device, DevicePortStat

    drift, cursor, seen = 0, None, 0
    while True:
        ids = list(
            Device.objects.filter(tenant=tenant, **({"pk__gt": cursor} if cursor else {}))
            .order_by("pk").values_list("pk", flat=True)[:batch]
        )
        want = compute(tenant, ids)
        have = {r.device_id: r for r in DevicePortStat.objects.filter(
            tenant=tenant, device_id__in=ids)}
        seen += len(have)
        for did in ids:
            row, fields = have.get(did), want.get(did)
            if row is None or fields is None:
                drift += (row is None) != (fields is None)
            elif any(getattr(row, f) != v for f, v in fields.items()):
                drift += 1
        if len(ids) < batch:
            break
        cursor = ids[-1]
    drift += max(0, DevicePortStat.objects.filter(tenant=tenant).count() - seen)
    return drift


def small(tenant) -> bool:
    from .models import Device

    return Device.objects.filter(tenant=tenant)[: SMALL + 1].count() <= SMALL


list_summaries.register(list_summaries.Kind(
    name=KIND, refresh=refresh, build_batch=build_batch, check=check, small=small,
))


def touch(tenant_id, device_ids) -> None:
    list_summaries.touch(KIND, tenant_id, {str(i) for i in device_ids if i})


def touch_query(tenant_id, device_ids_qs) -> None:
    list_summaries.touch_query(KIND, tenant_id, device_ids_qs)


# ─── the read side ───────────────────────────────────────────────────────────


def _sum(metric: str, count_virtual: bool):
    expr = F(f"port_stat__if_{metric}") + F(f"port_stat__fp_{metric}")
    if count_virtual:
        expr = expr + F(f"port_stat__virt_{metric}")
    return Coalesce(expr, Value(0), output_field=IntegerField())


def annotate(qs, count_virtual: bool):
    """A Device queryset with ``pu_total``, ``pu_connected``,
    ``pu_reserved``, ``pu_marked``, ``pu_free``, ``pu_used`` and ``pu_pct``
    (connected plus reserved as a whole percentage, rounded half to even
    like :func:`api.port_utilization.used_pct`) from the stored counts."""
    if "pu_total" in qs.query.annotations:
        return qs
    qs = qs.annotate(
        pu_total=_sum("total", count_virtual),
        pu_connected=_sum("connected", count_virtual),
        pu_reserved=_sum("reserved", count_virtual),
        pu_marked=_sum("marked", count_virtual),
    ).annotate(
        pu_used=F("pu_connected") + F("pu_reserved"),
        pu_free=F("pu_total") - F("pu_connected") - F("pu_reserved"),
    )
    # n / d rounded half to even, in integers: q = n div d, r = n mod d.
    n = F("pu_used") * Value(100)
    d = F("pu_total")
    q = Case(When(pu_total__gt=0, then=n / d), default=None, output_field=IntegerField())
    r = Case(When(pu_total__gt=0, then=Mod(n, d)), default=None, output_field=IntegerField())
    return qs.annotate(_pu_q=q, _pu_r=r).annotate(pu_pct=Case(
        When(Q(_pu_r__gt=0) & Q(pu_total__lt=F("_pu_r") * 2), then=F("_pu_q") + 1),
        When(Q(_pu_r__gt=0) & Q(pu_total=F("_pu_r") * 2), then=F("_pu_q") + Mod(F("_pu_q"), 2)),
        default=F("_pu_q"), output_field=IntegerField(),
    ))
