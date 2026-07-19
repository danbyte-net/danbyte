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

!!! tip "Large data sets are capped"
    To stay fast on big tenants, the flat violations list is capped at 5,000
    entries, and each rule scans up to 5,000 rows. The **counts** stay exact even
    when the list is truncated.

### Rule detail page

Click a rule name to open its detail page. It shows the rule's configuration plus
an **affected objects** table — the rows it currently fails, rendered with the
same columns you'd see on that object type's normal list. A **Re-evaluate**
button refreshes it on demand.

### Violation markers on objects

Wherever a compliance object appears — its detail page header and its row in list
pages — a small warning marker shows up if that object is failing any rule. The
marker is tinted by the worst severity (critical = red, warning = amber,
info = neutral) and its tooltip names the failing rules with a link back to the
Compliance page. Clean objects show nothing.

## Export the results

The Violations table and the affected-objects table are standard data tables, so
they carry the app-wide **Export** menu (HTML / CSV / Print to PDF) and row
checkboxes. See [Exporting tables](exporting-tables.md).

## Audit trail

Creating, editing, or deleting a rule is recorded, so you can see who changed your
policy and when. See the [change log](change-log.md).
