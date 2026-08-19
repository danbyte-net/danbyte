"""Windows DNS sync engine.

Zones are always *enumerated* (name, type, record count); record
reconciliation is opt-in per zone. For synced zones, A/AAAA (forward) and PTR
(reverse) records are reconciled against ``IPAddress.dns_name``:

* IP found, ``dns_name`` blank → the name is **filled in** (blank-fill only).
* IP found, names agree → in sync.
* IP found, names differ → a ``mismatch`` :class:`~integrations.models.DnsDrift`
  row for the operator to settle - accept the server's name, or push Danbyte's.
* IP carries a name inside a synced forward zone but the zone has no record →
  a ``missing_record`` drift (accept = clear the name / push = create the record).
* Record with no matching IP in Danbyte → ignored (view it live on the zone).

Nothing is ever auto-applied in either direction beyond blank-fill.

Push helpers rewrite records with ``Remove-DnsServerResourceRecord`` +
``Add-DnsServerResourceRecordA/AAAA/Ptr`` - Windows' Set- cmdlet needs full
record objects, so remove+add is the reliable shell-exec path.
"""
from __future__ import annotations

import ipaddress
import logging

from django.db import transaction
from django.utils import timezone

from api import vrf_placement

from .winrm_client import ps_str, run_json, run_ps

logger = logging.getLogger("danbyte.dns_sync")

#: AD/system zones nobody wants reconciled or even listed.
SKIP_ZONES = {"trustanchors"}

#: AD helper host labels that alias a DC's IP - real records, but never the
#: name a human means by that address, so they're chosen last when filling.
_AD_HELPER_HOSTS = {"forestdnszones", "domaindnszones", "gc"}


class DnsImportError(RuntimeError):
    """Raised when a record can't be imported into IPAM (no containing prefix)."""


def containing_prefix(tenant, ip: str, *, placement=None):
    """The smallest prefix that contains ``ip``, or None.

    Which VRF's prefixes are eligible is the connection's placement policy;
    ``placement=None`` means the default - the Global VRF alone, which is what
    this did before placement existed.
    """
    placement = placement or vrf_placement.Placement()
    return vrf_placement.place(tenant, ip, placement).prefix


def suggested_prefix_cidr(ip: str) -> str:
    """A sensible containing CIDR to offer when no prefix exists yet - a /64 for
    IPv6, a /24 for IPv4 (the address's network at that length)."""
    addr = ipaddress.ip_address(ip)
    plen = 64 if addr.version == 6 else 24
    return str(ipaddress.ip_network(f"{ip}/{plen}", strict=False))


def import_record(record):
    """Create an IPAddress for a DNS record's address and link it back.

    Fills the IP's ``dns_name`` from the record. Raises :class:`DnsImportError`
    when no prefix contains the address (an IP needs a prefix). Idempotent: if
    the address already exists it's adopted and linked, not duplicated.
    """
    from api.models import IPAddress

    conn = record.zone.connection
    tenant = conn.tenant
    placement = vrf_placement.Placement.from_policy(conn)
    row, _note = vrf_placement.existing_row(tenant, record.ip, placement)
    if row is None:
        placed = vrf_placement.place(tenant, record.ip, placement)
        if not placed.ok:
            where = vrf_placement.vrf_label(placement.preferred)
            raise DnsImportError(
                f"No prefix contains {record.ip} in {where} - create the "
                "prefix first, then import."
            )
        prefix = placed.prefix
        dns_name = record.name if record.record_type in ("A", "AAAA") else ""
        row = IPAddress.objects.create(
            tenant=tenant, ip_address=record.ip, prefix=prefix,
            dns_name=dns_name,
            description=f"Imported from Windows DNS «{record.zone.connection.name}»",
        )
    else:
        if record.record_type in ("A", "AAAA") and not row.dns_name:
            row.dns_name = record.name
            row.save(update_fields=["dns_name"])
    record.ip_address = row
    record.save(update_fields=["ip_address"])
    return row


