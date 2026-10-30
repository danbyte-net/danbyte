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
    This page covers the catalog, its screens, assignments and the API.
    Services, Danbyte monitoring, PRTG and Zabbix sections, config contexts
    and automatic propagation of profile edits follow. Until then an edited
    profile reaches its objects on **Re-apply**. Compliance rules can already
    scope and check by profile: the **Device profile** field (a child profile
    counts as its parent) and **Profile state** (in step, missing items,
    edited items, pending) - see
    [Compliance](compliance.md#scope-and-conditions).

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
| **Application groups** | Assigns each group, which records its installs as a group assignment always does. A group the object already has is left alone. Each install then documents the flows its application's [requirements](application-flows.md#requirements) need on the object. |
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

## The screens

**DCIM → Devices → Device profiles**, after Application groups, lists the
profiles: the name as the profile's colour badge, the **Parent** (the chain
above it, the parent itself a link), **Applies to**, the number of
**Application groups**, how many objects it is **Assigned** to, and tags.
*Children* and the slug are in the Columns menu. The rail filters by parent
and by what a profile applies to. **Add profile** opens the editor; a
selection can be deleted in bulk (a profile still assigned or with children
is skipped and named).

### The profile page

| Tab | |
|---|---|
| **Overview** | A **Device profile** card (slug, parent, applies to, assigned count, runbook link, tags), the notes, then one card per section - **Application groups**, **Tags to add**, **Custom field values**, **Platform** - listing the *effective* items: the parents' applied. An item that comes from a parent carries a *from &lt;parent&gt;* chip. |
| **Assigned objects** | Every device and VM with the profile: its kind, its state pill (**OK**, **Missing**, **Edited**, **Pending**), the missing and edited counts, and when it was assigned. The totals of missing and edited items sit above the table. Each row has **Re-apply** and **Unassign**; tick rows to do either to all of them. |
| **Children** | The profiles whose parent this is. |
| **Journal**, **Change log** | As on every object. |

### Editing a profile

The editor opens with the facts - **Name**, **Slug**, **Parent**,
**Color**, **Applies to** (a switch each for devices and virtual machines)
and **Description**. The parent list leaves out the profile itself and every
profile under it, so a chain cannot loop. Then one card per section:

| Card | |
|---|---|
| **Application groups** | The groups, in order - the order they are picked in. |
| **Tags to add** | The tags an object gets. |
| **Custom field values** | **Add field** offers the custom fields of every kind the profile applies to (devices, VMs or both); each picked field is a row with its own typed input and a remove button. |
| **Platform** | Set on an object that has none. |
| **Runbook and notes** | A runbook link and free notes. |

The profile's own custom fields and tags follow, as on any catalog object.

## On devices and VMs

- **Form field.** The device and VM forms have a **Profiles** field under
  *Application groups*: the profiles in order, as their badges. The first
  profile in the list wins a single value. A new device or VM gets its
  profiles with its first save; on an existing one, saving makes its profiles
  exactly the list (`set/`). The field shows only to someone who may assign
  and unassign profiles.
- **Profiles card.** The Overview of a device or VM has a **Profiles** card
  beside *Software*: each profile as its badge with its state pill,
  **Re-apply** (restores what someone removed) and **×** (unassign, which
  says how many rows were removed, kept or moved to another profile).
- **Apply profile.** The card's **Apply profile** opens a dialog: pick a
  profile (those already on the object are left out) and the dialog shows the
  [preview](#api) section by section - **Will create**, **Will change**,
  **Already there** and **Skipped**, each skip with its reason - and first,
  in red, any permission you are missing. **Apply** is offered only when
  nothing is missing and the profile fits the object.
- **Profiles column.** Device and VM tables offer a **Profiles** column in
  the Columns menu (hidden by default): the profiles as badges, with the state
  pill beside one that is not in step.
- **In bulk.** Tick devices or VMs on their list and pick **Apply profile** in
  the selection bar. Up to 25 objects answer at once with each outcome
  (*Applied*, *Already had it*, *Not allowed*, *Refused*) and the totals; more
  run as a background job, and the dialog links to it on **Jobs**.

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
field definitions). Devices and VMs carry `device_profiles` on list and
detail - `[{id, assignment_id, name, slug, color, state}]`, in order - for a
reader who may view profile assignments (empty otherwise). An assignment carries `profile`, `device` or
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
