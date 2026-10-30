---
icon: lucide/history
---

# Change log

The change log is Danbyte's automatic record of who changed what, and when. Every
time someone creates, edits, or deletes an object, Danbyte writes an entry - you
never have to remember to log anything.

Each entry shows a **field-by-field diff**: the old value and the new value for
everything that changed, with friendly labels (you'll see "VLAN 10: prod", not a
raw ID).

Open any entry for the full view: the **Difference** summary and the complete
**Pre-/Post-change** snapshots both resolve related objects to their names -
where a field points at another object (a device, interface, prefix, tenant…)
you see the object's name with its raw UUID kept beside it, muted, so nothing is
lost. Names that can't be resolved (the object was later deleted) fall back to
the UUID.

A related object you can't view - a device at another site that a shared
address was bound to - shows as **hidden**: no name and no UUID, in the
diff, the snapshots and the API. In the API its value is `null`, with
`old_hidden` / `new_hidden` set on the diff and the snapshot keys listed in
`hidden_related`. For a user with limited access, a deleted related object
also shows as hidden, since its scope can no longer be checked.

A generated application flow is named after the hosts at its ends, and
keeps that name after it is detached or released until someone renames it.
When you can't view one of them, its entries name it as the flow's API does
- *WMS to Broker: wms-1 → Hidden* - in the entry, its `name` diff and
snapshots, and a search of the log, and its `binding_key` (which names the
ends by id) is `null`; see
[application flows](application-flows.md#permissions).

A support coverage entry is titled after its device (*Coverage of edge-01*;
older entries read *contract → device*). When you can't view that device -
it has since moved to another site, or is gone - the entry reads *Coverage
of Hidden*, on the global page and the object's tab, and a search of the
log does not match the device's name; an older title leaves out a contract
you can't view. The stored entry is unchanged.

!!! note "Change log vs. journal"
    The change log is the *automatic* record of what changed. A
    [journal](journals.md) is where people write *their own* notes about an
    object. They sit side by side.

## Where to find it

| Place | What it shows |
|---|---|
| **Governance → Change log** | The global feed across the whole tenant. Filter by action, object type, user, or **source** - UI (a browser session), API (a token request), Assistant (a write the in-app assistant made), or System (workers and shell) - and search. An Assistant entry still names the person who asked for it: it acts with their access, not its own. Click any entry to expand its diff. Filters and the page number live in the URL, so the back button returns to the view you left and a filtered view can be shared as a link. |
| **Change log tab** on a detail page | Just that one object's history. |

One name everywhere: the global page and the per-object tab are both called
**Change log** - the same record at two scopes (the page was previously
"Audit log", the tab "History"; the URLs `/audit-log` and `?tab=history`
still work).

Every object you can edit has a **Change log** tab on its detail page - prefixes, IP
addresses, devices, sites, VRFs, VLANs, manufacturers, device types, cables,
interfaces, IP statuses and roles, route targets, custom fields, tags, tenants,
locations, compliance rules, and the rest. If a model can be changed, its
changes are tracked and shown there (next to the **Journal** tab).

## What's recorded

The change log covers the things people edit:

- **IPAM & DCIM** - prefixes, IP addresses, VRFs, VLANs, sites, route targets,
  manufacturers, device types, devices, interfaces, ports, cables, IP statuses,
  IP roles.
- **Configuration** - custom fields, monitoring check templates and assignments,
  alert rules, notification channels, silences, deployment settings.
- **Organization** - tenants and tags.

Bulk edits (changing many rows at once) are recorded too - one entry per affected
object, each with its own diff. A relation changed in bulk (a status, a VRF, a
peer group) shows by name, as a single edit does.

A saved topology view's layout can run to megabytes, so its entries summarise
it - the top-level parts that changed and the size before and after - rather
than copying the whole layout. Its name still diffs as usual. See
[saved views](topology.md#saved-views).

### Cause

A change Danbyte derives from another one says why. The flows an
[application flow requirement](application-flows.md#requirements) writes
carry a **cause** - *Requirement 'WMS to Broker': WMS client installed on
wms-07* - shown under the entry's changes, with the user and request of the
change that triggered them, so the install and the flows it documented
group together. The nightly sweep's entries read *nightly sweep* and are
written by the system. Ordinary edits have no cause. The API returns it as
`cause` on `/api/changelog/`. A reader who can't view every address, range
and prefix reads a flow's cause as just *Requirement 'WMS to Broker'*: what
set it off may be a host at another site.

Not every writer is a person. An [Outpost](../monitoring/outposts.md) writes as
itself, and is named that way - `outpost:probe-1` - with no linked user account,
because there is no user to link. The name is the whole record of who, which is
what you want it to say.

!!! note
    High-volume automatic data - like individual monitoring check results - is
    deliberately left out so the log stays readable and focused on human changes.

## How long entries are kept

Old entries are pruned automatically. By default they're kept for **730 days**
(two years), after which they're removed. An administrator can change or disable
this retention period for your deployment.

## Related

- [Journals](journals.md) - your own notes on an object.
- [Permissions & access](permissions.md) - who can change things in the first
  place.
