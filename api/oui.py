"""MAC vendor lookup (#141): prefix parsing, longest-prefix resolution, the
IEEE registry import, and "next free MAC in an owned range".

Resolution order for one address: the longest matching prefix wins; at equal
length a tenant's custom range beats the IEEE registry. An address that
matches nothing but has the locally-administered bit set resolves to
"Locally administered" rather than blank - it is not a vendor, and saying so
is more useful than an empty cell.
"""
from __future__ import annotations

import csv
import io
import re

from django.db.models import Q

_HEX = re.compile(r"[^0-9a-f]")
MIN_PREFIX_HEX = 2
MAX_PREFIX_HEX = 11
LOCAL_LABEL = "Locally administered"


class OuiError(ValueError):
    """Bad prefix syntax or an unusable import file."""


def hexkey(mac: str) -> str:
    """Separator-insensitive lowercase hex (``aa:bb`` == ``AA-BB`` == ``aabb``)."""
    return _HEX.sub("", (mac or "").lower())


def parse_prefix(text: str) -> str:
    """``"02:00:AA"`` / ``"0200aa"`` / ``"02-00-AA"`` → ``"0200aa"``. Raises
    :class:`OuiError` when it is not 2-11 hex digits."""
    key = hexkey(text)
    if not (MIN_PREFIX_HEX <= len(key) <= MAX_PREFIX_HEX):
        raise OuiError("A prefix is 2 to 11 hex digits, e.g. 00:1b:44 or 02:00:aa:0.")
    return key


def is_locally_administered(mac: str) -> bool:
    key = hexkey(mac)
    if len(key) < 2:
        return False
    return bool(int(key[:2], 16) & 0x02)


def vendors_for(macs, tenant) -> dict[str, dict | None]:
    """Batch resolve: ``{hexkey: {"name", "source"} | None}`` for every MAC
    in ``macs`` in ONE query, however many rows the caller renders."""
    from .models import OuiPrefix

    keys = {hexkey(m) for m in macs if m}
    keys.discard("")
    if not keys:
        return {}
    cands = {k[:n] for k in keys for n in range(MIN_PREFIX_HEX, MAX_PREFIX_HEX + 1) if len(k) >= n}
    scope = Q(tenant__isnull=True)
    if tenant is not None:
        scope |= Q(tenant=tenant)
    rows = OuiPrefix.objects.filter(scope, prefix__in=cands).values_list(
        "prefix", "vendor", "source", "tenant_id"
    )
    by_prefix: dict[str, tuple[str, str]] = {}
    for prefix, vendor, source, tenant_id in rows:
        # A custom (tenant) row wins over the registry at the same prefix.
        if prefix in by_prefix and tenant_id is None:
            continue
        by_prefix[prefix] = (vendor, source)
    out: dict[str, dict | None] = {}
    for k in keys:
        hit = None
        for n in range(min(len(k), MAX_PREFIX_HEX), MIN_PREFIX_HEX - 1, -1):
            found = by_prefix.get(k[:n])
            if found:
                hit = {"name": found[0], "source": found[1]}
                break
        if hit is None and is_locally_administered(k):
            hit = {"name": LOCAL_LABEL, "source": "local"}
        out[k] = hit
    return out


def vendor_for(mac: str, tenant) -> dict | None:
    return vendors_for([mac], tenant).get(hexkey(mac))


def vendor_of_object(obj) -> dict | None:
    """A :class:`~api.models.MACAddress` object's vendor: its override when set,
    else the resolved one."""
    if obj.vendor_override:
        return {"name": obj.vendor_override, "source": "override"}
    return vendor_for(obj.mac_address, obj.tenant_id and obj.tenant)


# ─── registry import ─────────────────────────────────────────────────────────

_PREFIX_HEADERS = ("mac prefix", "prefix", "assignment", "oui")
_VENDOR_HEADERS = ("vendor name", "vendor", "organization name", "organization", "company")


