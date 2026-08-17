---
icon: lucide/refresh-cw
---

# External sync: Windows DHCP/DNS & virtualization

Danbyte can keep itself in sync with systems that own live network state —
**Windows DHCP**, **Windows DNS**, and your **hypervisors** (Proxmox VE and
VMware vCenter). Everything is agentless: DHCP/DNS talk WinRM to the Windows
server's own PowerShell modules; hypervisors are reached over their REST API.

## Turning it on

All three integrations ship **off**. A tenant admin enables them under
**Settings → Integrations** — one toggle each for DHCP sync, DNS sync, and
virtualization sync. While a toggle is off, that integration's pages and API
endpoints are hidden for the tenant and its scheduled syncs don't run.

## Where things live

Two places, on purpose:

- **Integrations → Windows servers / Virtualization sources** — where you
  *configure connections*: host, credentials, roles, sync mode, and the
  per-server drift/review views.
- **DNS & DHCP** (sidebar section) — where you *read and act on the synced
  data*, aggregated across every server: **DHCP** → Scopes, Reservations,
  Leases; **DNS** → Zones, Records. Each list filters by server and links back
  to the prefixes and IP addresses the data maps to. These pages appear once
  the matching toggle is on.

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

A source names one hypervisor API. Pick the **type** when you add it:

- **Proxmox VE** — authenticate with an **API token** (Datacenter →
  Permissions → API Tokens; `PVEAuditor` is enough for read sync). Default API
  port `8006`.
- **VMware vCenter** — authenticate with an **SSO username and password** (a
  read-only role is enough for inventory sync). Default API port `443`; the
  connector uses the vSphere Automation REST API (`/api/`), creating one login
  session per sync pass and tearing it down afterwards.

Credentials are encrypted at rest and write-only, and **Test connection**
reports the reachable host/node count (plus API version for Proxmox).

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

## Virtualization (Proxmox VE & VMware vCenter)

Enable the **Virtualization sync** toggle and add a source under
**Integrations → Virtualization sources**. For Proxmox any node's address works
(the API answers cluster-wide); for vCenter, point at the vCenter Server. Each
sync imports into the **existing cluster/VM inventory**:

