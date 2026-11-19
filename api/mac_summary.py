"""The MAC list's stored summary (#527): one :class:`~api.models.MacSummary`
row per MAC value a tenant records, so ``GET /api/macs/`` pages, searches,
sorts and counts its facets in SQL instead of gathering every MAC of the
tenant in Python on every visit.

A row is keyed as the list always grouped (``Lower(Trim(mac_address))``)
and holds what the rail and the sorts read:

* how many device interfaces, VM interfaces, IP pairings and MAC objects
  carry it (``interfaces`` … ``mac_objects``);
* the vendor: the first MAC object's override (by number), and the OUI
  resolution (``api.oui.vendors_for`` - longest prefix, a tenant's own range
  over the registry, "Locally administered");
* where the network learned it (``monitoring.mac_location.locate``, as the
  system sees it): the switch, its port.

What a row *shows* (its interfaces, IPs, objects, the Location cell) is read
live for the page's keys, cut to the caller's view scope, as before.

Rows are rebuilt from their sources by :func:`refresh` - the keys a write
marked (``api.summary_hooks``), a poll's learned MACs, an OUI change - and
in full, batch by batch, by :func:`build_batch` (``api.list_summaries``).
"""
from __future__ import annotations

from django.db import connection
from django.db.models import CharField, Count, F, Q, Value
from django.db.models.functions import Collate, Lower, Trim

from . import list_summaries
from .oui import hexkey, vendors_for

KIND = "mac"
#: A tenant with at most this many MAC rows is built on its first read.
SMALL = 5000

_COUNT_FIELDS = ("interfaces", "vm_interfaces", "ips", "mac_objects")
_FIELDS = (*_COUNT_FIELDS, "hex", "vendor_override", "oui_vendor", "oui_source",
           "learned_device_id", "learned_interface_id", "learned_port")


def key_expr(field: str = "mac_address"):
    """A MAC column as the list keys it: trimmed, lower case."""
    return Lower(Trim(field))


def norm(mac: str) -> str:
    return (mac or "").strip().lower()


def hex_of(key: str) -> str:
    h = hexkey(key)
    return h if len(h) == 12 else ""


def sources():
    """``(field, model, tenant path)`` of each place a MAC is recorded."""
    from .models import Interface, IPAddress, MACAddress, VMInterface

    return (
        ("interfaces", Interface, "device__tenant_id"),
        ("vm_interfaces", VMInterface, "vm__tenant_id"),
        ("ips", IPAddress, "tenant_id"),
        ("mac_objects", MACAddress, "tenant_id"),
    )


def source_rows(model, path: str, tenant_id):
    """The tenant's rows of one source that carry a MAC, keyed ``_k``."""
    return (model.objects.filter(**{path: tenant_id}).exclude(mac_address="")
            .annotate(_k=key_expr()).exclude(_k=""))


# ─── the ground truth ────────────────────────────────────────────────────────


def compute(tenant, keys) -> dict:
    """``{key: {field: value}}`` for those of ``keys`` some source still
    carries - from the sources themselves, a fixed number of queries for
    any number of keys."""
    from monitoring.mac_location import locate
    from monitoring.mac_tables import canon_mac

    from .models import MACAddress

    keys = sorted({norm(k) for k in keys} - {""})
    if not keys:
        return {}
    out: dict = {}
    for field, model, path in sources():
        rows = (source_rows(model, path, tenant.pk).filter(_k__in=keys).order_by()
                .values("_k").annotate(n=Count("pk")).values_list("_k", "n"))
        for k, n in rows:
            out.setdefault(k, dict.fromkeys(_COUNT_FIELDS, 0))[field] = n
    if not out:
        return {}
    overrides: dict = {}
    for k, override in (
        source_rows(MACAddress, "tenant_id", tenant.pk).filter(_k__in=list(out))
        .exclude(vendor_override="").order_by("numid", "pk").values_list("_k", "vendor_override")
    ):
        overrides.setdefault(k, override)
    vendors = vendors_for(out.keys(), tenant)
    canon = {k: canon_mac(k) for k in out}
    located = locate(tenant, {c for c in canon.values() if c}, None)
    for k, row in out.items():
        vendor = vendors.get(hexkey(k)) or {}
        loc = located.get(canon[k]) if canon[k] else None
        row.update(
            hex=hex_of(k),
            vendor_override=overrides.get(k, "")[:255],
            oui_vendor=(vendor.get("name") or "")[:255],
            oui_source=(vendor.get("source") or "")[:16],
            learned_device_id=loc.at.device_id if loc else None,
            learned_interface_id=loc.at.interface_id if loc else None,
            learned_port=((loc.at.interface_name or loc.at.port_name or loc.at.port_key)
                          if loc else "")[:128],
        )
    return out


