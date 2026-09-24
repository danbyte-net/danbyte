---
icon: lucide/badge-check
---

# Service level agreements

An agreement states the availability you promise over a period, the hours it
covers, and how each check status counts. Danbyte measures it from the same
status changes the monitoring history shows. Each period's figure is stored and
then frozen, so it stays the same after the raw data behind it is pruned.

**Governance → Monitoring → SLAs** lists every agreement. Each row shows this
period's figure against the target, the error budget left, how much of the
time was actually measured, and **Last 12**: how many of the last twelve
finished periods met the target.

## Your first agreement

1. Make sure the equipment is monitored. An agreement only reads the results
   of checks that already run; see [Monitoring](monitoring.md).
2. On the SLAs list, click **New agreement**. Give it a name, who it is
   **provided for**, a **target** such as 99.9 and a **period** such as
   Month. The other settings have sensible defaults.
3. On the agreement's **Check groups** tab, click **New group** and pick the
   checks that count, for example Ping. Leave the list empty to count every
   check.
4. On the **Members** tab, click **Add member** and pick devices, virtual
   machines, IP addresses or prefixes. You can also add them from an
   object's **Monitoring** tab or the device list, with **Add to SLA**.
5. The figure appears straight away and is kept up to date every 15
   minutes. The **Overview** tab shows it with charts.

### An example

A target of 99.9 % over a 30-day month allows 0.1 % of 30 days down: 43
minutes. That is the **error budget**.

- Fifteen days in, with 15 minutes down, 35 % of the budget is spent after
  50 % of the month. The **burn rate** is 35 ÷ 50 = 0.7, and availability so
  far is 99.93 %: *On target*.
- Twenty-five days in, with 35 minutes down, 81 % of the budget is spent.
  Availability is still 99.90 %, but three quarters of the budget is gone:
  *At risk*.
- Once the down time passes what the elapsed share of the month allows, the
  burn rate goes above 1.0 and availability drops under the target:
  *Breached*.

## The parts of an agreement

| Part | What it says |
|---|---|
| **Agreement** | Who it is provided for, the target (for example 99.9 %), the period, the service hours, holidays, and the counting rules |
| **Check group** | Which checks count for one class of equipment, and which address they are read from |
| **Member** | A device, virtual machine, IP address or prefix in a group |
| **Unit** | What the figure is built from: one member, or a redundancy group of members counted as one |
| **Exclusion** | Time that does not count, with the reason recorded |

A new tenant has no agreements. Nothing is seeded.

**Provided for** says who the promise is made to:

- **This tenant** (the default) - often the customer *is* the tenant.
- **Sites** - one or more of the tenant's sites or locations, for an
  internal agreement per site.
- **A contact** - someone from Contacts.
- **A name** - free text.

Lists, the agreement page and reports show it as "For ...". The SLAs list
searches it, and filters by site with `?site=`.

### Periods

A period is a calendar month, quarter or year, read in the agreement's
timezone. The timezone defaults to the tenant's. A period can also be rolling:
the last 7, 30 or 90 days.

Calendar periods go through three states:

- **Open** - the current period, recomputed every 15 minutes by the
  `danbyte-sla` timer (`manage.py sla_compute`).
- **Closed** - the period has ended. For seven days it is still recomputed,
  so exclusions can be added.
- **Frozen** - seven days after the period ends, the figure is final and
  never recomputed.

A rolling agreement has a single figure that is always current.

*Counts from* sets a start date. Nothing before it is computed.

### Service hours and holidays

By default an agreement covers all hours. With service hours set, for example
Monday to Friday 08:00-17:00, time outside those hours is not measured at all.

Holidays come from a **holiday calendar**. Calendars are shared across the
tenant and managed under **Holidays** on the SLAs list. A bank holiday is
entered once, and every agreement using that calendar skips it.

### Counting rules

| Status | Counts as | Can be changed to |
|---|---|---|
| Up | up | - |
| Down | down | - |
| Degraded | up | down |
| Stale | not measured | down |
| Unknown, skipped | not measured | down |

*Stale* means the probe could not see the target. That is usually a fault in
the probe or its network, not in the service, so by default it is not charged
as downtime.

