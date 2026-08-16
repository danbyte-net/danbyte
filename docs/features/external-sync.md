---
icon: lucide/refresh-cw
---

# External sync: Windows DHCP/DNS & virtualization

Danbyte can keep itself in sync with systems that own live network state —
**Windows DHCP**, **Windows DNS**, and your **hypervisors** (Proxmox VE first,
vCenter planned). Everything is agentless: DHCP/DNS talk WinRM to the Windows
server's own PowerShell modules; hypervisors are reached over their REST API.

## Turning it on

All three integrations ship **off**. A tenant admin enables them under
**Settings → Integrations** — one toggle each for DHCP sync, DNS sync, and
virtualization sync. While a toggle is off, that integration's pages and API
endpoints are hidden for the tenant and its scheduled syncs don't run.

## Connections

### Windows servers (DHCP / DNS)

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

### Virtualization sources

A source names one hypervisor API. For **Proxmox VE**, authenticate with an
**API token** (Datacenter → Permissions → API Tokens; `PVEAuditor` is enough
for read sync) — the token secret is encrypted at rest and write-only, and
**Test connection** reports the API version and node count.

## Internal hosts and the outbound allowlist

Like the NetBox importer, these integrations respect the deployment's
**outbound-connection guard**: a private/internal address (which most DHCP
servers and hypervisors are) must be allow-listed under **Settings →
Deployment → General** (or `DANBYTE_SSRF_ALLOWLIST`) before Danbyte will
connect. Test connection tells you exactly that when the target isn't listed.

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
| Reservation | **IP address** (with MAC + reservation note) |
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

### Pushing reservations out

The **Reservations** tab is bidirectional: creating, editing, or deleting a
reservation there calls `Add/Set/Remove-DhcpServerv4Reservation` on the
owning server immediately — the row only saves once the server accepted it.
Pushed reservations carry a `[danbyte]` marker in their description so their
origin is visible in the Windows DHCP console too.

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

## Virtualization (Proxmox VE)

Enable the **Virtualization sync** toggle and add the cluster under
**Integrations → Virtualization sources** (any node's address works — the
API answers cluster-wide). Each sync imports into the **existing
cluster/VM inventory**:

| Proxmox object | Danbyte object |
| --- | --- |
| Cluster | **Cluster** (a *Proxmox VE* cluster type is created on demand) |
| QEMU / LXC guest | **Virtual machine** (vCPUs, memory, disk, description) |
| Guest NIC (`netX`) | **VM interface** with its MAC |
| Guest-agent IP | **IP address** assigned to the interface |

Rules:

- Same adoption policy as the Windows syncs: VMs, interfaces and IPs you
  already have are linked and blank-filled, never overwritten — and never
  deleted by sync. Only objects the sync created itself are removed again
  when their guest disappears from the hypervisor.
- Guest IPs come from the **QEMU guest agent**, so they only appear for
  running QEMU VMs with the agent installed. An IP is only created when a
  **containing prefix** already exists — sync never invents address space.
  The first private IPv4 becomes the VM's primary IP (if it had none).
- A guest's node maps to the **Device** of the same name when one exists,
  linking VMs to their physical hosts.
- VM templates are skipped; read-only — Danbyte never changes the hypervisor.

!!! tip "Virtual routers become monitorable"
    Once a virtual router's IP is synced, the monitoring engine can check and
    SNMP-poll it like any other address — no special handling needed.

vCenter is planned behind the same source model (`kind: vcenter`).
