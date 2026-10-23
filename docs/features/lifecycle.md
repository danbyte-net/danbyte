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
are kept apart; fetched data never overwrites what you entered here.

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
- **Lifetime progress bar** - when both *Released* and *End of support* are
  set: how much of the support window is already consumed, with an
  "EoL in 2 y" / "EoL 3 mo ago" countdown. Rendered in the device-types and
  platforms tables, on their detail overviews, and on each device's overview
  (*Hardware support* from its type, *OS support* from its platform - so a
  device answers "how long does this box and its OS have left?" directly).
- **Filter** - `?lifecycle=eol|security_ended|eos|supported|none` on
  `/api/device-types/` and `/api/platforms/`; the list pages expose it as a
  Lifecycle facet. Combined with the device counts, "which EoL hardware do we
  still run the most of?" is one filter + one sort.

## Software target

The lifecycle dates say how long a version is supported; the **software
target** says which version you want running, and finds what does not run it.

- **Target version** on a platform (edit form, shown on its overview) - the
  version operators want running, e.g. `17.9.5`. Blank means no target.
- **Software version** on a device or virtual machine - the version it runs,
  e.g. `17.9.4a`. Typed in the edit form next to the platform, or filled by an
  integration: the [vCenter sync](virt-vcenter.md) fills an ESXi host's
  version.

A device is judged against its effective platform: its own, else its device
type's. The comparison is exact text. Each object is in one of three states:

| State | When |
|---|---|
| On target | The software version equals the platform's target version |
| Off target | Both are set and differ |
| Unknown | No version recorded, no target, or no platform |

Where it shows:

- **Overview** - the Platform row reads `IOS-XE 17.9.4a · target 17.9.5`; just
  the version when the platform has no target.
- **Lists** - devices and virtual machines have *Software version* and
  *Target* columns, hidden until picked from **Columns**, and a *Software
  target* facet (On target, Off target, Unknown).
- **Compliance** - a [Software target check](compliance.md#check-types) turns
  off-target objects into violations, with `Running 17.9.4a, target 17.9.5`
  as the reason.

An integration that fills a version also stamps `software_version_seen_at`.
A version a person types (in the form or the API) drops the stamp, and no
sync overwrites it; clear the field to hand it back to the sync.

## API

The fields live on the DeviceType and Platform resources; `lifecycle_state`
is read-only and computed server-side. Device payloads carry
`lifecycle_state` (+ the bar dates) on their nested `device_type` and
`platform` references, so device tables and detail pages render without
extra requests.

Software target (#395): `target_version` on `/api/platforms/` (and on the
nested `platform` / `effective_platform` of devices and VMs);
`software_version` (writable) and `software_version_seen_at` (read-only) on
`/api/devices/` and `/api/virtual-machines/`. Both lists take
`?software_target=on|off|unknown`; any other value is a 400.
