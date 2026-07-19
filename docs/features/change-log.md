---
icon: lucide/history
---

# Change log

The change log is Danbyte's automatic record of who changed what, and when. Every
time someone creates, edits, or deletes an object, Danbyte writes an entry — you
never have to remember to log anything.

Each entry shows a **field-by-field diff**: the old value and the new value for
everything that changed, with friendly labels (you'll see "VLAN 10: prod", not a
raw ID).

Open any entry for the full view: the **Difference** summary and the complete
**Pre-/Post-change** snapshots both resolve related objects to their names —
where a field points at another object (a device, interface, prefix, tenant…)
you see the object's name with its raw UUID kept beside it, muted, so nothing is
lost. Names that can't be resolved (the object was later deleted) fall back to
the UUID.

!!! note "Change log vs. journal"
    The change log is the *automatic* record of what changed. A
    [journal](journals.md) is where people write *their own* notes about an
    object. They sit side by side.

## Where to find it

| Place | What it shows |
|---|---|
| **Governance → Audit log** | The global feed across the whole tenant. Filter by action, object type, or user, and search. Click any entry to expand its diff. |
| **History tab** on a detail page | Just that one object's history. |

Every object you can edit has a **History** tab on its detail page — prefixes, IP
addresses, devices, sites, VRFs, VLANs, manufacturers, device types, cables,
interfaces, IP statuses and roles, route targets, custom fields, tags, tenants,
locations, compliance rules, and the rest. If a model can be changed, its
changes are tracked and shown there (next to the **Journal** tab).

## What's recorded

The change log covers the things people edit:

- **IPAM & DCIM** — prefixes, IP addresses, VRFs, VLANs, sites, route targets,
  manufacturers, device types, devices, interfaces, ports, cables, IP statuses,
  IP roles.
- **Configuration** — custom fields, monitoring check templates and assignments,
  alert rules, notification channels, silences, deployment settings.
- **Organization** — tenants and tags.

Bulk edits (changing many rows at once) are recorded too — one entry per affected
object, each with its own diff.

!!! note
    High-volume automatic data — like individual monitoring check results — is
    deliberately left out so the log stays readable and focused on human changes.

## How long entries are kept

Old entries are pruned automatically. By default they're kept for **730 days**
(two years), after which they're removed. An administrator can change or disable
this retention period for your deployment.

## Related

- [Journals](journals.md) — your own notes on an object.
- [Permissions & access](permissions.md) — who can change things in the first
  place.