def _preferred_name(server_names: set, zone_name: str) -> str:
    """Pick the name to fill a blank ``dns_name`` from an IP's server records.

    Prefer an ordinary host name over the zone apex, AD helper records
    (ForestDnsZones/DomainDnsZones), and underscore service labels - those
    alias the address but aren't what an operator means by it.
    """
    zn = zone_name.lower()

    def rank(name: str) -> tuple:
        low = name.lower()
        label = low[: -(len(zn) + 1)] if low.endswith("." + zn) else ""
        system = (
            low == zn  # apex
            or label in _AD_HELPER_HOSTS
            or label.startswith("_")
            or "._" in low
        )
        return (system, name)  # non-system first, then stable by name

    return sorted(server_names, key=rank)[0]


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
        # Prune zones that vanished from the server - but never Danbyte-authored
        # (managed) zones, which Danbyte owns and the server may not carry.
        DnsZone.objects.filter(connection=conn, managed=False).exclude(
            name__in=seen
        ).delete()

    # Records/drift only make sense for reconciled zones - drop any left behind
    # by a zone whose reconcile was switched off (or that vanished).
    from .models import DnsDrift, DnsRecord

    DnsRecord.objects.filter(
        zone__connection=conn, zone__sync=False, managed=False
    ).delete()
    DnsDrift.objects.filter(zone__connection=conn, zone__sync=False).delete()

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

    from .models import DnsDrift, DnsRecord

    zones = {z.name: z for z in synced_zones}
    for c in _as_list(data.get("counts")):
        zone = zones.get((c.get("zone") or "").rstrip("."))
        if zone is not None:
            zone.record_count = int(c.get("n") or 0)
            zone.save(update_fields=["record_count"])

    placement = vrf_placement.Placement.from_policy(conn)

    def ip_row(ip: str):
        row, _note = vrf_placement.existing_row(conn.tenant, ip, placement)
        return row

    fresh: set = set()  # (zone_id, ip, rtype) drift keys seen this pass
    fresh_records: set = set()  # (zone_id, name, rtype, data) stored this pass
    # (zone, ip) pairs that have a record - for missing_record detection.
    recorded: dict[str, set] = {z: set() for z in zones}

    # One IP legitimately carries many names (an AD zone's apex + ForestDnsZones
    # / DomainDnsZones helper records all point at the DC; round-robin, aliases).
    # So gather every server name per (zone, ip, rtype) first, then compare the
    # IP's dns_name against the whole set - a match to ANY of them is in sync.
    # names_by[(zone_name, ip, rtype)] = {server_name, …}
    names_by: dict[tuple, set] = {}
    for r in _as_list(data.get("records")):
        zone = zones.get((r.get("zone") or "").rstrip("."))
        rtype = r.get("rtype") or ""
        host = (r.get("HostName") or "").strip()
        raw = (r.get("data") or "").strip()
        if zone is None or not raw or (host == "@" and rtype == "PTR"):
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
        names_by.setdefault((zone.name, ip, rtype), set()).add(server_name)

        # Persist the address record itself so it's queryable from IPAM and a
        # real table - name/data are direction-specific.
        rec_name = server_name if rtype in ("A", "AAAA") else _fqdn(host, zone.name)
        rec_data = raw
        linked = ip_row(ip)
        # Opt-in auto-create: mint the IP for an untracked address when the zone
        # asks for it and a prefix contains it (else leave it unlinked).
        if linked is None and zone.auto_create:
            prefix = containing_prefix(conn.tenant, ip, placement=placement)
            if prefix is not None:
                from api.models import IPAddress

                linked = IPAddress.objects.create(
                    tenant=conn.tenant, ip_address=ip, prefix=prefix,
                    dns_name=rec_name if rtype in ("A", "AAAA") else "",
                    description=f"Imported from Windows DNS «{conn.name}»",
                )
                counts["filled"] += 1
        DnsRecord.objects.update_or_create(
            zone=zone, name=rec_name, record_type=rtype, data=rec_data,
            defaults={"ip": ip, "ip_address": linked, "last_seen_at": now},
        )
        fresh_records.add((zone.id, rec_name, rtype, rec_data))

    for (zone_name, ip, rtype), server_names in names_by.items():
        zone = zones[zone_name]
        row = ip_row(ip)
        if row is None:
            continue  # record with no IPAM presence - live view only
        ours = (row.dns_name or "").rstrip(".")
        lowered = {n.lower() for n in server_names}
        if not ours:
            row.dns_name = _preferred_name(server_names, zone.name)
            row.save(update_fields=["dns_name"])
            counts["filled"] += 1
        elif ours.lower() not in lowered:
            DnsDrift.objects.update_or_create(
                zone=zone, ip=ip, record_type=rtype,
                defaults={
                    "kind": "mismatch", "ip_address": row,
                    "danbyte_name": ours,
                    "server_name": ", ".join(sorted(server_names))[:255],
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
        scoped = IPAddress.objects.filter(tenant=conn.tenant)
        # Only addresses this connection is responsible for can be "missing" a
        # record here - one in another VRF is another routing domain's business.
        if not placement.allow_other_vrfs:
            scoped = scoped.filter(vrf=placement.preferred)
        candidates = scoped.filter(
            dns_name__iendswith=suffix
        ) | scoped.filter(dns_name__iexact=zone.name)
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

    # Drift that no longer reproduces is settled - drop stale rows.
    for stale in DnsDrift.objects.filter(zone__in=synced_zones):
        if (stale.zone_id, stale.ip, stale.record_type) not in fresh:
            stale.delete()

    # Records removed from the zone since last sync go too - but never the
    # ones authored in Danbyte (managed).
    for stale in DnsRecord.objects.filter(zone__in=synced_zones, managed=False):
        key = (stale.zone_id, stale.name, stale.record_type, stale.data)
        if key not in fresh_records:
            stale.delete()


# ─── Push (Danbyte → DNS) ─────────────────────────────────────────────────────


def _split_in_zone(fqdn: str, zone_name: str) -> str:
    """The record host name for ``fqdn`` inside ``zone_name`` ('@' for apex)."""
    f, z = fqdn.lower().rstrip("."), zone_name.lower()
    if f == z:
        return "@"
    if not f.endswith("." + z):
        raise ValueError(
            f"'{fqdn}' is outside zone '{zone_name}' - rename the IP's DNS "
            "name into the zone, or sync the zone that owns it."
        )
    return fqdn.rstrip(".")[: -(len(z) + 1)]


def push_record(conn, zone, drift) -> None:
    """Make the zone match Danbyte for one drift row (raises WinRMError)."""
    name = drift.danbyte_name
    ip = drift.ip
    if drift.record_type == "PTR":
        # The record name is the IP's reverse pointer relative to this zone -
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
