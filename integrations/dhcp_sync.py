"""Windows DHCP sync engine (issue #23).

Read direction: one WinRM round trip per connection pulls scopes, exclusion
ranges, reservations, per-scope options, and (for opted-in scopes) leases -
then reconciles them into IPAM:

====================  ============================================
Windows DHCP object   Danbyte object
====================  ============================================
Scope                 Prefix (+ a :class:`DhcpScope` link row)
Exclusion range       IPRange (via :class:`DhcpExclusion`)
Reservation           IPAddress (via :class:`DhcpReservation`)
Lease (opt-in)        IPAddress (via :class:`DhcpLease`)
Scope options         ``DhcpScope.options`` (kept structured)
====================  ============================================

Rules of engagement:

* IPAM rows an operator already has are **adopted, never clobbered** - the
  sync fills blanks (MAC, DNS name, description) and links, but does not
  overwrite non-empty operator data.
* Reservations Danbyte manages (``managed=True``, i.e. created/edited here)
  are **drift-checked**: a change made in the Windows console flags the row
  for review; nothing is silently overwritten in either direction.
* Unmanaged reservations simply mirror the server.

Write direction (:func:`push_reservation`, :func:`remove_reservation`): the
``Add/Set/Remove-DhcpServerv4Reservation`` cmdlets, with a "managed by
Danbyte" marker appended to the description so the origin is visible in the
Windows DHCP console too.
"""
from __future__ import annotations

import ipaddress
import logging
import re

from django.db import transaction
from django.utils import timezone

from .winrm_client import WinRMError, ps_str, run_json

logger = logging.getLogger("danbyte.dhcp_sync")

#: appended to pushed reservation descriptions, mirrored in the console.
MANAGED_MARK = "[danbyte]"

_SELECT_SCOPE = (
    "Select-Object @{n='scope_id';e={$_.ScopeId.IPAddressToString}},"
    " Name, Description, @{n='state';e={[string]$_.State}},"
    " @{n='start';e={$_.StartRange.IPAddressToString}},"
    " @{n='end';e={$_.EndRange.IPAddressToString}},"
    " @{n='mask';e={$_.SubnetMask.IPAddressToString}},"
    " @{n='lease_duration';e={$_.LeaseDuration.ToString()}}"
)


def _fetch_script(lease_scope_ids: list[str]) -> str:
    """The one-round-trip collection script."""
    lease_list = ",".join(ps_str(s) for s in lease_scope_ids) or "@()"
    return f"""
$scopes = @(Get-DhcpServerv4Scope | {_SELECT_SCOPE})
$excl = @(Get-DhcpServerv4ExclusionRange |
  Select-Object @{{n='scope_id';e={{$_.ScopeId.IPAddressToString}}}},
    @{{n='start';e={{$_.StartRange.IPAddressToString}}}},
    @{{n='end';e={{$_.EndRange.IPAddressToString}}}})
$res = @(); $opts = @()
foreach ($s in $scopes) {{
  $res += @(Get-DhcpServerv4Reservation -ScopeId $s.scope_id -ErrorAction SilentlyContinue |
    Select-Object @{{n='scope_id';e={{$_.ScopeId.IPAddressToString}}}},
      @{{n='ip';e={{$_.IPAddress.IPAddressToString}}}},
      @{{n='mac';e={{[string]$_.ClientId}}}}, Name, Description)
  $opts += @(Get-DhcpServerv4OptionValue -ScopeId $s.scope_id -ErrorAction SilentlyContinue |
    Select-Object @{{n='scope_id';e={{$s.scope_id}}}}, OptionId, Name,
      @{{n='value';e={{@($_.Value | ForEach-Object {{ [string]$_ }})}}}})
}}
$leases = @()
foreach ($sid in @({lease_list})) {{
  $leases += @(Get-DhcpServerv4Lease -ScopeId $sid -ErrorAction SilentlyContinue |
    Select-Object @{{n='scope_id';e={{$_.ScopeId.IPAddressToString}}}},
      @{{n='ip';e={{$_.IPAddress.IPAddressToString}}}},
      @{{n='mac';e={{[string]$_.ClientId}}}}, HostName,
      @{{n='state';e={{[string]$_.AddressState}}}},
      @{{n='expires';e={{if ($_.LeaseExpiryTime) {{ $_.LeaseExpiryTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ') }}}}}})
}}
[pscustomobject]@{{scopes=$scopes; exclusions=$excl; reservations=$res;
  options=$opts; leases=$leases}} | ConvertTo-Json -Depth 6
"""


