"""Windows DNS sync engine.

Zones are always *enumerated* (name, type, record count); record
reconciliation is opt-in per zone. For synced zones, A/AAAA (forward) and PTR
(reverse) records are reconciled against ``IPAddress.dns_name``:

* IP found, ``dns_name`` blank → the name is **filled in** (blank-fill only).
* IP found, names agree → in sync.
* IP found, names differ → a ``mismatch`` :class:`~integrations.models.DnsDrift`
  row for the operator to settle — accept the server's name, or push Danbyte's.
* IP carries a name inside a synced forward zone but the zone has no record →
  a ``missing_record`` drift (accept = clear the name / push = create the record).
* Record with no matching IP in Danbyte → ignored (view it live on the zone).

Nothing is ever auto-applied in either direction beyond blank-fill.

Push helpers rewrite records with ``Remove-DnsServerResourceRecord`` +
``Add-DnsServerResourceRecordA/AAAA/Ptr`` — Windows' Set- cmdlet needs full
record objects, so remove+add is the reliable shell-exec path.
"""
from __future__ import annotations

import ipaddress
import logging

from django.db import transaction
from django.utils import timezone

from .winrm_client import ps_str, run_json, run_ps

logger = logging.getLogger("danbyte.dns_sync")

#: AD/system zones nobody wants reconciled or even listed.
SKIP_ZONES = {"trustanchors"}


def _fetch_zones_script() -> str:
    return """
@(Get-DnsServerZone | Where-Object { -not $_.IsAutoCreated } |
  Select-Object ZoneName, @{n='zone_type';e={[string]$_.ZoneType}},
    IsReverseLookupZone) | ConvertTo-Json -Depth 4
"""


def _fetch_records_script(zone_names_synced: list[str]) -> str:
    zone_list = ",".join(ps_str(z) for z in zone_names_synced) or "@()"
    return f"""
$out = @()
foreach ($z in @({zone_list})) {{
  foreach ($t in @('A','AAAA','PTR')) {{
    $out += @(Get-DnsServerResourceRecord -ZoneName $z -RRType $t -ErrorAction SilentlyContinue |
      Select-Object @{{n='zone';e={{$z}}}}, HostName,
        @{{n='rtype';e={{$t}}}},
        @{{n='data';e={{
          if ($t -eq 'A') {{ $_.RecordData.IPv4Address.IPAddressToString }}
          elseif ($t -eq 'AAAA') {{ $_.RecordData.IPv6Address.IPAddressToString }}
          else {{ $_.RecordData.PtrDomainName }}
        }}}})
  }}
}}
$counts = @(); foreach ($z in @({zone_list})) {{
  $counts += [pscustomobject]@{{ zone = $z;
    n = @(Get-DnsServerResourceRecord -ZoneName $z -ErrorAction SilentlyContinue).Count }}
}}
[pscustomobject]@{{records=$out; counts=$counts}} | ConvertTo-Json -Depth 5
"""


def _as_list(value):
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def _fqdn(hostname: str, zone: str) -> str:
    host = (hostname or "").strip().rstrip(".")
    if host in ("@", ""):
        return zone
    return f"{host}.{zone}"


def _ptr_ip(hostname: str, zone: str) -> str | None:
    """Rebuild the address a PTR record names: record host + reverse zone."""
    try:
        full = f"{hostname}.{zone}".lower()
        if full.endswith(".in-addr.arpa"):
            parts = full[: -len(".in-addr.arpa")].split(".")
            return ".".join(reversed(parts))
        if full.endswith(".ip6.arpa"):
            nibbles = "".join(reversed(full[: -len(".ip6.arpa")].split(".")))
            words = [nibbles[i : i + 4] for i in range(0, 32, 4)]
            return str(ipaddress.ip_address(":".join(words)))
    except ValueError:
        return None
    return None


# ─── Read sync ────────────────────────────────────────────────────────────────


def sync_dns(conn) -> dict:
    from .models import DnsZone

    zones_raw = _as_list(run_json(conn, _fetch_zones_script()))
    now = timezone.now()
    counts = {"zones": 0, "records": 0, "filled": 0, "drift": 0}

    with transaction.atomic():
        seen = set()
        for z in zones_raw:
            name = (z.get("ZoneName") or "").rstrip(".")
            if not name or name.lower() in SKIP_ZONES:
                continue
            seen.add(name)
            counts["zones"] += 1
            DnsZone.objects.update_or_create(
                connection=conn, name=name,
                defaults={
                    "zone_type": z.get("zone_type") or "",
                    "is_reverse": bool(z.get("IsReverseLookupZone")),
                    "last_seen_at": now,
                },
            )
        DnsZone.objects.filter(connection=conn).exclude(name__in=seen).delete()

    synced = list(DnsZone.objects.filter(connection=conn, sync=True))
    if synced:
        data = run_json(conn, _fetch_records_script([z.name for z in synced])) or {}
        with transaction.atomic():
            _reconcile(conn, synced, data, now, counts)

    conn.last_sync_at = now
    conn.last_sync_status = "ok"
    conn.last_sync_error = ""
    conn.save(update_fields=["last_sync_at", "last_sync_status", "last_sync_error"])
    logger.info("dns sync %s: %s", conn.name, counts)
    return counts