**Ignore outages under** sets a number of seconds. Outages shorter than that
count as up.

**Exclude planned maintenance** removes the time of every maintenance event
that touches a member's device, unless the event is tentative, cancelled or
rescheduled. Outage events are never excluded. See
[Maintenance](maintenance.md).

Changing a rule creates a new **revision**. A closed period keeps the revision
it ran under. The **Revisions** tab shows what changed and who changed it.

## Check groups

A group lists the check templates that count, such as Ping and SSH. A check
can be **informational**: it is computed and shown next to the counted
checks, but never included in the figure. If a group lists no checks, every
check on the member's addresses counts.

**Addresses** controls where the checks are read from: the device's primary
address, or every address on it.

**Checks combine as** decides how several counted checks become one figure
for an object:

- **All must pass** (the default) - the object is down while any counted
  check is down.
- **Weighted** - the weighted average of the checks' up and down time. A
  check marked *required* always counts its full down time.

**Devices join by selector** adds, without adding them one by one, every
device that matches all of the selector fields you fill in: sites, roles,
device types, platforms, tags, and a name pattern such as `leaf-*`. A selector
with nothing filled in matches nothing. To keep one matching device out, add
it as a member and mark it excluded.

## Members

Add devices, virtual machines, IP addresses or prefixes on the **Members**
tab. A prefix stands for the monitored addresses in it and in its child
prefixes. An address with no check is not counted, so adding a /16 does not
bring in thousands of unmeasured rows.

Removing a member marks it as having left; it is not deleted. Periods it was
part of still count the time it was in. A member you cannot view cannot be
added.

**Redundancy group** is a label shared by members that back each other up,
such as a leaf pair. A redundancy group counts as one unit, and it is down only
while all of its members are down.

**Members combine as** decides how the units become the agreement's figure:

- **Average** - the time-weighted mean: total up time over total measured
  time.
- **Worst member** - the figure of the lowest unit.

## The figure

These figures appear everywhere an agreement's figure is shown:

- **Availability** - up ÷ (up + down) within service hours, after exclusions.
- **Coverage** - measured time ÷ service time, shown beside a figure as
  "68% measured". Time with no check results counts as neither up nor down,
  so a high availability with low coverage was measured over only part of
  the period; treat it with care. The badge is dimmed when coverage is under
  90 %.
- **State**:
    - *On target*;
    - *At risk* - below *At risk below*, or, when that is empty, once three
      quarters of the error budget is spent;
    - *Breached* - below the target;
    - *No data*.
- **Error budget** - the downtime the target allows over the whole period,
  what has been spent, and what is left. With *Average* the spend is the mean
  unit downtime; with *Worst member* it is the worst unit's downtime.
- **Burn rate** - budget spent ÷ share of the period elapsed. Above 1.0, the
  period ends over budget if nothing changes.
- **Forecast** - where the period ends if the rest of it goes like the last
  seven days: the figure so far and the last week's figure, weighted by how
  much of the period each covers. A bad start followed by a clean week
  forecasts better than the figure today; a fresh outage forecasts worse. It
  appears once a tenth of the period has passed, only while the period is
  open, and is coloured against the target like the figure.

### Latency objectives

**Latency objectives** set a p95 response time in milliseconds per check
kind (ICMP, TCP, HTTP, SSH), over the period. Missing one sends an alert and
draws in the latency chart. It never lowers availability. Leave a kind empty
to have no objective for it.

## Analysis

The **Overview** tab computes the agreement live for the window and slice you
pick. Every figure and chart follows the filter rail on the left.

- **Window** - this period, any stored period, or a custom date range (up to
  400 days).
- **Per** - day, or hour (up to 45 days).
- **Slices** - check groups, sites, check types, redundancy groups and
  members. Ticking several means any of them.

Above the headline, **history** shows the last twelve finished periods as
pills, oldest first, coloured by how each ended, with "Met 11 of 12" before
them. A pill opens that period. A closed period that is not yet frozen says
so on hover.

The headline shows availability, state, coverage, down time, budget left and
incidents. For a window still running, the forecast follows the target line,
and the availability chart draws the days still to come as hollow, dashed
bars at the last week's figure. Where it makes sense it adds the change from the window before:
the previous period, or a range of the same length just before a custom
range. The previous window is computed with the same slices, so the two
compare like for like.

