---
icon: lucide/zap
---

# Power

Power is where you record how electricity reaches your racks — the
**distribution panels** in a site and the **feeds** that run from those panels to
individual racks.

You build it in two layers: **power panels** (the distribution boards) and the
**power feeds** that draw from them.

## Add a power panel

A power panel is a distribution board within a site.

1. Open **Power → Power panels** in the sidebar and click **Add power panel**.
2. Pick the **site** the panel lives in.
3. Give it a **name** (must be unique within that site).
4. Optionally add **comments**, tags, and any custom fields.
5. Save.

## Add a power feed

A power feed is a circuit running from a panel, optionally delivered to a
specific rack.

1. Open **Power → Power feeds** and click **Add power feed**.
2. Choose the **panel** it comes from, and give the feed a **name** (unique
   within that panel).
3. Optionally point it at a **rack** — the rack this feed powers.
4. Set the electrical details (see below) and a **status**.
5. Save.

### Feed details

| Field | What it records |
|---|---|
| **Status** | planned, active, offline, or failed. |
| **Type** | primary or redundant. |
| **Supply** | AC or DC. |
| **Phase** | single-phase or three-phase. |
| **Voltage** | the supply voltage (volts). |
| **Amperage** | the rated current (amps). |
| **Max utilization** | a percentage ceiling — the most of this feed you plan to draw. |

### Feed status

| Status | Meaning |
|---|---|
| **Planned** | Designed but not yet energized. |
| **Active** | Live and in service. |
| **Offline** | De-energized or administratively down. |
| **Failed** | Faulted or out of service unexpectedly. |

!!! note "Nothing is pre-filled"
    Danbyte ships no sample panels or feeds — you create exactly the ones your
    sites have.

!!! warning "Panels in use can't be deleted"
    If a panel still has feeds attached, Danbyte blocks the delete. Remove or
    reassign those feeds first.

## Device power: ports & outlets

Panels and feeds cover power *upstream of the rack*. At the device, two
components complete the chain:

- A **power port** is a device's power **inlet** — where it draws power. It can
  carry the device's **maximum** and **allocated draw** (watts).
- A **power outlet** is a socket on a device that feeds *other* devices — a rack
  PDU's outlets. Each outlet can name the **inlet** on the same device that
  feeds it (so per-inlet load rolls up) and, on three-phase gear, which
  **feed leg** (A/B/C) it's on.

A typical rack: the PDU is a device whose power port **cables to a power
feed**, and whose outlets **cable to the servers' power ports**. All of these
are cable endpoints, so the whole power path is traceable end-to-end like any
other cabling. Manage them on the device's **Power** tab; connector types
(IEC C13/C14, NEMA, ...) come from the standard taxonomy.

## Tags & custom fields

Need to track something extra — a breaker number, a UPS reference, a circuit
drawing? Add a **custom field** for panels or feeds and it appears on every
form. See [Tags & custom fields](tags-and-custom-fields.md).
