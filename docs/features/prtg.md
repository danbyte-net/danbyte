---
icon: lucide/activity
---

# PRTG monitoring

Danbyte can read an existing PRTG Network Monitor core server. It pairs PRTG
devices with Danbyte devices and virtual machines, reads every linked
device's sensors on a schedule, rolls them up into one Danbyte state per
device, and answers `prtg` checks from that read, so PRTG's verdict reaches
Danbyte's status, alerts and SLA. Each linked device and VM gets a
**Sensors** tab with PRTG's sensors, channels and history drawn in Danbyte's
own way. Two things travel back, each behind its own switch:
acknowledgements (both ways) and Danbyte's maintenance windows (as pauses).
PRTG devices Danbyte has no device for can be adopted, and what PRTG knows
about a device's name and serial reaches its drift inbox. Policies and
sensor profiles say what PRTG *should* have; Danbyte plans those changes in
the review queue and, when they are applied, creates, moves and removes the
devices and sensors in PRTG (see [Writing to PRTG](#writing-to-prtg)).

!!! note "What PRTG monitors stays configured in PRTG"
    Danbyte shows PRTG's sensors, channel values, limits and history; it does
    not edit them. There is no limit editor and no sensor settings. Every
    sensor and device links into PRTG for that. Danbyte writes only what its
    plan names: devices and sensors it creates, the group a device it plans
    belongs in, and the removal of objects it created.

## Turning it on

1. **Settings → Integrations → PRTG monitoring**. Off by default, per tenant,
   like every other integration. On, it adds **PRTG** under *Integrations* in
   the sidebar; off, the page is hidden and the API answers 404. Opened by
   link, the page says PRTG is off.
2. In PRTG, create an **API key** for the user Danbyte should act as (*Setup →
   Account Settings → API Keys*). Reading needs read access. Acknowledging
   alarms and pausing devices for maintenance need a user that may do both
   on the devices Danbyte links; with a read-only key, leave those two
   switches off.
3. On the **PRTG** page, add the connection: a name, the URL of the PRTG web
   interface, the API key, how often Danbyte will read PRTG, TLS verification,
   and whether the connection is enabled. Press **Test connection**.

The API key is write-only. The form shows whether one is stored, never the key;
leaving the field blank keeps the stored key. Changing the URL to another host
drops the stored key, so it is never sent to a server it was not typed for.
The key is encrypted at rest and left out of the change log.

!!! warning "An internal PRTG has to be allow-listed"
    A tenant-configured URL is never a way to reach internal services, so every
    request goes through the outbound guard and redirects are never followed.
    Most PRTG servers are on RFC1918: a deployment admin adds the address under
    **Settings → Security → Outbound connections** (or `DANBYTE_SSRF_ALLOWLIST`).

PRTG installs with a self-signed certificate. Keep **Verify TLS certificate**
on and give PRTG a certificate your deployment trusts, rather than switching
verification off.

## What the test reports

| Field | Meaning |
|---|---|
| Version | The PRTG version from `getstatus.htm`. Below **24.1** the connection is marked unsupported. |
| Probes, sensors | How many the API key can see, from `table.json`. A key scoped to nothing shows zero. |
| API v2 | Whether PRTG's API v2 answers on the same host (port 1616 for HTTPS, 1615 for HTTP). A refused key still counts as answering. |
| Last error | PRTG's own sentence when it refused the call, or why it could not be reached. |

A failed test answers 502 with the reason; the reason is also kept on the
connection until the next test passes.

## How Danbyte talks to PRTG

The classic HTTP API, with the API key as the `apitoken` query parameter. That
is the only way the classic API takes a key: PRTG 26.3 answers an
`Authorization: Bearer` header there with 401 *Unsupported authorization
scheme.* API v2 is the other way round and takes the key only as a Bearer
header. Because the classic key travels in the URL, Danbyte never puts a
request URL in an error or a log line; the key is redacted from anything it
reports. PRTG's own web server logs the URL, as it does for every classic API
client. Tables are read in pages of 5,000
rows with a short pause between pages, since the same web server serves the
PRTG interface. Status codes 0-14 are read from `status_raw`; *Not Licensed*
(11, the state of sensors beyond a licence's limit) and every paused state read
as **unknown**, never down.

The freeware edition (100 sensors) has the same API as the commercial ones.

Probe counts use `table.json?content=probenode&filter_type=probenode`.
Unfiltered, that content lists other objects too: a fresh 26.3 install
answers 188 rows.

## The status read

Every **Read every** interval (1 minute to 1 hour, 2 minutes by default) the
shared external-monitoring beat (`manage.py extmon_sync`, run each minute by
`danbyte-extmon-sync.timer`) queues a read of each enabled connection that is
due. **Read now** on the PRTG page runs the same read straight away. One read
is two calls: the devices table and the sensors table. Then Danbyte:

1. Matches every device of the tenant to a PRTG device and links it, or puts
   it in the review queue (see below).
2. Writes each linked device's sensors as rows: name, type, PRTG status, the
   Danbyte state it maps to, the message, tags and the last check. A sensor
   PRTG no longer has is deleted.
3. Rolls each linked device up into one state, with counts per state.

The job checks again when it runs that the connection still exists, its
tenant is active and the integration is on. A read that fails writes nothing
and keeps PRTG's sentence as the connection's **Last error**. The attempt is
stamped anyway, so a broken connection waits for its interval instead of being
queued every minute. A per-connection lock keeps two reads from running at
once.

## Matching PRTG devices to Danbyte devices

Tried in order, and the first level with exactly one answer wins:

| Level | A PRTG device matches when |
|---|---|
| Link | It is the PRTG device the stored link names. Survives renames and re-addressing on both sides. |
| Tag | It carries the tag `danbyte-<device uuid>`. Add it in PRTG to pin a pairing by hand. |
| Address | Its *IPv4 address/DNS name* field is one of the addresses assigned to the device in this tenant, primary or not. |
| DNS name | That field is the DNS name of one of those addresses. |
| Name | Its name equals the device's name, ignoring case. |

**Virtual machines** are matched too, by the tag `danbyte-<vm uuid>`, by an
address - the VM's primary address or one assigned to it or to one of its
interfaces - and by the DNS name of one of those addresses. Never by name
alone: VM names repeat the names of the hosts and services around them. A
VM's link, sensors and queue rows belong to the VM, and the roll-up, the
`prtg` check (on an address assigned to the VM) and the list column work for
it as they do for a device.

**Two candidates are no match.** Two PRTG devices at one level, one PRTG
device matched by two Danbyte devices, or an address that several Danbyte
objects hold all become a **Needs a decision** row in the review queue, with
the reason. A common case is a VM and the device recorded on the same address:
PRTG's `host` does not say which of the two it watches. Fix the data (a tag
in PRTG is quickest) and the next read links it.

**Link devices** on the connection decides what a clear match does:
*Automatically* links it at once (the default; a link is Danbyte bookkeeping
and writes nothing to PRTG), *After review* puts a **Link in Danbyte** row in
the queue first. The **Review queue** tab lists both kinds, with *Link*,
*Dismiss*, *Restore* and *Link all*. A proposal that is no longer true goes
away on the next read. The **Links** tab lists every pairing with its roll-up;
*Unlink* removes one and the next read matches the device from scratch.

Matching covers every device of the tenant, not only those with a check: a
device PRTG already monitors is that device whatever Danbyte checks exist.

## Status mapping

Each PRTG status code maps onto a Danbyte state. Six carry a verdict and can be
changed on the connection under **Status mapping**:

| PRTG status | Default |
|---|---|
| Up | up |
| Warning | degraded |
| Unusual | degraded |
| Down | down |
| Down (Partial) | degraded |
| Down (Acknowledged) | down |

The rest are always **unknown**, because PRTG is not measuring the sensor:
Paused (by user, dependency, schedule or until), Not Licensed (a sensor beyond
the licence limit, such as the 101st on freeware), No Probe, None, Unknown and
Scanning.

A device's state is the **worst** over its active sensors. Paused sensors are
left out, and a device with no other sensors is unknown. Unknown ranks below
up, so one unlicensed sensor beside a healthy one leaves the device up. A
device with only unlicensed sensors is unknown, never down. Changing the map
re-rolls the stored states at once.

## The `prtg` check

To put PRTG's verdict into Danbyte's status, alerts and SLA, use the check kind
**PRTG** like any other: a check template, a policy over a site or role, or an
assignment. Create a monitoring engine of kind **PRTG** (Governance →
Monitoring engines), add it under **Engines** on the connection, and bind the
scope to it. The engine's driver answers every due `prtg` check from the last
read, without calling PRTG per check. Hysteresis, alert rules, silences,
flapping, escalation, notifications and SLA behave as for Danbyte's own
checks.

By default a check is the device's roll-up. Two optional template parameters
narrow it:

| Parameter | Narrows to |
|---|---|
| `sensor_type` | Sensors of that PRTG type, by raw name (`ping`, `paessler.icmp.ping_sensor.48`) or display name (`Ping v2`). |
| `sensor_tag` | Sensors carrying that tag (`pingsensor`). |

The check reads **unknown**, never down, with the reason, when the address
has no linked PRTG device, two PRTG devices share it, the PRTG device is
paused, no sensor fits the narrowing, the last read is older than three
intervals, or the last read failed. The check's detail lists the down and
degraded sensors with PRTG's message, and the monitoring hover links to the
device in PRTG.

## Push notifications

Polling is the truth. PRTG can also say "look now": its **Execute HTTP
Action** notification makes Danbyte read that one device again within seconds
and makes the device's `prtg` checks due.

1. On the connection, tick **Accept push notifications** and save. On the
   Overview tab, **Make token** shows the URL **once**. Only a hash of the
   token is stored; **New token** replaces it and the old URL stops working.
2. In PRTG, *Setup → Account Settings → Notification Templates → Add*:
   * **Execute HTTP Action** on.
   * **URL**: the URL shown, `https://<danbyte>/api/prtg/hook/<token>/`.
   * **HTTP Method**: POST.
   * **Payload**: `sensorid=%sensorid&deviceid=%deviceid&laststatus=%laststatus`
3. Trigger it on state change at the root group, so every sensor inherits it.

Only the ids are read; `laststatus` and everything else is ignored, and the
device is read from PRTG through the API key. A forged call can at most make
Danbyte ask PRTG sooner. An unknown token, push switched off, a disabled
connection, an inactive tenant or the integration off all answer 404. Each
connection takes 60 notifications a minute (429 beyond), and a second
notification for the same device within 5 seconds rides the first.

## Acknowledgements

**Acknowledgements both ways** on the connection (on by default) keeps "someone
has this" the same in both systems.

**Danbyte → PRTG.** Acknowledging a Danbyte alert that a `prtg` check raised
acknowledges, in PRTG, every sensor behind the check that the last read saw
*Down* or *Down (Partial)* (`acknowledgealarm.htm`). A check narrowed to a
sensor type or tag acknowledges only those sensors. The note reads
`[Danbyte] <your name>: <your note>`, and PRTG shows it first in the sensor's
message. The write is a background job, so the acknowledgement in Danbyte
never waits on PRTG. What was written, or PRTG's refusal, is kept on the alert
(`detail.prtg_ack`). PRTG accepts an acknowledgement only for a sensor that is
down, so nothing else is sent. PRTG has no un-acknowledge: clearing the
acknowledgement in Danbyte is recorded on the alert and goes no further.

**PRTG → Danbyte.** When a status read finds every sensor behind a firing,
unacknowledged alert in *Down (Acknowledged)*, and at least one of them was
acknowledged by a person in PRTG, the Danbyte alert is acknowledged with the
note `Acknowledged in PRTG by <who>: <their note>`. It has no Danbyte user.

**No echo.** An acknowledgement read from PRTG is recorded with the source
`prtg`, and the write-back is never called for it. The `[Danbyte]` marker keeps
Danbyte's own acknowledgements from being read back as PRTG's. If you clear an
acknowledgement in Danbyte that came from PRTG, the same PRTG acknowledgement
does not set it again. A new acknowledgement in PRTG does.

**With push.** A push notification re-reads its device's sensors, and the
acknowledgement check runs on that re-read too. When the notification
template fires on the change to *Down (Acknowledged)*, a PRTG acknowledgement
reaches Danbyte in seconds. Otherwise it arrives with the next status read.

## Maintenance windows

**Pause for maintenance windows** on the connection (off by default) mirrors
Danbyte's calendar into PRTG. A confirmed maintenance or outage window that
silences devices pauses each linked PRTG device it covers, for the rest of the
window (`pauseobjectfor.htm`, in minutes, with the message
`[Danbyte] Maintenance: <window>`). A virtual machine the window names is
paused as well when PRTG has a device linked to it. PRTG pauses the device's
sensors with it (*Paused by parent*). Danbyte reads paused as unknown, and its
own silence holds the alerts.

* **One pause per device.** PRTG keeps one pause per object, so overlapping
  windows on one device are written as their union: from the earliest start
  to the latest end of every window that overlaps the one open now.
* **Not early.** A window that has not started is not written. The reconcile
  runs every status interval and whenever a window changes, so a device is
  paused within one interval of its window opening.
* **Moves follow.** A window that is lengthened, shortened or joined by
  another is written again. A window cancelled or deleted early resumes the
  device (`pause.htm?action=1`). One that ends on time needs nothing: PRTG
  lifts the timed pause itself.
* **Hands off what is not Danbyte's.** A device that is already paused when
  its window opens was paused by somebody in PRTG. Danbyte leaves it alone and
  records nothing, so it never resumes it. Danbyte resumes only a device it
  paused that is still paused with Danbyte's message. A device somebody
  resumed or paused again by hand is left as it is.

The link records what Danbyte did: when it paused the device, until when, and
for which windows. The device's **Monitoring** tab shows *Paused by
maintenance until …* on its PRTG row while that holds. The API's
`maintenance-now/` runs the pass at once.

## Adopting PRTG devices

**Adopt devices** on the connection (off by default) turns PRTG into a way
into Danbyte. Every status read proposes an **Adopt into Danbyte** row in the
review queue for each PRTG device that no Danbyte device or virtual machine
answers to. "Answers to" means by address, serial or name, across the whole
tenant. PRTG's own objects are skipped: the core server (no address) and the
probe device (a loopback address). The proposal is keyed by the PRTG object
id, so a device is proposed once.

Where the device would land is decided most specific first:

1. The first matching **adoption rule** in order (*Adoption* tab, lower order
   first). A rule matches the PRTG device's name, its group, its probe or its
   address. The pattern is a glob, `regex:`, or a CIDR for addresses. A rule
   sets the site, and the role and device type when it names them.
2. A PRTG **group named like one of your sites**.
3. The connection's **defaults**: site, role, device type.

A proposal that still lacks a site, role or type says so and waits;
**Set defaults** opens the connection. Changing the defaults updates the
waiting proposals at once, leaving what a rule or group decided alone.

**Adopt** makes the device with PRTG's name, links it
(`matched_by="adopted"`) and records its address only when the PRTG host is
an IP inside one of your existing prefixes. A device PRTG knows by a DNS name
is adopted without an address, and the row says so: Danbyte never resolves a
name to invent one. **Apply all** skips proposals that cannot be placed.
Every site, role and type in a proposal is read again inside your tenant when
it is applied. Turning adoption off clears the proposals at the next read.

## Inventory drift

**Read system information** on the connection (off by default) reads what
PRTG holds about each linked device (`table.json?content=sysinfo`, category
*system*) once an hour, 50 devices a pass, the oldest first, each again after
12 hours. PRTG collects it itself over WMI, SNMP or SSH, about once a day, and
only where it has credentials. Many devices have none, which Danbyte records
as "looked, nothing to say".

| PRTG key | Recorded as | Drift |
|---|---|---|
| *Bios Serial Number*, *Serial Number* | serial | Offered |
| *sysName*, *Host Name*, *Computer Name* | name | Offered |
| *Manufacturer*, *Vendor* | vendor | Recorded only |
| *Model*, *System Model* | model | Recorded only |
| *Windows Version*, *Operating System*, *sysDescr* | OS | Recorded only |

A different name or serial shows in the device's **drift inbox**, marked as
coming from PRTG. Nothing reaches the device until somebody accepts it.
Danbyte's own SNMP poll outranks PRTG wherever both report the same field. A
paused PRTG device is not an observation of now. Turning the switch off
withdraws PRTG's opinions rather than leaving the last ones standing.

## The device list

Devices get a **PRTG** column, hidden until ticked in the Columns menu: the
device's roll-up as its state pill, red and amber counts of down and warning
sensors, and a link to the device in PRTG. `?prtg=` filters the device list
API: `linked`, `unlinked`, or a state (`up`, `degraded`, `down`, `unknown`).
The virtual machine list has the same **PRTG** column.

## Sensors

Every status read writes each linked sensor's record as well as its state:
the primary value as PRTG formats it (`12 msec`, `81 %`) with its number and
unit, the interval, uptime and downtime, priority, the last check, last up and
last down, and the probe and group. A device or VM that PRTG has a device for
gets a **Sensors** tab, with the sensor count, while the integration is on.

**The tab.** A status strip on top: one badge per state with its count -
down, degraded, up, unknown, and paused apart - named as the tenant names its
states, then the PRTG device with a link to it in PRTG and when it was last
read. Below, a card per sensor, worst first: its name and kind, the state
pill (PRTG's own word, *Paused by Dependency*, in the tooltip), the last value
as the big number, the last check, the uptime, and PRTG's message as a muted
notice when the sensor is not up - two lines at most, ending in an ellipsis,
with the whole message on hover and in the panel. The link icon opens the
sensor in PRTG; the pin puts the sensor on the Overview (see
[Pinned sensors](#pinned-sensors)).

**The sensor panel.** Clicking a card opens the sensor's panel
(`?sensor=<id>` in the address, so it can be linked). It shows PRTG's
summary and one card per channel:

| Channel | Drawn as |
|---|---|
| A number (`Response Time`, `Days to Expiration`) | An arc gauge: the value as the big number with its unit, min and max at the ends, and PRTG's warning and error limits as thin amber and red arcs. The value arc is green inside the limits, amber or red in a band, and neutral when the channel has no limits. |
| A percentage (`Free Space C:`) | The same gauge from 0 to 100 %. |
| A lookup (`Root Authority Trusted`, `Public Key Length`) | A segmented state bar: one segment per value the lookup knows, the current one filled in what it means (green ok, amber warning, red error), its label underneath. |
| Text (`Only Strong Protocols Available`) | The text. |

Values are shown in the unit PRTG displays: a traffic channel PRTG keeps in
bytes per second reads `0.03 Mbit/s`. A channel PRTG has no value for
(*Downtime* on a sensor that has never been down) reads **No value**.

Under the reading, what the channel's history says, with no setting per
channel:

- **A number or percentage that moved** gets the last hour's sparkline and a
  **1h / 24h / 7d** switch that opens its history graph, in the channel's
  own unit. The switch appears only once the hour has at least two values.
  The sparkline and the graph are one line from sample to sample: a sensor
  checked less often than the history's averaging interval leaves empty
  points between its samples, and those are its rhythm, not gaps. Only a
  stretch longer than one and a half times its usual spacing breaks the
  line.
- **A number that did not move** (*Days to Expiration* over an hour) reads
  *Steady over the last 1h* instead of a flat line; its graph says the same
  for a range in which it stayed put.
- **A lookup** gets a state timeline instead of a line: one rounded
  segment per run of the same state along the chosen range, sized by how
  long it lasted, no axis and no percentages. A state holds from its sample
  to the next; consecutive samples in the same state are one segment, and a
  muted segment marks only where PRTG has no data (before the first sample,
  or a stretch longer than the sensor's rhythm, as for the line). Hovering a
  segment shows its state and its span. PRTG records a lookup channel's
  history as the share of each interval spent in one named state (*Root
  Authority Trusted (Yes)*, 0 %); Danbyte reads that back as the state.
- **Text** has no history to show.

PRTG averages the history per range: one minute for an hour (or the sensor's
interval when that is longer), 15 minutes for 24 hours, one hour for 7 days,
at most 400 points per channel.

**Reading PRTG on demand.** Channels are one call per sensor, so the status
read never fetches them. The panel reads them when it opens -
`table.json?content=channels` (its `info` column carries each channel's
status, limits and lookup table) and `getsensordetails.json` - and the history
from `historicdata.xml` per range. Both are kept on the sensor for one status
interval: opening the same sensor again, by anyone, inside the interval asks
PRTG nothing. When PRTG does not answer, the last read is shown and marked.
`historicdata` takes its window in the PRTG server's local time; Danbyte learns
the offset once from `getstatus.htm` and keeps it on the connection.

### Pinned sensors

A sensor card, the sensor panel's header and each channel card in the panel
have a **Pin to Overview** toggle: the first two pin the whole sensor, the
third one channel. A sensor pins whole once and each of its channels once
more, side by side. Pins show on the device's or VM's **Overview** in a
**Sensors** card, one tile each in one grid, in the order they were pinned:

- **A sensor tile**: the sensor's name, its kind, the state pill, the
  primary channel's value as the big number with its unit (a lookup's
  label), the last hour's sparkline under it - none when the value held
  still - and the last check.
- **A channel tile**: the gauge, lookup bar or value, the channel and its
  sensor, and the sensor's state when it is not up.

A tile opens the sensor's panel; hovering it shows **Unpin**. The card is
absent until something is pinned, and one device or VM carries at most 24
pins of either kind. A pin keeps no reading: the tiles read the channels and
the hour's history as the panel does, and a sensor gone from PRTG takes its
pins with it. Pinning and unpinning need change on *PRTG sensor pins* and
view on the device or VM; site roles include the pins of their sites'
objects.

The same channels can go on a dashboard: see
[Sensor widgets](dashboard.md#sensor-widgets).

**The Monitoring tab** gets one **PRTG** row per linked device or VM: the
roll-up pill, the state strip, the PRTG device and a link to the Sensors tab.
The rest of the tab is unchanged; like the Zabbix section, the row never
changes Danbyte's own status.

**Who sees it.** The sensors and channels are the device's or VM's data: the
channels and history need view on the device or VM as well as on PRTG
sensors. Site roles include PRTG device links, sensors, system information
and the review queue for their sites (an `auth_api` migration gives roles made before 0.19 the same,
see [Permissions](permissions.md#site-roles-local-it-in-one-click)); PRTG
connections stay with administrators.

## The PRTG page

**Overview** carries a status strip across every imported sensor of the
connection, with when it was last read, above the connection card.
**Alarms** lists every down or degraded sensor, worst and newest first: the
sensor (linked to its device's or VM's Sensors tab with the panel open), the
device or VM, kind, state, PRTG's message, since when (the last down, else
the last check), whether it is acknowledged in PRTG (*Down (Acknowledged)*),
probe and group, and a link into PRTG. **Sensors** lists every sensor with
the same columns plus the last value and uptime, and a **Hide paused**
switch. Both have search, facets for state, device, kind and probe/group, and
export. **Review queue** holds link proposals, adoptions, ambiguities and planned changes;
**Links** lists the pairings; **Adoption** edits the adoption rules;
**Policies** and **Profiles** edit what PRTG should have (see
[Registering devices and VMs](#registering-devices-and-vms)). The
connection card's **Two-way** panel says which of acknowledgements,
maintenance pauses, inventory and adoption are on.

## API

All under `/api/prtg/`, scoped to the active tenant, 404 while the integration
is off, and gated on the PRTG permissions (group *Monitoring*).

| Endpoint | Purpose |
|---|---|
| `connections/` | List, create, update, delete. `api_key` is write-only; `api_key_set` says whether one is stored. `status_interval_seconds` is 60-3600. `api_v2_url` is blank to derive it, and must name the same host as `url`. `engines` are the tenant's PRTG engines only. `state_map` takes the six editable codes onto `up`, `degraded` or `down`. A fixed code may only be `unknown`, and the map is stored complete. `link_mode` is `auto` or `review`; `push_enabled`; `hook_token_set` (read-only); `last_status_at` and `last_status_summary` (read-only). Two-way: `write_acknowledgements` (default on, both directions), `sync_maintenance`, `read_inventory`, `adopt_devices` (default off) with `adopt_site`, `adopt_role` and `adopt_device_type` (the tenant's own rows only) and `adopt_names` (read-only); `last_maintenance_sync_at` and `last_inventory_at` (read-only). Writes: `seed_device_objid` (a PRTG object id), `send_credentials`, `auto_apply_registration` and `prune_devices` (default off); `write_mode` (`v2`, `seed`, `none`, or blank before a check), `write_detail`, `write_checked_at`, `last_apply_at` and `last_apply_summary` (read-only). |
| `connections/defaults/` | Every status code with its label, whether it is fixed and why, the default map, and the states (named by the tenant) a code may map onto. |
| `connections/<id>/test/` | `POST`. Returns `ok`, `detail`, `version`, `probes`, `sensors`, `v2_available`, `v2_detail`, `write_mode` and `write_detail`; 502 when it fails. Records the version, API v2 answer, what PRTG can create and the error on the connection. |
| `connections/<id>/check-writes/` | `POST`. Asks PRTG what it can create: `{mode, detail, version}`, kept on the connection. |
| `connections/<id>/prtg-devices/` | `GET`. PRTG's devices, read live, for the seed device picker: `[{objid, name, host, group, paused}]`; 502 with PRTG's sentence. |
| `connections/<id>/status-now/` | `POST`. Runs a status read now; returns its counts (`linked`, `proposed`, `ambiguous`, `unmatched`, `sensors`, `deleted`, `gone`, `adopt`, `acknowledged`), 502 with PRTG's sentence when it fails. |
| `connections/<id>/maintenance-now/` | `POST`. Reconciles the maintenance pauses now; returns `paused`, `extended`, `resumed`, `left`, `failed`. 400 while `sync_maintenance` is off, 502 when PRTG cannot be read. |
| `connections/<id>/rotate-hook-token/` | `POST`. A new push token: `{token, path}`, shown this once. |
| `connections/<id>/plan-now/` | `POST`. Runs the planning pass now; returns `scoped`, `create`, `add_sensor`, `remove_sensor`, `move`, `not_applicable`, `no_address`, `awaiting_link`, 502 with PRTG's sentence when its groups cannot be read. Writes nothing to PRTG. The connection keeps `last_plan_at` and `last_plan_summary`; a status read's counts carry the same under `plan`. Registration fields on the connection: `register_all`, `register_profile` (a profile of this connection), `register_group_id` and `register_group_path`. |
| `policies/` | CRUD (`?connection=`): `name`, `enabled`, `priority` (lower first), `scope` (`global`, `region`, `site`, `location`, `platform`, `device_type`, `device_role`) with its target (`region`, `target_site`, `location`, `platform`, `device_type`, `device_role` - only the scope's own is kept), `match_tags`, `match_name`, `match_hardware`, `applies_to_devices`, `applies_to_vms`, `profile` (required, this connection's), `group_id` (required) and `group_path`. Every target must be the active tenant's. |
| `profiles/` | CRUD (`?connection=`) with `definitions` nested in order: `{id, kind, name, params, interval_seconds, required, tags}`. Writing `definitions` replaces the list; a row with an existing `id` is updated. `params` are checked against the kind and stored with its defaults. Deleting a profile in use answers 400. `profiles/kinds/` lists the kinds, their parameters and PRTG's intervals; `POST profiles/starter/ {connection}` makes the starter profile. |
| `groups/?connection=<id>` | PRTG's probes and groups: `{connection, read_at, groups: [{objid, name, kind, path, probe, parent_id}], error}`. Kept on the connection and read again after one status interval, or with `refresh=1`. Needs view on PRTG policies. |
| `plan/?device=` or `?virtual_machine=` | What PRTG would get for one object, per enabled connection: `{connection, prtg_sync, managed, via, reason, linked, group, policies, profiles, sensors: [{name, kind, kind_label, params, interval_seconds, tags, required, interface, template, present, sensor}], credentials, problems, last_apply}` (`linked` carries `created_here`; `last_apply` is `{at, kind, ok, detail, result, by}` or null). Needs view on the object; asks PRTG nothing. |
| `links/` | List (`?connection=`, `?device=`, `?virtual_machine=`), retrieve, delete (unlink). Each link has its `device` or `virtual_machine`, PRTG object id, name, host, probe, group, `matched_by`, `state`, `sensor_counts` and `url`, and what the maintenance mirror did: `maintenance_paused_at`, `maintenance_paused_until`, `maintenance_events` (`[{id, name}]`) and `maintenance_note`; `created_here` and `last_apply` (what Danbyte last wrote for it). |
| `sensors/` | Every imported sensor, read-only. Filters: `connection`, `device`, `virtual_machine`, `state` (comma-separated; `paused` picks the paused sensors), `kind` (raw or display name), `probe`, `group`, `alarms=1` (down and degraded, not paused), `hide_paused=1`, `search`; `ordering` is `name`, `-name` or `alarms` (worst, then newest problem first); `page_size` honoured. Each row has its `device` or `virtual_machine`, PRTG's `status` word, the mapped `state`, `paused`, `acknowledged`, the message, the record above, `url` (the sensor in PRTG) and `device_url`. |
| `sensors/summary/` | Counts for a status strip in one query, with the list's filters: `down`, `degraded`, `up`, `unknown` (not paused), `paused`, `acknowledged`, `total`, `read_at`. |
| `sensors/<id>/channels/` | The sensor's channels, read from PRTG at most once per status interval: `{fetched_at, summary, rows}`, each row `{id, name, value, value_raw, unit, kind, state, status, lookup_label, limits: {warn_min, warn_max, error_min, error_max}, lookup_states: [{value, to, label, state}], min, max, primary}`. `kind` is `number`, `percent`, `lookup` or `text`; a lookup `state` is `ok`, `warning`, `error`, `none` or `unknown`. Needs view on the device or VM. 502 with PRTG's sentence when PRTG cannot be read and nothing is cached; `stale: true` when the last read is served instead. |
| `sensors/<id>/history/?range=1h\|24h\|7d&channel=<id>` | `{range, avg, fetched_at, stale, channels: [{id, name, unit, points: [{t, v}]}]}`, read at most once per range and interval, at most 400 points per channel. `channel` narrows to one. Needs view on the device or VM. |
| `changes/` | The review queue, the same shape as Zabbix's: list (`?connection=`, `?ignored=1`), `<id>/apply/`, `<id>/dismiss/`, `<id>/restore/`, `apply-all/` (body `{"connection": …}`, skips *Needs a decision* and adoptions that cannot be placed). Kinds: `link_device`, `adopt` (no device; `key` and `detail.objid` are the PRTG object id, `detail` carries `name`, `host`, `address`, `group`, `probe`, the placement as `site`/`site_id`, `role`/`role_id`, `device_type`/`device_type_id`, `rule`, `defaulted`, and `reason` while it cannot be placed), `ambiguous`, and the planned kinds `create_device`, `add_sensor` (`key` is the sensor's `danbyte-def-` tag), `remove_sensor` (`key` is the PRTG sensor id), `move_device` and `remove_device` - see [Planned changes](#planned-changes). A planned row's `detail` carries `reason` and `fix_link` when it cannot be written, and what applying it did: `result` (`device`, `sensors` by tag, `credentials`, `templates`), `log` (`[{at, by, ok, detail, steps}]`), `applied` or `last_error`. `applicable` says whether apply can run now; `status` is `ready`, `attention`, `applied`, `failed` or `decision`; `destructive` marks removals. `<id>/apply/` answers `{ok, detail, status, result}` (400 when the row cannot be written, 502 when PRTG refused). `apply-all/` applies ready rows and skips removals; `apply-selected/` (`{ids: [...]}`, at most 500, removals included) and `dismiss-selected/` act on the tenant's rows named, `apply-selected/` answering `{applied, failed, results: [{id, ok, detail, status}]}`. |
| `adoption-rules/` | CRUD for where adopted PRTG devices land: `scope` (`name`, `group`, `probe`, `ip`), `pattern` (glob, `regex:`, or a CIDR for `ip`), `site`, optional `role` and `device_type`, `weight` (lower first), `enabled`. Site, role and type must be the tenant's own. |
| `sensor-pins/?device=\|virtual_machine=` | Sensors and channels pinned to an Overview, in order: `{id, sensor, channel_id, display, position, device, virtual_machine, sensor_info}`. `POST {sensor, channel_id, display}` pins one (`display` is `auto`, `gauge`, `lookup` or `value`; the device or VM is the sensor's own; a channel pins once, at most 24 per object); `POST {sensor}` with no or a blank `channel_id` pins the whole sensor (`channel_id` reads `""`, once per sensor, beside its channel pins; `sensor_info` carries `last_value` and `last_check_at` for its tile); `DELETE <id>/` unpins; `POST reorder/ {device \| virtual_machine, order: [pin ids]}` sets the order. Writes need change on PRTG sensor pins; every call needs view on the device or VM. |
| `device-status/?device=`, `?virtual_machine=` or `?ip=` | One entry per link: connection, PRTG device and its URL, `matched_by`, the roll-up, counts and the down and degraded sensors. Empty when the caller may not view the device or VM. |
| `device-states/` | `{device id: {state, down, warning, name, url}}` for every linked device the caller may view. Feeds the device-list column. |
| `vm-states/` | The same for virtual machines. Feeds the VM-list column. |
| `hook/<token>/` | `POST`, no session: the push receiver above. 202 when accepted. |

## Registering devices and VMs

Danbyte can say which of its devices and VMs PRTG should monitor, where in
PRTG they belong and which sensors they should carry. What it would do
appears in the review queue as planned changes; applying one writes it to
PRTG (see [Writing to PRTG](#writing-to-prtg)).

There are three ways to pick an object, strongest first:

| Order | Set where | Says |
|---|---|---|
| 1 | **PRTG: Exclude from PRTG** on the device or VM form | Never in PRTG's plan, whatever a policy or *Register all* says. Its Monitoring tab's PRTG row shows **Exclude**. |
| 2 | **PRTG: Monitor in PRTG** on the form | Always in the plan, even with no policy and a retired status. |
| 3 | **Policies** (the **Policies** tab) | Every object an enabled policy matches. |
| 4 | **Register all devices and VMs** on the connection | Every object left, less those already linked. |

The form's default is **Follow policies**: rows 3 and 4 decide. Policies and
*Register all* leave out objects whose status is *Decommissioning*,
*Decommissioned* or *Retired*, and objects whose primary address is excluded
from monitoring. *Register all* only ever adds devices to PRTG, so it says
nothing about a device PRTG already has. VM templates are not a case of
their own: virtualization sync leaves them out unless told to import them.

When the connection's **provisioning scope** is *Devices with a PRTG check*,
only objects carrying a `prtg` check on one of the connection's engines are
considered; *Monitor in PRTG* still wins. The default, *Every device the
policies match*, considers every object.

**Policies.** A policy has a name, a **priority** (lower first), a scope
- *Every device and VM*, a region, site, location, platform, device type or
role - and filters that narrow it: **tags** (all of them), a **name** glob
(`core-*`) and a **hardware** glob over inventory items and modules
(`psu*`). A region reaches its child regions' sites, a location its child
locations. **Devices** and **VMs** say what it applies to. A VM's site is
its own or its cluster's, and its location is its host device's. A VM never
matches a device type or a hardware filter. Each policy names a **sensor
profile** and the **PRTG group or probe** new devices go under, picked from
the list Danbyte reads from PRTG (`table.json?content=groups` and
`content=probenode`).

Policies stack. An object several policies match gets every one of their
profiles' sensors, the same sensor once. The matching policy with the lowest
priority decides the group. An object picked only by *Monitor in PRTG* or
*Register all* gets the connection's **registration profile** and **group**,
set beside the *Register all* switch.

## Sensor profiles

A profile (the **Profiles** tab) is an ordered list of sensors. **Starter
profile** makes an ordinary, editable one: Ping, SNMP uptime, SNMP traffic
on connected interfaces, and HTTPS where the object has a service on port
443. Nothing is created until you press it.

Each sensor has a kind, its parameters, an optional name, an interval (one
of PRTG's, or inherit PRTG's), the tags to set in PRTG and **Required**:

| Kind | Parameters | Needs |
|---|---|---|
| Ping | - | - |
| SNMP uptime, SNMP CPU load, SNMP memory | - | An SNMP profile |
| SNMP traffic | **Interfaces** (globs, comma-separated, over name and SNMP name), **Connected interfaces only** | An SNMP profile |
| HTTP | **Scheme**, **Port**, **Path**, **Only with a service on the port** | - |
| SSL certificate, SSL security check | **Port** (443), **Only with a service on the port** | - |
| WMI CPU load, WMI memory, WMI free disk space | - | A Windows login |
| Windows service | **Service name** | A Windows login |
| Device template | **Template**, as PRTG names it | - |

SNMP traffic is one sensor per enabled interface that matches; *Connected
interfaces only* keeps those with a cable or marked connected (a VM's
interfaces count as connected when enabled). A blank name takes the kind's,
and `{interface}` in a name is the interface's. SNMP credentials come from
the object's SNMP profile. Danbyte holds no Windows logins for devices or
VMs yet, so a WMI sensor is planned but marked as not ready.

A **device template** hands the device to one of PRTG's own templates. The
template files live on the PRTG core server and the API cannot read them,
so a template is part of what a new device gets and is never compared with
a device PRTG already has.

Tags starting with `danbyte-` are Danbyte's own. Every sensor Danbyte will
create carries `danbyte-def-<hash>` naming the profile entry that wants it.
A profile a policy or *Register all* uses cannot be deleted.

## Planned changes

Every status read is followed by a **planning pass**, and **Plan now** on the
connection runs one at once. It reads PRTG's groups and probes, works out
what PRTG should have for every object, compares that with the links and
the imported sensors, and writes the difference into the review queue:

| Kind | When | Detail |
|---|---|---|
| **Create in PRTG** | An object should be in PRTG and is not linked. | Name, host (its primary address), the group or probe with its path, the policies and profiles, the sensors, any templates, the tags (`danbyte`, `danbyte-<uuid>`) and the credentials it would send, by name only. |
| **Add sensor in PRTG** | A linked object lacks a required sensor. | The PRTG device, the profile entry, the sensor's name, kind, parameters and tags, and the interface for traffic. |
| **Remove from PRTG** | A sensor carries a `danbyte-def-` tag no profile wants any more. | The sensor and the tag. |
| **Move in PRTG** | A linked object is under another group than its policy names. | From and to, by path. |
| **Remove device from PRTG** | A PRTG device Danbyte created belongs in PRTG no more (set to *Exclude from PRTG*, no policy matches, *Register all* off), and **Propose removing devices** is on. | The PRTG device and why. Never proposed for a device Danbyte did not create. |

A sensor already in PRTG counts when it carries the entry's tag, or when it
is of the same type (`Ping v2` counts as Ping; a traffic sensor named after
the interface counts for it). An optional sensor a linked object lacks is
not proposed. An object without a primary address, and one whose link
is waiting in the queue, gets no **Create in PRTG** row; the pass counts
both.

A row says why it could not be written as it stands - *PRTG has no group …
any more*, no group named, no SNMP profile, no Windows login, *This PRTG
cannot create objects through its API* - with a **Fix** link to where that
is set, and `applicable` is false. A sensor Danbyte created that somebody
deleted in PRTG is proposed again as **Add sensor in PRTG**, required or
not, with *Deleted in PRTG.* A sensor carrying a `danbyte-def-` tag that
Danbyte did not create is shown for removal but cannot be applied: remove
it in PRTG if it should go. A row that is no longer true goes away with the
next pass; an applied row stays a day as *Applied*. A pass whose group read
fails proposes and drops nothing.

### Working the queue

The queue is an inbox. Each row carries a status:

| Status | Means |
|---|---|
| **Ready** | It can be applied as it stands. |
| **Needs attention** | Something is missing; the row says what, with a **Fix** link. |
| **Applied** | Written to PRTG: the ids PRTG gave the device and sensors, and a link to the device in PRTG. |
| **Failed** | PRTG refused or could not be reached: its sentence, and **Retry**. A retry carries on where the last attempt stopped. |
| **Needs a decision** | An ambiguous match; nothing to apply. |
| **Dismissed** | Kept aside; shown when **Hide dismissed** is off, with Restore. |

**Apply** sits beside Dismiss on every row that can be applied (links and
adoptions too). Ticking rows brings up **Apply selected** and **Dismiss
selected**; **Apply all applicable** says how many rows of which kinds it
will write before it does. Removals are never part of *Apply all* or the
automatic apply: each is applied on its own row, after a confirmation that
names what PRTG will lose. The facet rail filters by status and kind.
Clicking a row opens its whole plan beside the table: host, target group,
each sensor with its parameters, interface and interval, the credentials by
name, the policies and profiles that produced it, and the apply log - every
attempt, who made it, and each write it did.

The device's and VM's **Monitoring** tab has **What would PRTG get?** on its
PRTG row: per connection, whether the object is in the plan and why, the
group, the policies and profiles, each sensor marked present or planned,
the credentials by name, anything in the way, and what Danbyte last wrote
to PRTG for it (applied or failed, when, and PRTG's answer). It is computed
from what Danbyte holds; PRTG is not asked. A PRTG device Danbyte created
says **Created by Danbyte** on that row.

## Writing to PRTG

Applying a planned change writes it to PRTG:

| Kind | What Danbyte does |
|---|---|
| **Create in PRTG** | Creates the device under the planned group or probe, named after the object, with its primary address as host and the tags `danbyte` and `danbyte-<uuid>`; writes its credentials when **Send credentials** is on; creates every planned sensor, each tagged `danbyte` and its `danbyte-def-` tag; runs the device templates; links the object, marked as created by Danbyte. |
| **Add sensor in PRTG** | Creates the one sensor on the linked device. |
| **Remove from PRTG** | Deletes the sensor - only one Danbyte created. |
| **Move in PRTG** | Moves the device to the planned group or probe. |
| **Remove device from PRTG** | Deletes the device and its sensors - only one Danbyte created - and the link. |

Each write leaves a journal note and a change-log entry on the device or
VM, under the name of whoever applied it (*PRTG writer* for the automatic
apply). A retry is safe: before creating, Danbyte looks for the
`danbyte-<uuid>` or `danbyte-def-` tag in PRTG and carries on with what is
there, and a row keeps what an earlier attempt made. Right after a write
Danbyte reads that device's sensors again, so the next plan already sees
them. Writes are spaced a quarter second apart and wait as PRTG asks when
it answers *too many requests*.

**Danbyte never touches** a sensor it did not create, or a device it did not
create - except moving a linked device its policy places elsewhere, which
is proposed and applied like any other change. A device found already
tagged `danbyte-<uuid>` is linked, not counted as created, so it is never
proposed for removal.

### How PRTG is written

Creating objects needs **PRTG 26.2.120 or later** with API v2 (the new UI's
REST API, on port 1616 for HTTPS). Its create, delete and metascan calls are
under `/experimental` and Paessler says they may change between releases;
Danbyte was built against **PRTG 26.3.124**. **Test connection** (and
**Check** in the connection's *Writes* section) asks PRTG what it can do and
keeps the answer:

| Can create | Means |
|---|---|
| **API v2** | Devices and sensors are created through API v2. |
| **Seed copies** | API v2 cannot create here; new devices and sensors are copies of the **seed device**. |
| **Cannot create** | Neither: create and add-sensor rows say *This PRTG cannot create objects through its API.* |

What each call is, as PRTG 26.3.124 answered it:

- Devices: `POST /api/v2/experimental/groups/{id}/device` or
  `/experimental/probes/{id}/device`; the new id comes back in `Location`.
- Sensors: `POST /api/v2/experimental/devices/{id}/sensor?kindid=<kind>`
  (`ping`, `snmpuptime`, `snmpcpu`, `snmpmemory`, `snmptraffic`, `http`,
  `sslcertificate`, `ssl`, `wmiprocessor`, `wmimemory`, `wmidiskspace`,
  `wmiservice`). For a few seconds after a device is created PRTG answers
  *could not find parent* for it; Danbyte waits that out (up to half a
  minute). SNMP traffic, SNMP memory and Windows service sensors scan
  the device first (`/experimental/devices/{id}/metascan`) and pick the
  interface or service by name; a scan that finds no match, or does not
  finish within a minute, fails the row with PRTG's words.
- Tags and names: `PATCH /api/v2/experimental/sensors/{id}`.
- Scanning interval: API v2 refuses it (on create and on PATCH), so it is
  set through the classic API: `interval` and `intervalgroup_=0` (the
  inheritance switch; `intervalgroup` is accepted and does nothing).
- Device templates: the classic `discovernow.htm` with the template file
  names.
- Moving: `POST /api/v2/objects/{id}/move`. The classic API has no move
  call, so without API v2 a move row cannot be applied.
- Deleting: `DELETE /api/v2/experimental/devices/{id}` and
  `/experimental/sensors/{id}`; the classic `deleteobject.htm` on seed-copy
  servers.

**The seed device** is an empty, paused PRTG device the operator makes once,
with one sensor of each kind Danbyte may need, and picks under **Seed
device**. A new device is a copy of it (classic `duplicateobject.htm`; the
copy's own sensors are deleted, its host and tags set, then resumed), and a
new sensor is a copy of the seed's sensor of that kind, renamed, tagged,
with an HTTP URL or SSL port set, and resumed. Per-interface and per-item
sensors (SNMP traffic, SNMP memory, Windows service) cannot be copied - a
copy keeps the original's interface - and need PRTG 26.2.120 or later.

### Credentials

With **Send credentials** on, a device Danbyte creates gets the credentials
Danbyte holds for it, as device settings with inheritance off, through
`PATCH /api/v2/devices/{id}`:

| Danbyte | PRTG settings |
|---|---|
| SNMP profile v1 / v2c | `snmpversiongroup`: `snmpversion` `V1`/`V2`, `snmpcommv1`/`snmpcommv2`, `snmpport` |
| SNMP profile v3 | `snmpversion` `V3`, `snmpuser`, `snmpauthmode` (`authpHMACMD596`, `authpHMACSHA96`, `authpHMACSHA224` … `authpHMACSHA512`), `snmpauthpass`, `snmpencmode` (`DESPrivProtocol`, `AESPrivProtocol`, `AES192PrivProtocol`, `AES256PrivProtocol`), `snmpencpass`, `snmpcontext` |
| Windows login | `windowsconnection`: `windowslogindomain`, `windowsloginusername`, `windowsloginpassword` |

PRTG 26.3 accepted every one of these in the lab. It reads passwords back as
`*********`, but an SNMP community comes back in clear through API v2, so
Danbyte never records what PRTG returns there. On a seed-copy server the
same names are set as classic properties, with `<section>_` set to `0` for
inheritance. Danbyte keeps only a keyed hash of what it wrote; the queue,
the journal and the change log name the credentials, never their values.
Danbyte holds no Windows logins for devices yet, so for now only SNMP is
sent.

### Applying automatically and pruning

**Apply automatically** lets the beat apply the ready creates, sensors and
moves after each planning pass, under the name *PRTG writer*; one writer
runs per connection at a time. **Propose removing devices** makes the
planning pass propose **Remove device from PRTG** for a device Danbyte
created whose object no longer belongs in PRTG. Both are off by default,
and removals are always applied by a person, row by row.

---

PRTG is a trademark of Paessler GmbH. Danbyte is not affiliated with or
endorsed by Paessler.
