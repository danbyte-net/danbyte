---
icon: lucide/activity
---

# Monitoring

Monitoring watches your IPs and prefixes and tells you whether they're up,
degraded, or down. You define **checks** — ICMP ping, TCP, UDP, HTTP(S), SNMP,
SSH, Telnet, or a script — attach them to an IP or a whole prefix, and Danbyte
runs them on a schedule, keeps the history, and shows live status everywhere it
matters: on detail pages, in list columns, and on a global Monitoring dashboard.

This page is organised by task. Jump to:

- [Set up a check](#set-up-a-check) — create one and attach it
- [Check types](#check-types) — the eight protocols and what each measures
- [Where checks apply (prefixes and inheritance)](#where-checks-apply)
- [Schedule modes](#schedule-modes) — when checks run
- [Reading results](#reading-results) — status, sparklines, history, uptime
- [Run a check now](#run-a-check-now)
- [The Monitoring dashboard](#the-monitoring-dashboard)
- [Alerts](#alerts) and [Notifications](#notifications)
- [Auto-discovery and cleanup](#auto-discovery-and-cleanup)
- [Settings reference](#settings)

!!! note "Works fully offline"
    Monitoring has no external dependencies and makes no calls to outside
    services. It runs in completely airgapped environments.

## Set up a check

Checks are created from a target's **Monitoring** section, and the same builder
works for both IPs and prefixes.

1. Open the IP or prefix detail page and go to its **Monitoring** tab.
2. Click **Add check** (on a prefix, **Add prefix check**).
3. Choose either:
   - **Use existing** — pick one of your saved check definitions, or
   - **New check** — define one from scratch (it's also saved for reuse).
4. Pick the **kind** (ICMP, TCP, HTTP, …). The form's fields change to match —
   for example a TCP check asks for a port, an ICMP check for a packet count.
5. Set the timing and credentials as needed (see [Check types](#check-types) and
   [Schedule modes](#schedule-modes)).
6. Save. The check appears in the Monitoring section and starts running on its
   schedule. Use **Check now** if you want a result immediately.

### Reusable check definitions

A check definition (for example *HTTP health on :8080* or *SSH reachability*) can
be attached to **many** IPs and prefixes. Edit the definition once and the change
takes effect everywhere it's used. Manage your library from the **Templates** tab
of the Monitoring dashboard — it lists each definition with its kind, interval,
and how many places use it, and warns you before deleting one that's still in use.

## Check types

Each check reports one of four states: **up**, **degraded** (reachable but
impaired), **down** (genuinely unreachable), or **unknown** (a configuration or
internal error — never treated as an outage).

| Kind | Up when… | Degraded when… | Credentials |
|---|---|---|---|
| **ICMP** (ping) | The host replies | Latency or loss crosses your threshold | — |
| **TCP** | The TCP connection succeeds | Connected, but the banner doesn't match | — |
| **UDP** | The probe gets the expected reply | A reply arrives but doesn't match | — |
| **HTTP(S)** | The status code (and optional body) match what you expect | Reachable, but the status or body is wrong | — |
| **SNMP** (v2c/v3) | The agent answers the requested value | The value fails your comparison | Community / v3 keys |
| **SSH** | Connects and authenticates (plus optional command checks) | Auth rejected, or a command check fails | Username + password or key |
| **Telnet** | Connects (and optional banner matches) | The banner doesn't match | — |
| **Script / exec** | A local plugin exits `0` | The plugin exits `1` (warning) | — |

!!! tip "`unknown` is not `down`"
    If a check is misconfigured — bad parameters, missing privilege, an
    unexpected error — it reports **unknown**, and that never flips a known-good
    status to down. Misconfiguration won't masquerade as an outage.

### HTTP checks are pinned to the target

An HTTP check always connects to the IP it's assigned to — you choose the scheme,
port, and path, and optionally a `Host` header to set the virtual host, but it
will never be redirected to dial some arbitrary hostname.

### Credentials are encrypted and write-only

SNMP communities, SSH passwords and keys, and SNMP v3 keys are stored encrypted
at rest. You can set them, but they're **never** shown again or returned through
the API — the UI only tells you whether a credential is saved.

### Script and exec checks

Two options let you monitor anything that can express its health as an exit
code — handy when a plain port or HTTP probe can't capture the real condition.

**SSH script** — the SSH check can run a command (or a multi-line script) on the
target and judge it by exit code and/or an output pattern. For example, to alert
when nginx isn't running on a host:

| Field | Value |
|---|---|
| Kind | SSH |
| Username / Password (or key) | `monitor` / … *(encrypted)* |
| Script | `systemctl is-active --quiet nginx && echo OK` |
| Expected exit code | `0` |
| Expect output (regex, optional) | `^OK$` |

Exit `0` → **up**; nginx stopped → non-zero exit → **degraded** (the host is
reachable, only the service is down); a refused or timed-out SSH connection →
**down**.

**Local exec (Nagios-plugin style)** — runs a vetted plugin on the worker and
maps its exit code:

| Exit code | Meaning | Status |
|---|---|---|
| `0` | OK | up |
| `1` | Warning | degraded |
| `2` | Critical | down |
| `3` / other | Unknown | unknown |

The plugin's first line of output becomes the result message (e.g. `OK - 12ms`).

!!! warning "Exec checks are off by default"
    Running local commands from a web UI is a powerful capability, so it's
    disabled out of the box. An administrator must place the approved plugins in a
    directory and enable the feature in the worker's environment (see
    [Settings](#settings)). Checks then reference a plugin by its bare name plus
    arguments — use `{host}` where the target IP belongs. Arguments are passed
    directly (no shell), and the plugin must live inside the approved directory.

    *Example — HTTP health via the standard `check_http` plugin:*

    | Field | Value |
    |---|---|
    | Kind | Script / exec |
    | Plugin name | `check_http` |
    | Arguments | `-H {host} -u /health -w 1 -c 3` |

## Where checks apply

You can attach a check directly to an IP, or to a prefix.

- A check on a **prefix** applies to every IP inside it (when **Apply to
  children** is on). You can **exclude** specific IPs from a prefix check.
- A check on an **IP directly** is more specific than one inherited from a prefix.
- **Most specific wins.** If both a prefix check and a direct IP check exist for
  the same definition, the IP-level one takes over. Turning a check off on a
  single IP cancels the inherited one for that IP.

So you can monitor a whole subnet with one prefix check, then fine-tune
individual hosts without touching the rest.

### Inherited checks on an IP

On an IP's Monitoring tab, checks inherited from a parent prefix are marked as
inherited and can't be edited or removed there — edit the parent prefix instead
(the IP view links to it).

### Per-check overrides

Without forking a shared definition, you can override individual settings on a
single assignment — expand the check's row on the Monitoring tab to adjust:

- **Enabled** — keep the assignment but stop it running.
- **Schedule mode** — Follow global / Always on / Off.
- **Interval, rise, fall** — leave blank to inherit the definition's defaults.
- **Exclusions** (prefix checks) — tick the IPs to exempt.

## Schedule modes

Danbyte runs checks automatically in the background; you don't run a separate
scheduler. Each check resolves how often it runs from its own interval and a
**schedule mode**:

| Mode | Behaviour |
|---|---|
| **Follow global** | Runs (or pauses) according to the tenant's global monitoring switch and default interval. |
| **Always on** | Runs regardless of the global switch. |
| **Off** | Doesn't run. |

The global switch and default interval live in the Monitoring settings (see
[The Monitoring dashboard](#the-monitoring-dashboard)).

### Check frequency

How often a policy-driven check runs resolves in two levels:

1. **Global default** — the *Default check interval* in Monitoring settings.
   Every policy-based check uses this unless something more specific overrides
   it.
2. **Per-scope override** — on **Monitoring → Configuration**, each row
   (prefix, device, device type, device role) has a **Frequency** picker in its
   policy menu. Pick *Follow global default* to inherit, or a concrete cadence
   (1 min … daily) to override. The **most-specific** scope that sets one wins —
   a prefix beats its VRF beats global — so you can make one busy subnet poll
   every minute while everything else follows the default.

The chosen cadence shows on the policy button (e.g. `2 items · 15m`). Overrides
take effect on the next materialisation pass (within a minute or two), not
instantly. Hand-attached checks (the *Add check* flow on an IP or prefix) keep
their own per-check interval and schedule mode instead — see
[Per-check overrides](#per-check-overrides).

### Monitoring devices, types, and roles

Checks always run against **IP addresses**, so a device (or every device of a
type/role) is monitored through *its IPs*. On **Monitoring → Configuration**,
the Devices / Device types / Device roles tabs each carry the same policy
controls plus an **Apply to** target that picks which of the device's IPs the
checks cover:

| Apply to | Runs against |
|---|---|
| **All IPs** (default) | every IP assigned to the device |
| **Interface IPs** | IPs bound to one of the device's interfaces |
| **Primary IP** | the device's designated primary IP |
| **OOB / management IP** | the device's out-of-band IP |

A device-type or device-role policy applies the same target to *every* matching
device. The most-specific scope wins (a per-device policy beats the device's
type/role).

**Turning *Monitor* on with no profiles/templates selected monitors basic
reachability** — the policy falls back to a default ICMP *Reachability (ping)*
check (the policy button shows **Ping**), so the toggle always produces
something. Attach profiles or templates to check more than reachability. A
policy left on **Follow global** contributes nothing of its own — it just rides
the broader-scope (global/VRF/prefix) policies — so it never adds a stray ping.
A device with no IPs (or no primary/OOB when that target is chosen) still has
nothing to check. Matching checks ("services") are created on the next
materialisation pass (within a minute or two) and appear on each IP's
**Monitoring** tab tagged **from policy**.

### Monitoring a service

A **Service** (a device/VM's name + protocol + ports — e.g. "HTTPS · TCP 443")
carries a **Monitored** flag. Turn it on from the device's **Services** tab and
each port is watched by a TCP/UDP check against the service's target IP (its own
IP, else the parent's primary IP). The row's **Monitoring** badge reflects the
live state — *Monitored* (green) once checks are scheduled, *No IP* (amber) if
the flag is on but no target IP exists yet (it activates automatically when one
appears).

To watch a service across a whole fleet, define it once on the **device type**
(Device type → Components → **Services**) and tick **Monitor**. Every device
created from that type is then born with the service and, if monitored, starts
checking as soon as it has an IP. This is the smart, low-maintenance path — no
per-device clicking. Full design: [service
monitoring](../architecture/service-monitoring.md).

### How status changes settle (hysteresis)

To avoid flapping on a single blip, status changes require a streak:

- A check goes **up** only after a number of consecutive successes (the **rise**
  count), and **down** only after a number of consecutive failures (the **fall**
  count).
- **Degraded** shows immediately when a host is reachable-but-impaired — it
  doesn't wait out the rise count.
- **Stale** — a check that's been down for a long time (a configurable number of
  consecutive failures, or a number of days) is escalated to *stale* to mark a
  chronic outage versus a fresh one.
- **Skipped** — IPs whose status is on your skip list (for example *reserved*)
  are never dialled; their checks are marked *skipped* and no result is recorded.

Every status change is logged so you get a history timeline and can drive
notifications.

## Reading results

### On an IP

The IP detail page has a **Monitoring** section with one row per check showing:

- A status badge — up / down / degraded / unknown.
- The check name and kind.
- An inline **sparkline** of recent latency/status.
- The last latency and last-run time.

Expand a row to see its recent **history** table. When an IP has several checks
with **different** results (one down while others are up), the badge becomes a
**split badge** — coloured segments sized by how many checks are in each state,
with a hover breakdown — rather than collapsing to just the worst one.

### On a prefix

The prefix Monitoring tab shows:

- A **roll-up** badge and breakdown (e.g. `2 down · 1 up`) across the prefix's
  IPs, worst status winning.
- The **prefix-level checks**, each with Apply-to-children, schedule-mode, and
  excluded-count controls.
- A **per-IP status grid** linking to each monitored child IP.

### On a device

Checks attach to IPs, not to devices — but the device page rolls them up for
you in three places:

- A **roll-up badge** in the device header, next to the status badge (the same
  mixed-status badge as the list column).
- The **IPs tab** has a **Monitoring** column showing each IP's status badge.
- The **Overview** has a **Monitoring** summary: the roll-up badge + breakdown
  across every IP assigned to the device (worst status winning) and a per-IP
  status grid linking to each monitored IP.

Because a service's check lives on the service's IP, service monitoring rolls
up here too. The summary only appears when the device has at least one
monitored IP. Manage the actual checks on each IP's Monitoring section.

### In list pages

The Prefixes list and the Devices list each carry a **Monitoring** column
showing the row's worst-status badge with a tooltip breakdown (a device rolls
up across its assigned IPs), so you can scan health across many subnets or
devices at a glance.

### Uptime / SLA

The IP Monitoring tab includes an **Uptime (SLA)** card with a window selector
(24h / 7d / 30d / 90d). Availability is **time-weighted** — measured from how long
the IP spent in each state, not raw sample counts — so a slow check interval
doesn't skew the number. Time spent in *unknown* or *skipped* is excluded from the
calculation and reported separately, so a check that simply wasn't running can't
read as 100% uptime. The card also shows the number of **incidents** in the window
and the **mean time to recovery (MTTR)**.

## Run a check now

Anywhere checks are listed you can force an immediate run instead of waiting for
the schedule:

- **Check now** on an IP or prefix runs its checks right away and refreshes in
  place.
- The **Prefixes** and **IPs** list pages have a bulk **Check now** action — select
  rows, and Danbyte re-checks every selected IP (and every IP in selected
  prefixes), with a live progress bar.

A manual check rolls into the same state machine as a scheduled one — it advances
the rise/fall counters, can move the status, logs the change, and fires alerts
exactly like an automatic scan.

!!! tip "Large prefixes are fast"
    Sweeping a very large prefix (a `/16` is ~65,000 hosts) completes in seconds,
    not minutes — ICMP sweeps are batched and run with high concurrency, and big
    target sets are split across background workers that run in parallel.

## The Monitoring dashboard

**Governance → Monitoring** is the global view. It has three tabs:

- **Overview** — stat cards (total checks, monitored IPs, definitions, alert
  channels), charts (status distribution, checks by type, results over the last
  24 hours), recent status changes, a **flapping** card (see below), and the
  monitoring settings.
- **Checks** — a global list of every check with quick-filter tabs (All / Up /
  Degraded / Down / Stale / Skipped / Unknown, each with a count), search, and
  paging. Each row links to its IP.
- **Templates** — your reusable check library.

### Settings on the dashboard

The Overview tab (also reachable from **Settings → Monitoring**) is where you set
the per-tenant monitoring options:

| Setting | What it controls |
|---|---|
| **Global schedule switch** | Master on/off for checks in *Follow global* mode. |
| **Default interval** | How often *Follow global* checks run. |
| **Stale thresholds** | After how many consecutive failures, or how many days, a down check becomes *stale*. |
| **Skip statuses** | IP statuses whose IPs should never be checked. |
| **Reverse-DNS sync** | Keep IPs' DNS names current automatically (see below). |
| **Discovery & cleanup** | Auto-discovery and stale-IP cleanup options (see below). |

### Flapping monitor

The Overview tab has a **flapping** card that proactively surfaces IPs bouncing
between states a lot — "this host is flapping, maybe go look at it" — ranked by how
noisy each one is, regardless of whether it's currently up or down. To keep
expected churn out of the list you can exclude whole IP statuses (the DHCP-scope
escape hatch, in settings) or flip an **Ignore flapping** toggle on a single
known-noisy IP. It only raises visibility — it doesn't page anyone.

### Reverse-DNS enrichment

With **Sync reverse DNS** turned on, each time an IP is checked Danbyte looks up
its PTR record and writes the hostname to the IP's DNS name field. Two options
handle the no-result case: keep the existing name when a lookup fails but the host
is up (so a transient DNS blip doesn't wipe a name off a live host), or clear the
name when a lookup returns nothing.

## Alerts

Status changes are turned into stateful **alerts** — incidents you can see and act
on, not just a stream of changes. Manage them under **Governance → Alerts**.

- A change into a bad state opens **one** firing alert per condition (down/stale →
  critical, degraded → warning); a recovery or skip resolves it. *Unknown* never
  opens an alert.
- The **Alerts** page lists firing and resolved alerts with their severity,
  target, the bad status, when they opened, and how long they've been firing.
  Filter by status and severity; the list auto-refreshes.

### Alert rules

The **Rules** tab decides which failures alert and at what severity. Each rule
matches on check kinds, trigger statuses (down / stale / degraded), IP tags, and
an optional prefix (all ANDed together) and assigns a severity. A failing check is
matched against your enabled rules in priority order, and the first match sets the
severity. With **no rules**, a sensible default applies (down/stale → critical,
degraded → warning), so alerting works out of the box.

### Acknowledge an alert

You can **acknowledge** a firing alert so the team knows someone owns it (with an
optional note). The alert keeps firing, but acknowledging it records who and when —
and **stops reminder notifications** (see below).

### Silences and maintenance windows

A **silence** mutes notifications for matching alerts during a time window.
Matchers mirror alert rules (kinds, statuses, IP tags, a prefix, plus an optional
single IP — all empty means a blanket silence). While a silence is active, alerts
still open and are tracked, but no notification is sent. A silence scheduled for
the future is effectively a **maintenance window**. Manage these under **Alerts →
Silences**; silenced alerts are flagged in the list.

### Renotify, escalation, grouping, flap dampening

These time-based policies are **per-tenant** and **off by default** (except
grouping), and all of them respect acknowledgement and silences:

- **Grouping** (on by default) — when one event opens many alerts at once (a switch
  dies, taking 50 IPs down), they're coalesced into a single digest per channel
  instead of a storm of messages.
- **Renotify** — re-sends a reminder for an alert that's still firing, unacked, and
  un-silenced after a configurable interval. Acknowledging or silencing stops the
  reminders.
- **Escalation** — an alert left firing and unacknowledged past a deadline is
  bumped to *critical* and re-notified.
- **Flap dampening** — an alert whose condition keeps reopening is marked
  *flapping* and excluded from reminders until it settles, so a flapping host can't
  page on a loop.

The Alerts table surfaces *escalated*, *flapping*, *silenced*, and *ack* chips, and
tracks how many times each alert has notified.

## Notifications

When an alert opens, escalates, or resolves, Danbyte routes it to your enabled
**notification channels**. Manage them under **Alerts → Channels**; each has a
**Send test** action. Every channel applies two gates before it fires:

- **Minimum severity** — alerts below the channel's threshold are skipped.
- **On statuses** — an optional allow-list of check statuses; empty means any bad
  status.

Supported channels:

| Channel | You provide | Notes |
|---|---|---|
| **Slack / Teams / Discord** | An incoming-webhook URL | Posts the alert summary with a deep link. |
| **PagerDuty** | A routing key | Triggers on fire, resolves on clear; deduplicated per condition. |
| **Webhook** | A URL | POSTs the alert as JSON to your own endpoint. |
| **Email** | Recipient addresses | Sent via the deployment mail server (below). |

Notifications are best-effort: a failing channel is logged and never breaks a
check run. When a **public base URL** is configured (see below), messages include
a clickable link straight back to the alert.

### Email and outbound delivery (deployment-wide)

Mail server and outbound options are a **single deployment-wide setting**, edited
under **Settings → Email & Delivery** by an administrator (users with the manage
permission). Email channels all deliver through this one server.

| Setting | What it controls |
|---|---|
| **Email enabled** | Master switch for email channels. |
| **SMTP host / port / security** | The mail server and `none` / `starttls` / `ssl`. |
| **SMTP username / password** | Auth (the password is encrypted at rest and write-only). |
| **From address** | The From header on alert emails. |
| **Public base URL** | Adds clickable links to alerts in Slack/Teams/email/PagerDuty messages. |
| **Webhook timeout** | How long to wait for outbound webhook POSTs. |
| **Outbound proxy** | Optional HTTP(S) proxy for outbound webhooks. |

A **Send test email** action confirms the mail settings work.

## Auto-discovery and cleanup

Two **opt-in** background jobs manage the IP lifecycle of monitored subnets. Both
default off and are controlled from **Monitoring → Settings**.

### Discovery

When enabled, Danbyte periodically ICMP-sweeps the prefixes you've enrolled and
records the responders it finds as new IPs.

- **What's enrolled:** either *every* prefix (a global "discover everything"
  switch), or each prefix you flag **Auto-discover** plus its descendant prefixes
  in the same VRF — so flagging a parent subnet enrols all its children.
- **New IPs** are created with a tenant-specific **Auto-discovered** status (amber,
  not "available") so a human has to review and promote them — discovery never
  silently marks hosts active. In keeping with zero-pre-filled-data, that status
  isn't seeded at install; it's created the first time a responder is found, as a
  normal editable status you own.
- **Guards:** IPv4 only, and prefixes larger than a configurable minimum length
  (default /22) are skipped, so nobody accidentally sweeps a huge range.

**Controls:** each prefix has an **Auto-discover** toggle and a **Discover now**
button (on its detail header and Monitoring tab). Small prefixes scan instantly;
large ones run in the background with a live progress bar, and discovered IPs
appear in the table as they're found. The Prefixes list bulk bar also offers
**Auto-discover on/off**, **Discover now**, and **Check now** over the selection.

### Stale cleanup

When enabled, **discovered** IPs that have been unreachable longer than a
configurable number of days are deleted automatically.

!!! warning "Only auto-discovered IPs are ever deleted"
    Cleanup only touches IPs that Danbyte discovered itself. IPs you created by
    hand are **never** deleted by cleanup — the discovered flag is the safety
    boundary between "the tool made this" and "a person entered this".

## Settings

Most day-to-day options live in the per-tenant settings on the Monitoring
dashboard. A few deployment-level options (concurrency limits, the secret key for
credential encryption, default global interval and switch, exec-check enablement
and plugin directory, retention windows) are set by an administrator — see
[Reference → Settings](../reference/settings.md#monitoring).

Check history is high-volume (hundreds of thousands of raw results per day on a
busy install), so Danbyte automatically prunes old results (default **30 days**,
`MONITORING_RESULT_RETENTION_DAYS`) and old status-change records (default 365
days, kept longer as an audit timeline) on a schedule. The rolled-up per-check
state and the status-change timeline carry the long-term story; raw results only
need to cover the sparkline/history windows.

## Email digest

A scheduled summary email of the monitoring picture — a lightweight status
report (like ping-monitor "digest" mails) delivered on your cadence rather than
alert-by-alert. Each digest covers, per tenant: check counts by status (up /
down / degraded / stale) with a reachable %, currently-firing alerts by
severity, recent status changes in the window, and a count of configuration
changes.

Configure it under **Settings → Deployment → General → Email digest**
(deployment-wide default) — enable it, choose **daily** or **weekly** (with a
weekday), and set the **recipients** (comma/newline-separated). A tenant can
override the whole group (schedule + recipients) via its own settings, so an MSP
sends each customer their own digest. Use **Send test digest** to email one
immediately for the active tenant.

Delivery uses the same effective SMTP cascade as every other email
(tenant/site override → deployment relay), and the message is sent as a branded
HTML email with a plain-text fallback. Sending is driven by a daily systemd
timer (`danbyte-digest`) → `manage.py send_digest`, which gates each tenant on
its frequency, weekday, and last-sent date; nothing is sent twice in a day. Send
one by hand with:

```bash
.venv/bin/python manage.py send_digest --tenant <slug> --force
```
