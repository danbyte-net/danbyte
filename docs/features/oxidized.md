---
icon: lucide/file-code
---

# Oxidized config backups

[Oxidized](https://github.com/ytti/oxidized) backs up network device
configurations into git. This integration shows what it holds on each device's
**Config** tab, and on a virtual machine's for a virtual router (MikroTik CHR,
VyOS, a virtual firewall): the current configuration, its history, and a diff
between any two versions.

!!! note "Oxidized is the store"
    Danbyte keeps how to reach oxidized-web and which node is which device or
    VM - never the configuration text. A config is fetched when someone opens it,
    held in Redis for a minute (a version addressed by its commit, five
    minutes), and nothing is written to Danbyte's database.

## Turning it on

1. **Settings → Integrations → Oxidized config backups**. Off by default, per
   tenant. On, it adds **Oxidized** under *Integrations* in the sidebar; off,
   the page is hidden and the API answers 404. Opened by link, the page says
   Oxidized is off.
2. On the **Oxidized** page, add the connection: the URL oxidized-web answers
   on, an optional username and password for basic auth (for an oxidized-web
   behind a proxy that asks for it), TLS verification, and the matching rule.
   Press **Test** - it counts the nodes Oxidized lists.
3. Press **Sync nodes**. Danbyte reads the node list and pairs each node with
   a device or a virtual machine. A new connection then syncs on its own every
   30 minutes - see [Automatic sync](#automatic-sync).
4. Grant **view config** on devices, and on virtual machines if you have
   virtual routers, to whoever should read configs. See
   [Who can read a config](#who-can-read-a-config).

!!! warning "An internal Oxidized has to be allow-listed"
    Outbound goes through the SSRF guard, so a tenant-configured URL is never
    a way to reach internal services. Most Oxidized servers are on RFC1918: a
    deployment admin adds the address under **Settings → Security → Outbound
    connections** (or `DANBYTE_SSRF_ALLOWLIST`). Redirects are never followed.

The password is write-only: the API says whether one is set, never what it is.
It is dropped when the URL moves to another host or the username changes, so a
stored password is never sent somewhere it was not typed for.

## Matching nodes to devices and VMs

Oxidized knows a node by name, address and model. Danbyte looks among the
tenant's devices and virtual machines together, tries, in order, and stops at
the first rung that gives exactly one of them:

1. **Pinned.** A node an admin pinned to a device or VM by hand. Kept across
   every sync.
2. **Address.** The node's address is one recorded on the device or VM - its
   primary address or any address assigned to it or to one of its interfaces.
   A node defined by address alone counts.
3. **Name.** Case-insensitive. The host part of an FQDN counts on either side:
   node `core1.example.net` finds device `core1`, and node `edge` finds device
   `edge.example.net`.

The connection's **Matching** setting chooses *Address, then name* (the
default), *Address only* or *Name only*. Pinning is always on.

Two candidates on one rung - two devices, two VMs, or a device and a VM with
the same name or address - or two nodes landing on one, link nothing: those
nodes are listed as unmatched with the reason. A wrong pairing would show
one box's configuration under another's name; a missing one is visible and
fixable. This is the same rule the [Zabbix](../monitoring/zabbix.md) matcher
follows.

A link, once matched, is kept. When a new device or VM shares the name or
address of a linked node's object, or a second node lands on it, the link
stays and the sync reports the namesake as a note on the link. Only a node
without a link is left unmatched by a namesake.

Only a confirmed link is kept this way. A proposed link holds nothing: when
the node's last confirmed device or VM is among the candidates again, the
link returns there, confirmed, and the proposal goes.

### Proposed links

A new match for a node Danbyte has seen before - one that sat unmatched, or
moves to another device or VM - is **proposed**. A proposed link shows no
config on the device's or VM's Config tab until someone confirms it.
Whoever created, renamed or addressed the object that now matches may not be
allowed to read that node's config.

Links are made at once, without confirmation, for:

- every node on a connection's first sync;
- a node seen for the first time;
- a node matched back to the object its last confirmed link pointed at, such
  as after an **Unlink**.

A connection that synced on an 0.18 pre-release, before node memory existed,
has not recorded every node it saw. On such a connection a new match for any
node it has no record of is always proposed, since a node that was away from
Oxidized during a sync may still have been seen before. Connections created
since link a node new to Oxidized at once.

The **Oxidized** page lists:

- **Unmatched nodes** - every node the last sync could not pair, with why.
  **Pin** links one by hand to a device or a virtual machine.
- **Linked nodes** - every pairing in force, how it was made, any note from
  the last sync, and when the node was last seen. A **Proposed** link has a
  **Confirm** button. **Unlink** removes one; a matched node comes back on the
  next sync if it still matches.

The connection card counts **Proposed** links and **Namesakes**, links kept
despite a namesake.

Each sync re-decides the matched links, so a renamed device or a moved address
follows, as a proposed link. A matched link whose node has gone is removed; a
pinned one stays.

!!! warning "Matching trusts device names and addresses"
    Whoever may rename a device or give it an address can make a node match
    it. That is why such a match is proposed rather than served. Check the
    device or VM before confirming, and pin the nodes of sensitive devices.

## Automatic sync

Each connection can re-sync its nodes on a schedule, the same pass as **Sync
nodes**: new nodes are matched, changed ones re-matched, matched links whose
node has gone are removed, and pinned links are kept.

| Setting | Default | |
|---|---|---|
| **Sync nodes automatically** | On for a new connection | Off for a connection that existed before the upgrade - turn it on in **Edit**. |
| **Sync every** | 30 minutes | 5, 10, 15 or 30 minutes, or 1 hour. |

The connection card shows **Auto sync**, **Last sync** (the last successful
one), **Next sync**, and **Last sync failed** with the message when the latest
attempt did not get through. A failed attempt keeps the links and counts of
the last good sync and is retried one interval later, not every minute.
**Sync nodes** still syncs at once, and the next automatic sync counts from it.

The `danbyte-oxidized-sync` timer (`manage.py oxidized_sync`) runs every
minute and queues one background job per connection that is due; it shows on
[Jobs](jobs.md) as *Oxidized node sync*. The job checks again that the
connection exists, is enabled and still syncs automatically, that its tenant
is active and that the integration is on, before it reads anything.

## On the device or VM

**Config → Config backup**, first on the Config tab of a device or a virtual
machine. Hidden while the integration is off or when you lack *view config* on
that kind of object.

| View | What it shows |
|---|---|
| **Current** | The configuration Oxidized holds now, in monospace. **Find in config** narrows it to matching lines with their line numbers. **Copy**, **Download**, **Reload** (skips the cache) and **Fetch now**. |
| **History** | Every version Oxidized's git output kept: date, author, commit message and commit. **View** opens one; **Diff to current** compares it with the current config. |
| **Diff** | A unified diff between any two versions, or a version and *Current*. |

**Fetch now** asks Oxidized to back the node up next (`/node/next`), with your
username as the commit author. The new version appears once Oxidized has run.

A badge says **Changed since you last looked** when the newest version is not
the one this browser saw last time.

History and diffs need Oxidized's **git** output. With the file output there is
only the current config.

A config is shown as text. Markup in a banner or description is never
interpreted.

## Who can read a config

A running config carries SNMP communities, password hashes and keys. Reading
one needs **view config** on devices, or on virtual machines for a VM's
config - a capability verb that:

- is never implied by *view*, *change* or any other verb on the type, and
  *view config* on devices does not reach VMs;
- is not held by the built-in Administrator, Operator or Read-only groups -
  grant it to the people who should have it;
- follows the grant's sites and row limits, like *view*. The device or VM must
  also be visible to you.

Superusers have it. The connections and the node links are ordinary object
types (*Oxidized connections*, *Oxidized node links*): they say which node
backs which device or VM, never what is in it.

### Who can pin and unlink

A device's Config tab shows whichever node is linked to it, so the mapping
decides whose config people read. Pinning and unlinking are connection
management:

- **Pin** and **Confirm** need *add* on node links and *change* on the
  connection. **Unlink** needs *delete* on node links and *change* on the
  connection. The built-in Administrator group can do all three, Operator can
  pin and confirm.
- Node links follow the site of their device or VM. A grant limited to sites
  lists, pins and unlinks only those sites' links, and cannot pin a node that
  is linked to another site's device or VM.
- A pin or a confirm never shows you a config you could not already read.
  Where you hold *view config* on the device or VM you pin to, the node must
  be linked to an object whose config you can read. An unlinked node counts
  as linked to the object its last confirmed link pointed at, so unlinking
  first changes nothing. For a node that never had a confirmed link, or whose
  last object was deleted, your *view config* on that kind must not be
  limited to sites or rows. A proposed link does not count. Otherwise the
  pin or confirm is refused.

Without *view config* on the target a pin gives you nothing to read, so an
administrator who does not read configs can still map every node.

## API

All under `/api/oxidized/`, 404 while the integration is off.

| Endpoint | |
|---|---|
| `connections/` | CRUD. `password` is write-only; `password_set` reads back. `auto_sync` and `sync_interval_minutes` (5, 10, 15, 30, 60) set the schedule; `last_sync_at` (last success), `last_sync_attempt_at` and `next_sync_at` (null while off) read back. |
| `connections/<id>/test/` | `POST`. Reach oxidized-web and count nodes. |
| `connections/<id>/sync/` | `POST`. Read the node list and re-match. The summary counts `linked`, `proposed`, `unmatched_count` and `warning_count`. |
| `connections/<id>/unmatched/` | The nodes the last sync left unmatched, with reasons, and `warnings`: the links it kept despite a namesake. A reason names a device or VM only when the caller can view it; otherwise it reads "a device" or "a virtual machine". The same goes for the `sync/` response. |
| `links/` | List (`?connection=`, `?device=`, `?virtual_machine=`), `POST` to pin (`connection_id`, `full_name`, and one of `device_id` or `virtual_machine_id`), `DELETE` to unlink. A link reads back `device` or `virtual_machine`, the other null, and `proposed`. Pinning and unlinking need *change* on the connection (403); see [Who can pin and unlink](#who-can-pin-and-unlink). |
| `links/<id>/confirm/` | `POST`. Confirm a proposed link. 400 when it is not proposed or the confirm would show you a config you cannot read. |
| `devices/<id>/` | The nodes linked to a device. A proposed link is left out until confirmed. |
| `devices/<id>/config/` | The current config. `?link=` picks a node, `?refresh=1` skips the cache. |
| `devices/<id>/versions/` | The history, newest first. |
| `devices/<id>/versions/<oid>/` | One version's text. |
| `devices/<id>/diff/?from=&to=` | Unified diff. Each side is a commit or `current`. |
| `devices/<id>/fetch-now/` | `POST`. Queue the node in Oxidized. |
| `virtual-machines/<id>/…` | The same six endpoints for a virtual machine. |

The device and VM endpoints need *view config* on that type: 404 for an object
you cannot see, 403 when you can see it but lack the verb. A response over 10 MB is refused with
413.

Danbyte reads these oxidized-web routes: `/nodes.json`,
`/node/fetch/<group>/<name>`, `/node/version.json?node_full=`,
`/node/version/view?…&format=text` and `PUT /node/next/<group>/<name>.json`.
Diffs are computed by Danbyte from two version texts.
