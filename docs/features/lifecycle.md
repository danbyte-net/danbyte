# Hardware & OS lifecycle (EoS / EoL)

Device types and platforms carry an optional **vendor lifecycle window**, so
the fleet's age risk is visible where you plan: which hardware is past end of
sale, which OS versions no longer get security fixes, and how long anything
has left.

Zero pre-filled data applies: Danbyte ships no vendor dates. You enter them
(from the vendor's EoL notice) on the device type or platform, and everything
below derives from what you entered.

For operating systems and software, platforms can also take their dates from
a public source instead - see [End-of-life data](end-of-life-data.md). The two
are kept apart; fetched data never overwrites what you entered here. Where a
platform has both, the bars read the
[effective OS date](#the-effective-os-date).

These dates describe the model. Whether a single device is under a support
contract or warranty is [Support & warranty coverage](support-coverage.md);
the device overview shows both side by side.

## The fields

Both **device types** (hardware) and **platforms** (OS) have the same
"Lifecycle" section in their edit form - all optional:

| Field | Meaning |
|---|---|
| Released | GA / first-ship date - the start of the lifetime bar |
| End of sale | Vendor stops selling it (EoS) |
| End of security updates | Last security / vulnerability fixes |
| End of support (EoL) | Vendor support ends - the end of the lifetime bar |
| Vendor notice URL | Link to the vendor's official EoL announcement |

## What renders from them

- **Lifecycle state** - the most severe milestone that has passed:
  *Supported* (dates set, none passed) → *End of sale* → *No security fixes*
  → *End of life*. Shown as a badge on the type/platform detail header and,
  for at-risk states only, next to the type/platform name in the devices
  table (healthy rows stay quiet).
- **Lifetime bar** - how much of the support window is already used, with an
  "EoL in 2 y" / "EoL 3 mo ago" countdown; the exact date is in its tooltip.
  Rendered in the device-types and platforms tables, on their detail
  overviews, on each device's overview (*Hardware support* from its type,
  *OS support* from its platform - so a device answers "how long does this
  box and its OS have left?" directly) and on each virtual machine's
  overview (*OS support*).
- **Filter** - `?lifecycle=eol|security_ended|eos|supported|none` on
  `/api/device-types/` and `/api/platforms/`; the list pages expose it as a
  Lifecycle facet. Combined with the device counts, "which EoL hardware do we
  still run the most of?" is one filter + one sort.
- **Next end of life** - an optional column on the Devices and Virtual
  machines lists: the soonest end across hardware, OS, coverage and installed
  software, as the bar with its source, sorting by days left. Hidden until
  ticked in the Columns menu.
- **Lifecycle overview** - every device's hardware row and every device's
  and VM's OS row, next to its support coverage and installed software,
  soonest end first. A software row names its application, filters by it
  (`/lifecycle?source=software&application=<id>`) and links its end to the
  application's End of life card. See
  [Lifecycle overview](lifecycle-overview.md).

### The lifetime bar

Every end date in Danbyte - hardware, OS and support coverage - is drawn with
the same bar:

- **Fill** - the share of *Released* → *End of support* that has passed.
- **Colour** - by the time left, so the bar agrees with the status badges:
  red once the end has passed, amber when it falls inside the warning
  window, otherwise the accent colour. Hardware and OS use the end-of-life
  **warning window** (Settings → General → End-of-life data, 180 days by
  default - it applies to entered dates even while fetching is off);
  coverage uses the tenant's coverage window.
- **Missing dates** - with an end and no start there is no track, only the
  countdown; with no end but a known state (a cycle the source marks end of
  life) the state's badge alone; with nothing, a dash.

### The effective OS date

A platform can have dates you entered here and a mapped
[end-of-life](end-of-life-data.md) cycle. The OS bars - the platform's *OS
lifecycle* card and column, a device's and a VM's *OS support* - read one
**effective** date, field by field:

- the **start** is the entered *Released*, else the cycle's release date;
- the **end** is the entered *End of support*, else the cycle's end of life.

What you entered wins - it covers extended support you bought. The cycle's
dates count only while end-of-life data is on. The bar's tooltip says which
the end came from: *Entered* or *endoflife.date*. Both cards stay on the
platform page, and nothing is copied either way. The API carries the result
as `effective_release`, `effective_end` and `effective_source` (`entered` or
the source, e.g. `endoflife_date`) on platforms and on the nested `platform`
of devices and virtual machines.

## Software target

The lifecycle dates say how long a version is supported; the **software
target** says which version you want running, and finds what does not run it.

- **Target version** on a platform (edit form, shown on its overview) - the
  version operators want running, e.g. `17.9.5`. Blank means no target.
- **Software version** on a device or virtual machine - the version it runs,
  e.g. `17.9.4a`. Typed in the edit form next to the platform, or filled
  automatically - see [Where the running version comes
  from](#where-the-running-version-comes-from).

A device is judged against its effective platform: its own, else its device
type's. The comparison is exact text. Each object is in one of three states:

| State | When |
|---|---|
| On target | The software version equals the platform's target version |
| Off target | Both are set and differ |
| Unknown | No version recorded, no target, or no platform |

Where it shows:

- **Overview** - the Platform row reads `IOS-XE 17.9.4a · target 17.9.5`; just
  the version when the platform has no target. The version's source follows
  it in muted text (*SNMP*, *Manual*, …); hovering it says where the version
  came from and when an integration last set it.
- **Lists** - devices and virtual machines have *Software version* and
  *Target* columns, hidden until picked from **Columns**, and a *Software
  target* facet (On target, Off target, Unknown) and a *Software version*
  facet.
- **Lifecycle → Versions** - the count of devices and VMs per platform and
  version; see [Versions view](lifecycle-overview.md#versions-view).
- **Compliance** - a [Software target check](compliance.md#check-types) turns
  off-target objects into violations, with `Running 17.9.4a, target 17.9.5`
  as the reason.

An integration that fills a version also stamps `software_version_seen_at`.
A version a person types (in the form or the API) drops the stamp, and no
sync overwrites it; clear the field to hand it back to the sync.

## Where the running version comes from

Every software version records its **source**:

| Source | Set by |
|---|---|
| Manual | A person: the edit form, the API, a planned change |
| Import | A data import file |
| SNMP | The SNMP facts poll, read from `sysDescr` |
| Virtualization | A hypervisor sync - the [vCenter sync](virt-vcenter.md) fills an ESXi host's version |
| Oxidized | Reserved for versions read from stored configurations |

The rule: **a manual or imported version is never overwritten** by an
automatic source. SNMP and the virtualization sync fill a blank version, or
replace one an automatic source wrote, and stamp `software_version_seen_at`
with when they set it. Clearing the field hands it back to them.

### Reading the version from SNMP

Each time SNMP facts are collected (Poll now, the schedule, an Outpost), the
version is read out of `sysDescr` and recorded with source *SNMP*. A failed
poll writes nothing. Built-in readers cover:

| Platform | Example `sysDescr` | Version |
|---|---|---|
| Cisco IOS-XE | `Cisco IOS Software [Cupertino], … (CAT9K_IOSXE), Version 17.9.4a, RELEASE SOFTWARE (fc3)` | `17.9.4a` |
| Cisco IOS | `Cisco IOS Software, C2960X Software (C2960X-UNIVERSALK9-M), Version 15.2(7)E8, …` | `15.2(7)E8` |
| Cisco NX-OS | `Cisco NX-OS(tm) n9000, Software (n9000-dk9), Version 9.3(10), RELEASE SOFTWARE` | `9.3(10)` |
| Juniper Junos | `Juniper Networks, Inc. ex4300-48t Ethernet Switch, kernel JUNOS 21.4R3-S5.4, …` | `21.4R3-S5.4` |
| Arista EOS | `Arista Networks EOS version 4.28.3M running on an Arista Networks DCS-7050SX3-48YC8` | `4.28.3M` |

The version is kept as the device reports it (`17.09.04a` stays zero-padded).
A Linux `sysDescr` gives nothing: the kernel release is not the platform's
version.

### Version pattern

For anything else, set a **Version pattern** on the platform: a regular
expression with one capture group, or a group named `version`, e.g.
`FortiGate-\S+ v(\d+\.\d+\.\d+)`. It is tried first, on the first 512
characters of `sysDescr`; when it does not match the built-in readers still
apply. A pattern that does not compile, or captures nothing, is refused when
the platform is saved. A device uses its effective platform's pattern.

Saving a new pattern reads the stored `sysDescr` of that platform's devices
and VMs again in the background. To read every stored `sysDescr` again, for
example after an upgrade:

```sh
manage.py extract_software_versions [--tenant <id>] [--platform <id>] [--enqueue]
```

`--enqueue` runs it as a job on the `low` queue.

## API

The fields live on the DeviceType and Platform resources; `lifecycle_state`
is read-only and computed server-side. Device payloads carry
`lifecycle_state` (+ the bar dates) on their nested `device_type` and
`platform` references, and virtual machine payloads on their nested
`platform`, so tables and detail pages render without extra requests.
Software target (#395): `target_version` on `/api/platforms/` (and on the
nested `platform` / `effective_platform` of devices and VMs);
`software_version` (writable) and `software_version_seen_at` (read-only) on
`/api/devices/` and `/api/virtual-machines/`. Both lists take
`?software_target=on|off|unknown`; any other value is a 400.

Version source (#451): `software_version_source` (read-only: `manual`,
`snmp`, `virtualization`, `oxidized`, `import`, or `""` without a version)
on devices and VMs; writing `software_version` sets it to `manual`, or
clears it with the version. `version_pattern` on `/api/platforms/` (a 400
with a `version_pattern` error when invalid). Device and VM lists take
`?software_version=<exact version>` and
`?software_version_source=manual|snmp|virtualization|oxidized|import|none`.
The per-version counts are `GET /api/lifecycle/versions/` - see
[Versions view](lifecycle-overview.md#versions-view).
