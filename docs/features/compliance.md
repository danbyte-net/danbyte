---
icon: lucide/shield-check
---

# Compliance

Compliance lets you write **rules** about your own data - "every prefix must have
a description", "active IPs need a DNS name", "devices need a serial number" - and
then see every object that breaks them, on demand.

Danbyte ships **zero rules**. The policy is entirely yours to define, so the
checks match how your organisation actually works. You'll find everything under
**Governance → Compliance** in the sidebar.

## How a rule works

A rule has three parts:

- **Applies to** - one or more object types: prefix, IP address, device,
  VLAN, VRF, site, virtual machine. One rule can cover devices *and* virtual
  machines.
- **Scope** - which of those objects the rule judges, written with the same
  builder as the [advanced filter](saved-views.md#advanced-filter-expressions):
  *Device role is any of Server* and *Tags is any of production*. No scope
  means every object of the chosen types.
- **Check** - what each object in scope must satisfy: **Conditions** you
  build the same way (*Owner is not empty*, *Name matches `^sw-`*), or one of
  the computed checks - end-of-life status, support coverage, software
  target.

An object fails the rule when it is in scope and does not pass the check. When
you open the Compliance page, Danbyte evaluates every enabled rule against
your live data and lists the objects that fail. The results are not stored -
they are always computed fresh from the current data. What is stored is what
your team decides about a violation: acknowledged, or snoozed until a date
(see [Triage](#triage-acknowledge-and-snooze)).

## Create a rule

1. Go to **Governance → Compliance** and open the **Rules** tab.
2. Click **Add rule**.
3. Fill in the rule:

   | Card | Field | What it does |
   |---|---|---|
   | Rule | **Name** | A short label for the rule. |
   | Rule | **Severity** | `Critical`, `Warning`, or `Info`. Used for sorting and triage - it does not block or enforce anything. |
   | Rule | **Description** | Optional note explaining the rationale. |
   | Rule | **Enabled** | Turn the rule off to skip it during evaluation without deleting it. |
   | Remediation | **How to fix** | Optional **Markdown remediation guide** - step-by-step instructions rendered wherever the rule's violations appear (see below). |
   | Applies to | **Object types** | Toggle the types the rule covers; at least one. |
   | Applies to | **Only objects where** | The scope. Leave it empty to judge every object of the chosen types. |
   | Check | **Check** | **Conditions** (the default), **End-of-life status**, **Support coverage** or **Software target**. |
   | Check | **Must match** | For Conditions: what every object in scope must satisfy. |

4. Watch the **Preview** under the form: how many objects are in scope and how
   many fail, per type, with a sample of the failing ones. It refreshes half a
   second after you stop editing and counts only the objects you may view.
   Saving never waits for it.
5. Save. The rule starts being evaluated immediately.

### Scope and conditions

The scope and the conditions are built the same way: rows of *field ·
operator · value* in groups. Each group matches **All** or **Any** of its rows;
**+ Condition** adds a row and **+ Group** a nested group, up to three levels -
`(type is Device and device type is C9300) or type is Virtual machine`.

The fields depend on the chosen types. A device or VM offers name,
description, software version, status, device role, platform, site, region,
cluster, primary IP, tags, **device profile**, **profile state** and its custom
fields; a device adds device type, manufacturer, location, rack, serial
number, asset tag and warranty end; a VM adds vCPUs, memory, disk, VM group
and host device. Prefixes, IP addresses, VLANs, VRFs and sites have their own
lists (an IP address's role is **IP role**, a different catalog from a
device's role). Layout data and other internal fields are never offered.

| Operator | Applies to | Matches when |
|---|---|---|
| **is any of** / **is none of** | Catalog rows (status, role, site, tag, profile, …), choices, object type | The value is one of the picked rows - or, for tags and profiles, the object has any of them / none of them |
| **is** / **is not**, **contains** / **doesn't contain** | Text | Compared case-insensitively |
| **matches** / **doesn't match** | Text | A regular expression, PostgreSQL's dialect, case-sensitive |
| **is**, **>**, **<**, **>=**, **<=** | Numbers and dates | Compared as numbers or dates |
| **is empty** / **is not empty** | Every field | The field has no value (blank text counts as empty) |

Catalog values are picked from the catalog and drawn as their pills; a rule
stores their ids, so renaming a role or a tag never changes a rule.
**Device profile is any of** *RDS-Server* also matches objects given a child
profile such as *RDS-Server-HR*.

### Several object types

When a field exists on only some of the chosen types, its row carries a
marker such as **Devices only**, and on the other types the field reads as
empty: *Device type is any of C9300* is false for a VM, *Device type is
empty* is true. The **Object type** field lets a rule say which branch is
for which type. A field that none of the chosen types has cannot be saved.

The end-of-life and software target checks apply to devices and VMs, support
coverage to devices; the **Check** list offers what suits every chosen type.

### Check types

| Check | Passes when… | You provide |
|---|---|---|
| **Conditions** | The object matches **Must match**. | The conditions |
| **End-of-life status** | The platform's [end-of-life status](end-of-life-data.md#compliance-rules) is not the one picked. Devices and virtual machines only. | What it fails on: *End of life*, *Support ending or ended*, or *No end-of-life data*; **Include installed software** also fails on the [installed software](applications.md#installed-software) (off by default) |
| **Support coverage** | The device's [support coverage](support-coverage.md#compliance-rules) is not one the check fails on. Devices only. | What it fails on: *Expired or not covered*, or *Expiring, expired or not covered* |
| **Software target** | The object's [software version](lifecycle.md#software-target) equals its platform's target version. Passes when the platform has no target. Devices and virtual machines only. | Optionally **Fail without a version**, so a blank software version fails too (otherwise it passes) |

Every check takes the scope.

### Rules from before conditions

Rules made before conditions keep their single-field checks - **Field must
be set**, **Field must be empty**, **Field must match a pattern**, **Must carry
a tag** and **Custom field must be set** - and judge exactly what they did.
Editing one shows its check with **Convert to conditions**, which rewrites it
as a condition (a pattern becomes *is empty* or *matches*, because the old
check passed a blank value); nothing is converted unless you save. Note that
a converted pattern runs as a PostgreSQL regular expression instead of a
Python one - named groups `(?P<name>…)` are not supported there. A support
coverage rule's **tag** moves into the scope the next time it is edited, when
the slug names exactly one tag.

### Broken rules

A rule whose scope or conditions name a row that no longer exists - a deleted
role, say - shows **Broken** with the reason, and counts nothing until it is
edited. A missing reference is never read as "matches nothing", which would
let the rule pass silently. A rule whose query runs longer than five seconds
shows *The rule took too long to evaluate* the same way.

## Read the results

The Compliance page has three tabs: **Overview** (where it opens),
**Violations** and **Rules**. Each one runs the enabled rules against your
live data when it opens; **Evaluate now** in the header runs them again, and
the header says when the figures were taken.

### Overview

The Overview is the page to keep open. Worst things come first.

- **Figures** across the top: how many rules are enabled, how many pass, how
  many have violations, how many objects fail at least one rule, and the open
  violations per severity (**Critical**, **Warning**, **Info**). Click a
  severity or **Objects in violation** to open the Violations tab filtered to
  those open violations; click **With violations** to show only failing rule
  cards.
- **Rule cards**: one per enabled rule, with its object type, condition,
  severity, and result. A passing rule shows **OK**; a failing one shows its
  open violations in its object type - "3 devices", "1 prefix" - tinted by
  severity. Click the count to open the Violations tab filtered to that rule.
  Violations someone has acknowledged or snoozed show as **N triaged** beside
  it. Cards sort worst first: open critical failures, then warning, then info,
  then the rules that pass. **Search rules…** narrows by name,
  **Hide passing** drops the rules that pass, and **Group** sorts the cards
  under severity or object type headings.
- **Top offenders**: the ten objects failing the most rules, with their worst
  severity and the rules they fail. Click the count for that object's
  violations.

The figures count every object, whatever you may view; the top offenders name
only objects you can open.

### Violations

The **Violations** tab lists every object that currently fails a rule, worst
first: severity, then open before triaged. Each row shows the severity, the
object (linked to its page), its type, the rule (linked to the rule's page),
the object's site, and the triage state. You can:

- **Search** by object or rule name.
- **Filter** on the rail by **State**, **Severity**, **Rule**, **Object type**,
  **Site** and **Tags**, each value with a live count.
- **Group by rule**: one collapsible header per rule, with its severity and
  how many objects fail it.
- **Save the view** with the saved-views menu beside the search box, like any
  list page.
- **Export** the rows from the table's Export menu (HTML / CSV / Print to PDF).

### Triage: acknowledge and snooze

A security team needs to say "seen, we know" without changing the rule. Tick
rows on the Violations tab and use the bar that appears:

| Action | What it does |
|---|---|
| **Acknowledge** | Marks the violations seen. They stay in the list as *Acknowledged*, with who and when, and leave the open counts until the object passes the rule. |
| **Snooze until…** | Takes them out of the open counts until a time: 1 day, 7 days, 30 days, or a picked date (the start of that day). At that time they read as open again. At most 366 days. |
| **Reopen** | Clears an acknowledgement or snooze, back to open. Shown when the selection holds triaged rows. |

An optional **Note** goes with the action and shows in the row. Triage is
kept per rule and object, and the two kinds end differently:

- **An acknowledgement covers this occurrence.** When an evaluation finds the
  object passing the rule, the acknowledgement is cleared, so if it fails
  again it shows as open. The clearing is recorded in the
  [change log](change-log.md) and as a journal note on the rule and the
  object ("Cleared: the object passed …"), by *Compliance* rather than a
  person.
- **A snooze lasts until its date**, whether the object passes or not. If it
  fails again before then, it is still snoozed; after that it is open.

A violation both acknowledged and snoozed keeps its snooze (and its note)
when the acknowledgement clears. The check runs whenever the Overview,
the Violations tab or a rule's Results tab is evaluated, for the rules that
evaluation covers; there is no background job, so a violation that passed
and failed again between two evaluations stays acknowledged. **Reopen**
clears either kind by hand. Deleting a rule drops its triage. Config drift
is not triaged here; it clears when the device's configuration matches
again.

Triage needs the *change* permission on **Compliance triage**, its own
permission apart from compliance rules: editing rules does not let you
triage, and triage does not let you edit rules. The built-in Administrator
and Operator groups hold it; Read-only can view triage but not change it.
Every object in the selection must be one you can view: a site-limited user
triages only their own sites' objects. Each action is recorded in the
[change log](change-log.md) and as a journal note on the rule and on each
object.

### Filters live in the URL

Every filter on the page is kept in the query string, so a view is
**shareable and bookmarkable** and survives the browser's back/forward buttons.
For example:

```
/compliance?tab=violations&severity=critical,warning&type=device&q=core
/compliance?tab=violations&rule=<rule-id>&state=open
/compliance?tab=violations&device=<object-id>
/compliance?tab=violations&site=<site-id>&tag=pci&group=rule
/compliance?failing=1&by=severity
```

| Parameter | Tab | Meaning |
|---|---|---|
| `tab` | | `overview` (the default), `violations` or `rules`. |
| `q` | Violations | Free-text search over object and rule name (the search box). |
| `severity` | Violations | Comma-separated severities (`critical`, `warning`, `info`). |
| `type` | Violations | Comma-separated object types (`device`, `prefix`, …). |
| `rule` | Violations | Comma-separated rule ids. |
| `device` | Violations | A single object id - only that object's violations. |
| `site` | Violations | Comma-separated site ids; `none` for objects without a site. |
| `tag` | Violations | Comma-separated tag slugs - objects carrying any of them. |
| `state` | Violations | Comma-separated triage states (`open`, `acknowledged`, `snoozed`). |
| `group` | Violations | `rule` groups the rows under one header per rule. |
| `rq` | Overview | Search over rule names. |
| `failing` | Overview | `1` hides the rules that pass. |
| `by` | Overview, Rules | Group the rules by `severity` or `type`. |

A `rule` or `device` filter that the rail does not list shows as a
dismissible chip next to the search box.

The violation list names only objects the caller can view: a site-limited user
sees their own sites' failures. The per-rule counts and the totals still count
every object.

!!! tip "Large data sets are capped"
    To stay fast on big tenants, the flat violations list is capped at 5,000
    entries. A **Conditions** rule is evaluated in the database, so its count
    is exact however many objects fail. The other checks (end of life,
    support coverage, software target and the single-field checks from before
    conditions) read up to 5,000 objects per type; past that, objects are not
    judged.

### Rules tab

Every rule, enabled or not, with its severity, its current **Result** (the same
badge as the rule cards, *Broken*, or *Disabled*), what it applies to and its
condition in a few words ("role is Server · must: owner set"). A rule over
several types counts per type: *12 devices, 3 virtual machines*.
Rules sort worst first; **Group** puts them under severity or object type
headings, and a column header sorts by that column.

### Rule detail page

Click a rule name to open its detail page. The header line under the name
carries the severity, the result, the object types, the condition and when
it was evaluated. The **Overview** tab holds the rule's configuration, with
the scope and conditions drawn as the builder draws them; the **Results** tab
lists the objects it currently fails, rendered with the same columns you'd
see on that object type's normal list - one tab per type on a rule of
several - and **Triage** opens the
Violations tab filtered to the rule. The rows follow your access to that
object type: the compliance permission shows which rules fail and how many
objects, while the rows themselves need *view* on the type and are cut to the
sites that grant covers. **Re-evaluate** refreshes it on demand. If the rule
has a **How to fix** guide, it is rendered above the table.

### Remediation guides ("How to fix")

Each rule can carry a Markdown remediation guide, edited on the rule form
(requires the *change* permission on compliance rules, like any other rule
edit). It supports headings, ordered/unordered lists, fenced and inline code,
bold/italic, and `https://` links, and is rendered:

- on the rule's Results tab, above the violating objects, and
- on the per-device compliance page, expandable per failing rule via
  **How to fix**.

The renderer never interprets raw HTML - markup in the guide is shown as plain
text.

### Per-device compliance page

Every device has a dedicated compliance status page at
`/devices/<id>/compliance`. It shows either **"All green - no violations"**
when the device passes every enabled rule, or one card per failing rule with
its severity, what the rule asserts, and the expandable remediation guide.
Config drift (from IaC integrations) appears here too, linking to the
Config-drift page. A **Re-evaluate** button refreshes the status on demand.

The page is backed by `GET /api/compliance/devices/<id>/`, which is
tenant-scoped and requires the compliance *view* permission plus visibility of
the device itself.

### Violation markers on objects

Wherever a compliance object appears - its detail page header and its row in list
pages - a small warning marker shows up if that object is failing any rule. The
marker is tinted by the worst severity (critical = red, warning = amber,
info = neutral) and its tooltip names the failing rules. For **devices** the
marker links to that device's compliance page; for other object types it links
back to the Compliance page. Clean objects show nothing.

## Export the results

The Violations table, the top offenders and the rule's Results table are
standard data tables, so they carry the app-wide **Export** menu
(HTML / CSV / Print to PDF). See [Exporting tables](exporting-tables.md).

## API

All compliance endpoints are tenant-scoped and need the *view* permission on
compliance rules; triage needs *change* on compliance triage.

| Endpoint | What it returns |
|---|---|
| `GET/POST /api/compliance-rules/`, `GET/PATCH/DELETE /api/compliance-rules/<id>/` | Rules. Besides the name, severity and check fields a rule carries `object_types` (a list; `object_type` is its first entry), `scope` and `condition` (expression trees, below; `null` = none) and, read-only, `refs` - the rows the trees name, by id: `{"model", "name", "color", "missing"}`, with `"name": null, "hidden": true` for a row you may not view. A write may send the older `object_type` alone instead of `object_types`. |
| `GET /api/compliance/fields/?object_types=device,virtualmachine` | The fields a scope or condition can name on those types: `{"fields": [{"key", "label", "kind", "types", "ops", "ref", "choices"}]}`. `kind` is `string`, `number`, `date`, `bool`, `choice`, `ref`, `tags` or `type`; `types` lists the chosen types that have the field; `ref` names the catalog list its values come from. Names and shapes only, never data. |
| `POST /api/compliance-rules/preview/` | A rule's body (name optional) judged without saving: `{"by_type": {"device": {"in_scope", "failing", "sample": [{"id", "repr", "site_name"}]}}, "error"}`, with up to 25 sample objects per type. Needs *add* or *change* on compliance rules, and counts only the objects you may view. |
| `GET /api/compliance/summary/` | The Overview in one response: `evaluated_at`; `totals` (`rules`, `disabled_rules`, `passing`, `failing`, `violations`, `open`, `acknowledged`, `snoozed`, `objects_in_violation`); `by_severity` (per severity: `rules`, `failing_rules`, `violations`, `open`); `rules` (one row per enabled rule and config drift, worst first, with `violations`, `open`, `acknowledged`, `snoozed`, `object_types`, `by_type`, `error` and the rule's check fields, scope, conditions and refs); `top_offenders` (the ten visible objects failing the most rules). |
| `GET /api/compliance/evaluate/` | The per-rule summary, the flat violation list, `total_violations`, `objects_in_violation`, and `facets` - value counts for `severity`, `state`, `rule`, `object_type`, `site` and `tag` over the violations you may view. Each violation carries its own object's `object_type`, `site_id`, `site_name`, `tags`, `state`, `acknowledged_by`, `acknowledged_at`, `snoozed_until` and `note`. Each rule row carries `object_types`, `by_type` (failing objects per type) and `error` (why it is Broken, else `null`). The query parameters `severity`, `object_type`, `rule`, `object`, `site`, `tag`, `state` and `q` narrow the list (values within one parameter are ORed) and leave the summary, totals and facets whole. |
| `GET /api/compliance-rules/<id>/violations/` | One rule's violating objects, its `result` counts and `evaluated_at`. `objects_by_type` holds the failing rows per type, serialized as that type's list serializes them; `objects` holds them for a single-type rule. |
| `POST /api/compliance/triage/` | Body `{"action": …, "items": [{"rule_id", "object_id"}], "until": …, "note": …}` with `action` one of `acknowledge`, `snooze` (needs `until`, an ISO time) or `clear`; up to 1,000 items. Every rule must be the tenant's and every object one you can view, of one of its rule's types, or nothing is written. Returns `{"updated": n}`. |

### Expression trees

`scope` and `condition` share one shape, the advanced filter's:

```json
{"kind": "group", "op": "and", "terms": [
  {"kind": "cmp", "field": "role", "cmp": "in", "values": ["<role id>"]},
  {"kind": "cmp", "field": "name", "cmp": "matches", "value": "^srv-"},
  {"kind": "empty", "field": "cf.owner", "negated": true}
]}
```

`cmp` is one of `=`, `!=`, `~`, `!~`, `>`, `<`, `>=`, `<=` and `matches`,
`not_matches` (with `value`), or `in`, `not_in` (with `values` - ids for
catalog fields). A save is refused with `400` and one entry per problem,
pointing at the node: `{"condition": [{"path": "terms.1.values.0", "detail":
"Not one of this tenant's tags."}]}`. Every id must be one of this tenant's
rows, and for a catalog bound to sites (sites, locations, racks, site-local
catalogs) one you may view. Limits: groups three deep, 50 conditions per
tree, 200 values per condition, 255 characters per value, 16 KB in all. A
pattern PostgreSQL cannot compile is refused with its message.

## Audit trail

Creating, editing, or deleting a rule is recorded, and so is every
acknowledgement, snooze and reopen, so you can see who changed your policy or
triaged a violation and when. Triage entries show to people with *view* on
compliance triage. See the [change log](change-log.md).
