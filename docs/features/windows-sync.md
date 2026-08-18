---
icon: lucide/server
---

# Windows DHCP & DNS sync

Danbyte keeps itself in sync with **Windows DHCP** and **Windows DNS** —
agentless, over WinRM to the server's own PowerShell modules. Enable the
toggles under **Settings → Integrations** and add the server under
**Integrations → Windows servers**; see [External sync](external-sync.md) for
the shared ground rules (toggles, allowlist, where things live).

## The connection

One connection describes one Windows server; a single server can serve both
roles. A connection carries:

- **Host + port** — WinRM defaults to `5985` (HTTP) or `5986` with *Use TLS*.
  Self-signed WinRM certificates are the norm, so certificate verification is
  opt-in.
- **Auth** — NTLM (default; needs nothing on the Danbyte host) or Kerberos.
- **Credentials** — a username and password, encrypted at rest and write-only:
  the API never returns the password, only whether one is set.
- **Roles** — which of DHCP / DNS to sync from this server.
- **Poll interval** and an enable switch per connection.

**Test connection** runs a real probe: PowerShell version plus a scope count
(DHCP) and zone count (DNS), so a permission or role problem shows up before
the first sync.

!!! tip "Service account, not domain admin"
    Use a dedicated service account in the **DHCP Administrators** group (and
    with DNS management rights if syncing DNS). Windows DHCP has no per-scope
    ACLs — the account can touch every scope on that server — so restrict
    inbound WinRM on the server's firewall to the Danbyte host.

## Windows DHCP

Enable the **Windows DHCP sync** toggle, add the server under
**Integrations → Windows servers** with the DHCP role ticked, and sync (the
scheduler polls on the connection's interval; **Sync now** on the server page
does it immediately).

### What syncs in

| Windows DHCP object | Danbyte object |
| --- | --- |
| Scope | **Prefix** (found by CIDR, or created) |
| Exclusion range | **IP range** |
| Reservation | **IP address** (with MAC; flagged by the DHCP badge) |
| Lease *(opt-in per scope)* | **IP address** |
| Scope options (router, DNS, lease time…) | kept structured on the scope |

Rules:

- **Nothing of yours is overwritten.** Existing prefixes and IPs are adopted —
  the sync fills blank fields (MAC, DNS name) and links objects, but never
  replaces operator data.
- **Leases are opt-in per scope** (the *Lease sync* switch on the server's
  Overview tab) — they churn constantly and would flood the database
  otherwise. IPs the lease sync created disappear again with their lease;
  IPs you already had are never deleted. A reservation always wins over a
  lease on the same address.
- Deleting a scope on the server removes the scope link, **not** the prefix.

### Adding reservations

Static reservations (a **MAC → IP** binding) are bidirectional: create, edit or
delete one from the **DHCP reservations** page (Add button + per-row edit/
delete), a server's page, or the **IP address form** — when an address sits
inside a scope pool, the form offers **Reserve in DHCP (MAC binding)**, which
binds it to the form's MAC field; unticking removes the reservation. All paths
call `Add/Set/Remove-DhcpServerv4Reservation` on the owning server immediately —
the row only saves once the server accepted it. Pushed reservations carry a
`[danbyte]` marker in their description so their origin is visible in the
Windows DHCP console too.

### Authoring scopes and zones

Scopes and zones are usually born from a sync, but you can also create them by
hand:

- **DHCP scope** — **Add scope** on the DHCP scopes page. Pick the **server**
  (or **Local — Danbyte-managed** for deployments without a synced DHCP server:
  the scope is stored in Danbyte only, nothing is pushed). The subnet comes
  from an **existing prefix** (keeping its VRF) or a typed CIDR in a chosen
  **VRF**; the lease range sits inside it. With a server picked, Danbyte runs
  `Add-DhcpServerv4Scope` first and only saves once it's accepted; deleting a
  pushed scope removes it on the server too. Reservations in a local scope are
  likewise stored locally without a push. You can also create a scope inline
  from the **+** next to the Scope picker in the New reservation dialog.
- **DNS zone** — **Add zone** on the DNS zones page (server, name, forward or
  reverse). DNS is Danbyte-authoritative for managed content — pushing zones to
  the server is a later phase — so an authored zone is stored locally, tagged
  **managed**, and never pruned by sync. Only managed zones can be deleted;
  mirrored zones would just return on the next sync.

### Spotting DHCP in IPAM

DHCP-managed space is flagged so it's obvious in IPAM, in one blue hue at two
intensities so the states read as the same family:

- A prefix that **backs a DHCP scope** shows a **DHCP** badge in the prefix
  list (its own sortable/filterable column).
