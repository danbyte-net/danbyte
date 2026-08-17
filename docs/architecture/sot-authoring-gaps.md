---
icon: lucide/clipboard-check
---

# Source-of-truth authoring audit

Danbyte is the **source of truth** (SoT) for network state. Some objects,
though, only ever appear because a sync or automation created them — there is no
way for an operator to author them by hand. That is fine for genuinely
*observed* data (a DHCP lease, a config-drift record) but a defect when the
object is something a human should be able to declare first.

This page is the running inventory of **what can be authored manually vs. what
is sync/automation-only**, so the gap is visible and gets closed deliberately
rather than by accident. Update it whenever an object gains or loses a manual
create path.

## Legend

- **Manual create / edit / delete** — an operator can do it from the React UI
  (a create button, form, or dialog), backed by a write API.
- **API create** — the DRF endpoint accepts `POST` (some viewsets are
  `get`/`patch`-only, or 405 `create()` on purpose).
- **By sync** — the object is minted by a sync/automation engine
  (`dhcp_sync`, `dns_sync`, `virt_sync`, drift ingest, deploy dispatch).
- **Verdict** — ✅ authorable · 🟡 partial · 🔴 sync-only gap · ⚙️ sync-only by
  design (observed/event data, not meant to be authored).

## Integrations objects

| Object | Manual create | Edit | Delete | API create | By sync | Verdict |
|---|---|---|---|---|---|---|
| Windows server connection | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| Virtualization source (vCenter/Proxmox) | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| Webhook | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| Automation target | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| DHCP reservation | ✅ | ✅ | ✅ | ✅ (pushes to Windows) | ✅ (mirror) | ✅ |
| DNS record | ✅ (managed) | ✅ (managed) | ✅ (managed) | ✅ | ✅ (mirror) | ✅ |
| DHCP scope | ✅ (pushes to Windows) | 🟡 (`lease_sync` toggle) | ✅ (removes on server) | ✅ | ✅ | ✅ |
| DNS zone | ✅ (managed, local) | 🟡 (`sync`/`auto_create`) | ✅ (managed only) | ✅ | ✅ | ✅ |
| **DHCP exclusion** | 🔴 | 🔴 | 🔴 | 🔴 (no viewset) | ✅ | 🔴 |
| **Virtual network** | 🔴 | 🔴 | 🔴 | 🔴 (`get` only) | ✅ | 🔴 |
| **Virtual disk** | 🔴 | 🔴 | 🔴 | 🔴 (no viewset) | ✅ | 🔴 |
| DHCP lease | 🔴 | 🔴 | 🔴 | 🔴 (`get` only) | ✅ | ⚙️ (ephemeral, observed) |
| VirtGuest (hypervisor↔VM link) | 🔴 | 🔴 | 🔴 | 🔴 (no viewset) | ✅ | ⚙️ (internal linkage) |
| Deploy run | 🔴 | — | — | 🔴 (`retry` action only) | ✅ | ⚙️ (job record) |
| DNS drift | 🔴 | — | — | 🔴 (`resolve` action only) | ✅ | ⚙️ (review inbox) |
| Virt change | 🔴 | — | — | 🔴 (`accept`/`ignore` only) | ✅ | ⚙️ (review inbox) |
| Device config state / snapshot | 🔴 | — | — | 🔴 (drift-ingest endpoint) | ✅ | ⚙️ (observed) |
| NetBox import run | ✅ (start import) | — | — | ✅ (function view) | ✅ | ✅ |
| Integration settings | n/a (singleton) | ✅ (`PUT`) | n/a | — | auto | ✅ |

!!! note "VirtGuest vs. Virtual machine"
    The **Virtual machine** object an operator creates in the UI is
    `api.VirtualMachine` — the SoT VM, fully authorable. `integrations.VirtGuest`
    is the *observed* hypervisor guest the virtualization sync records and links
    to it; that linkage is sync-owned by design.

## Closed

1. **DHCP scope** — ✅ **done.** Authorable from **Add scope** (and the inline
   **+** in the reservation dialog); create runs `Add-DhcpServerv4Scope` on the
   server and delete removes it there. `DhcpScopeViewSet` now does
   `get`/`post`/`patch`/`delete`.
2. **DNS zone** — ✅ **done.** Authorable from **Add zone** as a Danbyte-owned
   `managed` zone (stored locally, never pruned by sync; pushing to the DNS
   server is a later phase). Only managed zones are deletable.

## Remaining gaps (🔴), in priority order

1. **Virtual network** — read-only mirror of hypervisor port groups / bridges.
   Its VLAN mapping can only come from sync. Revisit if operators need to
   pre-declare networks.
2. **DHCP exclusion** — no API or UI at all; only the sync creates them. An
   operator can't carve an exclusion by hand. Niche but a genuine hole.
3. **Virtual disk** — display-only under a VM, though the data model allows
   operator-added disks. Add create/edit/delete when VM disk authoring is
   wanted.

## Not gaps (⚙️ sync-only by design)

DHCP leases (ephemeral), VirtGuest linkage rows, and the job/review records
(deploy runs, DNS drift, virt changes, device config snapshots) are *observed*
or *event* data. They are created by the system on purpose and have action-only
write paths (retry, resolve, accept) rather than a manual create — that is
correct, not a defect.

## See also

- [External sync](../features/external-sync.md) — the DHCP/DNS sync engines.
- [Prefix CRUD](../features/prefix-crud.md) — includes bulk **Add pool**.