def _reconcile(conn, synced_zones, data, now, counts) -> None:
    from api.models import IPAddress

    from .models import DnsDrift

    zones = {z.name: z for z in synced_zones}
    for c in _as_list(data.get("counts")):
        zone = zones.get((c.get("zone") or "").rstrip("."))
        if zone is not None:
            zone.record_count = int(c.get("n") or 0)
            zone.save(update_fields=["record_count"])

    def ip_row(ip: str):
        return IPAddress.objects.filter(
            tenant=conn.tenant, vrf__isnull=True, ip_address=ip
        ).first()

    fresh: set = set()  # (zone_id, ip, rtype) drift keys seen this pass
    # (zone, ip) pairs that have a record — for missing_record detection.
    recorded: dict[str, set] = {z: set() for z in zones}

    for r in _as_list(data.get("records")):
        zone = zones.get((r.get("zone") or "").rstrip("."))
        rtype = r.get("rtype") or ""
        host = (r.get("HostName") or "").strip()
        raw = (r.get("data") or "").strip()
        if zone is None or not raw or host == "@" and rtype == "PTR":
            continue
        counts["records"] += 1
        if rtype in ("A", "AAAA"):
            ip, server_name = raw, _fqdn(host, zone.name)
        else:  # PTR
            ip = _ptr_ip(host, zone.name) or ""
            server_name = raw.rstrip(".")
        if not ip:
            continue
        recorded[zone.name].add(ip)
        row = ip_row(ip)
        if row is None:
            continue  # record with no IPAM presence — live view only
        ours = (row.dns_name or "").rstrip(".")
        if not ours:
            row.dns_name = server_name
            row.save(update_fields=["dns_name"])
            counts["filled"] += 1
        elif ours.lower() != server_name.lower():
            DnsDrift.objects.update_or_create(
                zone=zone, ip=ip, record_type=rtype,
                defaults={
                    "kind": "mismatch", "ip_address": row,
                    "danbyte_name": ours, "server_name": server_name,
                    "last_seen_at": now,
                },
            )
            fresh.add((zone.id, ip, rtype))
            counts["drift"] += 1

    # missing_record: an IP names itself inside a synced forward zone, but the
    # zone has no record for it.
    for zone in synced_zones:
        if zone.is_reverse:
            continue
        suffix = "." + zone.name.lower()
        candidates = IPAddress.objects.filter(
            tenant=conn.tenant, vrf__isnull=True, dns_name__iendswith=suffix
        ) | IPAddress.objects.filter(
            tenant=conn.tenant, vrf__isnull=True, dns_name__iexact=zone.name
        )
        for row in candidates:
            if row.ip_address in recorded.get(zone.name, set()):
                continue
            rtype = "AAAA" if ":" in row.ip_address else "A"
            DnsDrift.objects.update_or_create(
                zone=zone, ip=row.ip_address, record_type=rtype,
                defaults={
                    "kind": "missing_record", "ip_address": row,
                    "danbyte_name": (row.dns_name or "").rstrip("."),
                    "server_name": "",
                    "last_seen_at": now,
                },
            )
            fresh.add((zone.id, row.ip_address, rtype))
            counts["drift"] += 1

    # Drift that no longer reproduces is settled — drop stale rows.
    from .models import DnsDrift as _D

    for stale in _D.objects.filter(zone__in=synced_zones):
        if (stale.zone_id, stale.ip, stale.record_type) not in fresh:
            stale.delete()


# ─── Push (Danbyte → DNS) ─────────────────────────────────────────────────────


def _split_in_zone(fqdn: str, zone_name: str) -> str:
    """The record host name for ``fqdn`` inside ``zone_name`` ('@' for apex)."""
    f, z = fqdn.lower().rstrip("."), zone_name.lower()
    if f == z:
        return "@"
    if not f.endswith("." + z):
        raise ValueError(
            f"'{fqdn}' is outside zone '{zone_name}' — rename the IP's DNS "
            "name into the zone, or sync the zone that owns it."
        )
    return fqdn.rstrip(".")[: -(len(z) + 1)]


def push_record(conn, zone, drift) -> None:
    """Make the zone match Danbyte for one drift row (raises WinRMError)."""
    name = drift.danbyte_name
    ip = drift.ip
    if drift.record_type == "PTR":
        # The record name is the IP's reverse pointer relative to this zone —
        # works for any zone cut (/24, /16, …), not just the conventional one.
        rec_host = _split_in_zone(ipaddress.ip_address(ip).reverse_pointer, zone.name)
        script = (
            f"Remove-DnsServerResourceRecord -ZoneName {ps_str(zone.name)} "
            f"-RRType PTR -Name {ps_str(rec_host)} -Force "
            f"-ErrorAction SilentlyContinue; "
            f"Add-DnsServerResourceRecordPtr -ZoneName {ps_str(zone.name)} "
            f"-Name {ps_str(rec_host)} -PtrDomainName {ps_str(name + '.')} "
            f"-ErrorAction Stop"
        )
    else:
        rec_host = _split_in_zone(name, zone.name)
        old_host = (
            _split_in_zone(drift.server_name, zone.name)
            if drift.server_name else None
        )
        add = (
            f"Add-DnsServerResourceRecordAAAA -ZoneName {ps_str(zone.name)} "
            f"-Name {ps_str(rec_host)} -IPv6Address {ps_str(ip)} -ErrorAction Stop"
            if drift.record_type == "AAAA"
            else f"Add-DnsServerResourceRecordA -ZoneName {ps_str(zone.name)} "
                 f"-Name {ps_str(rec_host)} -IPv4Address {ps_str(ip)} "
                 f"-ErrorAction Stop"
        )
        remove = ""
        if old_host is not None:
            remove = (
                f"Remove-DnsServerResourceRecord -ZoneName {ps_str(zone.name)} "
                f"-RRType {drift.record_type} -Name {ps_str(old_host)} -Force "
                f"-ErrorAction SilentlyContinue; "
            )
        script = remove + add
    run_ps(conn, script)