| Chart | What it shows | Click |
|---|---|---|
| **Availability over time** | Availability per day or hour against the dashed target line | A day opens it by the hour: who was down, which check, the incidents, and down time per check type |
| **Error budget** | Budget spent so far (steps) against the pace that would spend it exactly by the period's end (dashed); the red line is the whole budget | - |
| **Where the down time went** | Down time and availability per member, check group, site or check type | A row narrows the whole page to it |
| **When outages happen** | Down time by weekday and hour, in the agreement's timezone. A nightly job or a Monday change window shows up as a stripe. Hover a cell for its down time | - |
| **Incident lengths** | Incidents by duration, and the mean time to recover | - |
| **Latency against objectives** | p95 and median per check type, with the objective as a dashed line | - |
| **Members over time** | One status strip per member across the window, so overlaps and redundancy show at a glance | A name opens the member panel |

The **member panel** shows one member for the window:

- its name, linked to the object's page, and its check group;
- its figure, coverage, down time and incidents;
- its strip;
- each check with its own availability, informational checks marked, and a
  link to the check's page (for a prefix, with the address it runs on);
- its incidents.

The report bar above the analysis downloads or emails the **stored** figure
of a period. The analysis itself is computed fresh each time, from the same
status changes.

**Incidents** lists each outage that spent budget: when it started, how long
it lasted, and which members were down as it began.

**Exclusions** removes time from the figure, for the whole agreement or for
one member, with a required reason. Examples are a provider's fibre cut or a
test the customer asked for. Each exclusion is kept in the change log. An
exclusion cannot touch a frozen period.

After a change to members, groups or exclusions, the figure is recomputed
straight away. **Recompute** does the same by hand.

## Alerts

Under **Alerts and reports** on the agreement's form, pick **Alert
channels**: any notification channel (email,
Slack, Teams, Discord, Telegram, PagerDuty or webhook). Each alert goes out at
most once per period; a rolling agreement repeats a standing alert once a
day.

| Alert | When |
|---|---|
| **SLA breached** | The period's availability is below the target. It is also sent when a period tips into breach in its last minutes and closes before the next run. |
| **SLA at risk** | The state is at risk (below *At risk below*, or three quarters of the budget spent), or the budget burns faster than **At risk above burn rate**. At 1.0 the budget runs out exactly at the period's end; at 2 it lasts half the period. |
| **SLA coverage low** | Less of the service time than **Coverage alert below** was measured. This waits until a tenth of the period has passed. |
| **Latency objective missed** | A check kind's p95 over the members' checks is above its **latency objective** for the period. It never changes availability. |

A new agreement does not alert about periods that ended before it existed.

### Burn-rate alerts

The alerts above look at the whole period, so a sharp outage early in a month
can spend much of the budget before anything tells you. **Burn-rate alerts**
watch the last hour or hours instead.

A burn rate says how fast the budget is being spent: 1x spends it exactly by
the period's end, 10x spends it in a tenth of the period. A rule compares two
windows and fires only while **both** burn at or above its threshold. The long
window shows the burn is real; the short one shows it is still happening, so
the alert clears a few minutes after the outage ends.

| Rule | Windows | Threshold | Meaning (30-day budget) |
|---|---|---|---|
| **Fast** | 1 h and 5 min | 14.4x | 2 % of the budget gone in an hour. Page someone. |
| **Slow** | 6 h and 30 min | 6x | 5 % gone in six hours. Look at it today. |

Both rules are on for every agreement. Change the windows and thresholds, or
switch a rule off, under **Burn-rate alerts** on the form. Each rule sends one
message when it starts firing and one when it stops. PagerDuty gets a trigger
and a matching resolve. A rule that starts firing again within an hour of its
last message stays quiet.

The Overview shows **Burn now** beside the target for the current period:
each rule's two windows, and a badge while it fires. Outside service hours
nothing is measured, so nothing burns. Viewers with a limited view do not see
burn rates, because they cover the whole agreement.

