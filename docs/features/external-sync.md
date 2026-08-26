---
icon: lucide/refresh-cw
---

# External sync overview

Danbyte can keep itself in sync with systems that own live network state.
Each connector has its own page:

- **[Windows DHCP & DNS](windows-sync.md)** - scopes, reservations, leases,
  zones and records, over WinRM.
- **[Proxmox VE](virt-proxmox.md)** - clusters, VMs, disks, bridges and
  networks, over the Proxmox API.
- **[VMware vCenter](virt-vcenter.md)** - clusters, VMs, disks, switches and
  port-groups, over the vSphere REST API.

Everything is agentless. This page covers the ground rules they all share.

## Turning it on

All three integrations ship **off**. A tenant admin enables them under
**Settings → Integrations** - one toggle each for DHCP sync, DNS sync, and
virtualization sync. A toggle governs the **sync machinery only**: while it's
off, the connection pages, drift views and scheduled syncs are hidden and
idle. DNS zones/records and DHCP scopes/reservations are first-class IPAM
features and stay fully usable regardless - author a **local** zone (no
server) or a local scope, and the sync never touches them.

## Where things live

Two places, on purpose:

- **Integrations → Windows servers / Virtualization sources** - where you
  *configure connections*: host, credentials, roles, sync mode, and the
  per-server drift/review views.
- **IPAM → DHCP / DNS** (clusters inside the IPAM section - scopes,
  reservations and zones are address-space state) - where you *read and act on
  the synced data*, aggregated across every server. Virtualization lands under
  **Virtualization** (VMs, virtual switches, network topology). Each list
  filters by server and links back to the prefixes and IP addresses the data
  maps to. The connection pages appear once the matching toggle is on; the
  DNS/DHCP data pages are always there.

## Internal hosts and the outbound allowlist

Like the NetBox importer, these integrations respect the deployment's
**outbound-connection guard**: a private/internal address (which most DHCP
servers and hypervisors are) must be allow-listed under **Settings →
Deployment → General** (or `DANBYTE_SSRF_ALLOWLIST`) before Danbyte will
connect. Test connection tells you exactly that when the target isn't listed.

## Shared rules of engagement

- **Nothing of yours is overwritten.** Existing objects are adopted - syncs
  fill blank fields and link objects, but never replace operator data.
- **Sync-created objects go with their source**; operator-created ones are
  never deleted by a sync.
- Objects Danbyte manages are **drift-checked**, not silently overwritten:
  differences surface for review (Accept / Push ours).
- **A sync never invents address space.** An address is recorded only when a
  prefix that contains it already exists. What it can't place, it reports -
  see below.
- **Writing into the physical inventory is opt-in.** A virtualization source
  can create its hypervisor nodes as **Devices** (*Create hosts as devices*),
  off by default. It fills what the hypervisor reports, plus the site when
  [placement](#where-synced-hosts-and-vms-land) resolves one; the device type
  stays yours, because nothing on the wire says what it is.

## Where synced hosts and VMs land

A virtualization source can put the machines it discovers into the right
**site** - using where they sit in the hypervisor, never their IP address.

### The hierarchy, with no configuration

If a **site already has the same name** as the vCenter datacenter (or, on
Proxmox, the cluster), everything under it lands there. Nothing to set up.

### Placement rules, when the names don't line up

**Placement** on a source's row opens its rules. Each rule matches one part of
the hypervisor's structure and points at a site you already have:

| Match on | Example pattern |
| --- | --- |
| **Datacenter** | `Lab*` |
| **Cluster** | `*-DR` |
| **Folder** | `Test site` |
| **Host** | `regex:^esxi-0[12]$` |
| **IP address** | `10.0.9.0/24` or `192.168.110.*` |

Patterns are globs; prefix with `regex:` for a regular expression. A folder
pattern matches either the folder's name or its full path
(`Test site/Linux`).

**Matching on address** covers the common convention where each site has its own
management subnet - `192.168.110.* = UA`, `10.0.9.* = RS`. Write it as a CIDR
where you can: a glob only reaches octet boundaries, so nothing but a CIDR
expresses a `/22`. A rule matches if *any* address the hypervisor reports for
the machine falls in range.

VM addresses come from the guest tools. **Host** addresses live only in
vSphere's SOAP API, so a vCenter source reads them on the same call it uses for
host hardware - if that call fails, the sync says so rather than quietly
placing nothing.

**A folder rule covers everything nested under it.** Point one rule at
`Test site` and the VMs in `Test site / Linux` and `Test site / Windows` follow,
without a rule each.

**Nearest wins:** address beats host beats folder beats cluster beats
datacenter, and the closest matching folder beats a more distant ancestor. An
address rule outranks the rest because it names one machine. *Weight* only breaks ties
within one level, so overriding a single machine never means re-thinking the
order of everything else.

### What it will not do

- **It never writes to a hypervisor.** The client can log in and read; there
  is no code path that creates, changes or deletes anything on vCenter or
  Proxmox. Accepting a change writes to the Danbyte inventory only, in every
  sync mode.
- **It never creates a site.** Sites are physical facts you own. A rule points
  at a real site, and the hierarchy only ever *matches* one by name. When
  nothing matches, nothing is placed and the connection's **Last sync** badge
  says which name it couldn't resolve and what to do about it.
- **It never overwrites a site you set.** Placement is blank-fill, like
  everything else a sync writes.

Rules apply to Proxmox too - it has no datacenters or folders, so cluster and
host rules are the useful ones there.

## Reviewing changes

A source in **review** mode queues what it found instead of applying it. The
queue lives on the source's **Review** tab (and in the Pending changes dialog
on the sources list). Each row's button says what accepting does in Danbyte:

| Row | Accept |
|---|---|
| New VM on hypervisor | Creates the VM record; NICs and IPs fill in on the next sync |
| Specs changed | Copies vCPU / RAM / disk onto the VM |
| Interface fields differ | Copies the hypervisor's MAC / MTU / VLAN onto the interface |
| Interface not on hypervisor | **Deletes** the Danbyte interfaces the hypervisor doesn't report |
| VM removed from hypervisor | **Deletes** the Danbyte VM record |

The two deleting rows ask for confirmation first, and only ever reach the
queue for records a person created - rows the sync itself made are cleaned up
without asking. **Ignore** hides a row until that difference changes again.

## The sync log

Every virtualization source keeps the full log of its **last run** on its
detail page (**Sync log** tab): each VM created or adopted, interface,
switch, network, VLAN, link, placement, prune, and every warning - followed
by the run summary. **Copy log** puts the whole thing on the clipboard.

When reporting a sync problem, paste that log into the issue - it says
exactly what the sync saw and did, and needs no shell or container access to
retrieve.

Operators with shell access have the same lines (with history) in the
journal (`journalctl --user -u danbyte-workers`), in `docker logs
danbyte-workers-1` on a container install, and in
`/var/log/danbyte/danbyte.log` when `DANBYTE_LOG_DIR` is set - see
[Turn on /var/log/danbyte logging](../getting-started/upgrading.md#turn-on-varlogdanbyte-logging).

## Where synced addresses land

Every connection states which **VRF** the addresses it discovers belong to:

| Setting | What it does |
| --- | --- |
| **Address VRF** | The routing context to look in. *Global* is the default and is a real choice, not a blank. |
| **If nothing there contains it** | *Skip the address* (default), or *Look in other VRFs*. |

An address's VRF always comes from its prefix, so choosing where to look is
what decides where the address lands - you never set a VRF on an address
directly.

**A stated VRF is a hard scope.** If a connection says *prod* and no prefix in
*prod* contains an address, that address is skipped and reported. It is never
quietly filed in Global instead: a setting that silently falls back is worse
than no setting.

*Look in other VRFs* tries the chosen VRF **first** and only widens if nothing
there matches. That ordering matters - it means turning it on can only place
addresses that were being skipped, and can never move one that already fits.
Where two VRFs contain an address equally well, the sync skips it and says so
rather than guessing; name a VRF to resolve it.

For virtual machines you can be more specific than the source. Most specific
wins:

```
VM interface VRF          the operator's per-NIC override
  ↓ (empty)
Port group / bridge VRF   on the switch's Networks tab
  ↓ (empty)
Virtual switch VRF        the switch-wide default
  ↓ (empty)
Source Address VRF        the connection's own setting
```

Every layer is read live and **none is ever written by a sync** - they're
yours. Empty means *no opinion*, so it falls through to the next layer rather
than meaning Global. See [virtual switches](virtual-switches.md#routing-context-vrf).

### When an address can't be placed

Nothing is dropped silently:

- **Sync now** reports the count in its result - *"3 addresses unplaced"*.
- The connection's **Last sync** badge reads `ok · 3 warnings`, and hovering it
  lists each address with the reason and the fix. Scheduled runs have no toast,
  so this is where they surface.

The usual cause is simply a missing prefix. Create it - in the right VRF - and
the next sync attaches the address.
