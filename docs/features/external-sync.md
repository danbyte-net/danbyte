---
icon: lucide/refresh-cw
---

# External sync overview

Danbyte can keep itself in sync with systems that own live network state.
Each connector has its own page:

- **[Windows DHCP & DNS](windows-sync.md)** — scopes, reservations, leases,
  zones and records, over WinRM.
- **[Proxmox VE](virt-proxmox.md)** — clusters, VMs, disks, bridges and
  networks, over the Proxmox API.
- **[VMware vCenter](virt-vcenter.md)** — clusters, VMs, disks, switches and
  port-groups, over the vSphere REST API.

Everything is agentless. This page covers the ground rules they all share.

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
- **IPAM → DHCP / DNS** (clusters inside the IPAM section — scopes,
  reservations and zones are address-space state) — where you *read and act on
  the synced data*, aggregated across every server. Virtualization lands under
  **Virtualization** (VMs, virtual switches, network topology). Each list
  filters by server and links back to the prefixes and IP addresses the data
  maps to. These pages appear once the matching toggle is on.

## Internal hosts and the outbound allowlist

Like the NetBox importer, these integrations respect the deployment's
**outbound-connection guard**: a private/internal address (which most DHCP
servers and hypervisors are) must be allow-listed under **Settings →
Deployment → General** (or `DANBYTE_SSRF_ALLOWLIST`) before Danbyte will
connect. Test connection tells you exactly that when the target isn't listed.

## Shared rules of engagement

- **Nothing of yours is overwritten.** Existing objects are adopted — syncs
  fill blank fields and link objects, but never replace operator data.
- **Sync-created objects go with their source**; operator-created ones are
  never deleted by a sync.
- Objects Danbyte manages are **drift-checked**, not silently overwritten:
  differences surface for review (Accept / Push ours).
- **A sync never invents address space.** An address is recorded only when a
  prefix that contains it already exists. What it can't place, it reports —
  see below.
- **Writing into the physical inventory is opt-in.** A virtualization source
  can create its hypervisor nodes as **Devices** (*Create hosts as devices*),
  off by default; it fills only what the hypervisor reports and leaves device
  type and site to you.

## Where synced addresses land

Every connection states which **VRF** the addresses it discovers belong to:

| Setting | What it does |
| --- | --- |
| **Address VRF** | The routing context to look in. *Global* is the default and is a real choice, not a blank. |
| **If nothing there contains it** | *Skip the address* (default), or *Look in other VRFs*. |

An address's VRF always comes from its prefix, so choosing where to look is
what decides where the address lands — you never set a VRF on an address
directly.

**A stated VRF is a hard scope.** If a connection says *prod* and no prefix in
*prod* contains an address, that address is skipped and reported. It is never
quietly filed in Global instead: a setting that silently falls back is worse
than no setting.

*Look in other VRFs* tries the chosen VRF **first** and only widens if nothing
there matches. That ordering matters — it means turning it on can only place
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

Every layer is read live and **none is ever written by a sync** — they're
yours. Empty means *no opinion*, so it falls through to the next layer rather
than meaning Global. See [virtual switches](virtual-switches.md#routing-context-vrf).

### When an address can't be placed

Nothing is dropped silently:

- **Sync now** reports the count in its result — *"3 addresses unplaced"*.
- The connection's **Last sync** badge reads `ok · 3 warnings`, and hovering it
  lists each address with the reason and the fix. Scheduled runs have no toast,
  so this is where they surface.

The usual cause is simply a missing prefix. Create it — in the right VRF — and
the next sync attaches the address.
