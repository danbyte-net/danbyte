---
icon: lucide/file-cog
---

# Config contexts

Config contexts let you keep environment-, role-, or region-specific data (DNS
servers, NTP, SNMP communities, VLANs, and so on) in **one place** and have it
apply automatically to the devices and virtual machines it should — instead of
copying the same values onto every object by hand.

Each context holds a block of JSON and a set of match rules. Danbyte merges
together every context that matches a given device or VM, so each object ends up
with one combined config context computed from the layers that apply to it.

You'll find config contexts under **Customize → Config contexts** in the sidebar.

## Create a config context

1. Go to **Customize → Config contexts** and click **Add config context**.
2. Fill in the form:

   | Field | What it does |
   |---|---|
   | **Name** | A label for the context. |
   | **Description** | Optional note. |
   | **Weight** | A number that decides who wins on conflicts. When two contexts set the same key, the higher weight wins. |
   | **Active** | Inactive contexts are ignored during the merge. |
   | **Data** | The JSON object this context contributes. Edit it in the built-in JSON editor. |
   | **Assignment criteria** | Which objects this context applies to — choose any number of regions, sites, device roles, and platforms. |

3. Save.

### How matching works

The assignment criteria decide which devices and VMs a context applies to:

- **Across dimensions, all must match (AND).** If you set both a site and a
  platform, an object must be in that site *and* run that platform.
- **Within one dimension, any matches (OR).** Listing three sites means an object
  in any one of them qualifies.
- **An empty dimension matches everything.** Leave platforms blank and the
  context applies regardless of platform.
- **Regions are inherited downward.** A context assigned to a parent region also
  applies to sites nested under it.

## How the merge works

For a given device or VM, Danbyte takes every *active* context that matches it
and deep-merges them in order of weight (and then name), so the highest-weight
context wins on any conflicting key. Within the merge:

- Nested objects are combined key by key.
- Plain values and lists are **replaced** wholesale, not concatenated.

The result is a single rendered config context for that object.

!!! tip "Higher weight = last word"
    If a base context sets `ntp: ["10.0.0.1"]` (weight 10) and a more specific one
    sets `ntp: ["10.1.0.1"]` (weight 100), the object gets `["10.1.0.1"]` — the
    list is replaced by the higher-weight layer, not merged.

## See it on a device or VM

Every device and virtual machine detail page has a **Config** tab. It shows the
final merged JSON for that object and lists, as chips, which contexts contributed
to it — so you can always see where a value came from.

## Permissions and audit

Config contexts are managed by users with the **Customize** permission group, and
every create, edit, and delete is recorded in the [change log](change-log.md).