def _as_list(value):
    """ConvertTo-Json collapses single-element arrays to a bare object."""
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def _norm_mac(raw: str) -> str:
    """Windows ClientIds look like ``aa-bb-cc-00-11-22`` - normalise to colons.

    Anything that isn't a 48-bit MAC comes back as-is: a ClientId may be an
    RFC 4361 client identifier, a DUID, or a 20-byte Infiniband GUID, and the
    lease/reservation row keeps whatever the server actually reported.
    """
    hexed = re.sub(r"[^0-9a-fA-F]", "", raw or "")
    if len(hexed) == 12:
        return ":".join(hexed[i : i + 2] for i in range(0, 12, 2)).lower()
    return (raw or "").lower()


# A canonical 48-bit MAC, which is all IPAddress.mac_address holds.
_MAC_RE = re.compile(r"^[0-9a-f]{2}(:[0-9a-f]{2}){5}$")


def _mac_for_ip(value: str) -> str:
    """The value if it really is a MAC, else blank.

    ``IPAddress.mac_address`` is ``varchar(17)`` and documented as a 48-bit
    MAC. A longer ClientId assigned to it aborted the whole scope's sync with
    *"value too long for type character varying(17)"* - one client with a DUID
    took its entire scope down (#115). Nothing is lost by skipping it: the
    lease and reservation rows keep the raw identifier, and a DUID was never a
    MAC to begin with.
    """
    return value if _MAC_RE.match(value or "") else ""


def _parse_when(iso: str | None):
    if not iso:
        return None
    import datetime as _dt

    from django.utils.dateparse import parse_datetime

    parsed = parse_datetime(iso)
    if parsed is not None and timezone.is_naive(parsed):
        parsed = timezone.make_aware(parsed, _dt.UTC)
    return parsed


def _source_note(conn) -> str:
    if conn is None:  # local (Danbyte-owned) scope - no server behind it
        return "Danbyte-local DHCP scope"
    return f"Synced from Windows DHCP «{conn.name}»"


# ─── Read sync ────────────────────────────────────────────────────────────────


def sync_dhcp(conn) -> dict:
    """Full read sync for one connection. Returns a counters dict."""
    from .models import DhcpScope

    lease_ids = list(
        DhcpScope.objects.filter(connection=conn, lease_sync=True).values_list(
            "scope_id", flat=True
        )
    )
    data = run_json(conn, _fetch_script(lease_ids)) or {}
    now = timezone.now()
    with transaction.atomic():
        counts = _apply(conn, data, now)
    logger.info("dhcp sync %s: %s", conn.name, counts)
    return counts