def refresh(tenant, keys) -> int:
    """Bring the rows of ``keys`` in line with their sources: a key no
    source carries loses its row. Only rows that differ are written."""
    from .models import MacSummary

    keys = sorted({norm(k) for k in keys} - {""})
    if not keys:
        return 0
    want = compute(tenant, keys)
    have = {r.key: r for r in MacSummary.objects.filter(tenant=tenant, key__in=keys)}
    new, changed = [], []
    for k, fields in want.items():
        row = have.pop(k, None)
        if row is None:
            new.append(MacSummary(tenant=tenant, key=k, **fields))
        elif any(getattr(row, f) != fields[f] for f in _FIELDS):
            for f in _FIELDS:
                setattr(row, f, fields[f])
            changed.append(row)
    gone = [r.pk for r in have.values()]
    MacSummary.objects.bulk_create(new, batch_size=1000)
    MacSummary.objects.bulk_update(changed, [*_FIELDS, "refreshed_at"], batch_size=1000)
    if gone:
        MacSummary.objects.filter(pk__in=gone).delete()
    return len(new) + len(changed) + len(gone)


def _keys_sql(tenant_id, after: str, limit: int | None):
    """SQL for the tenant's distinct keys after ``after``, byte order."""
    parts, params = [], []
    for _, model, path in sources():
        qs = source_rows(model, path, tenant_id).order_by().values_list("_k")
        sql, p = qs.query.sql_with_params()
        parts.append(sql)
        params.extend(p)
    sql = (f'SELECT k FROM ({" UNION ".join(parts)}) AS s(k) '
           f'WHERE k COLLATE "C" > %s ORDER BY k COLLATE "C"')
    params.append(after)
    if limit is not None:
        sql += " LIMIT %s"
        params.append(limit)
    return sql, params


def _keys_after(tenant_id, after: str, limit: int | None) -> list[str]:
    sql, params = _keys_sql(tenant_id, after, limit)
    with connection.cursor() as cur:
        cur.execute(sql, params)
        return [r[0] for r in cur.fetchall()]


def build_batch(tenant, cursor: str, limit: int):
    """The next ``limit`` keys after ``cursor`` rebuilt, and the rows in
    that stretch no source carries any more dropped."""
    from .models import MacSummary

    keys = _keys_after(tenant.pk, cursor, limit)
    written = refresh(tenant, keys)
    stale = MacSummary.objects.filter(tenant=tenant).alias(
        _c=Collate("key", "C")).filter(_c__gt=cursor)
    done = len(keys) < limit
    if not done:
        stale = stale.filter(_c__lte=keys[-1])
    written += stale.exclude(key__in=keys).delete()[0]
    return len(keys), written, None if done else keys[-1]


def check(tenant, batch: int = 5000) -> int:
    """How many rows differ from their sources (missing, extra or stale)."""
    from .models import MacSummary

    drift, cursor = 0, ""
    seen = 0
    while True:
        keys = _keys_after(tenant.pk, cursor, batch)
        want = compute(tenant, keys)
        have = {r.key: r for r in MacSummary.objects.filter(tenant=tenant, key__in=keys)}
        for k in keys:
            row, fields = have.get(k), want.get(k)
            if row is None or fields is None:
                drift += (row is None) != (fields is None)
            elif any(getattr(row, f) != fields[f] for f in _FIELDS):
                drift += 1
        seen += len(have)
        if len(keys) < batch:
            break
        cursor = keys[-1]
    drift += max(0, MacSummary.objects.filter(tenant=tenant).count() - seen)
    return drift


def small(tenant) -> bool:
    total = 0
    for _, model, path in sources():
        total += source_rows(model, path, tenant.pk)[: SMALL + 1].count()
        if total > SMALL:
            return False
    return True


list_summaries.register(list_summaries.Kind(
    name=KIND, refresh=refresh, build_batch=build_batch, check=check, small=small,
))


# ─── marks from the writers ──────────────────────────────────────────────────


def touch(tenant_id, macs) -> None:
    list_summaries.touch(KIND, tenant_id, {norm(m) for m in macs if m})


def touch_hexes(tenant_id, hex_qs) -> None:
    """Mark the rows whose hex a queryset of 12-hex strings names - the
    learned MACs a poll or an uplink change moved."""
    from .models import MacSummary

    list_summaries.touch_query(KIND, tenant_id, MacSummary.objects.filter(
        tenant_id=tenant_id, hex__in=hex_qs).values_list("key", flat=True))


def touch_sighted(tenant_id, sightings_qs) -> None:
    """Mark the rows of the MACs a ``MacSighting`` queryset names."""
    from django.db.models import Func

    hexes = sightings_qs.order_by().annotate(
        _h=Func(F("mac"), Value(":"), Value(""), function="replace", output_field=CharField())
    ).values("_h")
    touch_hexes(tenant_id, hexes)


def touch_vendors(tenant_id=None, prefix: str | None = None) -> None:
    """An OUI range changed: mark the rows it can resolve - the tenant's
    (a custom range), or every tenant's (the registry)."""
    from .models import MacSummary

    qs = MacSummary.objects.all()
    if tenant_id is not None:
        qs = qs.filter(tenant_id=tenant_id)
    if prefix:
        qs = qs.filter(hex__startswith=prefix)
    for tid in qs.order_by().values_list("tenant_id", flat=True).distinct():
        list_summaries.touch_query(KIND, tid, qs.filter(tenant_id=tid).values_list("key", flat=True))


def learned_q(prefix: str = "") -> Q:
    return Q(**{f"{prefix}learned_device__isnull": False})
