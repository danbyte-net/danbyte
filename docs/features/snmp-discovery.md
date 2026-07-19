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
- [nmap L3 sweep](#nmap-sweep) — seed live hosts as discovered IPs
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

Open a device → the **Observed (SNMP)** card → **Poll now**. Danbyte does one
synchronous SNMP read of the system group (`sysName`, `sysDescr`, `sysObjectID`,
`sysUpTime`, `sysContact`, `sysLocation`) plus the interface tables
(`ifTable`/`ifXTable`), and stores them as observed facts. The card shows a
**reachable / unreachable** badge, the named facts (never raw OIDs), the
interface list with oper-status and speed, and the last-polled timestamp.

A poll **never** touches the device's source-of-truth fields — it only refreshes
this card.

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

## Drift & reconciliation {#drift-and-reconciliation}

The **drift inbox** on the device page compares observed SNMP state to your
intended configuration and lists the differences:

- **Device name** vs `sysName`.
- **Interface present on the device but not in Danbyte** (`interface_missing`).
- **MAC or admin-status mismatch** on an interface you already have.
- **Stale** — Danbyte has an interface the device no longer reports (shown for
  awareness; discovery never deletes from the SoT).

MAC comparison is **separator-insensitive** — `00:11:22:33:44:55` and the Cisco
dotted form `0011.2233.4455` are recognised as the same address, so reformatting
alone never shows as drift.

Click **Accept** on an item to write that observed value into intent. This is the
**only** action that mutates the source of truth, and it requires the same
**`device.change`** permission the device form does (see
[Permissions](#permissions)). Everything else on this feature is read-only.

Drift kinds:

- **Device name** — `sysName` vs the device name.
- **New interface** — observed on the device, missing in Danbyte.
- **Interface mismatch** — MAC or admin-status differs.
- **Discovered IP** — an IP SNMP sees on an interface that Danbyte doesn't record.
  Accepting it assigns the IP to that interface (binding an existing unassigned IP
  if one matches, otherwise creating it in the smallest containing prefix). It
  then appears on the device's **IPs** tab — closing the discover→assign loop. If
  no prefix contains the address, accept fails: add the prefix first.

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
device's **ARP table**. The SNMP card renders:

- **LLDP neighbours** — `local-port ↔ remote-device : remote-port`.
- **ARP table** — the IP ↔ MAC pairs the device has learned.

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

## nmap L3 sweep {#nmap-sweep}

LLDP/ARP needs SNMP on each device. To find live hosts on a subnet **without**
touching every device, use the **Scan (nmap)** button on a prefix. It shells out
to `nmap -sn` (a ping sweep — no port scan, no root needed) and seeds any live
host that isn't already recorded as a **discovered** IP in that prefix, exactly
like the built-in ICMP discovery path (same VRF scoping, same auto-discovered
status, same cleanup eligibility).

`nmap` must be installed on the Danbyte host:

```bash
sudo apt install nmap
```

If it isn't, the button returns a clean error ("nmap is not installed") rather
than failing — nothing is created.

## Permissions {#permissions}

- **Read** (poll, view observed facts, view drift, view topology) — any
  authenticated member of the tenant.
- **Accept drift** (reconcile observed → intended) — requires **`device.change`**.
  This is the one source-of-truth write in the whole feature, so it's gated like
  editing the device itself, not merely tenant membership.
- **Manage profiles & bindings** — gated to users who can change the device /
  manage settings.