def _apply(conn, data: dict, now) -> dict:
    from .models import DhcpExclusion, DhcpLease, DhcpReservation, DhcpScope

    counts = {"scopes": 0, "prefixes_created": 0, "exclusions": 0,
              "reservations": 0, "leases": 0, "drift": 0}

    options_by_scope: dict[str, list] = {}
    for o in _as_list(data.get("options")):
        options_by_scope.setdefault(o["scope_id"], []).append(
            {"option_id": o.get("OptionId"), "name": o.get("Name") or "",
             "value": _as_list(o.get("value"))}
        )

    seen_scope_ids = set()
    scopes_by_id: dict[str, DhcpScope] = {}
    warnings: list[str] = []
    for s in _as_list(data.get("scopes")):
        sid = s["scope_id"]
        seen_scope_ids.add(sid)
        counts["scopes"] += 1
        prefix, created = _prefix_for_scope(
            conn, sid, s.get("mask"), vrf=conn.vrf
        )
        if created:
            counts["prefixes_created"] += 1
        if prefix is None and s.get("mask"):
            # The CIDR exists in more than one VRF, so linking it would be a
            # guess. Say which scope is affected - the scope still syncs, it
            # just carries no prefix until an operator names the VRF.
            warnings.append(
                f"Scope {sid}/{s.get('mask')} matches prefixes in several VRFs "
                f"- set this connection's VRF to choose one"
            )
        scope, _ = DhcpScope.objects.update_or_create(
            connection=conn, scope_id=sid,
            defaults={
                "name": s.get("Name") or "",
                "description": s.get("Description") or "",
                "state": s.get("state") or "",
                "start_range": s.get("start"),
                "end_range": s.get("end"),
                "subnet_mask": s.get("mask"),
                "lease_duration": s.get("lease_duration") or "",
                "options": options_by_scope.get(sid, []),
                "prefix": prefix,
                "last_seen_at": now,
            },
        )
        scopes_by_id[sid] = scope

    # Scopes deleted on the server: drop the link rows (the Prefix stays -
    # deleting IPAM data because a scope vanished is not our call).
    DhcpScope.objects.filter(connection=conn).exclude(
        scope_id__in=seen_scope_ids
    ).delete()

    # ── exclusion ranges → IPRange ──
    seen_excl: dict[str, set] = {sid: set() for sid in scopes_by_id}
    for e in _as_list(data.get("exclusions")):
        scope = scopes_by_id.get(e["scope_id"])
        if scope is None:
            continue
        key = (e["start"], e["end"])
        seen_excl[e["scope_id"]].add(key)
        counts["exclusions"] += 1
        excl, _ = DhcpExclusion.objects.get_or_create(
            scope=scope, start_address=e["start"], end_address=e["end"]
        )
        if excl.ip_range_id is None:
            excl.ip_range = _range_for_exclusion(conn, scope, e["start"], e["end"])
            excl.save(update_fields=["ip_range"])
    for sid, scope in scopes_by_id.items():
        for gone in scope.exclusions.all():
            if (gone.start_address, gone.end_address) in seen_excl.get(sid, set()):
                continue
            # We created the IPRange for this exclusion; it goes with it.
            if gone.ip_range_id:
                gone.ip_range.delete()
            gone.delete()

    # ── reservations → IPAddress ──
    server_res: dict[tuple, dict] = {}
    for r in _as_list(data.get("reservations")):
        server_res[(r["scope_id"], r["ip"])] = r
    for (sid, ip), r in server_res.items():
        scope = scopes_by_id.get(sid)
        if scope is None:
            continue
        counts["reservations"] += 1
        row = DhcpReservation.objects.filter(scope=scope, ip=ip).first()
        mac = _norm_mac(r.get("mac") or "")
        name = r.get("Name") or ""
        desc = (r.get("Description") or "").replace(MANAGED_MARK, "").strip()
        if row is None:
            row = DhcpReservation(scope=scope, ip=ip, managed=False)
        if row.managed:
            drift_detail = {}
            for field, server_val in (("mac", mac), ("name", name),
                                      ("description", desc)):
                ours = getattr(row, field)
                if ours != server_val:
                    drift_detail[field] = {"danbyte": ours, "server": server_val}
            row.drift = "modified" if drift_detail else ""
            row.drift_detail = drift_detail
            if drift_detail:
                counts["drift"] += 1
        else:
            row.mac, row.name, row.description = mac, name, desc
        row.last_seen_at = now
        if row.ip_address_id is None:
            row.ip_address = _ip_for_reservation(conn, scope, row)
        row.save()
    # Managed rows missing on the server = drift; unmanaged mirrors just go.
    for scope in scopes_by_id.values():
        for row in scope.reservations.all():
            if (scope.scope_id, row.ip) in server_res:
                continue
            if row.managed:
                if row.drift != "missing":
                    row.drift = "missing"
                    row.drift_detail = {}
                    row.save(update_fields=["drift", "drift_detail"])
                    counts["drift"] += 1
            else:
                row.delete()

    # ── leases (opt-in per scope) → IPAddress ──
    server_leases: dict[tuple, dict] = {}
    for lease in _as_list(data.get("leases")):
        server_leases[(lease["scope_id"], lease["ip"])] = lease
    for (sid, ip), lease in server_leases.items():
        scope = scopes_by_id.get(sid)
        if scope is None or not scope.lease_sync:
            continue
        # A reservation on the same address always wins over its lease echo.
        if DhcpReservation.objects.filter(scope=scope, ip=ip).exists():
            continue
        counts["leases"] += 1
        row, _ = DhcpLease.objects.get_or_create(scope=scope, ip=ip)
        row.mac = _norm_mac(lease.get("mac") or "")
        row.hostname = lease.get("HostName") or ""
        row.address_state = lease.get("state") or ""
        row.expires_at = _parse_when(lease.get("expires"))
        row.last_seen_at = now
        if row.ip_address_id is None:
            row.ip_address, row.created_ip = _ip_for_lease(conn, scope, row)
        row.save()
    for scope in scopes_by_id.values():
        if not scope.lease_sync:
            # Opt-out (or never opted in): drop lease mirrors + our IP rows.
            stale = scope.leases.all()
        else:
            stale = [
                lease for lease in scope.leases.all()
                if (scope.scope_id, lease.ip) not in server_leases
            ]
        for lease in stale:
            if lease.created_ip and lease.ip_address_id:
                ipa = lease.ip_address
                # Only if it's still exactly the row we minted (unassigned).
                if ipa.assigned_interface_id is None and ipa.assigned_device_id is None:
                    ipa.delete()
            lease.delete()

    conn.last_sync_at = now
    conn.last_sync_status = "ok"
    conn.last_sync_error = ""
    conn.record_skipped(warnings)
    conn.save(update_fields=["last_sync_at", "last_sync_status",
                             "last_sync_error", "last_sync_skipped"])
    return counts