- Every IP table has a dedicated **DHCP** column carrying the badge in one of
  two states:
    - **solid** — *leased*: held right now by a reservation or an active lease.
    - **faint outline** — *scope*: inside a scope's pool range but not currently
      handed out (DHCP-managed space, not necessarily in use).
- **Exclusion ranges carve holes in the pool.** Addresses inside an exclusion
  carry a dashed **DHCP EXCL** badge instead of the pool badge — static space
  the server never hands out. The IPRange the exclusion created carries the
  same badge on the ranges list and its detail page.
- On a prefix's IPs tab, the **Show DHCP pool** toggle (next to *Show
  available*) lays out the scope pool's addresses as ghost rows even before any
  of them exist in IPAM — the pool is visible without creating anything.

DHCP addresses are marked *only* by this badge; they never raise the operator's
manual **reservation note** marker, which stays reserved for addresses a person
deliberately holds.

### Drift

Reservations Danbyte manages are watched: change or delete one directly in
the Windows console and the next sync flags it — **modified on server** (with
a field-by-field diff) or **missing on server** — instead of silently adopting
or overwriting. Resolve each flag with **Accept** (take the server's version)
or **Push ours** (re-assert Danbyte's). Reservations that only ever lived on
the server simply mirror it and are never flagged.

## Windows DNS

Enable the **Windows DNS sync** toggle and tick the DNS role on the
connection. The server's **DNS** tab then lists every zone (auto-created and
system zones like TrustAnchors are skipped); click a zone to view its records
**live** off the server.

### Reconciliation (opt-in per zone)

Flip a zone's **Reconcile** switch and the sync compares its A/AAAA (and PTR,
for reverse zones) records against your IP addresses' **DNS names**:

- IP found, DNS name blank → the name is **filled in** (blank-fill only —
  the one automatic write).
- Names agree → in sync; nothing happens.
- Names differ → a **drift** entry: *Name differs*, showing both sides.
- An IP carries a name inside a reconciled forward zone, but the zone has no
  record for it → *No record on server*.
- A record whose address isn't in Danbyte at all is left alone — see it in
  the live zone viewer.

Nothing beyond blank-fill is ever applied automatically. Each drift entry is
settled by hand: **Accept** (the server wins — the IP takes the server's
name, or loses its name when no record exists) or **Push ours** (Danbyte
wins — the record is rewritten on the server via
`Remove-/Add-DnsServerResourceRecord`). Drift that stops reproducing — because
someone fixed it on either side — clears itself on the next sync.

Out of scope for now: CNAME/MX/SRV/TXT management, creating zones, and
DNSSEC. Point the connection at one server of an AD-replicated set; AD
replication carries pushed records to the rest.

### The zone page and record cross-links

Opening a zone (its name on the DNS tab) shows a **records page**: the
zone's A/AAAA/PTR records as a proper table, each linked to its IP address —
records for space Danbyte doesn't track are shown too, marked *not in IPAM*.
A **"Show all record types (live)"** button fetches the full zone dump
(CNAME/MX/TXT…) straight from the server when you need it.

Because reconciled records are stored, they also surface **inside IPAM**:

- A prefix's **DNS** tab lists every record whose address falls in that
  prefix.
- An IP address's overview shows a **DNS records** section — its A/AAAA and
  PTR records together, so you can see the forward/reverse round-trip at a
  glance.

Only reconciled zones store records (matching the per-zone opt-in); records
are pruned as they leave the server, and cleared entirely if you switch a
zone's reconcile off.

### Bringing records into IPAM

A record for an address Danbyte doesn't track yet shows **· not in IPAM**.
To pull it in:

- **Add to IPAM** on the record creates the IP address, links the record, and
  sets the IP's DNS name from it. On a zone page, **Add all unmatched to IPAM**
  does the whole zone at once.
- Import needs a **containing prefix** — an IP must belong to one. If no prefix
  covers the address (common for a public IPv6 record), the import is refused
  with a message; create the prefix first, then import. Bulk import reports how
  many were skipped for this reason.
- **Auto-add to IPAM** (per-zone switch) does it automatically on every sync —
  off by default, since importing is a deliberate choice. It still only creates
  IPs where a prefix exists.

### Authoring records

Records synced from a Windows server are read-only (the server owns them). You
can also **author your own** records in Danbyte: **DNS records → Add record**
(or the same button on a zone page) opens a form — pick the zone, name, **type**
(A, AAAA, CNAME, MX, TXT, NS, SRV, PTR, CAA), value, and an optional TTL, with
per-type validation (an A must be an IPv4, an MX is `"10 mail…"`, and so on).
Authored records are marked **managed**: they're **editable and deletable** (a
pencil/trash on the row), and the sync **never** touches or prunes them — so
Danbyte can be the source of truth even in a zone it also observes. (Pushing
authored records out to a DNS backend is a planned follow-up; today they live
in Danbyte.)
