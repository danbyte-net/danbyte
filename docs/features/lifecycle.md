# Hardware & OS lifecycle (EoS / EoL)

Device types and platforms carry an optional **vendor lifecycle window**, so
the fleet's age risk is visible where you plan: which hardware is past end of
sale, which OS versions no longer get security fixes, and how long anything
has left.

Zero pre-filled data applies: Danbyte ships no vendor dates. You enter them
(from the vendor's EoL notice) on the device type or platform, and everything
below derives from what you entered.

## The fields

Both **device types** (hardware) and **platforms** (OS) have the same
"Lifecycle" section in their edit form — all optional:

| Field | Meaning |
|---|---|
| Released | GA / first-ship date — the start of the lifetime bar |
| End of sale | Vendor stops selling it (EoS) |
| End of security updates | Last security / vulnerability fixes |
| End of support (EoL) | Vendor support ends — the end of the lifetime bar |
| Vendor notice URL | Link to the vendor's official EoL announcement |

## What renders from them

- **Lifecycle state** — the most severe milestone that has passed:
  *Supported* (dates set, none passed) → *End of sale* → *No security fixes*
  → *End of life*. Shown as a badge on the type/platform detail header and,
  for at-risk states only, next to the type/platform name in the devices
  table (healthy rows stay quiet).
- **Lifetime progress bar** — when both *Released* and *End of support* are
  set: how much of the support window is already consumed, with an
  "EoL in 2 y" / "EoL 3 mo ago" countdown. Rendered in the device-types and
  platforms tables, on their detail overviews, and on each device's overview
  (*Hardware support* from its type, *OS support* from its platform — so a
  device answers "how long does this box and its OS have left?" directly).
- **Filter** — `?lifecycle=eol|security_ended|eos|supported|none` on
  `/api/device-types/` and `/api/platforms/`; the list pages expose it as a
  Lifecycle facet. Combined with the device counts, "which EoL hardware do we
  still run the most of?" is one filter + one sort.

## API

The fields live on the DeviceType and Platform resources; `lifecycle_state`
is read-only and computed server-side. Device payloads carry
`lifecycle_state` (+ the bar dates) on their nested `device_type` and
`platform` references, so device tables and detail pages render without
extra requests.