def _prefix_for_scope(conn, scope_id: str, mask: str | None, *,
                      tenant=None, vrf=None, note: str | None = None):
    """Find or create the Prefix a scope maps to. Returns (prefix, created).

    Windows DHCP has no VRF concept, so the VRF is Danbyte's choice: sync takes
    it from the connection's placement policy (Global unless configured), and
    the authoring API passes an explicit tenant/VRF plus a note for local scopes
    that have no connection to describe them.

    This is the only place in the DHCP path that needs the policy - a scope's
    reservations, leases and exclusions all follow ``scope.prefix.vrf``.
    """
    from api.models import Prefix

    tenant = tenant or conn.tenant
    try:
        net = ipaddress.ip_network(f"{scope_id}/{mask}", strict=False)
    except ValueError:
        return None, False
    cidr = str(net)
    existing = Prefix.objects.filter(tenant=tenant, vrf=vrf, cidr=cidr).first()
    if existing:
        return existing, False
    # Not in the VRF we asked for - but never invent address space that already
    # exists elsewhere. An operator who moves a scope's prefix into a VRF would
    # otherwise get a second prefix with the same CIDR minted here, and the
    # scope silently re-pointed at the duplicate. One match elsewhere is
    # unambiguous, so adopt it; several means we cannot choose, and a scope with
    # no prefix is already a state the sync handles.
    elsewhere = list(Prefix.objects.filter(tenant=tenant, cidr=cidr)[:2])
    if len(elsewhere) == 1:
        return elsewhere[0], False
    if elsewhere:
        return None, False
    return Prefix.objects.create(
        tenant=tenant, cidr=cidr, vrf=vrf,
        description=note if note is not None else _source_note(conn),
    ), True


def _range_for_exclusion(conn, scope, start: str, end: str):
    from api.models import IPRange

    # An exclusion belongs to the scope's prefix, so it shares that prefix's
    # routing context - look it up and create it there, not in the Global VRF.
    vrf_id = scope.prefix.vrf_id if scope.prefix_id else None
    existing = IPRange.objects.filter(
        tenant=conn.tenant, vrf_id=vrf_id, start_address=start, end_address=end
    ).first()
    if existing:
        return existing
    return IPRange.objects.create(
        tenant=conn.tenant, prefix=scope.prefix,
        start_address=start, end_address=end,
        description=f"DHCP exclusion - {_source_note(conn)}",
    )


def _adopt_ip(conn, scope, ip: str, mac: str, dns_name: str, note: str):
    """Find the tenant's row for ``ip`` or mint one; fill blanks only."""
    from api.models import IPAddress

    # Local scopes (no connection) carry the tenant themselves.
    tenant = conn.tenant if conn is not None else scope.tenant
    # A scope's addresses live wherever its prefix lives - the same for synced
    # and local scopes. IPAddress.save() derives this anyway; matching it here
    # means the lookup finds the row it is about to create rather than missing
    # it and minting a duplicate.
    vrf_id = scope.prefix.vrf_id if scope.prefix_id else None
    row = IPAddress.objects.filter(
        tenant=tenant, vrf_id=vrf_id, ip_address=ip
    ).first()
    created = False
    if row is None:
        if scope.prefix_id is None:  # unparsable scope mask - nothing to attach to
            return None, False
        row = IPAddress(
            tenant=tenant, ip_address=ip, prefix=scope.prefix,
            description=note,
        )
        created = True
    changed = created
    mac = _mac_for_ip(mac)
    if mac and not row.mac_address:
        row.mac_address, changed = mac, True
    if dns_name and not row.dns_name:
        row.dns_name, changed = dns_name, True
    if changed:
        row.save()
    return row, created


