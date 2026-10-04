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
2. On the SLAs list, click **New agreement**. Three steps follow:
    - **Agreement** - a name, who it is **provided for**, a **target** such
      as 99.9 and a **period** such as Month.
    - **Members** - devices, virtual chassis, device roles, device types,
      virtual machines, IP addresses, prefixes or circuits. Pick several at
      once. A virtual chassis is a [switch stack counted once](#switch-stacks).
      Roles and types go on the group's selector, so devices join and leave
      as they gain or lose them: several roles mean any of them, and a role
      together with a type means a device needs both. Members can also be
      added later, from the agreement or from an object's **Monitoring** tab
      with **Add to SLA**.
    - **Checks** - a first check group and the checks that count. The checks
      your devices, stacks, roles, types and prefixes already run are ticked
      for you; with none ticked, every check on a member's addresses counts.

    **Create** makes the agreement, its group and its members. **All
    settings** opens every setting on one form instead.
3. The figure appears straight away and is kept up to date every 15
   minutes. The **Overview** tab shows it with charts. Service hours,
   counting rules, alerts, objectives and credits keep their defaults until
   you edit the agreement.

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
| **Member** | A device, virtual chassis, virtual machine, IP address, prefix or circuit in a group |
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
tenant and managed under **Holidays** on the SLAs list, which shows each
calendar's days this year and the agreements that use it. Every agreement
that uses a calendar skips its days.

A calendar opens on a year. Click a day to make it a holiday, and click it
again to take it off. Arrow keys move between days, Page Up and Page Down
move a month, and Enter or Space toggles. The list beside the year names
each day; on a narrow screen it sits above the year.

**Every year** repeats a fixed-date holiday such as 25 December, so it is
entered once. It counts in earlier years too. A yearly 29 February falls in
leap years only. Holidays that move, such as Easter Monday, are entered per
year or imported; there is no copy to next year, because a moving holiday
lands on another date. An every-year day has an inner ring in the year view.
Clicking it, in any year, takes it off every year, and **Undo** puts it back.

**Import** adds days in bulk:

- **Paste dates** takes `YYYY-MM-DD` dates, and dates in your own date
  format, one per line or separated by commas. A dash between two dates,
  as in `2026-12-24 – 2026-12-26`, adds each day from one to the other. Text
  beside a date becomes its name; with several dates on a line that starts
  with text, the text before each date names it.
- **Open .ics file** reads the all-day events of a calendar file. The event
  title becomes the name, a multi-day event adds each of its days, and an
  event that repeats yearly on its date becomes an every-year holiday. A
  yearly repeat with an end adds each year it covers. Timed events and other
  repeat rules are skipped, and the result says how many.

Days already in the calendar are kept, and **Undo** takes an import back
until you edit the calendar again. Dates typed in the paste box but not yet
added count as unsaved changes. A calendar holds up to 1,000 days, from 1970
to 2099: a pasted date outside those years is refused by line, and an .ics
import skips such days and says how many.

A change to a calendar applies to periods that are not yet frozen. Frozen
periods keep their stored figures.

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

An address [excluded from monitoring](monitoring.md#excluding-an-address) is
*skipped* for as long as it is excluded: not measured, even when unknown
counts as down. Its time still belongs to the member, so a long exclusion
lowers the member's **coverage** - which is the truth: nothing was measured.
When it is included again its checks stay *skipped* until their first answer,
so the gap is not charged either.

**Ignore outages under** sets a number of seconds. Outages shorter than that
count as up. It judges the whole outage: one that crosses the end of a period
or of the service hours is measured end to end, and the part inside each
period counts there.

**Exclude planned maintenance** removes the time of every maintenance event
that touches a member's device or circuit (a carrier's announced works),
unless the event is tentative, cancelled or
rescheduled. Outage events are never excluded. See
[Maintenance](maintenance.md).

Changing a rule creates a new **revision**. The running period uses the new
rules straight away; a closed period keeps the revision it ran under. The **Revisions** tab shows what changed and who changed it.

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
with nothing filled in matches nothing. The group's **Selector** line counts
what is set, such as "2 roles · 1 type". To keep one matching device out,
add it through the API as a member with `excluded: true`.

The **Device role** and **Device type** kinds under **Add member** add to this
selector and switch it on; the fields already set stay, and the dialog names
the ones that narrow the match. Adding can also shrink the group: the fields
must all match, so the first role, or the first type, on a selector that
already matches on other fields drops every device it matches now that lacks
the new pick. The dialog warns when it will. Another role beside roles
already set, or another type beside types, only adds. A selector match counts
from the start of the period, not from when it was added, so a change also
moves last period's figure while that period is inside its seven days, for
devices that join and devices that leave. To count a device only from today,
add the device itself.

## Members

Add devices, virtual chassis, virtual machines, IP addresses, prefixes or
circuits on the **Members** tab. The chassis picker leaves out stacks with no
members. A prefix stands for the monitored addresses in it and in its
child prefixes. An address with no check is not counted, so adding a /16 does
not bring in thousands of unmeasured rows.

A **circuit** is measured on the addresses of the interfaces its ends are
cabled to, followed through patch panels. The far side of a circuit is the
provider's, so the trace stops at its ends. To measure it somewhere else, set
a **monitor address** when adding it: usually the provider's far-end gateway,
which is the address that proves the circuit carries traffic. A circuit with
no cable and no monitor address has no data.

Removing a member marks it as having left; it is not deleted. Periods it was
part of still count the time it was in. A member you cannot view cannot be
added.

### Members with no address {#members-with-no-address}

A member with no monitored address is **not measured**: its availability is
"No data" and its coverage 0 %. Its service time still counts, so the
agreement's coverage drops and *SLA coverage low* can fire. It is never
counted as down, whatever *unknown* and *stale* count as: it has no checks at
all, and it leaves the error budget alone. An agreement whose members are all
like this has no data.

### Switch stacks {#switch-stacks}

In a switch stack usually only the master has an address, so the other
members have nothing to be measured on. Danbyte counts such a stack once, as
its [virtual chassis](../dcim/virtual-chassis.md):

- **The address** - the primary address of the stack's master, or of its
  lowest member when no master is set: the member SNMP polls. When that
  device has no primary address, the first member by position that has one
  stands in. With **Every address** on the group, every address on every
  member counts.
- **When it counts once** - in a group, a stack's devices become one member
  when the chassis itself is a member, or when one of them has no address of
  its own (no primary address; no address at all for **Every address**). A
  stack whose members all have their own addresses, such as a firewall pair,
  stays one member per device.
- **One row** - named after the chassis, with the devices it stands for:
  "via sw1-2, sw1-3". Removing it removes the rows it stands for that are
  still in; rows that already left stay, with their history. A stack
  brought in by a selector stays until the selector stops matching. A device
  in the stack is never scored on its own address. To measure one as well, add its address as an IP address member.
  The same stack in two groups is two rows, like any member.
- **Selectors** - a selector that matches a stack's members brings the stack
  in once. Excluding the chassis in the group keeps the whole stack out;
  excluding one member device keeps out only that device.
- **Maintenance** - planned maintenance on the chassis, or on the member whose
  address is measured, excuses the stack. Work on another member does not.
- **Redundancy group** - the first one set on the chassis row, the master's
  row, the measured member's row, then the other members' rows by position.
  A master in a redundancy group keeps the stack in it.
- **Exclusions** - an exclusion on any of the stack's rows excuses the stack.
  A new one goes on a row that is still in, the chassis row or the master's
  first.
- **Membership as it is now** - chassis membership is read live, like a
  selector. The open period and a closed one still inside its seven days are
  recomputed with it; frozen periods keep their figures.

An agreement that already held stack members without addresses changes when
it is next computed. Where the member that is measured was already in it,
and no other row of the stack carries a different redundancy group,
availability stays the same: the others were never measured. A stack whose
measured member was not in the agreement is now measured, where before it had
no data. Coverage rises, and with **Average** the budget spent rises too: the
same downtime is now spread over fewer units. Without an *At risk below*
level the state can turn *At risk*, and burn alerts can fire, in the open
period.

### Resetting an address {#resetting-an-address}

When an address is reused for a new host, its
[availability can be reset](monitoring.md#excluding-an-address): the figures
count it from the reset, and what the old host did before it is kept but not
counted. A member whose addresses have all been reset in a period joins that
period at the (earliest) reset - as if it had been added then - so the time
before it is outside the member's service time rather than unmeasured, and
coverage stays whole. A member with only some addresses reset counts those
addresses from their reset and the others as usual.

A reset never reaches back into a period that had ended before it: a period
counts only the resets made from a moment before its end, so last month's
figure - and a report already sent for it - stays as it closed. A reset
backdated into a closed period does change it, while it is not yet frozen.

A reset recomputes the agreements it touches straight away (queued, rather
than on the next 15-minute tick): the open period, and the closed ones still
inside their seven days that ended after the reset. **Frozen periods never
change.** Because it rewrites figures, a reset that touches an active
agreement needs `slaagreement.change` on that agreement as well as
`ipaddress.change` on the address, and needs a reason; the agreement's
journal records the address, who, when and why. The address's own journal
says how many agreements it touched, not which - its readers may not be
allowed to see them.

**Redundancy group** is a label shared by members that back each other up,
such as a leaf pair. A redundancy group counts as one unit, and it is down only
while all of its members are down.

**Members combine as** decides how the units become the agreement's figure:

- **Average** - the time-weighted mean: total up time over total measured
  time.
- **Worst member** - the figure of the lowest unit.
- **All must be up** - the units are in series, like the parts of one
  service: it is down while any unit is down. Two units down on different
  days both count, where an average would halve them.

Together with redundancy groups, "all must be up" describes a service built
from parts. *Internet at Aarhus* is the carrier circuit, then a firewall pair:
add the circuit, add both firewalls with the redundancy group `fw`, and pick
**All must be up**. One firewall down costs nothing; the circuit down, or both
firewalls, is an outage. A viewer with a limited view of such an agreement
sees its worst visible unit, because the series needs every unit.

## The figure

These figures appear everywhere an agreement's figure is shown:

- **Availability** - up ÷ (up + down) within service hours, after exclusions.
- **Coverage** - measured time ÷ service time, shown beside a figure as
  "68% measured". Time with no check results counts as neither up nor down,
  so a high availability with low coverage was measured over only part of
  the period; treat it with care. The badge gets a dashed outline when coverage is
  under 90 %.
- **State**:
    - *On target*;
    - *At risk* - below *At risk below*, or, when that is empty, once three
      quarters of the error budget is spent;
    - *Breached* - below the target;
    - *No data*.
- **Error budget** - the downtime the target allows over the whole period,
  what has been spent, and what is left. With *Average* the spend is the mean
  downtime of the measured units; with *Worst member* it is the worst unit's
  downtime. Hours are real hours: a month with a daylight-saving change is an
  hour longer or shorter.
- **Burn rate** - budget spent ÷ share of the period elapsed. Above 1.0, the
  period ends over budget if nothing changes.
- **Forecast** - where the period ends if the rest of it goes like the last
  seven days: the figure so far and the last week's figure, weighted by how
  much of the period each covers. A bad start followed by a clean week
  forecasts better than the figure today; a fresh outage forecasts worse. It
  appears once a tenth of the period has passed, only while the period is
  open, and is coloured against the target like the figure.

### Latency objectives

A **latency objective** is a promise about speed, counted in probes: *99 % of
ICMP probes answered within 20 ms*. Add them under **Latency objectives** on
the form: a check kind, a time, and the share of probes that must make it. The
time is one of 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000 or 5000 ms.

Each objective has its own figure, error budget and state, like availability.
With 99 % over 1,000 probes, ten may be slow; five slow probes have spent half
the budget. It is *at risk* at three quarters spent and *breached* below the
target. Only probes that answered count: an unanswered probe is down time,
which availability already charges.

Objectives are measured over the whole period, every hour, not only in service
hours, because the latency counts are kept per hour and per day. The Overview
shows a card per objective under the headline, and the latency chart draws
each objective's time as an amber line, with the share within it on hover.

By default objectives never change the agreement's state: they are reported,
and a breached one sends its own alert. Tick **Objectives count in the
state** to make the agreement's state the worst of availability and its
objectives. The availability alerts still speak about availability.

The counts come from a histogram the rollups keep from 0.17 on. After an
upgrade, the rollup timer fills it in for the last 27 days by itself, a few
days per run, from the raw results; periods older than that show no data for
an objective.

**p95 latency alert** is the simpler, older setting: a p95 in milliseconds per
check kind over the period. Above it sends an alert and draws a red line in
the latency chart. It never changes availability or the state.

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
| **Availability over time** | Availability per day or hour against the dashed target line. While the window runs, the last bar is today (or this hour) in progress, drawn half filled | A day opens it by the hour: who was down, which check, the incidents, and down time per check type |
| **Error budget** | Budget spent so far (steps) against the pace that would spend it exactly by the period's end (dashed); the red line is the whole budget | - |
| **Where the down time went** | Down time and availability per member, check group, site or check type | A row narrows the whole page to it |
| **When outages happen** | Down time by weekday and hour, in the agreement's timezone. A nightly job or a Monday change window shows up as a stripe. Hover a cell for its down time | - |
| **Incident lengths** | Incidents by duration, and the mean time to recover | - |
| **Latency against objectives** | p95 and median per check type, the p95 alert as a red line and each latency objective's time as an amber one. Hover a point for the share within each objective | - |
| **Members by check** | One row per member, one column per check template: each check's availability in the window as a pill against the target. A member with several addresses on one template shows its worst | A pill opens that check, or the member panel when there are several |
| **Members over time** | One status strip per member across the window, so overlaps and redundancy show at a glance | A name opens the member panel |

The **member panel** shows one member for the window:

- its name, linked to the object's page, its check group, and for a stack
  the devices it stands for;
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
| **Latency objective breached** | A latency objective's share within its time is below its target for the period. |
| **p95 latency above the alert** | A check kind's p95 over the members' checks is above its **p95 latency alert** for the period. It never changes availability. |

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

## Service credits

A contract usually pays out when the figure misses. Under **Service credits**
on the form, add **tiers**: below an availability, the customer is owed a
share of the period's fee. With *below 99.9 % → 10 %* and *below 99.5 % →
25 %*, a month at 99.7 % owes 10 % and a month at 99 % owes 25 %: the lowest
tier met wins. Set **Fee per period** and **Currency** to see the credit as an
amount; without a fee it is a percentage.

The credit is worked out with the figure and stored with the period. Tiers,
fee and currency are revisioned like the counting rules, so a frozen period
keeps the credit it was priced under when the contract changes later. The
running period always follows the current rules.

The credit shows after the target on the Overview, in a **Credit** column on
the SLAs list once any agreement owes one, as a line in the PDF report and as
rows in its CSV, and per agreement with totals per currency in the
**Overview** report. It needs the **view credits** permission (see below). A
filtered analysis never shows one; a slice of a service is not what the
contract prices.

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
period freezes, seven days after it ends. That report is the whole agreement,
service credit included, so changing the recipients needs *view credits* and
a view of every member that is not limited to sites or by constraints. **Email report** sends it now,
either to those recipients or once to addresses you type in; a one-off
address is not saved on the agreement.

**Overview** on the SLAs list gives every agreement's figure for this or the
last period, as one PDF or CSV.

Reports follow the viewer's permissions like the figures do. A site-scoped
user's report leaves out the members they cannot see, and says so.

## On lists and object pages

The device, virtual chassis, virtual machine, IP address, prefix, circuit,
site and cluster lists have two columns:

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
  hours, 7/30/90 days, or month, quarter or year to date). Month, quarter and
  year to date start at midnight on the period's first day in the tenant's
  timezone. When part of the frame had no check results, the share that did
  follows the figure, as in "75.1% 68% measured". Unmeasured time counts as
  neither up nor down.

A device in a [switch stack](#switch-stacks) that counts once shows the
stack's figure, marked "via" the stack. A stack's **Availability** is over
every member's addresses.

A site's **SLA** is every agreement provided for that site, with the
agreement's whole figure; its **Availability** is over the site's devices. A
cluster's are over its hosts: the agreements its hosts are in, and their
checks. A circuit's availability is over the addresses its ends are cabled
to.

A provider's **Circuits** tab shows the same two columns, so each carrier's
circuits can be read against their agreements in one table. Sort by **SLA**
to put the worst first.

The **Monitoring** tab of a device, virtual chassis, virtual machine, IP
address or prefix opens with the agreements the object is in, and has an
**Add to SLA** button. A chassis's tab then names the member and address the
stack is measured on, with that member's checks. A
circuit's **Overview** has the same panel; a circuit added from there is
measured through its cables. It asks
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

A virtual chassis has no site of its own, so a stack is shown only to a
viewer who can view the chassis and the device that owns the stack (its
master, or lowest member); the stack is at that device's site. Adding one
needs the same, and a chassis with no members cannot be added.

Service credits need **view credits** on SLA agreements as well, and a
partial figure never carries one: part of a service can't price the whole
contract.

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
| `/api/monitoring/sla-members/` | Members; `POST …/bulk-add/` adds up to 1,000 at once; **Add to SLA** on a bigger selection sends it 1,000 at a time. A circuit takes `monitor_ip`; a stack is `object_type: api.virtualchassis`. A folded stack's row in the figures has `via` and `member_ids` |
| `/api/monitoring/sla-exclusions/` | Excluded time |
| `/api/monitoring/holiday-calendars/` | Shared holiday calendars. `dates` is a list of `{date, name, yearly}`, dated 1970-2099; a plain `YYYY-MM-DD` string is also accepted |
| `GET …/sla-agreements/<id>/report/?period=&file=pdf\|csv` | A period's report (`file`, not `format`, which the API keeps for itself) |
| `GET …/sla-agreements/<id>/analysis/?period=\|since=&until=&bucket=day\|hour&group=&site=&member=&kind=&redundancy=` | The analysis view's data, computed live, with `forecast` while the window runs |
| `POST …/sla-agreements/<id>/send-report/` | Email it now: `{period, recipients?}` |
| `GET …/sla-agreements/overview-report/?period=&file=` | Every agreement for one period |
| `POST /api/monitoring/sla-status/` | `{kind: device\|vm\|ip\|prefix\|circuit\|site\|cluster\|vc, ids, frame?}` → each object's agreements, strictest figure, and availability over the frame. `vc` also returns `measured`: the member and address that stand for the stack. A stack member's device lists the stack's figure with `via_stack` |
