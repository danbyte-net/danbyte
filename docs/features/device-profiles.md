---
icon: lucide/layers
---

# Device profiles

A **device profile** describes a use case once - *RDS-Server-HR*,
*RDS-Server-Finance* - and gives it to a device or virtual machine in one
step. Assigning it writes ordinary rows on the object: the application groups
it runs, its tags, custom field values and its platform. Each row a profile
wrote is remembered as *from profile X*, so taking the profile off removes
only what it made and nobody changed.

A device type describes hardware and a role is one flat label. A profile says
what a server *is*; an [application group](applications.md#application-groups)
says what it *runs*, and a profile can carry several groups.

!!! note "In progress"
    This page covers the catalog, assignments and the API. The screens,
    services, Danbyte monitoring, PRTG and Zabbix sections, config contexts,
    compliance and automatic propagation of profile edits follow. Until then
    an edited profile reaches its objects on **Re-apply**.

## The profile

| Field | |
|---|---|
| **Name**, **slug** | The slug is the key automation will use; a rename keeps it. Unique per tenant. |
| **Description**, **color** | The color is the profile's badge (`#rrggbb`, blank = neutral). |
| **Parent** | Optional. The profile inherits its parent's sections (see below). |
| **Applies to** | Devices, virtual machines or both. |
| **Runbook link**, **notes** | Shown with the profile. |
| Tags, custom fields | The profile's own, like any catalog object. |

Profiles are a tenant-wide catalog, like application groups. Nothing ships
pre-filled.

### Sections

| Section | What assigning does |
|---|---|
| **Application groups** | Assigns each group, which records its installs as a group assignment always does. A group the object already has is left alone. |
| **Tags** | Adds each tag the object lacks. Under [enhanced site separation](../access/site-separation.md) only tenant-wide tags. |
| **Custom field values** | Fills each field while it is blank; a value already there is kept. Only fields that apply to the kinds of object the profile is for. |
| **Platform** | Sets the platform while the object has none. |

### Inheritance

A profile has at most one parent, and chains are at most four profiles deep.
A profile cannot be its own ancestor. Down the chain, lists add up (the
parent's groups and tags, then the child's) and single values come from the
nearest profile that sets them (the child's platform or custom field value
over the parent's). The profile's detail shows the result as `effective`,
each item naming the profile it comes from.

## Assigning

An object can have several profiles, in order. Lists are the union of all of
them; for a single value the first profile in order that sets it wins.

| When | What happens |
|---|---|
| A profile is assigned | Every item the object lacks is written and remembered as from that profile. A row the object already had is **present**: never claimed, never removed. A custom field or platform that already has a value is kept. |
| A profile is unassigned | Another assigned profile that wants the same item takes it over (*moved*). Otherwise: a group is unassigned by the group's own rule (untouched installs go, edited ones stay); a tag the profile added is removed; a custom field or platform is cleared only while it still holds the profile's value and was blank before - else it is *kept*. |
| Profiles are reordered | A custom field or platform value the profiles wrote and nobody changed follows the profile now first. |
| A row is removed by hand | The assignment shows it as **missing**. **Re-apply** writes it again. |
| A value is changed by hand | The assignment shows it as **edited** and leaves it; unassigning keeps it. |

Each assignment carries a state: `ok`, `missing` or `edited`, with the counts.
Deleting a device or VM takes its assignments along.

A profile that is assigned anywhere, or has child profiles, cannot be deleted
(409). An application group or platform a profile names cannot be deleted
either: the 409 names the profiles. A deleted tag or custom field simply drops
out of the profiles.

## Permissions

`deviceprofile` is a tenant-wide catalog a site role reads; changing a profile
takes `change` on it. `deviceprofileassignment` belongs to its device's or
VM's site, like an application group assignment, so a site editor assigns
profiles on their own sites.

Because the profile's rows are written as you, assigning takes, at the
object's site:

- `add` on device profile assignments;
- `add` on application group assignments and installed software, when the
  profile (or a parent) has groups;
- `change` on the device or VM, when it has tags, custom field values or a
  platform.

Unassigning takes `delete` instead of `add`. A missing right answers `403`
naming it, and the preview lists it first.

## API

| Endpoint | |
|---|---|
| `/api/device-profiles/` | CRUD. `?search=`, `?parent=`, `?application_group=`, `?device=`, `?virtual_machine=`, `?picker=1` (`{id, name, slug, color, path}`). `POST bulk-delete/`. Delete answers `409` while assigned or with children. |
| `/api/device-profiles/<id>/preview/` | `POST {device_id \| virtual_machine_id}`: per section what assigning would `create`, `change`, find `present` and `skip` (with the reason), plus `missing_permissions`. Nothing is written. |
| `/api/device-profile-assignments/` | List, `POST` (assign → `{assignment, created}`), `PATCH` (`position` only), `DELETE` (unassign → `{removed, kept, moved}`). `?profile=`, `?device=`, `?virtual_machine=`. |
| `/api/device-profile-assignments/set/` | `POST {device_id \| virtual_machine_id, profile_ids}`: the object's profiles become exactly the list, in its order. |
| `/api/device-profile-assignments/<id>/reapply/` | `POST`: brings the object in line and restores what this assignment wrote and someone removed. |
| `/api/device-profile-assignments/bulk/` | `POST {profile_id, action: assign\|unassign, device_ids \| virtual_machine_ids}`. Up to 25 objects answer inline with each outcome (`assigned`, `unassigned`, `unchanged`, `denied`, `refused`); more run as a background job (`202 {job_id, count}`, on **Jobs**), which re-checks every object's permissions. |

A profile carries `parent`, `path` (names from the root), `platform`,
`application_groups` (in order), `add_tags`, `cf_values`, `assignment_count`
and `child_count`; the detail adds `effective`. Write `parent_id`,
`platform_id`, `application_group_ids` (the whole ordered list),
`add_tag_ids` and `cf_values` (`{key: value}`, checked against the custom
field definitions). An assignment carries `profile`, `device` or
`virtual_machine`, `position`, `state`, `missing_count`, `edited_count`,
`reconciled_at` and `created_by`.

```bash
# Give a server its profile
curl -X POST https://danbyte.example/api/device-profile-assignments/ \
  -H "Authorization: Token $TOKEN" -H "Content-Type: application/json" \
  -d '{"profile_id": "…", "device_id": "…"}'

# Or set every profile of a VM at once, in order
curl -X POST https://danbyte.example/api/device-profile-assignments/set/ \
  -H "Authorization: Token $TOKEN" -H "Content-Type: application/json" \
  -d '{"virtual_machine_id": "…", "profile_ids": ["…", "…"]}'
```

Every reference must be the active tenant's: another tenant's profile,
group, tag, platform, device or VM answers `400`. Webhooks see
`deviceprofileassignment` created and deleted, and `deviceprofile` changes,
like any object type.
