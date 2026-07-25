---
icon: lucide/radar
---

# SNMP discovery

Monitoring tells you whether a device is **up**. SNMP discovery tells you what
the device actually **is** right now — its system facts, its interfaces, its
neighbours — read straight off the box over SNMP into a read-only **observed**
layer. Danbyte stays the source of truth; discovery never silently overwrites
your intended configuration. When observed reality and intent disagree, that
difference surfaces as **drift** you can review and accept one item at a time.

This page is organised by task. Jump to:

- [The observed-vs-intended model](#observed-vs-intended) — why discovery is safe
- [SNMP profiles](#snmp-profiles) — reusable v1/v2c/v3 credentials
- [Credential hierarchy](#credential-hierarchy) — device → role → type → location → site → default
- [Poll a device](#poll-a-device) — read system facts + interfaces
- [Scheduled polling & utilisation](#scheduled-polling) — the sparkline series
- [Drift & reconciliation](#drift-and-reconciliation) — accept observed into intent
- [Topology: LLDP & ARP](#topology) — neighbours and the ARP table
- [Permissions](#permissions)

## Observed vs intended {#observed-vs-intended}

Everything SNMP reads lands in a separate **observed** store
(`DeviceSnmp`), never on the `Device` source-of-truth fields. So a poll can run a
hundred times and your device record is untouched. The only place observed data
flows back into intent is when *you* explicitly **accept a drift item** — a
deliberate, permission-gated click. That's the whole design: reality flows in on
demand, but you decide what becomes truth.

## SNMP profiles {#snmp-profiles}

A **profile** is a reusable set of SNMP credentials, named per tenant. Manage
them under **Settings → SNMP profiles**.

- **Version** — `v1`, `v2c`, or `v3`.
- **v2c** — a community string.
- **v3** — username + auth/priv protocols and keys.

Secrets (the community, the v3 keys) are **encrypted at rest** and **write-only**
over the API — a `GET` never returns them, only a `has_secrets` flag. This
mirrors how monitoring check credentials are stored.

Mark one profile **default** for the tenant. Setting a new default automatically
clears the previous one, so there's always at most one default and switching it
actually switches it.

## Credential hierarchy {#credential-hierarchy}

You rarely want to pick a profile per device. Instead, **bind** a profile at the
level that makes sense and let it inherit. When Danbyte polls a device it
resolves the effective profile **most-specific-first**:

1. **Device** — a profile bound directly to this device.
2. **Device role** — e.g. all `core-switch` devices.
3. **Device type** — e.g. all `C9300-48P`.
4. **Location** — bound on the device's location, inherited down from a parent
   location if the child doesn't set one.
5. **Site** — bound on the device's site.
6. **Tenant default** — the profile flagged default.

Levels 1–3 are *what a device is*; levels 4–5 are *where it lives*. The
location/site levels let a remote **[Outpost](../monitoring/outposts.md)** poll a
site's devices with site-scoped credentials — set them on the site or location
form. If nothing is bound and there's no default, Danbyte will **only** auto-pick
when
the tenant has exactly one profile — otherwise it declines rather than guess
which credential to poll with. The device's SNMP card shows where the effective
credential came from.

## Poll a device {#poll-a-device}

Open a device → its **Monitoring** tab → the **Observed** card → **Poll now**.
Danbyte does one synchronous SNMP read of the system group (`sysName`,
`sysDescr`, `sysObjectID`, `sysUpTime`, `sysContact`, `sysLocation`) plus the
interface tables (`ifTable`/`ifXTable`), and stores them as observed facts. The
card shows a **reachable / unreachable** badge, the named facts (never raw
OIDs), the interface list with oper-status and speed, and the last-polled
timestamp.

A poll **never** touches the device's source-of-truth fields — it only refreshes
this card.

The tab is laid out by content width: the system facts, the interface table and
the [drift inbox](#drift-and-reconciliation) run full width, and the narrow
cards below them — [LLDP neighbours and the ARP table](#topology),
[custom SNMP sensors](#sensors) and the [BMC](#redfish) — pair up two-across on
a wide window and stack on a narrow one.

## Scheduled polling & utilisation {#scheduled-polling}

The on-demand button is a snapshot. To build a **utilisation series** for the
per-interface sparklines, run the poller on a schedule:

```bash
python manage.py poll_snmp
```

Each run records the interface HC octet counters (`ifHCInOctets` /
`ifHCOutOctets`) as a time-stamped sample. Utilisation is then derived as a rate
between consecutive samples — `Δoctets · 8 / Δt`, as a percentage of the
interface speed. A counter that goes backwards (reset/reboot/wrap) yields a `0`
delta rather than a negative spike. Schedule `poll_snmp` from cron or a systemd
timer at whatever interval you want the sparklines sampled.

!!! note "Counter64-safe"
    HC octet counters are SNMP Counter64 (unsigned 64-bit). Danbyte stores them
    as a 20-digit decimal so a large counter on a long-running, high-traffic
    interface can't overflow and crash the poll.

**Hardware health runs itself.** The `danbyte-hardware` systemd timer polls
every configured BMC ([Redfish](#redfish)) and [custom SNMP sensor](#sensors)
**every 30 minutes**, reconciling inventory and flipping statuses — so a
failing disk turns red on its own, no button press. Scheduled scope is bounded
to devices with a Redfish endpoint or a **device-type-scoped** sensor (plus,
when a tenant has an all-types sensor, every device with a primary IP);
all-types sensors otherwise run on the device's on-demand **Poll sensors**
button. Run it by hand with `python manage.py poll_hardware`.

## Drift & reconciliation {#drift-and-reconciliation}

The **drift inbox** on the device page compares observed SNMP state to your
intended configuration and lists the differences:

- **Device name** vs `sysName`.
- **Interface present on the device but not in Danbyte** (`interface_missing`).
- **MAC, admin-status, VLAN or speed mismatch** on an interface you already have.
- **Stale** — Danbyte has an interface the device no longer reports (shown for
  awareness; discovery never deletes from the SoT).

### Excluding a port from drift {#drift-exclude}

Some ports can *never* be polled — the silkscreened host NICs a BMC agent
doesn't see, an out-of-band jack, a port on gear behind the managed device.
Left alone they flag as **Stale — not seen on device** after every poll,
forever, and dismissing only hides them until the next one.

Click **Exclude** on the stale row instead. It sets the interface's
*Exclude from SNMP drift* flag: the port stops being compared in **both**
directions — never reported stale, never mismatch-checked, never touched by
**Sync from SNMP** — while everything else about it (cables, IPs, monitoring)
behaves as normal. Excluded ports show a muted eye-off mark in the interfaces
table, and the flag is a checkbox on the interface's edit form, which is also
where you undo it.

MAC comparison is **separator-insensitive** — `00:11:22:33:44:55` and the Cisco
dotted form `0011.2233.4455` are recognised as the same address, so reformatting
alone never shows as drift.

Interfaces that have drift are also flagged **in place**: the device's
**Components → Interfaces** table shows an amber **drift** badge on each affected
row, so you can spot which ports differ at a glance. It's a read-only signal —
reviewing and accepting drift stays in the drift inbox, so the source of truth
only changes when you choose (Danbyte stays drift-*aware*, never
drift-*driven*).

Click **Accept** on an item to write that observed value into intent. This is the
**only** action that mutates the source of truth, and it requires the same
**`device.change`** permission the device form does (see
[Permissions](#permissions)). Everything else on this feature is read-only.

Drift kinds:

- **Device name** — `sysName` vs the device name.
- **New interface** — observed on the device, missing in Danbyte.
- **Interface mismatch** — MAC, admin-status, VLAN or **speed** differs. Speed
  is compared as a number, so `1G`, `1 Gbps` and an observed 1000 Mbps are the
  same value — reformatting never reads as drift, and an intended speed that
  isn't parseable ("dual 10/25") is treated as deliberate and left alone.
- **Discovered IP** — an IP SNMP sees on an interface that Danbyte doesn't record.
  Accepting it assigns the IP to that interface (binding an existing unassigned IP
  if one matches, otherwise creating it in the smallest containing prefix). It
  then appears on the device's **IPs** tab — closing the discover→assign loop. If
  no prefix contains the address, accept fails: add the prefix first.

### Linking a discovered name to a port you already made {#interface-linking}

The names on the silkscreen and the names the agent reports rarely match: you
labelled the port `Ethernet 1`, the switch reports it as `eth0`. Discovery sees
two things where there is one, and the pair drifts forever as both *new* and
*missing*.

On any **New interface** row, **Link to…** lists the device's own interfaces
(unlinked ones first, searchable) — pick the port that discovered name really
is. Danbyte stores it as the interface's **SNMP name**, the matcher starts
treating the two as one, and both drift rows disappear on the next poll.

Linked ports carry an `↔ eth0` badge next to their name in the interfaces
table, so a link is never invisible.

**To remove a link**, click the `↔` badge on the port and choose **Unlink** —
the undo sits on the thing it undoes. The interface form's **SNMP name** field
does the same job if you're already editing the port. Linking a name that
another port has already *linked* moves it; a discovered name belongs to exactly
one port.

A link **replaces** the port's label rather than adding an alias to it. Saying
"the agent calls this port `eth0`" also says the agent never reports
`Ethernet 1`, so Danbyte stops expecting the label — otherwise the port you just
linked would keep drifting as *not seen on device* forever.

!!! note "You can't link onto a name another port already has"
    If `eth0` exists as an interface in its own right, `IMM` cannot be linked to
    `eth0`: both would answer to that name, and only one can win the match. The
    duplicate is the actual problem — delete or rename the port you don't want,
    then link. Danbyte refuses the link and says so rather than accepting one
    that can't work.

### Sync from SNMP

The drift inbox accepts items one at a time. The **Sync from SNMP** button on the
device's **Interfaces** tab does it all at once: create every observed interface
Danbyte lacks, fix MAC / admin-status / **speed** / **VLAN** drift, and assign
every observed IP that has a containing prefix. It reports what it
created/assigned and how many IPs were skipped for want of a prefix. (The device
name is left alone — accept that explicitly.) Needs `device.change`.

What a poll/sync reads per interface:

- **Speed** — `ifHighSpeed` → "10 Gbps" / "100 Mbps".
- **Layer** — L3 if the interface has an IP (`ipAddrTable`), else L2.
- **Access VLAN** — the PVID from **Q-BRIDGE-MIB** (`dot1qPvid`, mapped to the
  ifIndex via the bridge-port table), with the name from `dot1qVlanStaticName`.
  On sync the VLAN becomes a first-class Danbyte VLAN object (find-or-create,
  ungrouped) and is assigned to the interface. L3-only devices and non-switches
  don't report it — that's fine.

!!! note "Loopback and other special addresses"
    Observed addresses that don't belong in IPAM — loopback (`127.x`, `::1`),
    link-local (`169.254.x`, `fe80::`), unspecified (`0.0.0.0`, `::`) and
    multicast — are recognised by range and never offered for import or flagged
    as drift, even though the **Observed** card still shows them as the device
    reports them.

### Fleet-wide drift view

The per-device card is for one box. To see drift across the whole fleet, open
**Drift** in the sidebar — it has two tabs:

- **Config (Ansible)** — config-drift reported by your runner (device config vs
  rendered template).
- **SNMP (observed)** — every SNMP-polled device with its drift status
  (**in sync** / **N drifted** / **unreachable**), a one-line summary of what
  drifted (name, interfaces), the profile used, and when it was last polled.
  Filter by status; click a device to open its drift inbox and accept items.

Both tabs answer the same question — *does reality match intent?* — from the two
sources Danbyte has (your runner, and SNMP).

## Topology: LLDP & ARP {#topology}

A poll also walks **LLDP-MIB** for directly-connected neighbours and reads the
device's **ARP table**. The device's **Monitoring** tab renders both as their
own cards, side by side below the interface table:

- **LLDP neighbours** — `local-port ↔ remote-device : remote-port`.
- **ARP table** — the IP ↔ MAC pairs the device has learned.

Both are three narrow columns, so they pair up rather than stretch across the
page; a device that reports neither simply doesn't show them.

The join logic (`parse_lldp` / `parse_arp`) is pure and unit-tested, so it's
correct independent of any one device's quirks.

### Ghost cables on the topology map

LLDP also feeds the **topology map** (`/topology`). Real cables render as solid
edges; where two devices are LLDP-adjacent but **have no cable in Danbyte**, a
dashed **ghost** edge appears (and a "N LLDP links" chip in the header). LLDP
neighbours are matched to devices by name *or* observed `sysName`, so links show
up even before you've reconciled a name.

Click a ghost edge to **materialise it into a real `Cable`**. SNMP can't report
the physical connector, so you pick the cable type (and, if the devices are
adjacent on more than one link, which port pair). Creating the cable needs
`cable.add`, and both interfaces must already exist — if an end is missing,
accept its interface drift first. Once cabled, the ghost is replaced by a solid
edge.

## BMC hardware health (Redfish) {#redfish}

Servers expose their hardware over their BMC's **Redfish** API — the DMTF
management standard that iDRAC (Dell), iLO (HPE), XClarity (Lenovo),
Supermicro and Cisco UCS controllers all speak. Danbyte can poll it and keep
the device's **[inventory items](../dcim/device-catalog.md#inventory-items)**
in sync — disks, CPUs, DIMMs, PSUs and fans, with real serials and live
health.

**Set it up** on the device's **SNMP tab → BMC (Redfish)** card: enter the
BMC address, port and credentials (encrypted at rest, never returned by the
API), then **Poll now**. The collector walks
`Systems → Storage/Processors/Memory` and `Chassis → Power/Thermal`, and
reconciles what it finds:

- Parts are matched by **serial number** first, then by name — so renaming a
  disk (e.g. to match a drawn `Bay 3` marker) sticks across polls.
- Missing parts are **created** with kind, media (NVMe/SSD/HDD), capacity
  and model; existing parts get their hardware **facts** updated. Nesting,
  tags, descriptions and custom fields are never touched.
- **Health → status**: `OK` → *Active*, `Critical`/`Warning` → *Failed* — so
  a failing disk turns red on the Hardware tab, the photo faceplate and the
  3D rack. Status flips are journaled on the device. Parts the BMC stops
  reporting are left alone.

BMCs live on management (RFC1918) networks, which Danbyte's outbound-request
guard normally blocks. A Redfish endpoint is a deliberate, **scoped**
exception: it's configured by someone with device-change permission, pinned
to that one host, fetched with redirects disabled, and loopback/link-local
addresses are still refused. TLS verification is off by default (BMC
certificates are usually self-signed) — enable it when yours chain to a
trusted CA.

## Custom SNMP sensors (vendor health OIDs) {#sensors}

Not every BMC speaks [Redfish](#redfish) — plenty are SNMP-only (Supermicro,
older iDRAC/iLO, Synology, storage shelves). SNMP has no *standard* hardware-
health MIB, so each vendor exposes disk/PSU/fan status under its own OIDs.
**Custom sensors** let you teach Danbyte those OIDs.

### Find the OID by looking, not by reading a MIB {#oid-explorer}

You normally need the vendor's MIB file to know which OID reports health.
**Explore OIDs** on the *Custom SNMP sensors* card removes that step: it walks
down the device's own OID tree with you, one level at a time, and shows a table
**as the table it came from** the moment you reach one.

Start anywhere — `1.3.6.1.4.1` (the root of every vendor's private tree) is
offered in the field. Each level lists its branches with the first value found
underneath, as a hint at what's down there:

```
1.3.6.1.4.1
  .2       18                    7 levels     ← IBM/Lenovo
  .2021    0                     3 levels
  .8072                          9 levels
  .15601   3070372               3 levels
```

Open one to go deeper. Danbyte recognises a **table** when every branch holds
its values exactly one level down, and switches to a grid automatically —
no need to know in advance whether you're looking at a branch or a table.

!!! note "Why browsing isn't just a walk"
    A walk returns OIDs in lexicographic order, so walking `1.3.6.1.4.1`
    directly spends its whole budget inside the *first* vendor it meets and
    never reveals the others. Browsing costs one request per branch instead of
    one per value, which is what makes the vendor tree reachable at all.

Reaching a Lenovo IMM's power-supply table at
`1.3.6.1.4.1.2.3.51.3.1.11.2.1`:

| Row | .1 | .2 | .5 | .6 |
|---|---|---|---|---|
| 0 | 0 | Power System | Unknown | Normal |
| 1 | 1 | Power Supply 1 | K135155D0K2 | Normal |
| 2 | 2 | Power Supply 2 | K135155D0K5 | Normal |

Column `.2` names the supplies, `.5` holds serials, and `.6` is health. Click
`.6` → **Create sensor**, and the form opens with that column's OID filled in
and every value it returned already listed, so writing the value map is a
dropdown per value instead of transcription. Each column is annotated with what
its own values suggest — *all "Normal"*, *unique per row*, *3 values* — which is
usually enough to spot the health column at a glance.

Notes:

- **Numeric OIDs only.** A MIB *name* can't be resolved without its MIB file,
  so `sysDescr.0` is refused before anything touches the network.
- Reading a table is capped, and a truncated result says so — go one level
  deeper rather than trusting a partial view.
- Unreachable device, wrong community, or no applicable profile come back as a
  message in the dialog, not a failed request. Small BMCs sometimes time out
  when browsed several times in quick succession; that reads as an SNMP error,
  never as "nothing there", so a retry is the obvious next move.
- Standard tables are offered in the field too — `hrDeviceTable`,
  `hrStorageTable`, `entPhySensorTable`, `entPhysicalTable` — and are worth
  trying before the vendor tree, since they mean the same thing on every agent.

Exploring reads from the device and writes nothing, but it does make the server
query arbitrary operator-supplied OIDs on that host, so it takes the same
**device change** permission as the rest of the SNMP tooling.

### Defining a sensor by hand

On the device's **SNMP tab → Custom SNMP sensors** card, **Add sensor**:

- **OID** — the numeric OID. A **walk** reads a table column (one value per
  component, e.g. per drive); a **scalar** reads one value.
- **Reading is** — which hardware kind these readings describe (disk, PSU…).
- **Item name template** — how each reading names/matches its
  [inventory item](../dcim/device-catalog.md#inventory-items): `{index}` is
  the walk row, `{kind}` the kind (e.g. `Disk {index}` → `Disk 1`, `Disk 2`).
- **Value → status** — map each raw SNMP value to a status slug, e.g.
  `3 → active`, `4 → failed`. Unmapped values leave the item untouched.
- **Never reported** — status for parts the sensor covers that the agent never
  lists. See [empty bays](#absent-bays).
- **Scope** — limit the sensor to this device type, or apply it to all types
  (define once, reuse across every server of that model).

**Poll sensors** runs every applicable sensor with the device's SNMP profile,
then reconciles: matching items are created if missing and their **status is
flipped** — so a failing disk turns red on the Hardware tab, the photo
faceplate and the 3D rack, exactly like the Redfish path. Flips are journaled;
the last raw readings show on the card.

### How a reading finds its part {#sensor-matching}

By **name, and only by name**. The template renders one name per reading and
that string must equal the inventory item's name exactly — `disk{index}` on a
walk whose rows are `0…6` produces `disk0 … disk6`, which matches parts called
exactly that.

There is no stored link here. Unlike an interface, which records the
[SNMP name](#interface-linking) the agent uses for it, a part carries nothing
that says "this reading is mine". Two consequences worth knowing before you
rename anything:

- **Rename a part and the sensor stops finding it.** It doesn't error — it
  creates a *second* item under the templated name, and the renamed one keeps
  its last status forever. Change the template alongside the name, or don't
  rename monitored parts.
- **The template has to match how the agent indexes**, not how you'd label the
  bay. A 0-based walk with a `Disk {index}` template produces `Disk 0`, so
  parts named `Disk 1 … Disk n` will all be missed and duplicated. Use
  [Explore OIDs](#oid-explorer) to see the real row indexes first.

The safest order is: read the table, note its indexes, then write a template
that lands on the names you already have.

### Empty bays {#absent-bays}

A device type's [inventory templates](../dcim/device-catalog.md#component-templates)
stamp every bay a chassis *has* — 16 disk bays on a 16-bay server — while the
agent only reports the bays that are *populated*. Without help, the nine empty
bays on a 7-disk machine keep claiming to hold healthy hardware, on the
Hardware tab and on the faceplate.

Set **Never reported** on the sensor to a status like *Empty*, and after each
poll any part the sensor covers (same kind, same scope) that the agent didn't
list flips to it. A bay that later gets a disk is picked up and marked healthy
again on the next poll.

!!! note "Only ever applied after a poll that returned something"
    An agent that answers with nothing — blocked column, wrong community, a
    subtree that moved — looks exactly like "every bay is empty". Acting on that
    would mark real disks missing, so a poll with no readings, or one that
    errored, changes nothing. Silence is never evidence.

Only the sensor's own **kind** is touched: a disk sensor can't mark the power
supplies empty.

To find your vendor's OIDs, walk the BMC's enterprise tree
(`snmpwalk -v2c -c <community> <bmc> 1.3.6.1.4.1`) and consult its MIB — the
disk-status column is what you point the sensor at.

## Permissions {#permissions}

- **Read** (poll, view observed facts, view drift, view topology) — any
  authenticated member of the tenant.
- **Accept drift** (reconcile observed → intended) — requires **`device.change`**.
  This is the one source-of-truth write in the whole feature, so it's gated like
  editing the device itself, not merely tenant membership.
- **Manage profiles & bindings** — gated to users who can change the device /
  manage settings.
