---
icon: lucide/activity
---

# Monitoring

Monitoring watches your IPs and prefixes and tells you whether they're up,
degraded, or down. You define **checks** - ICMP ping, TCP, UDP, HTTP(S), SNMP,
SSH, Telnet, a TLS certificate read, or a script - attach them to an IP or a
whole prefix, and Danbyte runs them on a schedule, keeps the history, and shows
live status everywhere it matters: on detail pages, in list columns, and on a
global Monitoring dashboard.

This page is organised by task. Jump to:

- [Set up a check](#set-up-a-check) - create one and attach it
- [Check types](#check-types) - the protocols and what each measures
- [Where checks apply (prefixes and inheritance)](#where-checks-apply)
- [Schedule modes](#schedule-modes) - when checks run
- [Reading results](#reading-results) - status, sparklines, history, uptime, the history API
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
   - **Use existing** - pick one of your saved check definitions, or
   - **New check** - define one from scratch (it's also saved for reuse).
4. Pick the **kind** (ICMP, TCP, HTTP, …). The form's fields change to match -
   for example a TCP check asks for a port, an ICMP check for a packet count.
5. Set the timing and credentials as needed (see [Check types](#check-types) and
   [Schedule modes](#schedule-modes)).
6. Save. The check appears in the Monitoring section and is scheduled at once
   - a check on an address runs on the next dispatch (or, on the fast lane,
   within about ten seconds); a check on a prefix is spread over its
   addresses by the materialise pass, which runs every five minutes. Use
   **Check now** if you want a result immediately.

### Reusable check definitions

A check definition (for example *HTTP health on :8080* or *SSH reachability*) can
be attached to **many** IPs and prefixes. Edit the definition once and the change
takes effect everywhere it's used. Manage your library from the **Templates** tab
of the Monitoring dashboard - it lists each definition with its kind, interval,
and how many places use it, and warns you before deleting one that's still in use.

## Check types

Each check reports one of four states: **up**, **degraded** (reachable but
impaired), **down** (genuinely unreachable), or **unknown** (a configuration or
internal error - never treated as an outage).

| Kind | Up when… | Degraded when… | Credentials |
|---|---|---|---|
| **ICMP** (ping) | The host replies | Latency or loss crosses your threshold | - |
| **TCP** | The TCP connection succeeds | Connected, but the banner doesn't match | - |
| **UDP** | The probe gets the expected reply | A reply arrives but doesn't match | - |
| **HTTP(S)** | The status code (and optional body) match what you expect | Reachable, but the status or body is wrong | - |
| **SNMP** (v2c/v3) | The agent answers the requested value | The value fails your comparison | Community / v3 keys |
| **SSH** | Connects and authenticates (plus optional command checks) | Auth rejected, or a command check fails | Username + password or key |
| **Telnet** | Connects (and optional banner matches) | The banner doesn't match | - |
| **Script / exec** | A local plugin exits `0` | The plugin exits `1` (warning) | - |
| **TLS certificate** | The presented chain verifies and is inside its validity window | Reachable, but the certificate is untrusted, self-signed, or expired | - |

!!! tip "`unknown` is not `down`"
    If a check is misconfigured - bad parameters, missing privilege, an
    unexpected error - it reports **unknown**, and that never flips a known-good
    status to down. Misconfiguration won't masquerade as an outage.

### TLS certificate checks

The **TLS certificate** kind reads the certificate chain an endpoint presents
and files it in the [certificate inventory](../monitoring/certificates.md) -
expiry, issuer, SANs, key strength, self-signed and trust flags. It stores
**public certificate data only and never a private key**, and reads an
untrusted certificate without weakening verification anywhere.

Each read also records a **binding** - which endpoint served which certificate -
so "what breaks when this expires" is answerable, and endpoints inside the
warning window raise ordinary alerts through this same engine. See that page for
the full field list, the trust rules, and the expiry thresholds.

### HTTP checks are pinned to the target

An HTTP check always connects to the IP it's assigned to - you choose the scheme,
port, and path, and optionally a `Host` header to set the virtual host, but it
will never be redirected to dial some arbitrary hostname.

### Credentials are encrypted and write-only

SNMP communities, SSH passwords and keys, and SNMP v3 keys are stored encrypted
at rest. You can set them, but they're **never** shown again or returned through
the API - the UI only tells you whether a credential is saved.

### Script and exec checks

Two options let you monitor anything that can express its health as an exit
code - handy when a plain port or HTTP probe can't capture the real condition.

**SSH script** - the SSH check can run a command (or a multi-line script) on the
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

**Local exec (Nagios-plugin style)** - runs a vetted plugin on the worker and
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
    arguments - use `{host}` where the target IP belongs. Arguments are passed
    directly (no shell), and the plugin must live inside the approved directory.

    *Example - HTTP health via the standard `check_http` plugin:*

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
inherited and can't be edited or removed there - edit the parent prefix instead
(the IP view links to it).

### Per-check overrides

Without forking a shared definition, you can override individual settings on a
single assignment - expand the check's row on the Monitoring tab to adjust:

- **Enabled** - keep the assignment but stop it running.
- **Schedule mode** - Follow global / Always on / Off.
- **Interval, rise, fall** - leave blank to inherit the definition's defaults.
- **Exclusions** (prefix checks) - tick the IPs to exempt.

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

1. **Global default** - the *Default check interval* in Monitoring settings.
   Every policy-based check uses this unless something more specific overrides
   it.
2. **Per-scope override** - on **Monitoring → Configuration**, each row
   (prefix, device, device type, device role) has a **Frequency** picker in its
   policy menu. Pick *Follow global default* to inherit, or a concrete cadence
   (1 min … daily) to override. The **most-specific** scope that sets one wins -
   a prefix beats its VRF beats global - so you can make one busy subnet poll
   every minute while everything else follows the default.

The chosen cadence shows on the policy button (e.g. `2 items · 15m`). Overrides
take effect on the next materialisation pass (within a minute or two), not
instantly. Hand-attached checks (the *Add check* flow on an IP or prefix) keep
their own per-check interval and schedule mode instead - see
[Per-check overrides](#per-check-overrides).

### Sub-minute checks - the fast lane {#fast-lane}

The minute beat cannot run anything faster than a minute, and every run it
records is a row. For the handful of things that matter more than that - a
core switch, an uplink, a firewall pair - a check can run **every 200 ms to
30 s** instead. Pick a sub-minute interval on the check (the *Interval*
picker on a check definition or in *Add check*) and it moves to the **fast
lane**: one long-lived process (`danbyte-fastlane`) that probes from an
in-memory schedule, on the core for checks the core runs and inside the
Outpost for checks an Outpost runs.

What reaches the database is what matters:

- a **status change** is recorded the moment it happens - the probe that
  caused it, the change, and everything a change sets off (alerts,
  notifications, history, flapping) exactly as on the minute beat;
- everything else is **downsampled**: one aggregated result per **Record
  every** (default 60 s, 5 s at the least) carrying the window's min,
  average and max latency and its packet loss. A one-second ping therefore
  costs the database what a sixty-second one does, while an outage is seen
  in *interval × fall* - three seconds for a 1 s check with the default
  fall of 3. The individual probes are not stored; the IP's Monitoring tab
  shows the last ten minutes of them while it is open (see [On an
  IP](#on-an-ip)).

Rise and fall mean what they always meant; they simply add up faster.
*Stale after N scans* counts scans at the check's normal cadence rather
than probes, so ten failed one-second probes is not "stale" - ten failed
minutes is.

The floors are 200 ms for ICMP and 1 s for anything that opens a
connection; a timeout longer than the interval is brought down to it.
**Sub-minute checks** in the monitoring settings caps how many the lane runs
for the tenant (500 by default; 0 turns it off) - the rest, and every fast
check whenever the lane is not running, run on the minute beat at the
check's ordinary interval, which is why a fast check still carries one. The
Overview shows the lane's checks and probes per second, and the red strip
at the top says when the lane is down while fast checks exist.

An Outpost runs the same loop for the fast checks bound to it: it pulls
its set, probes it locally, and reports buffered probes every poll - or at
once when a probe's reachability differs from the last one - and the core
applies the same rise and fall to them it applies to its own. An Outpost
older than 0.8 does not know the lane; its fast checks simply run at the
ordinary interval until it is upgraded.

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
device.

Scopes run loosest to tightest - **region**, **site**, VRF, prefix,
**platform**, device type, device role, device - each inheriting from the ones
above it, and the most specific one wins:

| Scope | Matches |
|---|---|
| **Region** | Every address at a site in that region, **or in any region below it** - a policy on *Europe* reaches a site in *Amsterdam*. |
| **Site** | Every address at that site, including ones with no device on them. |
| **Platform** | Every device running it. Broader than a device type, since one platform spans many models. |

Region and site honour the **target** selector too, so "the primary IP of
everything at this site" is one setting - but unlike the device-shaped scopes
they also reach addresses with no device at all, because those are still at the
site.

The tab is part of the address - `?view=configuration&scope=platforms` - so a
link to one scope's policies is something you can hand somebody, and a reload
lands where it was.

### Narrowing a policy

A scope answers *which* objects; **filters** answer *which of them*. Every
policy carries two, both empty by default:

| Filter | Effect |
|---|---|
| **Name** | A glob the device name must match - `core-*`, `*-fw??`. Case-insensitive. |
| **Interface** | A glob the address's interface must match - `Gi0/0/*`. Reads the *port*, not the device, so "only the uplinks" is one setting. An address bound to no interface never matches it. |
| **Tags** | Every tag listed must be on the device. Several tags means all of them, not any. |
| **Hardware** | A glob at least one of the device's inventory items or installed modules must match, by name or part number - `*PSU*`, `C9300-NM-*`. This is how a policy says *has this hardware, add that sensor*. Case-insensitive. |

They **narrow**, never widen: a filter can only stop a policy applying, never
add a check and never disable one a looser policy already added. That is why
they are filters rather than scopes - a ladder would need an answer to "is a
tag more specific than a role", and nobody can predict that one.

Name and tags read the **device**, so a policy filtered on either does not
reach an address with nothing on it; the interface filter reads the address's
own port. Narrower is the safe direction for a rule that can only add
monitoring.

!!! warning "A prefix policy competes by its mask length"
    Scopes are ranked on one scale, and a **prefix** policy takes its rank from
    the prefix's **mask length** rather than a fixed position. So a `/24`
    prefix policy outranks a device-role policy, while a `/8` one is outranked
    by a VRF policy. If two policies could both apply to an address and one is
    prefix-scoped, check the mask before assuming which wins - and prefer a
    per-device policy when you want certainty, since only a `/128` reaches that
    high. Region and site sit deliberately below any realistic mask, so they
    never collide.

**Turning *Monitor* on with no profiles/templates selected monitors basic
reachability** - the policy falls back to a default ICMP *Reachability (ping)*
check (the policy button shows **Ping**), so the toggle always produces
something. Attach profiles or templates to check more than reachability. A
policy left on **Follow global** contributes nothing of its own - it just rides
the broader-scope (global/VRF/prefix) policies - so it never adds a stray ping.
A device with no IPs (or no primary/OOB when that target is chosen) still has
nothing to check. Matching checks ("services") are created on the next
materialisation pass (within a minute or two) and appear on each IP's
**Monitoring** tab tagged **from policy**.

### Monitoring a service

A **Service** (a device/VM's name + its ports - e.g. "HTTPS · TCP 443", or
"DNS · TCP 53 · UDP 53") carries a **Monitored** flag. Turn it on from the
device's **Services** tab and each port is watched against the service's target
IP (its own IP, else the parent's primary IP) **with that port's own protocol**
- so a DNS service raises a TCP check on 53 and a UDP check on 53. The row's **Monitoring** badge reflects the
live state - *Monitored* (green) once checks are scheduled, *No IP* (amber) if
the flag is on but no target IP exists yet (it activates automatically when one
appears).

To watch a service across a whole fleet, define it once on the **device type**
(Device type → Components → **Services**) and tick **Monitor**. Every device
created from that type is then born with the service and, if monitored, starts
checking as soon as it has an IP. This is the smart, low-maintenance path - no
per-device clicking. Full design: [service
monitoring](../architecture/service-monitoring.md).

### How status changes settle (hysteresis)

To avoid flapping on a single blip, status changes require a streak:

- A check goes **up** only after a number of consecutive successes (the **rise**
  count), and **down** only after a number of consecutive failures (the **fall**
  count).
- **Degraded** shows immediately when a host is reachable-but-impaired - it
  doesn't wait out the rise count.
- **Stale** - a check that's been down for a long time (a configurable number of
  consecutive failures, or a number of days) is escalated to *stale* to mark a
  chronic outage versus a fresh one.
- **Skipped** - IPs whose status is on your skip list (for example *reserved*)
  are never dialled; their checks are marked *skipped* and no result is recorded.

Every status change is logged so you get a history timeline and can drive
notifications.

### Calling the states what you call them

The six states are the machine's vocabulary. Yours may differ - plenty of NOCs
say *Critical* rather than *Down*, and the shipped red is not everybody's red.
A [status](catalogs-and-settings.md#naming-a-monitoring-check-state) can speak
for a check state: tick the box, pick the state, and that status's name and
colour take over every monitoring surface - badges, split badges, the filter
rail, the dashboard charts. One status per state, and the stored value is
still the state, so alert rules and webhooks are untouched.

## Reading results

Every result and every status change records **who answered**: Danbyte's own
workers, an Outpost by name, or Zabbix. It is the engine that *ran* the check,
not the one the target is bound to - a ping on a device bound to Zabbix is run
by Danbyte and says so. The Checks list shows it as a **Source** column and
filters on it (`?source=local|outpost|zabbix`, `?engine=<id>`), and the check
history and recent-changes lists carry it per row. Rows written before this
was tracked have no engine and show as *Local*.

### On an IP

The IP detail page's **Monitoring** tab reads top to bottom as *now → other
systems → over time*, three sections in the same frame: **Checks**, **Zabbix**
(only when the address's device is a Zabbix host) and **History**.

The tab is **live**: while it is open, every result the workers or the fast
lane write for the address is pushed to it over a WebSocket (`/ws/monitoring/`)
- the pill, latency and *last checked* move on their own, the fast lane's
probes every second, and a status change re-reads the strips, bars and
history. A *Live* badge beside the section title says the socket is up;
without one (no WebSocket process, a proxy that drops it) the tab polls
every 15 seconds instead. Only addresses somebody is looking at are pushed:
a page registers interest for its address and the writers check it first,
so an estate with nobody watching costs nothing.

**Checks** is one row per check: the status pill, the name and kind (with
*inherited* or *from policy* as muted text when the check is not the
address's own), a *Fast* badge for a sub-minute check, a *Flapping* pill when
it is flagged, the last seven days as a **status strip** drawn to scale (an
outage two days ago is a red block two days back; hover a block for its
state and length, click it for its exact bounds, the status change that
started it and the alerts that were open while it lasted), the last
latency and when it last ran. When the
checks disagree (one down while others are up), the section's badge is a
**split badge** - coloured segments sized by how many checks are in each
state - rather than just the worst one.

Every row opens: the check's **latency over time** (24h / 7d / 30d - the
average as a line, each bucket's min–max as a band, packet loss as bars on
its own axis; a fast-lane check's windows carry their own min, max and loss,
so a one-second ping and a five-minute one draw the same way), the
per-check overrides, and its recent recorded results. A result row opens
too: a plain one shows what the checker returned, a fast-lane window
(*N probes · min–max ms*) shows the window's length, how many probes it
folded and at what pace, its loss and its min / average / max.

What a window does **not** carry is the probes themselves - the lane keeps
one row per *Record every* by design (see [the fast lane](#fast-lane)), so
lower *Record every* (five seconds at the least) when a check needs finer
stored history. The last **ten minutes** of a fast check's raw probes are
still there to look at: **Recent probes** under the chart lists them,
newest first with millisecond timestamps, and grows by one line per probe
while the tab is open. That list lives in Redis, only for addresses
somebody is watching, and is gone ten minutes after the last look - it is
a window on the lane, not history.

**History** carries the window - 1h / 12h / 24h / 7d / 30d / 90d on the
tabs, or any span at all from the slider button beside them (a number of
hours or days, an hour to a year) - and, for that window:
the availability figure with incidents, MTTR and time down; **daily
availability** as one bar per day once three or more days were measured
(three nines green, two amber, less red, a day with nothing measured empty);
a strip for all checks together (worst state wins) and one per check when
there are several, each with its availability at the end; then the status
changes behind the picture, paged, with who answered each. Strip, bars,
figure and table come from the same log, so they cannot disagree. *Open in
Monitoring* carries the address into the tenant-wide History view with its
filters set.

### On a prefix

The prefix Monitoring tab shows:

- A **roll-up** badge and breakdown (e.g. `2 down · 1 up`) across the prefix's
  IPs, worst status winning.
- The **prefix-level checks**, each with Apply-to-children, schedule-mode, and
  excluded-count controls.
- A **per-IP status grid** linking to each monitored child IP.

### On a device

Checks attach to IPs, not to devices - but the device page rolls them up for
you in three places:

- A **roll-up badge** in the device header, next to the status badge (the same
  mixed-status badge as the list column).
- The **IPs tab** has a **Monitoring** column showing each IP's status badge.
- The **Overview** has a **Monitoring** summary: the roll-up badge + breakdown
  across every IP assigned to the device (worst status winning) and a per-IP
  status grid linking to each monitored IP. What an external system reports -
  open problems, protocols it cannot reach the host on - shows as chips beside
  the badge, and in the badge's hover, the same way the lists show it.
- The **Monitoring** tab: the roll-up with seven days of status to scale, one
  row per monitored address with its own strip and chips, a **Zabbix** panel
  when the device is a Zabbix host (what Zabbix reports - problems,
  reachability, disabled or in maintenance - beside Danbyte's status, never
  folded into it; see [What Zabbix says about a device](../monitoring/zabbix.md#host-status)),
  and the **History** panel with the changes behind them over 24h / 7d / 30d
  / 90d. The tab beside it, **SNMP**, holds what the device itself reports -
  system facts, interfaces, sensors, drift.

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
(24h / 7d / 30d / 90d). Availability is **time-weighted** - measured from how long
the IP spent in each state, not raw sample counts - so a slow check interval
doesn't skew the number. Time spent in *unknown* or *skipped* is excluded from the
calculation and reported separately, so a check that simply wasn't running can't
read as 100% uptime. The card also shows the number of **incidents** in the window
and the **mean time to recovery (MTTR)**.

### History

Status changes are kept for a year, results for thirty days. Both are also
folded into [rollups](#rollups) that outlive them. The history API
reads the changes back filtered by anything an address is - the same
dimensions the list pages filter on - and returns facet counts and a bucketed
series alongside the rows, so one call feeds a rail, a chart and a table:

- `GET /api/monitoring/alerts/` takes `ip=`, `device=`, `template=` and a
  `since`/`until` window (an alert overlaps it when it opened before the end
  and was not resolved before the start) - what a strip segment asks.
- `GET /api/monitoring/transitions/` - paged (`page`, `page_size` ≤ 200),
  ordered by `at` or `ip`. Window: `since`/`until` (timezone-aware ISO) or
  `days` (default 7, up to 365). Filters: `to_status`, `from_status`, `kind`,
  `template`, `source`, `engine`, `ip`, `site`, `region` (descendants
  included), `device`, `device_type`, `role`, `platform`, `prefix`, `vrf`,
  `vlan`, `port`, `tag` (repeatable, every tag must match), `search`, and
  `flapping=1` for the changes behind checks flagged as flapping right now;
  every row says whether its check is (`flapping`), and the facets carry a
  *Flapping* bucket counted like the others. Lists are comma-separated and
  mean *any of*. A site matches an address's own site, its prefix's or its
  device's. A VLAN matches the prefix's VLAN or the interface's.
- `…/ips/<id>/transitions/`, `…/devices/<id>/transitions/`,
  `…/prefixes/<id>/transitions/` - the same shape, pinned to one object.
- `…/ips/<id>/timeline/?days=` and `…/devices/<id>/timeline/` - status over the
  window as segments `{start, end, status}`, per check and rolled up (worst
  wins), computed from the same transitions the uptime figure integrates.
  Every window-taking endpoint also accepts `hours=` (1 up to a year), which
  wins over `days`; explicit `since`/`until` stamps win over both.
  `POST …/timeline/ {states: [...], days}` returns segments for up to 200
  checks at once, for list strips.
- `…/ips/<id>/history/` pages a check's recorded results backwards with
  `before=<id>` (`next_before` in the response).
- `…/ips/<id>/probes/?template=` - the last ten minutes of a fast-lane
  check's raw probes, newest first (`probes`, `kept_seconds`, `interval_ms`);
  `fast: false` and no probes for an ordinary check. Kept in Redis only
  while the address is being watched.
- `…/stats/?hours=24|168|720` picks the results-chart window; beyond three
  days the buckets are days. 720 hours is the ceiling because results are
  pruned after thirty days.

### Rollups {#rollups}

Every five minutes the `danbyte-rollups` timer (`manage.py rollup_checks`)
writes one hourly record per check, and once a day has ended, one daily record.
Each record holds:

- the seconds spent up, down, degraded, stale and unknown;
- the incidents that began in the bucket;
- the probe count;
- that check's own latency: min, average, p50, p95, p99 and max;
- **spikes**, the probes slower than the check's usual latency;
- a latency histogram: how many probes answered within 1, 2, 5, 10, 20, 50,
  100, 200, 500, 1000, 2000 and 5000 ms. The
  [SLA latency objectives](sla.md#latency-objectives) read it.

Hourly records are kept 30 days (`MONITORING_ROLLUP_HOURLY_RETENTION_DAYS`).
Daily records are never pruned, so an availability figure for last year can
still be read after the raw results and status changes behind it are gone.

A spike is a probe slower than both *factor × baseline* and *baseline + floor*.
The baseline is the median of the check's hourly p50 over the previous seven
days. The factor defaults to 3 and the floor depends on the kind:

| Kind | Floor |
|---|---|
| ICMP | 5 ms |
| TCP, UDP | 20 ms |
| HTTP, SSH, Telnet, SNMP, TLS | 50 ms |

Both the factor (`spike_factor`) and the per-kind floors (`spike_floor_ms`)
are monitoring settings. A new check has no baseline, so it records no spikes
for its first hour.

Availability is read from the recorded seconds with one set of counting
rules:

- *degraded* counts as up;
- *stale* counts as unmeasured, not down, so a blind probe is not charged as
  an outage;
- *unknown* is unmeasured.

Availability is up ÷ (up + down). **Coverage** is the measured time ÷ all
time. A 99.99 % figure measured over three days of a thirty-day month shows
10 % coverage beside it.

A new install starts recording from its first run. To build records from the
history already on disk, run `manage.py rollup_checks --backfill 90`. Daily
records go back as far as status changes do. Latency goes back only as far as
raw results, which is thirty days by default.

Facet counts are computed with every filter applied *except* the facet's own,
so ticking a second value in one facet never zeroes its neighbours. All of it
is site-scoped: a viewer limited to one site gets that site's history, counts
and buckets and nothing else.

## Run a check now

Anywhere checks are listed you can force an immediate run instead of waiting for
the schedule:

- **Check now** on an IP or prefix runs its checks right away and refreshes in
  place.
- The **Prefixes** and **IPs** list pages have a bulk **Check now** action - select
  rows, and Danbyte re-checks every selected IP (and every IP in selected
  prefixes), with a live progress bar.

A manual check rolls into the same state machine as a scheduled one - it advances
the rise/fall counters, can move the status, logs the change, and fires alerts
exactly like an automatic scan.

!!! tip "Large prefixes are fast"
    Sweeping a very large prefix (a `/16` is ~65,000 hosts) completes in seconds,
    not minutes - ICMP sweeps are batched and run with high concurrency, and big
    target sets are split across background workers that run in parallel.

## The Monitoring dashboard

**Governance → Monitoring** is the global view. Its tabs:

- **Overview** - stat cards (total checks, monitored IPs, **availability**
  over the chosen window - up over up-plus-down, degraded counting as
  reachable - definitions, alert channels), charts (status distribution,
  checks by type, results over the last 24 hours, 7 days or 30 days - hourly
  up to three days, daily beyond; 30 days is the ceiling because results are
  pruned after that), **Latency** (median and 95th percentile per bucket,
  one check kind at a time, since a ping and an HTTPS fetch do not share a
  scale - the median says how it feels, the 95th says who is suffering;
  `latency_by_kind` in the stats payload), **Alerts** (opened against resolved per day - whether you are
  keeping up), **Recent changes** (the latest status changes grouped by the
  hour they landed in, with who answered), a **Flapping now** count (see
  below), and the monitoring settings.
- **History** - every status change in the tenant. The rail on the left
  filters by the state a change went to or came from, who answered, check
  type, site, device type, role, platform, check and engine - each with a
  count of what ticking it would leave - and narrows by region, device,
  prefix, VRF, VLAN, tag or port. The window is 24h / 7d / 30d / 90d or a
  custom date range; the chart above the table shows changes per hour or per
  day by state. Under it, **By weekday and hour** is a heatmap of the same
  changes in your timezone (a 03:00 column lit on every row is a backup
  window; a lit Monday row is a boot storm) - click a cell and the table and
  the top list narrow to that hour of that weekday (`?dow=&hour=`; the
  heatmap itself stays whole so the next cell can be picked) - and **Most
  changes** lists the addresses that changed most, ten a page, with how many
  of those changes went bad. Both follow the rail. Everything lives in the URL, so a view is
  a link, and saved views keep a rail, a window and a search under a name.
  Export walks every page the filters match, up to 5,000 rows.
- **Checks** - every check in the tenant, on the same rail as History: status,
  source, type, site, device type, role, platform, check and engine facets
  with counts, plus region, device, prefix, VRF, VLAN, tag and port. The
  quick tabs (All / Up / Degraded / Down / …, each with a count) set the
  status in one click; the rail's Status facet combines several. Columns -
  status, address with DNS name, device, site, check, type, source, latency,
  since, last checked - sort on the server, so a click reorders the whole
  list, not the page in hand. Three more columns come from the
  [rollups](#rollups) and cover the last seven days:
    - availability, with the share measured beside it ("68% measured")
      when part of the week went unmeasured;
    - p95 latency;
    - the check's baseline.

  **7 days** adds a status strip per row. Saved views and export work as on
  History; the dashboard donut's slices land here with the status set. A
  check's name opens [its own page](#check-page).
- **Explore** - the checks grouped by one dimension: site, role, device type,
  platform, device, prefix, VRF, check or type. The window runs from 24 hours
  to a year. Each row shows:
    - the number of checks;
    - availability, with coverage;
    - incidents;
    - time to recover (down time per incident);
    - latency p50 / p95, separately for each check kind.

  The worst availability comes first. A group's name opens the Checks list
  filtered to that group.
- **Latency** - one check kind at a time; the tabs show each kind's p95.
  For the chosen window it shows:
    - the median and 95th percentile, with the spikes per bucket as bars;
    - the checks **furthest from their baseline** (window p95 ÷ baseline,
      so 2.0x is twice as slow as usual);
    - the checks with the **most spikes**.
- **SLAs** - service level agreements, with each one's figure for this
  period against its target. See [Service level agreements](sla.md).
- **Flapping** - shown while anything is flagged: the Checks list pinned to
  flapping checks, with row selection and a bulk **Confirm not flapping**.
  Every row carries its **last 24 hours** to scale - the alternation itself
  is the picture, so you can see whether the bouncing is settling before you
  confirm; a block opens to its exact times and the alerts it raised.
- **Templates** - your reusable check library.

### The check page {#check-page}

Each check has its own page at `/monitoring/checks/<id>`. The hero shows the
status and the address, device and kind, with availability, p95 and baseline
in the stat rail.

The **Overview** tab holds:

- the check's details;
- the window's figures:
    - availability and coverage;
    - incidents and time to recover;
    - p50 / p95 / p99;
    - the spike threshold and the spike count;
- a bar chart of availability per day, or per hour for the 24-hour window;
- latency against the check's baseline (dashed) and spike threshold
  (dotted), with spikes as bars;
- the raw-probe latency chart.

The window runs from 24 hours to a year.

**Status changes** pages every change the check made in the last year.
**Results** shows its recent raw results.

Percentiles over a window are the sample-weighted mean of each bucket's
percentiles. That is close to, but not exactly, the percentile of every
probe in the window.

The same figures are available from the API:

- `GET /api/monitoring/checks/<id>/?days=` - one check;
- `GET /api/monitoring/explore/?group_by=&days=` - grouped figures;
- `GET /api/monitoring/latency/?kind=&days=` - the Latency view;
- `GET /api/monitoring/checks/?with=figures&days=` - the list with figures.

`hours=` (up to 48) can replace `days=`. All four are site-scoped like the
Checks list.

### The Settings tab

The **Settings** tab (also reachable from **Settings → Monitoring**) is where
you set the per-tenant monitoring options. It sits on its own tab rather than
at the foot of Overview: a dashboard is for reading and settings are for
changing, and a form below the charts was easy to miss. The tab appears for
users with `users.manage`.

Deployment-wide scheduling for config-drift runs and the email digest is a
separate, deployment-admin concern and stays under **Settings → Monitoring
defaults**.

| Setting | What it controls |
|---|---|
| **Global schedule switch** | Master on/off for checks in *Follow global* mode. |
| **Default interval** | How often *Follow global* checks run. |
| **Stale thresholds** | After how many consecutive failures, or how many days, a down check becomes *stale*. |
| **Skip statuses** | IP statuses whose IPs should never be checked. |
| **Reverse-DNS sync** | Keep IPs' DNS names current automatically (see below). |
| **Discovery & cleanup** | Auto-discovery and stale-IP cleanup options (see below). |

### Flapping {#flapping}

A check that goes bad **Flap threshold** times (5) within the **Flap window**
(30 minutes) is **flapping** - and that is something the check *is*, not a
list you have to ask for. The state shows as a **Flapping** pill beside the
status badge wherever the status is: the prefix, device and VM lists, the
address's summary and Monitoring tab (one pill per check), the device's
Overview and Monitoring tab, every row of the Checks list and every change
of a flagged check on the History tab - both of which have a **Flapping**
facet on the rail to keep only those. The pill's hover says how many checks
under the target are flagged. A flapping alert stops sending reminders, so a bouncing
host cannot page on a loop.

It is **sticky**. "It stopped bouncing" and "it is fine" are different
claims, and the second is the operator's to make: **Confirm not flapping**
(on the address, on the device, or in bulk on the **Flapping** tab of the
Monitoring page) clears the state, records who said so in the address's
change log, and only bad transitions *after* that moment count towards
flagging it again - a confirmation means something, and the flag re-arms
only on new evidence. Confirming needs `ipaddress.change` on the address.

A tenant that would rather not be asked turns on **Auto-clear flapping** in
the monitoring settings: a flagged check then clears itself once it has been
quiet for **Quiet for** minutes (30) and is under the threshold. Off by
default.

Two things keep expected churn out: exclude whole IP statuses (the
DHCP-scope escape hatch, in settings) or tick **Ignore flapping** on one
known-noisy address - neither is ever flagged, and either clears a flag
already raised. That is different from confirming: confirming clears the
flag once, ignoring stops it being raised at all.

**What gets mailed.** A flapping check is not mailed one change at a time.
The moment the sweep flags it, every status-change channel in scope of the
address (instant or batched, email or webhook) gets one **Flapping** notice:
target, device, check, how many changes in the window, the last few changes
as a chain, and a link to the address. From then on its changes are left out
of the instant and batched status-change messages, and the alerts it opens
and resolves are recorded - flagged from the start - but not announced. One
more message follows when it is over: **Not flapping** when someone confirms
it (naming who), or **Settled** when auto-clear cleared it. A webhook channel
receives the same as an event (`"event": "flapping"`, `"settled"`,
`"confirmed"`). The alert channels stay quiet the whole time; the flapping
notice stands in for them.

The Monitoring page's Overview shows a **Flapping now** count that opens the
**Flapping** tab - the Checks list pinned to flagged checks, where rows can
be selected and confirmed together. The dashboard has a **Flapping** widget
with the same list. `GET /api/monitoring/flapping/` returns it; `POST
/api/monitoring/flapping/clear/` with `state_ids`, `ip_ids` or `device_ids`
confirms, as do `…/ips/<id>/flapping/clear/` and
`…/devices/<id>/flapping/clear/`.

### Reverse-DNS enrichment

With **Sync reverse DNS** turned on, each time an IP is checked Danbyte looks up
its PTR record and writes the hostname to the IP's DNS name field. Two options
handle the no-result case: keep the existing name when a lookup fails but the host
is up (so a transient DNS blip doesn't wipe a name off a live host), or clear the
name when a lookup returns nothing.

#### Choosing which nameservers to ask

By default the lookup uses whatever resolver the Danbyte host itself uses. On a
split-horizon network that is often the wrong answer - or no answer - so
**Nameservers** lets you name the servers to ask, as IP addresses, in order.

They are queried directly, which means **the Danbyte machine does not need DNS
configured for this to work**; the addresses are enough. A server is only tried
when the one before it fails to respond at all - "no such record" is a real
answer, so the list stops there rather than shopping around for a better one.

The list never quietly falls back to the host's resolver. If every server you
named is unreachable the lookup fails, which is what *keep the existing name
when a lookup fails but the host is up* is there to absorb. A setting that
silently ignored itself would be worse than none, because the names it produced
would look right while coming from the wrong place.

Leave it empty for the previous behaviour.

These resolvers are used by the **Danbyte server**. By default that is where
every PTR lookup happens, including for checks an Outpost ran remotely - so
name servers the core server can actually reach.

An Outpost can instead resolve its own, which is usually what you want when it
sits in a branch office: see *Reverse DNS from an Outpost* in
[Outposts](../monitoring/outposts.md).

## Alerts

Status changes are turned into stateful **alerts** - incidents you can see and act
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

The same tab also holds **port utilization rules**: warn when a device's port
fill reaches (or drops to) a threshold, or when a device has **no ports at
all**. Each rule scopes to a specific device, a device type, and/or a device
role (all set conditions AND together; nothing set = every device in the
tenant). They ride the periodic utilization sweep and notify through the
tenant's channels with hysteresis - a rule fires once per crossing and
re-arms when the condition stops holding, exactly like prefix-utilization
alerts. Counting matches the device page's Port utilization card: connected
(including ports *marked connected* without a documented cable) or
*Planned*-reserved ports over total interfaces, front ports and rear
ports.

### Acknowledge an alert

You can **acknowledge** a firing alert so the team knows someone owns it (with an
optional note). The alert keeps firing, but acknowledging it records who and when -
and **stops reminder notifications** (see below).

### Silences and maintenance windows

A **silence** mutes notifications for matching alerts during a time window.
Matchers mirror alert rules (kinds, statuses, IP tags, a prefix, plus an optional
single IP - all empty means a blanket silence). While a silence is active, alerts
still open and are tracked, but no notification is sent. A silence scheduled for
the future is effectively a **maintenance window**. Manage these under **Alerts →
Silences**; silenced alerts are flagged in the list.

### Renotify, escalation, grouping, flapping

These time-based policies are **per-tenant** and **off by default** (except
grouping), and all of them respect acknowledgement and silences:

- **Grouping** (on by default) - when one event opens many alerts at once (a switch
  dies, taking 50 IPs down), they're coalesced into a single digest per channel
  instead of a storm of messages.
- **Renotify** - re-sends a reminder for an alert that's still firing, unacked, and
  un-silenced after a configurable interval. Acknowledging or silencing stops the
  reminders.
- **Escalation** - an alert left firing and unacknowledged past a deadline is
  bumped to *critical* and re-notified.
- **Flapping** - an alert whose check is [flapping](#flapping) is marked so
  and excluded from reminders until the state is confirmed clear (or clears
  itself, when auto-clear is on), so a flapping host can't page on a loop.

The Alerts table surfaces *escalated*, *flapping*, *silenced*, and *ack* chips, and
tracks how many times each alert has notified.

## Notifications

When an alert opens, escalates, or resolves, Danbyte routes it to your enabled
**notification channels**. Manage them under **Alerts → Channels**; each has a
**Send test** action. Every channel applies two gates before it fires:

- **Minimum severity** - alerts below the channel's threshold are skipped.
- **On statuses** - an optional allow-list of check statuses; empty means any bad
  status.

Supported channels:

| Channel | You provide | Notes |
|---|---|---|
| **Slack / Discord** | An incoming-webhook URL | Posts the alert summary with a deep link. |
| **Microsoft Teams** | A workflow/webhook URL | Posts the alert summary as an Adaptive Card. |
| **PagerDuty** | A routing key | Triggers on fire, resolves on clear; deduplicated per condition. |
| **Telegram** | A bot token and a chat ID | Posts the alert summary as plain text; optionally into one group topic. |
| **Webhook** | A URL | POSTs the alert as JSON to your own endpoint. |
| **Email** | Recipient addresses | Sent via the deployment mail server (below). |

Notifications are best-effort: a failing channel is logged and never breaks a
check run. When a **public base URL** is configured (see below), messages include
a clickable link straight back to the alert.

#### Microsoft Teams

Teams messages are sent as an **Adaptive Card** (v1.4) inside the standard
message envelope, which is what both a **Teams Workflows** webhook and a Power
Automate flow ending in **Post card in a chat or channel** expect. With a public
base URL set, the card carries a *View in Danbyte* button instead of a pasted
link.

Note that the webhook answers **202 Accepted** as soon as the flow accepts the
request - before the flow has posted anything. A 202 (and so a green **Send
test**) means Danbyte delivered the payload, not that Teams rendered the message.
If the card never appears, check the run history of the flow itself.

#### Telegram

Telegram uses the **Bot API**, not a webhook URL. You provide:

- **Bot token** - from [@BotFather](https://t.me/BotFather). Stored encrypted and
  never read back by the API; leave the field blank when editing to keep it.
- **Chat ID** - the destination. A private chat, group, supergroup or channel;
  group and channel IDs are negative (`-1001234567890`).
- **Topic ID** - optional, for a group with **Topics** enabled. Sent as the Bot
  API's `message_thread_id`; leave it blank to post in the general topic.

Add the bot to the group or channel **before** testing - a bot cannot message a
chat it isn't in, and for a channel it needs post rights. A user must have
messaged the bot at least once before it can DM them.

To find a chat ID, message the chat (or add the bot and post there) and read
`https://api.telegram.org/bot<TOKEN>/getUpdates` - the `chat.id` in the last
update is the value to paste. If the group has Topics on, the same update
carries the `message_thread_id` of the topic you posted in.

Messages are sent as **plain text** with no `parse_mode`, so device names and
detail strings never need escaping. Telegram answers **HTTP 200** with
`{"ok": false, "description": …}` when it refuses a message (wrong chat ID, bot
not in the group, deleted topic) - Danbyte treats that as a failure and **Send
test** shows the description.

### Subscriptions and the Notifications page

Beyond a channel's free-text recipient list, you can **subscribe** a user or a
whole **group** to a channel - the channel then also emails that user, or every
member of that group. Subscriptions are additive: they merge with the recipient
list at send time.

Two kinds:

- **Mandatory** (admin- or group-assigned) - the subscriber **cannot** remove it
  themselves. This is the "the NOC group is on DC-event notifications and members
  can't opt out" case. Group subscriptions are always mandatory for members.
- **Self-assigned** - a user opted themselves in and can leave again.

The top-level **Notifications** page has two views:

- **For you** (every user): what you're subscribed to - your own, your groups',
  and any channel that lists your address directly - each tagged with its source
  (Self / Assigned / via *group* / Direct). Self-assigned rows have an
  **Unsubscribe** button; mandatory and group ones are read-only. Channels marked
  **self-subscribable** show up under "Available to join" with a **Subscribe**
  button.
- **All channels** (admins): every subscription across channels - the groups and
  users each one reaches - with add/remove.

**The quickest path - "Notify me":** a prefix or IP **Monitoring** tab - and a
device's Monitoring strip - has a **Notify me** button. One click emails you
(your account address) whenever that prefix/IP/device changes status - no
channel setup. Behind the scenes it reuses a shared, auto-created email channel
scoped to that object and adds you as a self subscription (visible under
Notifications → For you, where you can turn it off again). A scoped channel only
ever fires for its own target - a device scope covers every IP assigned to the
device - for both status changes and alerts. Manually-created channels can be
scoped the same way in the channel form (Everything / a subnet / a device).

Channel **Send test** now surfaces delivery errors instead of always reporting
success - for an email channel that means the actual SMTP error, so a silent
channel can be diagnosed from the UI.

Self-service opt-in/opt-out is gated by the **`subscribe`** capability on
notification channels; grant it to the users/groups who should manage their own
subscriptions (like `reveal`/`connect`, it isn't in the default Administrator
set - superusers always have it). Managing *other* people's subscriptions uses
ordinary add/change/delete on notification subscriptions. Mark a channel
**self-subscribable** in its form to let permitted users join it.

### Raw status-change notifications (no alert rules)

A channel can also send **every status change** for the IPs it matches, without
setting up any alert rule - for operators who just want "email me when something
in this subnet goes down". Enable **Send raw status changes** on the channel and
pick a delivery mode:

- **Instant** - the first change goes out at once; a channel then never sends
  more often than once a **minute**. Changes inside that minute are held and
  delivered together in the next message (the minute beat sends it when no
  new batch does), so a check on the fast lane that bounces every few seconds
  costs one email a minute at most - and none once the flap sweep has
  flagged it (see [Flapping](#flapping)).
- **Batched** - a periodic **mini-digest** every *N* minutes (default 30),
  summarising the window's changes as the same per-prefix status-badge chains the
  monitoring digest uses. Nothing is sent for an empty window.

Scope it with the channel's existing **On statuses** filter (e.g. only `down`)
and an optional **subnet** - only IPs inside that prefix notify. Changes on a
check that is currently **flapping** are left out of both modes; the channel
gets the flapping notice instead. This rides the
same delivery gates and the same effective SMTP as everything else; instant fires
from the check batch, batched from the minute beat, so neither needs a new timer.

### Email and outbound delivery (deployment-wide)

Mail server and outbound options are a **single deployment-wide setting**, edited
under **Settings → Email** by an administrator (users with the manage
permission). Email channels all deliver through this one server.

| Setting | What it controls |
|---|---|
| **Email enabled** | Master switch for email channels. |
| **SMTP host / port / security** | The mail server and `none` / `starttls` / `ssl`. |
| **SMTP username / password** | Auth (the password is encrypted at rest and write-only). |
| **From address** | The From header on alert emails. |
| **Public base URL** | Adds clickable links to alerts in Slack/Teams/Telegram/email/PagerDuty messages. |
| **Webhook timeout** | How long to wait for outbound webhook POSTs. |
| **Outbound proxy** | Optional HTTP(S) proxy for outbound webhooks. |

A **Send test email** action confirms the mail settings work. A misconfigured
or unreachable SMTP host fails fast (a bounded connection timeout,
`EMAIL_SMTP_TIMEOUT`, default 10s) and returns the SMTP error, rather than
hanging the request.

**Templates.** A **Templates** card on Settings → Email shows every email
Danbyte produces - monitoring digest, certificate digest, alert and
grouped-alert notifications, status changes, the flapping notice, the sign-in code, the invite -
rendered with example data exactly as a recipient sees it. Pick one to see
it in the page; **Send this one** (or **Send all**) mails it to an address you
choose, subject prefixed with `[Preview]`, through the same SMTP config, so
you can check it in a real mail client before it goes out for real.

Every email shares one layout: a document, not a marketing card. White,
black ink, hairlines, bold for emphasis, and colour only where something
needs acting on - a red critical count, a red *Down*; a warning is bold, an
*Up* is plain. The header carries the deployment's logo: the **login logo**
uploaded under Settings → Branding & identity when there is one, else
Danbyte's own. It is embedded in the mail itself as an inline image (not a
`data:` URI, which Gmail and Outlook strip), so it shows on a laptop with no
access to the site. SVG logos are skipped - mail clients do not draw them;
upload a PNG. Everything is table-based inline-styled HTML with a plain-text
alternative, the only markup every mail client agrees on.

## Auto-discovery and cleanup

Two **opt-in** background jobs manage the IP lifecycle of monitored subnets. Both
default off and are controlled from **Monitoring → Settings**.

### Discovery

When enabled, Danbyte periodically ICMP-sweeps the prefixes you've enrolled and
records the responders it finds as new IPs.

- **What's enrolled:** either *every* prefix (a global "discover everything"
  switch), or each prefix you flag **Auto-discover** plus its descendant prefixes
  in the same VRF - so flagging a parent subnet enrols all its children.
- **New IPs** are created with a tenant-specific **Auto-discovered** status (amber,
  not "available") so a human has to review and promote them - discovery never
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
    hand are **never** deleted by cleanup - the discovered flag is the safety
    boundary between "the tool made this" and "a person entered this".

## Settings

Most day-to-day options live in the per-tenant settings on the Monitoring
dashboard. A few deployment-level options (concurrency limits, the secret key for
credential encryption, default global interval and switch, exec-check enablement
and plugin directory, retention windows) are set by an administrator - see
[Reference → Settings](../reference/settings.md#monitoring).

Check history is high-volume (hundreds of thousands of raw results per day on a
busy install), so Danbyte automatically prunes old results (default **30 days**,
`MONITORING_RESULT_RETENTION_DAYS`) and old status-change records (default 365
days, kept longer as an audit timeline) on a schedule. The rolled-up per-check
state, the status-change timeline and the [rollups](#rollups) carry the
long-term story; raw results only need to cover the sparkline/history windows.

## Email digest

A scheduled summary email of the monitoring picture - a lightweight status
report (like ping-monitor "digest" mails) delivered on your cadence rather than
alert-by-alert. Each digest covers, per tenant: check counts by status (up /
down / degraded / stale) with a reachable %, window activity counters (how many
IPs went down / came up / went stale), currently-firing alerts by severity, and
a count of configuration changes.

The **State changes** section lists every IP that changed state in the window,
grouped by prefix. Each IP is drawn as a horizontal **chain of status badges** -
the status it entered the window with, then one coloured badge per transition
(`Up → Down (Jul 20 03:01) → Up (Jul 20 03:07)`) - so a flapping host reads at a
glance. Badges use Danbyte's status palette (green up, red down/stale, amber
degraded), and a heavily-flapping network is capped so the mail stays a
reasonable size.

Configure it under **Settings → Monitoring → Email digest**
(deployment-wide default) - enable it, choose **daily** or **weekly** (with a
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

The digest also carries a compact **Certificates** strip - expired, expiring
(critical / warning), and recently-changed counts - so the overall certificate
picture rides along with the status summary.

## Certificate digest

A **separate**, certificate-focused digest, because expiry is the one class of
problem where "you find out when it breaks" is an outage. Immediate,
per-certificate expiry alerts already fire in real time through the notification
channels (see [Certificates](../monitoring/certificates.md)); this is the
recurring "everything approaching expiry, at a glance" companion email, sent as
its own message rather than buried in the monitoring digest.

Each certificate digest covers, per tenant:

- **Expired** and **expiring** (critical / warning) leaf certificates actually
  served on the wire.
- **Declared** certificates (uploaded and assigned, not yet observed) approaching
  expiry.
- **Recent changes** - endpoints now serving a different certificate than before.

Enable it under **Settings → Monitoring → Email digest → Certificate
digest**. It runs on the same cadence as the monitoring digest (the daily
`danbyte-digest` timer) but is gated by its own flag and tracked separately, so a
tenant can run one, both, or neither. Recipients default to the digest
recipients; set **Certificate-digest recipients** to send it elsewhere (e.g. a
security team). A scheduled certificate digest with nothing to report is skipped;
`--force` sends it anyway:

```bash
.venv/bin/python manage.py send_digest --tenant <slug> --force
```
