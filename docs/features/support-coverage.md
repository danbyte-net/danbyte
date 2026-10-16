---
icon: lucide/shield-check
---

# Support & warranty coverage

The [lifecycle fields](lifecycle.md) say how long a **model** is supported by
its vendor. Support coverage says whether **this device** is covered: which
support contract it is under, when its hardware warranty ends, and what
expires soon.

Nothing ships pre-filled. You enter your contracts and warranty dates, or
import them, and everything below derives from what you entered.

## Contracts

**DCIM → Support contracts** lists every contract of the tenant. A contract
has:

| Field | Meaning |
|---|---|
| Manufacturer | Whose hardware it covers. Required. |
| Contract number | The reference you quote to the vendor. Unique per manufacturer. |
| Service level | Free text in the vendor's own words: *8x5xNBD*, *24x7x4*, *SNT*. |
| Start / End | The term. The end date is the **last covered day**; blank means open-ended. |
| Reseller | The partner you buy it through. |
| Cost | An amount with a three-letter currency (EUR, USD). Needs *view cost*, see [Permissions](#permissions). |
| Vendor portal | A link to the contract in the vendor's portal. |
| Renewal notes | What to remember at the next renewal. |
| Notifications | Channels that hear when it nears its end. See [Notifications](#notifications). |

Contracts carry tags and custom fields, and have a **Documents** tab for the
contract PDF, a journal and a change log.

A contract's **state** is *Active*, *Expiring* (its end date falls within the
warning window) or *Expired*. The list filters on it.

### Add devices

On a contract's **Devices** tab, **Add devices** offers two ways:

- **Pick** - choose devices in the picker, several at once.
- **Serial numbers** - paste a list, one per line or separated by commas,
  semicolons or spaces. Serials are matched without case. Serials that match
  nothing, or more than one device, are listed back and nothing is guessed.

Select rows on the tab and **Remove** to take devices off the contract.

### Hardware warranty

A device's **Warranty end** (on its edit form) is the last day of its hardware
warranty. It counts as coverage on its own, for devices with no contract.

## Coverage status

Each device's status comes from the latest of its contracts' end dates and its
warranty end. It is worked out when it is read, so *Expiring* moves with the
calendar.

| Status | When |
|---|---|
| Covered | Coverage ends after the warning window, or a contract is open-ended. |
| Expiring | Coverage ends today or within the warning window. |
| Expired | Every contract and the warranty ended before today. |
| Not covered | No contract and no warranty date. |

A contract's start date does not affect the status: a renewal that starts the
day the old one ends keeps the device covered.

The **warning window** is 90 days unless a tenant administrator changes it
under **Settings → Tenant policy → Support coverage** (1-730 days).

## Where it shows

- **Device overview** - *Support coverage* next to *Hardware support* and *OS
  support*: the status, the coverage end, the warranty end and every contract,
  best first. Contracts you may not view are counted, not named.
- **Devices list** - a *Coverage* column with a facet. `/devices?coverage=expired`
  opens the list filtered.
- **Dashboard** - the *Support coverage* widget: devices per status, narrowed
  by site and manufacturer, and the contracts that end soonest. A count opens
  the devices list filtered to it.

### Lifecycle flags

The device overview flags two combinations of coverage and the model's
[end of support](lifecycle.md):

| Flag | When |
|---|---|
| Contract runs past end of support | A contract ends after the device type's end of support. |
| End-of-life hardware under contract | The device type is past end of support and a contract has not ended. |

## Notifications

A contract with **Notifications** channels is announced to them once when it
enters the warning window and once when it expires. A renewed contract, whose
end date moves out of the window, is announced again when it next nears its
end. The check runs with the daily digest (`manage.py send_digest`).

The tenant's [email digest](monitoring.md#email-digest) also lists the contracts that end
within the window and those that ended in the last 30 days.

## Compliance rules

A [compliance rule](compliance.md) with the **Support coverage** check fails a
device on its status:

| Fails on | Fails when the status is |
|---|---|
| Expired or not covered | Expired or Not covered |
| Expiring, expired or not covered | Expiring, Expired or Not covered |

Give the rule a **tag** to judge only the devices that carry it - for example
`production`.

## Import and export

Contracts and coverage rows round-trip through
[Import & export](import-export.md):

- **Support contracts** - matched by manufacturer and contract number.
- **Support coverage** - one row per covered device: `contract` (the contract
  number) and `device` (the device name, or its id when the name is not
  unique).

For a renewal meeting, filter the devices list by manufacturer and *Coverage*,
show the *Site* column, and export it.

## Permissions

| Object type | Covers |
|---|---|
| Support contracts | The contracts. Tenant-wide. |
| Support coverage | Which devices a contract covers. A coverage row belongs to its device's site, so a site-limited grant covers the devices of those sites only. |

Linking devices needs *add* on Support coverage and sight of the contract and
the devices. The one-click site roles include Support coverage.

A contract's device count, its `?device=` filter and the dashboard widget's
site filter count only the devices you can see. A coverage row whose contract
you can't see shows no contract, in the API and the export.

### Cost

A contract's cost is commercial data, so seeing it is its own grant: **view
cost** on Support contracts. Without it, cost and currency are left out of
the contract page, the list and its columns, the API, exports and the change
log, and the form has no cost fields. Setting or changing the cost needs it
too; an edit without it keeps the stored cost.

Superusers and the built-in Administrator group see the cost. Operator,
Read-only and the site roles do not: add *view cost* to a grant for the
people who handle renewals and budgets. *All object types* with *view cost*
covers it.

## API

| Endpoint | Notes |
|---|---|
| `GET/POST /api/support-contracts/` | `?state=active,expiring,expired`, `?manufacturer=`, `?device=`, `?search=` |
| `GET/PATCH/DELETE /api/support-contracts/<id>/` | `notify_channel_ids` and `tag_ids` to write; `cost` and `currency` absent without *view cost* |
| `POST /api/support-contracts/bulk-delete/` | Safe bulk delete |
| `GET/POST /api/support-coverage/` | `?contract=`, `?device=`; body `{"contract_id", "device_id"}`; `contract` is `null` when you can't see it |
| `DELETE /api/support-coverage/<id>/` | |
| `POST /api/support-coverage/bulk-add/` | `{"contract_id", "device_ids": [...], "serials": "..."}` → `created`, `existing`, `matched`, `unmatched`, `ambiguous` |
| `POST /api/support-coverage/bulk-remove/` | `{"contract_id", "device_ids": [...]}` → `removed` |
| `GET /api/devices/?coverage=` | `covered`, `expiring`, `expired`, `none`; comma-separated for several |
| `GET /api/devices/?support_contract=<id>` | The devices a contract covers |
| `GET /api/devices/<id>/coverage/` | Status, contracts, `hidden_contracts`, flags |
| `GET /api/devices/coverage-summary/` | `?site=`, `?manufacturer=`; counts per status and the contracts ending soonest |

Every device payload carries `warranty_end` and
`coverage: {status, end, contracts}`; `end` is `null` when coverage is
open-ended or there is none.
