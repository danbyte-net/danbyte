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
