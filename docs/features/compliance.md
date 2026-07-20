---
icon: lucide/shield-check
---

# Compliance

Compliance lets you write **rules** about your own data — "every prefix must have
a description", "active IPs need a DNS name", "devices need a serial number" — and
then see every object that breaks them, on demand.

Danbyte ships **zero rules**. The policy is entirely yours to define, so the
checks match how your organisation actually works. You'll find everything under
**Governance → Compliance** in the sidebar.

## How a rule works

A rule is a single assertion of the form: *objects of type **X** must (or must
not) have property **Y***. When you open the Compliance page, Danbyte evaluates
every enabled rule against your live data and lists the rows that fail. Nothing
is stored — results are always computed fresh from the current data.

## Create a rule

1. Go to **Governance → Compliance** and open the **Rules** tab.
2. Click **Add rule**.
3. Fill in the rule:

   | Field | What it does |
   |---|---|
   | **Name** | A short label for the rule. |
   | **Description** | Optional note explaining the rationale. |
   | **How to fix** | Optional **Markdown remediation guide** — step-by-step instructions rendered wherever the rule's violations appear (see below). |
   | **Enabled** | Turn the rule off to skip it during evaluation without deleting it. |
   | **Severity** | `Critical`, `Warning`, or `Info`. Used for sorting and triage — it does not block or enforce anything. |
   | **Object type** | What the rule applies to: prefix, IP address, device, VLAN, VRF, or site. |
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

!!! note "Regex ignores empty values"
    A **Regex** check passes for objects where the field is blank — it only
    judges values that are actually present. If you want a field to be both set
    *and* well-formed, write two rules: one **Required** and one **Regex**. That
    keeps blanks from being reported twice. (Empty means `null`, `""`, an empty
    list, or an empty object.)

## Read the results

The **Violations** tab lists every object that currently fails a rule, with its
severity, object type, the object itself, and the rule it broke. You can:

- **Search** by object or rule name.
- **Filter** by object type and severity, each showing a live count.
- **Click an object** to jump to its detail page, or **click a rule** to open the
  rule's detail page.

### Filters live in the URL

Every violation filter is kept in the page's query string, so a filtered view is
**shareable and bookmarkable** and survives the browser's back/forward buttons.
For example:

```
/compliance?tab=violations&severity=critical,warning&type=device&q=core
/compliance?tab=violations&rule=<rule-id>
/compliance?tab=violations&device=<object-id>
```

| Parameter | Meaning |
|---|---|
| `q` | Free-text search over object and rule name (the search box). |
| `severity` | Comma-separated severities (`critical`, `warning`, `info`). |
| `type` | Comma-separated object types (`device`, `prefix`, …). |
| `rule` | A single rule id — only that rule's violations. |
| `device` | A single object id — only that object's violations. |

`rule` and `device` are deep-link filters: when present they appear as
dismissible chips next to the search box. The same parameters are accepted by
the API endpoint (`GET /api/compliance/evaluate/?severity=…&rule=…&object=…&q=…`),
which narrows the returned violation list while keeping the per-rule summary and
total unfiltered.

!!! tip "Large data sets are capped"
    To stay fast on big tenants, the flat violations list is capped at 5,000
    entries, and each rule scans up to 5,000 rows. The **counts** stay exact even
    when the list is truncated.

### Rule detail page

Click a rule name to open its detail page. It shows the rule's configuration plus
an **affected objects** table — the rows it currently fails, rendered with the
same columns you'd see on that object type's normal list. A **Re-evaluate**
button refreshes it on demand. If the rule has a **How to fix** guide, it is
rendered above the affected-objects table.

### Remediation guides ("How to fix")

Each rule can carry a Markdown remediation guide, edited on the rule form
(requires the *change* permission on compliance rules, like any other rule
edit). It supports headings, ordered/unordered lists, fenced and inline code,
bold/italic, and `https://` links, and is rendered:

- on the rule's detail page, above the affected objects, and
- on the per-device compliance page, expandable per failing rule via
  **How to fix**.

The renderer never interprets raw HTML — markup in the guide is shown as plain
text.

### Per-device compliance page

Every device has a dedicated compliance status page at
`/devices/<id>/compliance`. It shows either **"All green — no violations"**
when the device passes every enabled rule, or one card per failing rule with
its severity, what the rule asserts, and the expandable remediation guide.
Config drift (from IaC integrations) appears here too, linking to the
Config-drift page. A **Re-evaluate** button refreshes the status on demand.

The page is backed by `GET /api/compliance/devices/<id>/`, which is
tenant-scoped and requires the compliance *view* permission plus visibility of
the device itself.

### Violation markers on objects

Wherever a compliance object appears — its detail page header and its row in list
pages — a small warning marker shows up if that object is failing any rule. The
marker is tinted by the worst severity (critical = red, warning = amber,
info = neutral) and its tooltip names the failing rules. For **devices** the
marker links to that device's compliance page; for other object types it links
back to the Compliance page. Clean objects show nothing.

## Export the results

The Violations table and the affected-objects table are standard data tables, so
they carry the app-wide **Export** menu (HTML / CSV / Print to PDF) and row
checkboxes. See [Exporting tables](exporting-tables.md).

## Audit trail

Creating, editing, or deleting a rule is recorded, so you can see who changed your
policy and when. See the [change log](change-log.md).