def _ip_for_reservation(conn, scope, res):
    row, _created = _adopt_ip(
        conn, scope, res.ip, res.mac, "",
        note=f"DHCP reservation «{res.name}» - {_source_note(conn)}",
    )
    # `reservation_note` is the operator's own "I want to hold this address"
    # affordance (it raises the amber marker on the IP). A DHCP reservation is
    # not that - it's surfaced by the DHCP badge instead - so we never set it,
    # and we retire the marker earlier syncs wrote here.
    if (
        conn is not None
        and row is not None
        and row.reservation_note == f"DHCP reservation ({conn.name})"
    ):
        row.reservation_note = ""
        row.save(update_fields=["reservation_note"])
    return row


def _ip_for_lease(conn, scope, lease):
    return _adopt_ip(
        conn, scope, lease.ip, lease.mac, lease.hostname,
        note=f"DHCP lease - {_source_note(conn)}",
    )


# ─── Push (Danbyte → DHCP) ────────────────────────────────────────────────────


def _mac_for_windows(mac: str) -> str:
    return _norm_mac(mac).replace(":", "-").upper()


def push_reservation(conn, scope, *, ip: str, mac: str, name: str,
                     description: str, exists: bool) -> None:
    """Create or update a reservation on the server (raises WinRMError)."""
    desc = f"{description} {MANAGED_MARK}".strip()
    common = (
        f"-ScopeId {ps_str(scope.scope_id)} -IPAddress {ps_str(ip)} "
        f"-Name {ps_str(name)} -Description {ps_str(desc)}"
    )
    if exists:
        script = (
            f"Set-DhcpServerv4Reservation {common} "
            f"-ClientId {ps_str(_mac_for_windows(mac))} -ErrorAction Stop"
        )
    else:
        script = (
            f"Add-DhcpServerv4Reservation {common} "
            f"-ClientId {ps_str(_mac_for_windows(mac))} -ErrorAction Stop"
        )
    from .winrm_client import run_ps

    run_ps(conn, script)


def push_scope(conn, *, name: str, start: str, end: str, mask: str,
               description: str = "") -> None:
    """Create a scope on the server (``Add-DhcpServerv4Scope``). The scope id
    (network address) is derived by Windows from the start range + mask. Raises
    WinRMError if the server refuses it."""
    from .winrm_client import run_ps

    desc = f"{description} {MANAGED_MARK}".strip()
    run_ps(
        conn,
        f"Add-DhcpServerv4Scope -Name {ps_str(name)} "
        f"-StartRange {ps_str(start)} -EndRange {ps_str(end)} "
        f"-SubnetMask {ps_str(mask)} -Description {ps_str(desc)} "
        f"-State Active -ErrorAction Stop",
    )


def remove_scope(conn, scope_id: str) -> None:
    from .winrm_client import run_ps

    run_ps(
        conn,
        f"Remove-DhcpServerv4Scope -ScopeId {ps_str(scope_id)} -Force "
        f"-ErrorAction Stop",
    )


def remove_reservation(conn, scope, ip: str) -> None:
    from .winrm_client import run_ps

    # -IPAddress is its own parameter set; combining it with -ScopeId is
    # rejected as ambiguous ("Parameter set cannot be resolved").
    run_ps(
        conn,
        f"Remove-DhcpServerv4Reservation -IPAddress {ps_str(ip)} -ErrorAction Stop",
    )


def record_sync_failure(conn, exc: Exception) -> None:
    conn.last_sync_at = timezone.now()
    conn.last_sync_status = "failed"
    conn.last_sync_error = str(exc)[:2000]
    conn.save(update_fields=["last_sync_at", "last_sync_status", "last_sync_error"])


__all__ = [
    "MANAGED_MARK", "WinRMError", "push_reservation", "remove_reservation",
    "push_scope", "remove_scope", "record_sync_failure", "sync_dhcp",
]
