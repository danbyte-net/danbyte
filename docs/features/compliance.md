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

A rule is a single assertion of the form: *objects of type **X** must (or must
not) have property **Y***. When you open the Compliance page, Danbyte evaluates
every enabled rule against your live data and lists the rows that fail. The
results are not stored - they are always computed fresh from the current data.
What is stored is what your team decides about a violation: acknowledged, or
snoozed until a date (see [Triage](#triage-acknowledge-and-snooze)).

## Create a rule

1. Go to **Governance → Compliance** and open the **Rules** tab.
2. Click **Add rule**.
3. Fill in the rule:

   | Field | What it does |
   |---|---|
   | **Name** | A short label for the rule. |
   | **Description** | Optional note explaining the rationale. |
   | **How to fix** | Optional **Markdown remediation guide** - step-by-step instructions rendered wherever the rule's violations appear (see below). |
   | **Enabled** | Turn the rule off to skip it during evaluation without deleting it. |
   | **Severity** | `Critical`, `Warning`, or `Info`. Used for sorting and triage - it does not block or enforce anything. |
   | **Object type** | What the rule applies to: prefix, IP address, device, VLAN, VRF, site, or virtual machine. |
   | **Check type** | The kind of assertion (see below). |
   | **Parameters** | The field, pattern, tag, or custom-field key the check needs. Only the relevant inputs appear once you pick a check type. |

4. Save. The rule starts being evaluated immediately.

### Check types

| Check | Passes when… | You provide |
|---|---|---|
| **Required** | The field is set (not empty). | The field name |
| **Forbidden** | The field is empty. | The field name |
| **Regex** | The field, *if it has a value*, matches your pattern. | The field name and a regular expression |
| **Required tag** | The object carries a given tag. | The tag |
| **Required custom field** | A given custom-field key is set. | The custom-field key |
| **End-of-life status** | The platform's [end-of-life status](end-of-life-data.md#compliance-rules) is not the one picked. Devices and virtual machines only. | What it fails on: *End of life*, *Support ending or ended*, or *No end-of-life data*; **Include installed software** also fails on the [installed software](applications.md#installed-software) (off by default) |
| **Support coverage** | The device's [support coverage](support-coverage.md#compliance-rules) is not one the check fails on. Devices only. | What it fails on: *Expired or not covered*, or *Expiring, expired or not covered*; optionally a tag, to judge only devices with it |
| **Software target** | The object's [software version](lifecycle.md#software-target) equals its platform's target version. Passes when the platform has no target. Devices and virtual machines only. | Optionally **Fail without a version**, so a blank software version fails too (otherwise it passes) |

!!! note "Regex ignores empty values"
    A **Regex** check passes for objects where the field is blank - it only
    judges values that are actually present. If you want a field to be both set
    *and* well-formed, write two rules: one **Required** and one **Regex**. That
    keeps blanks from being reported twice. (Empty means `null`, `""`, an empty
    list, or an empty object.)

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
| **Acknowledge** | Marks the violations seen. They stay in the list as *Acknowledged*, with who and when, and leave the open counts. |
| **Snooze until…** | Takes them out of the open counts until a time: 1 day, 7 days, 30 days, or a picked date (the start of that day). At that time they read as open again. At most 366 days. |
| **Reopen** | Clears an acknowledgement or snooze, back to open. Shown when the selection holds triaged rows. |

An optional **Note** goes with the action and shows in the row. Triage is
kept per rule and object: when the object passes the rule, nothing shows,
and the decision is still there if it fails again - **Reopen** clears it.
Deleting a rule drops its triage. Config drift is not triaged here; it clears
when the device's configuration matches again.

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
    entries, and each rule scans up to 5,000 rows. The **counts** stay exact even
    when the list is truncated.

### Rules tab

Every rule, enabled or not, with its severity, its current **Result** (the same
badge as the rule cards, or *Disabled*), what it applies to and its condition.
Rules sort worst first; **Group** puts them under severity or object type
headings, and a column header sorts by that column.

### Rule detail page

Click a rule name to open its detail page. The header line under the name
carries the severity, the result, the object type, the condition and when it
was evaluated. The **Overview** tab holds the rule's configuration; the
**Results** tab lists the objects it currently fails, rendered with the same
columns you'd see on that object type's normal list, and **Triage** opens the
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
| `GET /api/compliance/summary/` | The Overview in one response: `evaluated_at`; `totals` (`rules`, `disabled_rules`, `passing`, `failing`, `violations`, `open`, `acknowledged`, `snoozed`, `objects_in_violation`); `by_severity` (per severity: `rules`, `failing_rules`, `violations`, `open`); `rules` (one row per enabled rule and config drift, worst first, with `violations`, `open`, `acknowledged`, `snoozed` and the rule's check fields); `top_offenders` (the ten visible objects failing the most rules). Its cost does not grow with the number of rules: one scan per object type. |
| `GET /api/compliance/evaluate/` | The per-rule summary, the flat violation list, `total_violations`, `objects_in_violation`, and `facets` - value counts for `severity`, `state`, `rule`, `object_type`, `site` and `tag` over the violations you may view. Each violation carries its `site_id`, `site_name`, `tags`, `state`, `acknowledged_by`, `acknowledged_at`, `snoozed_until` and `note`. The query parameters `severity`, `object_type`, `rule`, `object`, `site`, `tag`, `state` and `q` narrow the list (values within one parameter are ORed) and leave the summary, totals and facets whole. |
| `GET /api/compliance-rules/<id>/violations/` | One rule's violating objects, its `result` counts and `evaluated_at`. |
| `POST /api/compliance/triage/` | Body `{"action": …, "items": [{"rule_id", "object_id"}], "until": …, "note": …}` with `action` one of `acknowledge`, `snooze` (needs `until`, an ISO time) or `clear`; up to 1,000 items. Every rule must be the tenant's and every object one you can view, or nothing is written. Returns `{"updated": n}`. |

## Audit trail

Creating, editing, or deleting a rule is recorded, and so is every
acknowledgement, snooze and reopen, so you can see who changed your policy or
triaged a violation and when. Triage entries show to people with *view* on
compliance triage. See the [change log](change-log.md).