def parse_registry_csv(text: str) -> dict[str, str]:
    """``{prefix: vendor}`` from a maclookup.app CSV (``Mac Prefix,Vendor
    Name,…``) or the IEEE ``oui.csv`` / ``mam.csv`` / ``oui36.csv``
    (``Registry,Assignment,Organization Name,…``). Header names pick the
    columns; a headerless file is read as ``prefix,vendor``."""
    reader = csv.reader(io.StringIO(text))
    rows = iter(reader)
    try:
        first = next(rows)
    except StopIteration:
        raise OuiError("The file is empty.") from None
    lowered = [c.strip().lower() for c in first]
    p_idx = next((i for i, c in enumerate(lowered) if c in _PREFIX_HEADERS), None)
    v_idx = next((i for i, c in enumerate(lowered) if c in _VENDOR_HEADERS), None)
    if p_idx is None or v_idx is None:
        # No recognisable header: treat the first row as data, first two columns.
        p_idx, v_idx = 0, 1
        rows = iter([first, *rows])
    out: dict[str, str] = {}
    for row in rows:
        if len(row) <= max(p_idx, v_idx):
            continue
        key = hexkey(row[p_idx])
        vendor = row[v_idx].strip()
        if MIN_PREFIX_HEX <= len(key) <= MAX_PREFIX_HEX and vendor:
            out[key] = vendor[:255]
    if not out:
        raise OuiError("No prefix/vendor rows found - expected a maclookup.app or IEEE CSV.")
    return out


def sync_registry(entries: dict[str, str], *, on_progress=None) -> dict:
    """Make the deployment-wide (tenant NULL) ``ieee`` rows mirror ``entries``.
    Creates, updates changed vendors, removes prefixes no longer listed."""
    from .models import OuiPrefix

    existing = {
        p: (pk, vendor)
        for pk, p, vendor in OuiPrefix.objects.filter(
            tenant__isnull=True, source="ieee"
        ).values_list("id", "prefix", "vendor")
    }
    to_create, to_update = [], []
    for prefix, vendor in entries.items():
        cur = existing.get(prefix)
        if cur is None:
            to_create.append(
                OuiPrefix(prefix=prefix, bits=len(prefix) * 4, vendor=vendor, source="ieee")
            )
        elif cur[1] != vendor:
            to_update.append(OuiPrefix(id=cur[0], vendor=vendor))
    gone = [pk for p, (pk, _) in existing.items() if p not in entries]
    total = len(to_create) + len(to_update) + len(gone)
    done = 0
    batch = 2000
    for i in range(0, len(to_create), batch):
        OuiPrefix.objects.bulk_create(to_create[i : i + batch])
        done += len(to_create[i : i + batch])
        if on_progress:
            on_progress(done, total)
    for i in range(0, len(to_update), batch):
        OuiPrefix.objects.bulk_update(to_update[i : i + batch], ["vendor"])
        done += len(to_update[i : i + batch])
        if on_progress:
            on_progress(done, total)
    for i in range(0, len(gone), batch):
        OuiPrefix.objects.filter(id__in=gone[i : i + batch]).delete()
        done += len(gone[i : i + batch])
        if on_progress:
            on_progress(done, total)
    return {
        "created": len(to_create),
        "updated": len(to_update),
        "removed": len(gone),
        "total": len(entries),
    }


# ─── next free MAC in an owned range ─────────────────────────────────────────

_PROBE = 256


def next_free_mac(rng, tenant) -> str | None:
    """The lowest address in ``rng`` (a custom :class:`OuiPrefix`) that no
    interface, VM interface, IP pairing, or MAC object in ``tenant`` uses.
    ``None`` when the range is full (or absurdly probed - 65k tries)."""
    from .models import Interface, IPAddress, MACAddress, VMInterface

    prefix = rng.prefix
    width = 12 - len(prefix)
    if width <= 0:
        return None
    space = 16**width
    limit = min(space, 65536)
    fmt = lambda n: prefix + format(n, f"0{width}x")  # noqa: E731

    def used(cands: list[str]) -> set[str]:
        pretty = [":".join(c[i : i + 2] for i in range(0, 12, 2)) for c in cands]
        seen = set()
        for qs in (
            Interface.objects.filter(device__tenant=tenant, mac_address__in=pretty),
            VMInterface.objects.filter(vm__tenant=tenant, mac_address__in=pretty),
            IPAddress.objects.filter(tenant=tenant, mac_address__in=pretty),
            MACAddress.objects.filter(tenant=tenant, mac_address__in=pretty),
        ):
            seen.update(hexkey(m) for m in qs.values_list("mac_address", flat=True))
        return seen

    for start in range(0, limit, _PROBE):
        cands = [fmt(n) for n in range(start, min(start + _PROBE, limit))]
        taken = used(cands)
        for c in cands:
            if c not in taken:
                return ":".join(c[i : i + 2] for i in range(0, 12, 2))
    return None
