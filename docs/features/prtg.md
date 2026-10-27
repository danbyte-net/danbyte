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
| Address | Its *IPv4 address/DNS name* field is one of the addresses the device uses in this tenant: assigned to it or to one of its interfaces, or in its primary, OOB or secondary slot - the same candidates the host PRTG polls is chosen from (see [Registering devices and VMs](#registering-devices-and-vms)). |
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
PRTG's `host` does not say which of the two it watches.

**Shared addresses.** Several objects may hold one address - a VM and its
host, a cluster address, a NAT. Three rules settle most of it without a
person:

1. **The name decides.** When several objects hold the address of a PRTG
   device, the one whose name equals the PRTG device's name takes it
   (ignoring case and a trailing domain: `kbh-core1.example.lan` is
   `kbh-core1`), and no decision row is made. Objects that PRTG already has
   as another device, and objects whose **PRTG polls** override points
   elsewhere, do not contend. Only a real tie is a decision.
2. **A decision is remembered.** Choosing in the queue links the PRTG device
   to that object with `matched_by` **decided**, and the stored link wins
   from then on: the other objects are never asked about that PRTG device
   again.
3. **A separate PRTG device per object is allowed.** Creating never refuses
   because another PRTG device already has that host. The decision row's
   **Create a separate PRTG device for …** creates one for its object on the
   same host, linked and marked as created by Danbyte, and the planner
   proposes the same for any other object on the address that is
   registered.

**Needs a decision** rows carry their choices inline, in the row and in its
panel: one **Link <PRTG device> (PRTG) to <object>** per candidate (each
listed with its site and address), **Link <object> to <PRTG device>
(PRTG)** when one object matches several PRTG devices, **Create a separate
PRTG device for <object>** when something registers the object (Monitor in
PRTG, a policy, Register all) and PRTG can create objects, and **Dismiss**.
A choice applies at once, journals it on the object, and the row turns
*Applied* with the result; the other candidates' rows for that PRTG device
go.

**PRTG polls.** A device or VM may name the address or DNS name PRTG should
poll instead of its primary address - **PRTG polls** under the PRTG select
on its form (`prtg_host`, blank by default). A device Danbyte creates gets
it as its host, and matching uses it alone for that object: an object with
an override matches the PRTG device on that host, not one on its other
addresses. Without one, the host follows the order under
[Registering devices and VMs](#registering-devices-and-vms).

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

**The tab.** A one-line strip on top, the PRTG row of the Monitoring tab:
*PRTG*, the sensors' state as the shared badge - one pill when every sensor
is in one state (*Up*), the mixed badge when they are not - then the PRTG
device with a link to it in PRTG, when it was last read, and the device's
actions menu. Hovering the badge lists the counts per state (named as the
tenant names its states, paused apart) and the sensors worst first with
PRTG's message. Clicking *PRTG* or the badge shows the down and degraded
ones (`?state=problem`); clicking again, or *Show all*, clears it. A link
from the Overview card can open the tab on one state (`?state=down`,
`?state=paused`, ...). Below, a card per sensor, worst first: its name and
kind, the state pill flush in the top-right corner (*Paused* when paused;
PRTG's own word, *Paused by Dependency*, and its message in the tooltip),
the last value as the big number, the last check, the uptime, and PRTG's
message as a muted notice when the sensor is not up - two lines at most,
ending in an ellipsis, with the whole message on hover and in the panel.
Hovering a card slides the pill left and shows the pin (puts the sensor on
the Overview, see [Pinned sensors](#pinned-sensors)) and the actions menu
in the corner; on a touch screen they always show. The link icon opens the
sensor in PRTG.

**Acknowledge, pause, resume.** The actions menu (the `...` button on a
card, in the sensor panel's header and on each row of the /prtg Alarms and
Sensors tabs) acts on the sensor in PRTG:

- **Acknowledge...** - for a down sensor, while the connection writes
  acknowledgements (*Two-way > Acknowledgements*). A small dialog takes a
  note; PRTG gets `[Danbyte] <your name>: <note>` and the sensor reads
  *Down (Acknowledged)* at once.
- **Pause for 1 hour**, **Pause for 24 hours**, **Pause until resumed** -
  the sensor reads *Paused* and drops out of the counts straight away.
- **Resume** - on a paused sensor; Danbyte reads the device's sensors again
  so the card shows PRTG's state.

The strip's menu does the same for the whole PRTG device: pause (1 hour,
24 hours, until resumed) and resume, which PRTG applies to every sensor on
it. Each action is written to the device's or VM's **Journal** and
**Change log** under your name. The menu shows with *change* on PRTG
sensors (or on PRTG links for the device menu); the server checks it again,
and PRTG's own error comes back as the toast.

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
absent until something is pinned, and one object carries at most 24 pins of
either kind. A pin keeps no reading: the tiles read the channels and the
hour's history as the panel does, and a sensor gone from PRTG takes its
pins with it.

**Where a pin goes.** A pin sits on the page it was pinned from. On the
device's or VM's Sensors tab the toggle pins to the device's or VM's
Overview. On an IP address's, interface's or service's Sensors tab (see
[Where sensors show up](#where-sensors-show-up)) it reads **Pin to this
address's Overview** (interface's, service's) and pins to that object's
Overview, where the same **Sensors** card shows above the rest; a tile there
opens the panel on the object's own Sensors tab. The same sensor can be
pinned on its device and on the address it watches, each with its own order
and its own 24. Only a sensor linked to an address, interface or service
can be pinned on it - the API refuses any other with *This sensor does not
watch this address* - and deleting the object takes its pins with it.

Pinning and unpinning need change on *PRTG sensor pins*, view on the object
the pin sits on and view on the sensor's device or VM. A pin's site is its
object's - the address's, the interface's device's, the service's - so site
roles include the pins of their sites' objects.

The same channels can go on a dashboard: see
[Sensor widgets](dashboard.md#sensor-widgets).

**The Monitoring tab** gets one **PRTG** row per linked device or VM - the
same row as the strip - and a link to the
Sensors tab; a count opens the tab filtered to its state. Its chevron opens
the [registration details](#planned-changes) in place.
The rest of the tab is unchanged; like the Zabbix section, the row never
changes Danbyte's own status.

**Who sees it.** The sensors and channels are the device's or VM's data: the
channels and history need view on the device or VM as well as on PRTG
sensors. Site roles include PRTG device links, sensors, system information
and the review queue for their sites (an `auth_api` migration gives roles made before 0.19 the same,
see [Permissions](permissions.md#site-roles-local-it-in-one-click)); PRTG
connections stay with administrators.

### Where sensors show up

A sensor is the device's or VM's, and it is also about something on it. Every
status read ties each sensor to the address, interface and service it
watches, and those pages get a **Sensors** tab of their own, with the count,
whenever a sensor watches them:

| Page | Its sensors | Matched by |
|---|---|---|
| **IP address** | Every sensor of the PRTG device that reaches its device or VM on this address. | The PRTG device's host, compared with the addresses assigned to the linked device or VM. A host that is a name matches the address whose DNS name it is. |
| **Interface** | The SNMP traffic sensor measuring the port. | PRTG names traffic sensors `(001) GigabitEthernet0/1 Traffic`: the number in brackets is the ifIndex, looked up in the device's last [SNMP poll](snmp-discovery.md); without it, or when the poll does not know it, the rest of the name is matched to the interface's name, label or SNMP name, or to a polled ifName, ifDescr or ifAlias. The index wins when both say something. |
| **Service** | The HTTP, HTTPS and SSL sensors checking its port. | The port in the sensor's name (`SSL Security Check (Port 443)`, `api:8443`), else 443 for SSL sensors and for a name that says HTTPS, else 80; then the device's or VM's service on that TCP port. Two services on the port are told apart by the address each answers on. |

Only the linked device's or VM's own objects in the connection's tenant are
candidates, and a sensor that could mean two of them is tied to none. VM
interfaces are matched the same way, from the VM's SNMP poll.

The tab is the Sensors tab's shape: a strip that reads **via db-dev01 in
PRTG**, linking to the device's Sensors tab, with the PRTG device in PRTG
beside it; then the cards; a card opens the same sensor panel. On every
card, the device's Sensors tab included, small chips name what the sensor
watches - the address, the interface, the service - and each opens that
object's page.

## The PRTG page

**Overview** puts the connection's sensors beside the connection card on a
wide screen (above it on a narrow one): one row per state with sensors in
it, worst first, each the state's pill and its count. A row opens the tab
that lists it - **Alarms** for down and degraded, **Sensors** for the rest -
and hovering a down or degraded row lists its sensors.
**Alarms** lists every down or degraded sensor, worst and newest first: the
sensor (linked to its device's or VM's Sensors tab with the panel open), the
device or VM, kind, state, PRTG's message, since when (the last down, else
the last check), whether it is acknowledged in PRTG (*Down (Acknowledged)*),
probe and group, and a link into PRTG. **Sensors** lists every sensor with
the same columns plus the last value and uptime, and a **Hide paused**
switch. Both have search, facets for state, device, kind and probe/group, and
export. With *change* on PRTG sensors, each row ends in the sensor's actions
menu (see [Acknowledge, pause, resume](#sensors)) and rows can be selected:
the selection bar at the foot acknowledges every selected down sensor (one
note for all), pauses the selected sensors for 1 hour, 24 hours or until
resumed, or resumes the paused ones. **Review queue** holds link proposals, adoptions, ambiguities and planned changes;
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
| `connections/` | List, create, update, delete. `api_key` is write-only; `api_key_set` says whether one is stored. `status_interval_seconds` is 60-3600. `api_v2_url` is blank to derive it, and must name the same host as `url`. `engines` are the tenant's PRTG engines only. `state_map` takes the six editable codes onto `up`, `degraded` or `down`. A fixed code may only be `unknown`, and the map is stored complete. `link_mode` is `auto` or `review`; `push_enabled`; `hook_token_set` (read-only); `last_status_at` and `last_status_summary` (read-only). Two-way: `write_acknowledgements` (default on, both directions), `sync_maintenance`, `read_inventory`, `adopt_devices` (default off) with `adopt_site`, `adopt_role` and `adopt_device_type` (the tenant's own rows only) and `adopt_names` (read-only); `last_maintenance_sync_at` and `last_inventory_at` (read-only). Writes: `seed_device_objid` (a PRTG object id), `send_credentials`, `auto_apply_registration` and `prune_devices` (default off), `send_tags` (default on) and `tag_site_role` (default off); `write_mode` (`v2`, `seed`, `none`, or blank before a check), `write_detail`, `write_checked_at`, `last_apply_at` and `last_apply_summary` (read-only). |
| `connections/defaults/` | Every status code with its label, whether it is fixed and why, the default map, and the states (named by the tenant) a code may map onto. |
| `connections/<id>/test/` | `POST`. Returns `ok`, `detail`, `version`, `probes`, `sensors`, `v2_available`, `v2_detail`, `write_mode` and `write_detail`; 502 when it fails. Records the version, API v2 answer, what PRTG can create and the error on the connection. |
| `connections/<id>/check-writes/` | `POST`. Asks PRTG what it can create: `{mode, detail, version}`, kept on the connection. |
| `connections/<id>/prtg-devices/` | `GET`. PRTG's devices, read live, for the seed device picker: `[{objid, name, host, group, paused}]`; 502 with PRTG's sentence. |
| `connections/<id>/status-now/` | `POST`. Runs a status read now; returns its counts (`linked`, `proposed`, `ambiguous`, `unmatched`, `sensors`, `deleted`, `gone`, `adopt`, `acknowledged`), 502 with PRTG's sentence when it fails. |
| `connections/<id>/maintenance-now/` | `POST`. Reconciles the maintenance pauses now; returns `paused`, `extended`, `resumed`, `left`, `failed`. 400 while `sync_maintenance` is off, 502 when PRTG cannot be read. |
| `connections/<id>/rotate-hook-token/` | `POST`. A new push token: `{token, path}`, shown this once. |
| `connections/<id>/plan-now/` | `POST`. Runs the planning pass now; returns `scoped`, `create`, `add_sensor`, `remove_sensor`, `move`, `not_applicable`, `no_address`, `awaiting_link`, 502 with PRTG's sentence when its groups cannot be read. Writes nothing to PRTG. The connection keeps `last_plan_at` and `last_plan_summary`; a status read's counts carry the same under `plan`. Registration fields on the connection: `register_all`, `register_profile` (a profile of this connection), `register_group_id` and `register_group_path`. |
| `policies/` | CRUD (`?connection=`): `name`, `enabled`, `priority` (lower first), `scope` (`global`, `region`, `site`, `location`, `platform`, `device_type`, `device_role`) with its target (`region`, `target_site`, `location`, `platform`, `device_type`, `device_role` - only the scope's own is kept), `match_tags`, `match_name`, `match_hardware`, `applies_to_devices`, `applies_to_vms`, `profile` (required, this connection's), `group_id` (required) and `group_path`. Every target must be the active tenant's. `policies/<id>/` also carries `match_count`. |
| `policies/<id>/matches/` | Every device and VM the policy matches now, by the planning pass's own matching, limited to the objects the caller may view, paged (`page_size` honoured): `{kind, id, name, site, role, platform, prtg_sync, linked, link: {objid, name, url}, managed, via, reason, group_policy: {id, name}, wins_group, policies}`. `group_policy` is the policy that decides the object's group (null when the connection does), `policies` every enabled policy that matches it. `?prtg_sync=` (`inherit`, `always`, `never`, comma-separated) and `?linked=1\|0` narrow it. Needs view on PRTG policies. |
| `profiles/` | CRUD (`?connection=`) with `definitions` nested in order: `{id, kind, kind_label, form, name, params, interval_seconds, required, tags}`. Writing `definitions` replaces the list; a row with an existing `id` is updated. `kind` is a Danbyte kind or any PRTG kind id (`form` `danbyte` or `generic`; PRTG's id of a kind with a Danbyte form is stored as the Danbyte kind). A Danbyte kind's `params` are checked against it and stored with its defaults; a PRTG-only kind's are `section.field` keys, typed by PRTG's create form when one is kept and otherwise stored as given (PRTG checks them when it creates the sensor; saving never asks PRTG). Deleting a profile in use answers 400. `profiles/kinds/` lists the kinds, their parameters and PRTG's intervals; `POST profiles/starter/ {connection}` makes the starter profile. |
| `groups/?connection=<id>` | PRTG's probes and groups: `{connection, read_at, groups: [{objid, name, kind, path, probe, parent_id}], error}`. Kept on the connection and read again after one status interval, or with `refresh=1`. Needs view on PRTG policies. |
| `plan/?device=` or `?virtual_machine=` | What PRTG has and would get for one object, per enabled connection: `{connection, prtg_sync, linked: {objid, name, host, group, matched_by, created_here, created_at, url} | null, managed, registers, registration: {mode, policies, group}, planned: {create_device, sensors: [{key, name, kind, kind_label, interface}], move: {from, to} | null, remove: [{objid, name, kind}], reasons, queued, ready, statuses, applying}, via, reason, reason_issue, group, policies, profiles, sensors: [{name, kind, kind_label, params, interval_seconds, tags, required, interface, template, present, sensor}], credentials, problems, issues, last_apply}`. `linked` is whether it is in PRTG (the stored link); `managed` whether Danbyte created that PRTG device; `registers` whether anything registers it, and `registration.mode` what: `always`, `policies`, `register_all`, `never` (excluded) or `none`. `planned.reasons` say why nothing is planned; `queued` counts its planned rows in the review queue, `ready` those **Add to PRTG now** would write, `statuses` how they stand, and `applying` whether an apply of them is queued or running. `connection` carries `auto_apply` and `write_mode`. `last_apply` is what Danbyte last wrote for it, `{at, kind, ok, detail, result, by}` or null (a pending create's last attempt when there is no link yet). `problems` are sentences; `issues` the same as `{code, text, policy, object}`, where `policy` is the policy to edit and `object` (`{kind, id}`) the object whose tab fixes it; `reason_issue` is `reason` in that shape, empty for a linked object nothing registers. Needs view on the object; asks PRTG nothing. |
| `links/` | List (`?connection=`, `?device=`, `?virtual_machine=`), retrieve, delete (unlink). Each link has its `device` or `virtual_machine`, PRTG object id, name, host, probe, group, `matched_by`, `state`, `sensor_counts` and `url`, and what the maintenance mirror did: `maintenance_paused_at`, `maintenance_paused_until`, `maintenance_events` (`[{id, name}]`) and `maintenance_note`; `created_here` and `last_apply` (what Danbyte last wrote for it); `sent_tags` (the Danbyte tags written onto the PRTG device); `paused`; `write_mode`, the connection's (whether sensors can be added by hand). The `sensors/`, `scan/`, `discover/` and `sensor-schema/` actions below need `change` on PRTG sensors and view on the device or VM. |
| `sensors/` | Every imported sensor, read-only. Filters: `connection`, `device`, `virtual_machine`, `ip_address`, `interface` (a device or VM interface), `service` (see [Where sensors show up](#where-sensors-show-up); a malformed id answers 400), `state` (comma-separated; `paused` picks the paused sensors), `kind` (raw or display name), `probe`, `group`, `alarms=1` (down and degraded, not paused), `hide_paused=1`, `search`; `ordering` is `name`, `-name` or `alarms` (worst, then newest problem first); `page_size` honoured. Each row has its `device` or `virtual_machine`, `link`, PRTG's `status` word, the mapped `state`, `paused`, `acknowledged`, the message, the record above, `url` (the sensor in PRTG), `device_url`, and what it watches: `ip_address` (`{id, address, dns_name}`), `interface` (`{id, name, kind, parent}`, `kind` `interface` or `vm_interface`, `parent` the device or VM) and `service` (`{id, name, ports}`), each null when nothing matched. |
| `sensors/<id>/acknowledge/` | `POST {note}`. Acknowledges a down sensor (*Down*, *Down (Partial)*) in PRTG with `[Danbyte] <name>: <note>`, then answers the sensor as it now reads. 400 while the connection's `write_acknowledgements` is off or the sensor is not down, 502 with PRTG's sentence. Each row of `sensors/` carries `ackable`: whether this would be accepted now. |
| `sensors/<id>/pause/` | `POST {minutes, note}`. Pauses the sensor in PRTG for `minutes` (1 to 527040), or until resumed when `minutes` is null or absent; answers the sensor, now paused. |
| `sensors/<id>/resume/` | `POST`. Resumes the sensor, reads the device's sensors again, and answers the sensor. |
| `links/<id>/pause/`, `links/<id>/resume/` | `POST {minutes, note}` and `POST`. The same for the PRTG device behind a link - PRTG pauses its sensors with it; answers the link, whose `paused` says whether PRTG holds it paused. |
| `connections/<id>/sensor-kinds/` | `GET` (`?link=` the device to ask about, else the first linked device; `?refresh=1`). The kinds that can be [added by hand](#adding-sensors-by-hand) or put in a [profile](#sensor-profiles): `{mode, source, read_at, danbyte_forms, detail, kinds: [{id, name, description, help, category, form, danbyte_form, danbyte_kind, scan, needs_scan, credentials, credential_group, manual, copy_from_seed}]}`. `source` is `prtg` (API v2, kept a day) or `danbyte` (seed copies or no writes); `form` is `danbyte` or `generic`. |
| `connections/<id>/device-templates/` | `GET` (`?refresh=1`). PRTG's device templates, kept a day: `{source, read_at, templates: [{file_name, name, id}]}`; `source` `defaults` lists PRTG's stock generic ones when the list cannot be read. |
| `connections/<id>/sensor-schema/?kind=` | `GET` (`?link=`, `?refresh=1`). PRTG's create form for a kind at connection level, as `links/<id>/sensor-schema/` answers it, kept on the connection for a day; the profile editor's form for PRTG-only kinds. PRTG answers only under a device that can take the kind: when the first linked device (or `?link=`) has no form, up to three other linked devices whose kind list names it are asked. When none can, the answer is 200 with `fields: []` and a `note`. |
| `links/<id>/sensor-schema/?kind=` | `GET`. PRTG's create form for a kind as fields: `{kind, fields: [{key, section, section_title, name, label, type, default, required, options, minimum, maximum, help}], scan: {section, field} \| null}`; `type` is `text`, `password`, `number`, `select`, `multi` or `checkbox`. |
| `links/<id>/scan/` | `POST {kind}`. PRTG's metascan of the device: `{kind, rows: [{value, name, status, connected, info}]}`. Needs API v2 writes; 502 with PRTG's sentence. |
| `links/<id>/sensors/` | `POST {kind, name?, params, interval_seconds?, tags?, interfaces?, request_id?}`. Adds a sensor now: `kind` is a Danbyte kind or a PRTG kind id; `params` are the kind's parameters, or `{"<section>.<field>": value}` for a generic kind; `interfaces` the picked scan rows (`[{value, name}]`, one sensor each, at most 50); `request_id` makes a retry find what an earlier attempt made. Answers 201 `{detail, objids, failed, sensors}` with the new rows as the re-read imported them; 400 with a sentence when it cannot be written, 409 while another write to the connection runs, 502 when PRTG refused. |
| `links/<id>/discover/` | `POST {template?}`. Runs PRTG's auto-discovery on the device, with a device template file name or the device's own; answers `{detail}`. |
| `sensors/summary/` | Counts for a status strip in one query, with the list's filters: `down`, `degraded`, `up`, `unknown` (not paused), `paused`, `acknowledged`, `total`, `read_at`. |
| `sensors/<id>/channels/` | The sensor's channels, read from PRTG at most once per status interval: `{fetched_at, summary, rows}`, each row `{id, name, value, value_raw, unit, kind, state, status, lookup_label, limits: {warn_min, warn_max, error_min, error_max}, lookup_states: [{value, to, label, state}], min, max, primary}`. `kind` is `number`, `percent`, `lookup` or `text`; a lookup `state` is `ok`, `warning`, `error`, `none` or `unknown`. Needs view on the device or VM. 502 with PRTG's sentence when PRTG cannot be read and nothing is cached; `stale: true` when the last read is served instead. |
| `sensors/<id>/history/?range=1h\|24h\|7d&channel=<id>` | `{range, avg, fetched_at, stale, channels: [{id, name, unit, points: [{t, v}]}]}`, read at most once per range and interval, at most 400 points per channel. `channel` narrows to one. Needs view on the device or VM. |
| `changes/apply-object/` | `POST {device}` or `{virtual_machine}`, optionally `{connection}`. **Add to PRTG now**: plans the object, then writes every ready planned row of it - the device, then its sensors - through the same writer as **Apply**. Removals are never written here. Answers one entry per connection `{connection, applied, failed, results: [{id, kind, ok, detail, status}], link: {id, objid, name, url} \| null}`; 409 while another write to the connection runs, 400 when no connection can write. Needs change on the review queue and view on the object. |
| `changes/<id>/decide/` | `POST` on a *Needs a decision* row: `{link: {kind, id}}` links the row's PRTG device to that candidate, `{remote: <objid>}` links the row's object to that PRTG device, `{create: true}` creates a separate PRTG device for it. Answers `{ok, detail, status, result}`; 400 with the reason when the choice cannot be made. |
| `changes/` | The review queue, the same shape as Zabbix's: list (`?connection=`, `?ignored=1`, and `?device=`, `?virtual_machine=` or `?object=` for one object's rows), `<id>/apply/`, `<id>/dismiss/`, `<id>/restore/`, `apply-all/` (body `{"connection": …}`, skips *Needs a decision* and adoptions that cannot be placed). Kinds: `link_device`, `adopt` (no device; `key` and `detail.objid` are the PRTG object id, `detail` carries `name`, `host`, `address`, `group`, `probe`, the placement as `site`/`site_id`, `role`/`role_id`, `device_type`/`device_type_id`, `rule`, `defaulted`, and `reason` while it cannot be placed), `ambiguous`, and the planned kinds `create_device`, `add_sensor` (`key` is the sensor's `danbyte-def-` tag), `remove_sensor` (`key` is the PRTG sensor id), `move_device`, `update_host` and `remove_device` - see [Planned changes](#planned-changes). A planned row's `detail` carries `reason` and `fix_link` when it cannot be written, and what applying it did: `result` (`device`, `sensors` by tag, `credentials`, `templates`), `log` (`[{at, by, ok, detail, steps}]`), `applied` or `last_error`. `applicable` says whether apply can run now; `status` is `ready`, `attention`, `applied`, `failed` or `decision`; `destructive` marks removals. `last_error` keeps PRTG's whole answer; when an SNMP scan failed it reads *PRTG could not read the interfaces over SNMP. Check the device's SNMP credentials and that PRTG can reach it.*, with PRTG's own text under `prtg` and an `issue` (`snmp_scan`) linking to the object's Access tab, and so does the log entry. A *Needs a decision* row's `detail` carries `remote` (`{objid, name, host, group}`) and `candidates` (`[{kind, id, name, site, address}]`), or `remotes` when one object matches several PRTG devices; `decision` is `{can_create}`. `<id>/apply/` answers `{ok, detail, status, result}` (400 when the row cannot be written, 502 when PRTG refused). `apply-all/` applies ready rows and skips removals; `apply-selected/` (`{ids: [...]}`, at most 500, removals included) and `dismiss-selected/` act on the tenant's rows named, `apply-selected/` answering `{applied, failed, results: [{id, ok, detail, status}]}`. |
| `adoption-rules/` | CRUD for where adopted PRTG devices land: `scope` (`name`, `group`, `probe`, `ip`), `pattern` (glob, `regex:`, or a CIDR for `ip`), `site`, optional `role` and `device_type`, `weight` (lower first), `enabled`. Site, role and type must be the tenant's own. |
| `sensor-pins/?device=\|virtual_machine=\|ip_address=\|interface=\|vm_interface=\|service=` | Sensors and channels pinned to an Overview, in order: `{id, sensor, channel_id, display, position, device, virtual_machine, ip_address, interface, vm_interface, service, sensor_info}`, exactly one of the six set. `POST {sensor, channel_id, display}` pins one (`display` is `auto`, `gauge`, `lookup` or `value`; a channel pins once, at most 24 per object); with no object named it goes on the sensor's own device or VM, and `ip_address`, `interface`, `vm_interface` or `service: <id>` - or `parent: {kind, id}` - pins it on that object, which must be the one the sensor is linked to (otherwise 400). `POST {sensor}` with no or a blank `channel_id` pins the whole sensor (`channel_id` reads `""`, once per sensor and object, beside its channel pins; `sensor_info` carries `last_value` and `last_check_at` for its tile); `DELETE <id>/` unpins; `POST reorder/ {<object field>, order: [pin ids]}` sets one object's order. Writes need change on PRTG sensor pins; every call needs view on the pinned object and on the sensor's device or VM. |
| `device-status/?device=`, `?virtual_machine=` or `?ip=` | One entry per link: connection, PRTG device and its URL, `matched_by`, the roll-up, counts and the down and degraded sensors. Empty when the caller may not view the device or VM. |
| `device-states/` | `{device id: {state, down, warning, name, url}}` for every linked device the caller may view. Feeds the device-list column. |
| `vm-states/` | The same for virtual machines. Feeds the VM-list column. |
| `hook/<token>/` | `POST`, no session: the push receiver above. 202 when accepted. |

**Retries.** Auto-apply picks up every Ready row, old ones included. A row whose apply failed is tried again after 2, 10 and then 30 minutes; after five failed tries in a row it stops and leaves the row as *Failed* for a person to retry. **Retry** in the queue always tries at once.


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
set under **Registration defaults** on the connection form (shown whenever
the connection can write, above the *Register all* switch).

**The host PRTG polls** is chosen in this order:

1. **PRTG polls** on the object (`prtg_host`).
2. Its primary address.
3. Its OOB address (devices).
4. The first address assigned to it or to one of its interfaces - the
   lowest, IPv4 before IPv6.
5. With none of those usable, the DNS name of its primary or first address.

An address excluded from monitoring is not usable. With nothing left the
object still gets its **Create in PRTG** row, as *Needs attention* with
*It has no address PRTG can poll*. The row's detail records which rule chose
the host (`host_source`: `override`, `primary`, `oob`, `assigned`, `dns`,
and `host_note`, *Host 10.0.0.12 from the first assigned address*); so does
the link of a device Danbyte creates (`host_source`). When a device Danbyte
created on a fallback host (OOB, first assigned address, DNS name) later has
a stronger one - typically a primary address set after it was created - the
next plan proposes **Update host in PRTG** (`update_host`).

**Plan on save.** When a device's or VM's PRTG setting (or its **PRTG
polls** host) changes - through its form, the Monitoring tab's **Register in
PRTG**, or the API - Danbyte plans that one object at once, from what it
holds (the stored link and sensors and the last group list; PRTG is not
asked), so its queue row exists the moment the save returns. With **Apply
automatically** on, its ready rows are then applied in a short background
job, through the same writer the beat uses, so the save does not wait on
PRTG. The save's response carries `prtg_plan: {state, connections, object,
issue}` - `state` is `applying`, `planned`, `attention`, `excluded` or
`none`, `issue` the first thing blocking the object's rows - and the form
says **Being added to PRTG**, **Planned for PRTG**, or **PRTG needs
attention:** followed by that issue, with its fix link and a link to the
object's rows in the review queue. Under the
PRTG select one muted line says what happens next: *Planned changes wait in
the Review queue* or *Applied automatically*.

**The Sensors tab** shows with the integration on, linked or not. Until PRTG
has sensors for the object it shows one card per connection, naming the
connection and linking to the PRTG page:

| Card | When | Offers |
|---|---|---|
| **Excluded from PRTG** | *Exclude from PRTG* is set. | A link to the edit form. |
| **Not in PRTG** | Nothing registers it. | The reason, with its links (policies, Monitor in PRTG, Register all). |
| **Planned for PRTG** | Planned and waiting in the review queue (or for the next pass with Apply automatically on). | What will be created, **Add to PRTG now** (writes the object's device and sensors at once, then shows progress until the link and sensors appear) and **Open review queue**, filtered to the object (`/prtg?tab=review&object=<id>`). |
| **Needs attention** | Something is missing, or the last apply failed. | Each issue with its fix link (*Set a primary address*, to the object's IPs tab, first when the object has no address PRTG can poll), the failure, Open review queue filtered to the object's rows. |
| **Adding to PRTG…** | An apply runs or the automatic apply is queued. | The card follows the plan every few seconds until PRTG has the device. |
| **In PRTG, no sensors yet** | Linked, but PRTG has no sensors on it. | **Add sensor** and **Discover**. |

The Monitoring tab's PRTG details carry the same **Add to PRTG now**.

In the policy editor, the **+** beside **Sensor profile** makes a new profile
without leaving the policy; once saved it is picked. When Danbyte has never
read PRTG's groups, the group picker says so and links to the connection:
test it, or use the picker's refresh, to read them.

**Who a policy hits.** A policy's name on the **Policies** tab opens its
detail (`/prtg?tab=policies&policy=<id>`): the policy's facts and a
**Matches** table of every device and VM it matches now, headed with the
count and how many are linked in PRTG. Each row has the object, its site,
role and platform, its PRTG setting (*Follow policies*, *Monitor in PRTG*,
*Exclude from PRTG*), the PRTG device when linked, and which policy decides
its group: *This policy*, another policy (linked to its detail), the
connection, or *Not in plan* when the object is left out (excluded, retired,
an excluded address, or no PRTG check under the checks scope). The matching
is the planning pass's own, so the table is what the next plan sees. A
disabled policy still lists who it would hit. The detail's **Edit** opens
the editor, as does `/prtg?tab=policies&edit=<id>`.

## Sensor profiles

A profile (the **Profiles** tab) is an ordered list of sensors. **Starter
profile** makes an ordinary, editable one: Ping, SNMP uptime, SNMP traffic
on connected interfaces, and HTTPS where the object has a service on port
443. Nothing is created until you press it.

Each sensor has a kind, its parameters, an optional name, an interval (one
of PRTG's, or inherit PRTG's), the tags to set in PRTG and **Required**.

The **Sensor** button opens the sensor-kind picker, the same one the [Add
sensor](#adding-sensors-by-hand) dialog uses: a search box (name,
description, PRTG kind id), a category rail, and a sortable list - **Name**,
**Category**, **Form** (*Danbyte* or *PRTG*), **Needs scan**,
**Credentials**. The kinds with Danbyte's own form are pinned under
**Standard**, and stay first while searching; the rest is PRTG's whole list
for the connection (read through any linked device, kept a day; **Refresh
from PRTG** reads it again). Arrow keys move through the list and Enter
picks. On a phone the columns fold into each row. Until PRTG's list has been
read - no API key, nothing linked yet, or a seed-copy server - only the
Standard kinds are there, with a link to test the connection.

**Add sensor** under the list opens the same picker with a checkbox per
row: click a row (or Enter) to check it; search and the category rail still
narrow the list and keep what is checked. The footer counts the choice
(*3 selected*) and **Add 3 sensors** appends one definition per kind, with
the name blank, the interval inherited and **Required** on. The **Sensor**
button of an existing row still picks one kind.

Danbyte's own kinds:

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

Any other kind PRTG lists can be a profile sensor too. A profile is tied
to no PRTG device, so adding such a kind always works at once; its settings
are optional. Danbyte reads PRTG's create form for it in the background
(`connections/<id>/sensor-schema/?kind=`, kept a day) and shows its fields
(the generic form of the Add sensor dialog) when it arrives. PRTG describes
a kind only under a device that can take it - the PRTG core server's own
device, for one, has no forms at all - so Danbyte asks the first linked
device and then up to three other linked devices whose PRTG kind list
(read once a day per device) names the kind. When none can, or PRTG cannot
be reached, the editor says *PRTG's defaults apply; add settings below if
needed* in muted text, with a small editor for `section.field` settings
typed by hand - never an error. Saving never needs the form: the settings
are stored as `section.field` keys (`{"portspecific.port": 8443}`), typed
by the form when one is already kept, and PRTG checks them only when it
creates the sensor on a matched device. A refusal (a missing credential, a
bad value) shows on that row of the review queue with PRTG's sentence. The
planning pass proposes it like any other sensor, and the writer creates it
through API v2 the way a hand-added sensor is: those settings sections, the
name and Danbyte's tags; with no settings PRTG's defaults apply. A kind
that needs device credentials in PRTG - *Proxmox VE Cluster Health* needs
the device's Proxmox credentials - is described and created without them,
but its sensor only works once they are set on the device. A kind PRTG fills from a
scan gets every row the scan finds. An existing PRTG sensor counts as one
when it carries the definition's tag or is of exactly that PRTG type. A
kind whose credential group is SNMP or Windows is planned with the same
credential checks as Danbyte's own. On a seed-copy server PRTG-only kinds
cannot be created.

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
| **Create in PRTG** | An object should be in PRTG and is not linked - also when something blocks it, as *Needs attention*. | Name, host and the rule that chose it, the group or probe with its path, the policies and profiles, the sensors, any templates, the tags (`danbyte`, `danbyte-<uuid>`) and the credentials it would send, by name only. |
| **Add sensor in PRTG** | A linked object lacks a required sensor. | The PRTG device, the profile entry, the sensor's name, kind, parameters and tags, and the interface for traffic. |
| **Remove from PRTG** | A sensor carries a `danbyte-def-` tag no profile wants any more. | The sensor and the tag. |
| **Move in PRTG** | A linked object is under another group than its policy names. | From and to, by path. |
| **Update host in PRTG** | A device Danbyte created on a fallback host now has a stronger one (a primary address set later). | From and to, and the rule that chose the new host. |
| **Remove device from PRTG** | A PRTG device Danbyte created belongs in PRTG no more (set to *Exclude from PRTG*, no policy matches, *Register all* off), and **Propose removing devices** is on. | The PRTG device and why. Never proposed for a device Danbyte did not create. |

A sensor already in PRTG counts when it carries the entry's tag, or when it
is of the same type (`Ping v2` counts as Ping; a traffic sensor named after
the interface counts for it). An optional sensor a linked object lacks is
not proposed. An object whose link is waiting in the queue gets no
**Create in PRTG** row; the pass counts it. A create that something blocks
- no address PRTG can poll, no group, a group gone, missing credentials, a
PRTG that cannot write - is proposed all the same, as *Needs attention*
with its issues, and counts toward the **Review queue** tab's badge. The
pass after the fix turns the same row *Ready*.

A row says why it could not be written as it stands - *PRTG has no group …
any more*, no group named, no SNMP profile, no Windows login, *This PRTG
cannot create objects through its API* - with links to where each is fixed
(below), and `applicable` is false. A sensor Danbyte created that somebody
deleted in PRTG is proposed again as **Add sensor in PRTG**, required or
not, with *Deleted in PRTG.* A sensor carrying a `danbyte-def-` tag that
Danbyte did not create is shown for removal but cannot be applied: remove
it in PRTG if it should go. A row that is no longer true goes away with the
next pass; an applied row stays a day as *Applied*. A pass whose group read
fails proposes and drops nothing.

The device's and VM's **Monitoring** tab has a chevron (**Details**) on its
PRTG row. It opens, in place, one card per connection - computed from what
Danbyte holds, PRTG is not asked:

| Row | Shows |
|---|---|
| **In PRTG** | **Yes** with the PRTG device (opens it in PRTG) and how it was matched (*matched by address*, *adopted*, *created by Danbyte*), or **No**. This is the stored link only, never the registration decision: a device PRTG has that nothing registers is still **Yes**. |
| **Managed by Danbyte** | **Yes, created on …** when Danbyte created the PRTG device, otherwise **No** - followed by the last apply (*Applied* or *Failed*, when, and PRTG's sentence when it failed), also for a create that has not made a link yet. The row itself carries a **Created by Danbyte** chip for such a device. |
| **Registration** | *Monitor in PRTG set on the object*, *Policy …* (each policy linked to its detail), *Register all*, *Excluded*, or *Nothing registers it* - with links to where it is set. |
| **Planned** | What the next plan proposes: create the device (and in which group), each sensor to add by name and kind, a move, a Danbyte sensor to remove - or *Nothing planned* with the reason. A linked device nothing registers is left alone: nothing planned, and no *Nothing registers this object* warning. |

Credential and group problems follow the card, each with its link. Under it,
**Register in PRTG** sets **Monitor in PRTG** on the object through its API,
which plans it at once (see *Plan on save*). It shows only while the object
is not in PRTG and not excluded, to someone who may change the object.
**Add to PRTG now** writes its ready rows at once, for someone who may apply
the queue. **Open review queue** shows when the queue holds planned rows for
the object, and opens the queue filtered to it. The block starts collapsed and the browser remembers whether
you left it open.

Every reason says what is missing and where to fix it, with a link there:

| Reason | Links to |
|---|---|
| *Nothing registers this object. Add a policy that matches it, set Monitor in PRTG on the object, or turn on Register all.* | Policies, the object's edit form, Register all on the connection |
| *No PRTG group chosen. Set one on the matching policy or under Register all on the connection.* | The policy's editor, Register all on the connection |
| *The PRTG group … is gone. Pick another on the matching policy or under Register all on the connection.* | The same |
| *No SNMP profile applies to …. Set one on its Access tab.* (a VM: *its SNMP tab*) | The device's Access tab, the VM's SNMP tab |
| *Danbyte holds no Windows login for …. Add one on its Access tab.* | The device's Access tab |
| *It has no address PRTG can poll. Set a primary address, or the host PRTG polls on the object.* | Set a primary address (the object's IPs tab), the object's edit form |
| *This PRTG cannot create objects through its API. Name a seed device on the connection, or use PRTG 26.2.120 or later.* | The connection |
| *It carries a Danbyte tag, but Danbyte did not create it. Remove it in PRTG if it should go.* | - |
| *Its status … is left out of PRTG.*, *Its primary address is excluded from monitoring.*, *It has no PRTG check …*, *Exclude from PRTG is set on this object.*, *It is already in PRTG. Register all only adds new devices.* | The object's edit form, where it applies |

Planned rows in the review queue carry the same sentences in `reason`, and
the same as `issues` (`[{code, text, policy, object}]`).

### Working the queue

The queue is an inbox. Each row carries a status:

| Status | Means |
|---|---|
| **Ready** | It can be applied as it stands. |
| **Needs attention** | Something is missing; the row says what, with a **Fix** link. |
| **Applied** | Written to PRTG: the ids PRTG gave the device and sensors, and a link to the device in PRTG. |
| **Failed** | PRTG refused or could not be reached: its sentence (all of it in the pill's tooltip and the panel's log), **Retry** and **Skip** (**Skip this sensor** on a sensor row; it dismisses the row). A retry carries on where the last attempt stopped. When PRTG could not read the device over SNMP the row says so in one sentence, with a link to the object's Access tab, and the panel keeps PRTG's own words under it. |
| **Needs a decision** | An ambiguous match: its choices sit on the row (see [Matching](#matching-prtg-devices-to-danbyte-devices)). |
| **Dismissed** | Kept aside; shown when **Hide dismissed** is off, with Restore. |

**Apply** sits beside Dismiss on every row that can be applied (links and
adoptions too). Ticking rows brings up **Apply selected** and **Dismiss
selected**; **Apply all applicable** says how many rows of which kinds it
will write before it does. Removals are never part of *Apply all* or the
automatic apply: each is applied on its own row, after a confirmation that
names what PRTG will lose. The facet rail filters by status and kind;
`?object=<id>` shows one device's or VM's rows, with **Show all** to clear
it. The **Review queue** tab counts the rows that need a person: ready,
needs attention and needs a decision.
Clicking a row opens its whole plan beside the table: host, target group,
each sensor with its parameters, interface and interval, the credentials by
name, the policies and profiles that produced it, and the apply log - every
attempt, who made it, and each write it did.

## Writing to PRTG

Applying a planned change writes it to PRTG:

| Kind | What Danbyte does |
|---|---|
| **Create in PRTG** | Creates the device under the planned group or probe, named after the object, with the chosen host (see the order under [Registering devices and VMs](#registering-devices-and-vms)) and the tags `danbyte` and `danbyte-<uuid>`; writes its credentials when **Send credentials** is on; creates every planned sensor, each tagged `danbyte` and its `danbyte-def-` tag; runs the device templates; links the object, marked as created by Danbyte. |
| **Add sensor in PRTG** | Creates the one sensor on the linked device. |
| **Remove from PRTG** | Deletes the sensor - only one Danbyte created. |
| **Move in PRTG** | Moves the device to the planned group or probe. |
| **Update host in PRTG** | Sets the host of a device Danbyte created (`PATCH /devices/{id}` on API v2, the `host` property otherwise) and records it on the link. Cannot be applied while the connection cannot write. |
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

### Tags

**Send Danbyte tags** (on by default) gives a device Danbyte creates in
PRTG the object's own Danbyte tags as PRTG tags, beside its `danbyte` and
`danbyte-<uuid>` markers: each tag's slug, lower case, with anything PRTG
does not take in a tag turned into `-`, and no prefix. **Add site and role
tags** (off by default) adds `site-<slug>` and `role-<slug>` too. Sensors
Danbyte creates carry the profile entry's own tags (the definition's
**Tags** field, space-separated, *Added to the PRTG sensor*; the **Add
sensor** dialog's field works the same) and the object's tags.

The tags stay in step: on each status read Danbyte compares what the object
should send with what it last wrote (`sent_tags` on the link) and, for a
PRTG device it created, writes the difference - adding new tags and removing
only the ones it put there before. Tags set in PRTG by hand are never
touched. The Monitoring tab's **Managed by Danbyte** row lists the tags
sent.

### Applying automatically and pruning

**Apply automatically** lets the beat apply the ready creates, sensors and
moves after each planning pass, under the name *PRTG writer*, and applies an
object's ready rows right after its PRTG setting is saved; one writer runs
per connection at a time. It never removes anything. The connection's
Registration card shows **Auto-apply** on or off with the last apply. **Propose removing devices** makes the
planning pass propose **Remove device from PRTG** for a device Danbyte
created whose object no longer belongs in PRTG. Both are off by default,
and removals are always applied by a person, row by row.

## Adding sensors by hand

Profiles say what a device *should* carry; a sensor can also be added to a
linked device straight away. On a device's or VM's **Sensors** tab the PRTG
device's row has **Add sensor** and **Discover**, shown to anyone with
`change` on PRTG sensors while the connection can create objects (*API v2*
or *Seed copies*). The /prtg **Sensors** tab shows the same two buttons
above the table once its filters narrow it to one PRTG device.

**Add sensor** opens the [sensor-kind picker](#sensor-profiles), with a
checkbox per row, over the kinds PRTG offers that device, by category (SNMP, Windows, Web, Ping, Flow,
Network services, vendors, …), each with PRTG's description and a form
chip:

| Chip | The form |
|---|---|
| **Danbyte** | A kind Danbyte knows (Ping, SNMP uptime / CPU / memory / traffic, HTTP, SSL certificate, SSL security check, WMI CPU / memory / disk, Windows service): the same parameter fields as a profile's definition. |
| **PRTG** | Any other kind: the fields of PRTG's own create form for it, read from `GET /api/v2/experimental/schemas/{device}/post?kind=` - text, number, choice and checkbox fields. Inherited sections (access, schedule, interval) and read-only fields are left to PRTG; PRTG checks the values. |

The list is read from PRTG (`GET /api/v2/experimental/schemas/{device}`,
354 kinds on PRTG 26.3.124, 12 of them with a Danbyte form) and kept on the
connection for a day; the refresh button reads it again. On a seed-copy
server the list is Danbyte's own kinds that a copy can make, and the
sensor is a copy of the seed device's sensor of that kind.

Every form also takes a name (blank: the kind's default), an interval
(blank: inherited) and extra tags. **SNMP traffic** - and any generic kind
PRTG fills from a scan - has a second step: **Scan device** runs PRTG's
metascan and lists what it found, with **Select all** and **Connected
only**; each picked row becomes one sensor.

Check one kind and **Add 1 sensor** opens its form as above. Check several
and **Add N sensors** creates them one after another through the same
create call:

- A kind with Danbyte's form, no scan and no required parameter without a
  default (Ping, SNMP uptime, …) is created at once with its defaults.
- Every other kind - PRTG's form, a required setting, a scan - becomes a
  step, shown in turn as *2 of 5*: fill it in and add it, or **Skip**. A
  kind PRTG refuses stays on its step with PRTG's sentence, to fix or skip.
- A result list ends it: each kind **Created**, **Failed** with PRTG's
  sentence, or **Skipped**.

The sensor is created the way an applied **Add sensor in PRTG** row is
(API v2, or a seed copy), tagged `danbyte`, `danbyte-manual` and a
`danbyte-man-` key. A retry - the same dialog saved twice - finds the
sensor by that key instead of creating another. Danbyte records it as one
it created (so it may delete it), writes a journal note and change-log
entry on the device or VM, reads the device's sensors again and shows the
new card with a brief highlight. Its card carries an **Added from
Danbyte** chip. The planning pass never proposes removing a sensor added
by hand: only `danbyte-def-` sensors are profile sensors.

**Discover** runs PRTG's auto-discovery on the device (classic
`discovernow.htm`) with an optional device template - PRTG's list
(`GET /api/v2/experimental/devices/templates`, kept for a day) is offered
as suggestions, and a template file name can be typed. PRTG adds what it
finds on its own schedule; the sensors arrive with the next status read.
Discovered sensors carry no Danbyte tags.

---

PRTG is a trademark of Paessler GmbH. Danbyte is not affiliated with or
endorsed by Paessler.