| Proxmox object | vCenter object | Danbyte object |
| --- | --- | --- |
| Cluster | Cluster (single-cluster vCenters; else the source name) | **Cluster** (a *Proxmox VE* / *VMware vCenter* cluster type is created on demand) |
| QEMU / LXC guest | Virtual machine | **Virtual machine** (vCPUs, memory, disk, description) |
| Guest tags (`prod;web`) | — | **Tags** (added, never removed) — Proxmox only |
| Notes / annotation | VM annotation | **Description** (blank-filled, never overwrites yours) |
| Guest NIC (`netX`) | Ethernet adapter | **VM interface** with its MAC |
| Disk (`scsiN`/`virtioN`/…) | Virtual disk device | **Virtual disk** (name, size, storage/datastore, controller) — *opt-in* |
| Bridge + VLAN tag (`vmbr0,tag=42`) | Port-group VLAN | **VLAN** (in the source's VLAN group) + the interface's access VLAN — *opt-in* |
| Bridge | vSwitch | **Virtual switch** — *opt-in* |
| Guest-agent IP | VMware Tools reported IP | **IP address** assigned to the interface |
| Node | ESXi host | linked to the **Device** of the same name |

### Disks, virtual switches and networks (opt-in)

Two per-source switches (under the tenant's virtualization master toggle)
widen what a source imports:

- **Sync disks** (on by default) — each VM's virtual disks become **Virtual
  disk** rows (shown on the VM's Overview): name, size, storage pool /
  datastore, and controller. Optical drives are skipped. The VM's aggregate
  *Disk* figure is unchanged.
- **Sync virtual switches & networks** (off by default) — virtual switches
  (Proxmox bridges / OVS, vCenter standard & distributed switches) become
  **Virtual switch** rows, and each VLAN-tagged network becomes a **VLAN** in a
  VLAN group named after the source. A VM interface's access VLAN is then
  **blank-filled** from the port-group/bridge tag (never overwriting a VLAN you
  set).

Both follow the same adoption rules as the rest of the sync: sync-created rows
are refreshed and pruned when they vanish; operator-created rows are only
blank-filled and never deleted.

Once networks are synced, each **virtual switch** page has a **Networks** tab
(its port-groups/bridges → VLANs → the VMs on them), and
**Virtualization → Network topology** draws the whole picture — switches, their
networks (VLANs) as bars, and the VMs on each — an OpenStack-style map, with VM
boxes tinted by status.

A switch's **Uplinks · physical adapters** (on its Overview) link the switch to
the **real host NICs** — the hypervisor host is a Device, and you assign its
physical interfaces as the switch's uplinks (host device → interface). This is
the vCenter "Physical Adapters" layer: the uplink traces straight through to its
cabled port (cable-trace), and the topology shows the adapters feeding each
switch.

For **Proxmox** these are filled **automatically**: each bridge's `bridge_ports`
are matched to the node Device's interfaces (so a cluster-wide bridge collects
the ports from every host — the multi-hypervisor case). The node must be
modelled as a Device with those interfaces; matching is additive and never
removes an uplink you set. For **vCenter** the vSphere REST API doesn't expose
standard-switch pNICs cleanly, so assign uplinks **inline on the switch page**
for now.

Both hypervisors run through the same reconcile engine, so sync modes,
adoption, blank-fill and the review inbox behave identically — only the fetch
and the identifiers differ (Proxmox integer VMIDs; vCenter VM MoRefs, whose
numeric part is used as the stable id).

### Sync mode — who is the source of truth

Each source has a **sync mode** that decides how discovered differences reach
the inventory:

- **Automatic (mirror)** — the sync applies everything on a schedule: new VMs
  are created, specs updated, and VMs whose guests disappear are removed. The
  **hypervisor is the source of truth**. Hands-off, but Danbyte follows
  Proxmox.
- **Review** (default) — the sync still polls on a schedule, but only to
  **detect**. New VMs, changed specs and removals land in a **review inbox**
  ("N to review" on the sources list); nothing changes until you **Accept**
  each one (or **Ignore** it until it changes again). **Danbyte stays the
  source of truth.**
- **Manual** — like Review, but nothing is scheduled: differences are detected
  only when you press **Sync**, and applied only on accept.

A new source defaults to **Review** so a fresh connection never reshapes your
inventory before you've seen what it would do.

### What each side owns

- The **hypervisor owns** a VM's existence, its node, power state, and — in
  Automatic mode — its specs (vCPU/RAM/disk).
- **You own** everything else: role, platform, tags, custom fields,
  description, site, and the primary-IP choice. The sync **never** overwrites
  those in any mode.

Rules:

- Same adoption policy as the Windows syncs: VMs, interfaces and IPs you
  already have are linked and blank-filled, never overwritten — and never
  deleted by sync. Only objects the sync created itself are removed again
  when their guest disappears from the hypervisor (Automatic), or offered as a
  removal to accept (Review/Manual).
- Interface and guest-IP discovery is additive (blank-fill) and runs for any
  already-linked VM in every mode — the review inbox is only for the decisions
  that reshape inventory: new VMs, spec changes, and removals.
- Guest IPs come from the in-guest agent — the **QEMU guest agent** on Proxmox,
  **VMware Tools** on vCenter — so they only appear for running VMs with the
  agent present. An IP is only created when a **containing prefix** already
  exists — sync never invents address space. The first private IPv4 becomes the
  VM's primary IP (if it had none).
- A guest's node (Proxmox node / ESXi host) maps to the **Device** of the same
  name when one exists, linking VMs to their physical hosts.
- VM templates are skipped; read-only — Danbyte never changes the hypervisor.

!!! tip "Virtual routers become monitorable"
    Once a virtual router's IP is synced, the monitoring engine can check and
    SNMP-poll it like any other address — no special handling needed.