The `danbyte-sla-burn` timer (`manage.py sla_burn`) checks the rules every
minute. **At risk above burn rate** stays as it was: the pace over the whole
period, sent once per period as *SLA at risk*.

## Reports

The agreement page downloads the selected period's report as **PDF** or
**CSV**. The report contains:

- the figure against the target, the state and the coverage;
- the error budget and the incidents;
- the counting rules;
- availability per day;
- each member, worst first, with its worst check;
- each incident, with the members that were down.

A report for a period that is still open or not yet frozen says so. A report
computed under an older revision of the rules names the revision.

**Report recipients** get the report by email, as PDF, CSV or both, when the
period freezes, seven days after it ends. **Email report** sends it now,
either to those recipients or once to addresses you type in; a one-off
address is not saved on the agreement.

**Overview** on the SLAs list gives every agreement's figure for this or the
last period, as one PDF or CSV.

Reports follow the viewer's permissions like the figures do. A site-scoped
user's report leaves out the members they cannot see, and says so.

## On lists and object pages

The device, virtual machine, IP address and prefix lists have two columns:

- **SLA** - the object's figure in its agreement's current period, coloured
  against that agreement's target. An object in several agreements shows the
  strictest one, the one furthest below its target. Hovering lists all of
  them, with the budget left and the worst check. An object in no agreement
  shows a dash, never a failing figure. The rail filters by state: on
  target, at risk, breached, or no SLA.
- **Availability** - plain uptime over a time frame, from every check on the
  object's addresses, whether it is in an agreement or not. The frame is
  picked on the list's toolbar and remembered in your browser. It defaults to
  the tenant's **Availability window**, set in the monitoring settings (24
  hours, 7/30/90 days, or month, quarter or year to date). When part of the
  frame had no check results, the share that did follows the figure, as in
  "75.1% 68% measured". Unmeasured time counts as neither up nor down.

The **Monitoring** tab of a device, virtual machine, IP address or prefix opens with
the agreements the object is in, and has an **Add to SLA** button. It asks
for the agreement, the check group and an optional redundancy group. The
device list's selection bar has the same button, for many devices at once.
An addition shows in the figure straight away.

## Who sees what

One permission, **SLA agreements**, covers an agreement together with its
groups, members and exclusions. Holiday calendars have their own permission.

A viewer whose device, VM or address permissions are limited to some sites gets
a partial figure. It covers only the units whose members they can all see,
and a note says how many members are left out. Hidden members, their
incidents, and the per-day figures are not shown.

## API

| Endpoint | What |
|---|---|
| `/api/monitoring/sla-agreements/` | Agreements; each includes the current period's figure as `current` |
| `…/sla-agreements/<id>/figures/?period=current\|previous\|2026-08` | One period, with members, incidents and days |
| `…/sla-agreements/<id>/periods/` | Every stored period |
| `…/sla-agreements/<id>/revisions/` | The rules over time |
| `POST …/sla-agreements/<id>/recompute/` | Recompute now |
| `burn_alerts` on an agreement | Up to four rules: `{name, long_min, short_min, burn, on}`; `current.burn` has each rule's last result |
| `/api/monitoring/sla-check-groups/` | Groups; `items` are written inline |
| `/api/monitoring/sla-members/` | Members; `POST …/bulk-add/` adds up to 1,000 at once |
| `/api/monitoring/sla-exclusions/` | Excluded time |
| `/api/monitoring/holiday-calendars/` | Shared holiday calendars |
| `GET …/sla-agreements/<id>/report/?period=&file=pdf\|csv` | A period's report (`file`, not `format`, which the API keeps for itself) |
| `GET …/sla-agreements/<id>/analysis/?period=\|since=&until=&bucket=day\|hour&group=&site=&member=&kind=&redundancy=` | The analysis view's data, computed live, with `forecast` while the window runs |
| `POST …/sla-agreements/<id>/send-report/` | Email it now: `{period, recipients?}` |
| `GET …/sla-agreements/overview-report/?period=&file=` | Every agreement for one period |
| `POST /api/monitoring/sla-status/` | `{kind: device\|vm\|ip\|prefix, ids, frame?}` → each object's agreements, strictest figure, and availability over the frame |
