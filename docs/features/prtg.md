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
own way. Nothing is written to PRTG.

!!! note "What PRTG monitors stays configured in PRTG"
    Danbyte shows PRTG's sensors, channel values, limits and history; it does
    not edit them. There is no limit editor and no sensor settings. Every
    sensor and device links into PRTG for that.

## Turning it on

1. **Settings → Integrations → PRTG monitoring**. Off by default, per tenant,
   like every other integration. On, it adds **PRTG** under *Integrations* in
   the sidebar; off, the page is hidden and the API answers 404. Opened by
   link, the page says PRTG is off.
2. In PRTG, create an **API key** for the user Danbyte should act as (*Setup →
   Account Settings → API Keys*). Read access is enough for everything Danbyte
   does today.
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
sensor in PRTG.

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
- **A number that did not move** (*Days to Expiration* over an hour) reads
  *Steady over the last 1h* instead of a flat line; its graph says the same
  for a range in which it stayed put.
- **A lookup** gets a state timeline instead of a line: one coloured segment
  per run of the same state along the chosen range, no axis and no
  percentages. PRTG records a lookup channel's history as the share of each
  interval spent in one named state (*Root Authority Trusted (Yes)*, 0 %);
  Danbyte reads that back as the state.
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

Each channel card in the panel has a **Pin to Overview** toggle. Pinned
channels show on the device's or VM's **Overview** in a **Sensors** card: one
small tile per channel - the gauge, lookup bar or value, the channel and its
sensor, and the sensor's state when it is not up - in the order they were
pinned. A tile opens the sensor's panel; hovering it shows **Unpin**. The card
is absent until something is pinned. A pin keeps no reading: the tiles read
the channels as the panel does, and a sensor gone from PRTG takes its pins
with it. Pinning and unpinning need change on *PRTG sensor pins* and view on
the device or VM; site roles include the pins of their sites' objects.

The same channels can go on a dashboard: see
[Sensor widgets](dashboard.md#sensor-widgets).

**The Monitoring tab** gets one **PRTG** row per linked device or VM: the
roll-up pill, the state strip, the PRTG device and a link to the Sensors tab.
The rest of the tab is unchanged; like the Zabbix section, the row never
changes Danbyte's own status.

**Who sees it.** The sensors and channels are the device's or VM's data: the
channels and history need view on the device or VM as well as on PRTG
sensors. Site roles include PRTG device links, sensors and the review queue
for their sites (an `auth_api` migration gives roles made before 0.19 the same,
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
export. **Review queue** and **Links** are below.

## API

All under `/api/prtg/`, scoped to the active tenant, 404 while the integration
is off, and gated on the PRTG permissions (group *Monitoring*).

| Endpoint | Purpose |
|---|---|
| `connections/` | List, create, update, delete. `api_key` is write-only; `api_key_set` says whether one is stored. `status_interval_seconds` is 60-3600. `api_v2_url` is blank to derive it, and must name the same host as `url`. `engines` are the tenant's PRTG engines only. `state_map` takes the six editable codes onto `up`, `degraded` or `down`. A fixed code may only be `unknown`, and the map is stored complete. `link_mode` is `auto` or `review`; `push_enabled`; `hook_token_set` (read-only); `last_status_at` and `last_status_summary` (read-only). |
| `connections/defaults/` | Every status code with its label, whether it is fixed and why, the default map, and the states (named by the tenant) a code may map onto. |
| `connections/<id>/test/` | `POST`. Returns `ok`, `detail`, `version`, `probes`, `sensors`, `v2_available` and `v2_detail`; 502 when it fails. Records the version, API v2 answer and error on the connection. |
| `connections/<id>/status-now/` | `POST`. Runs a status read now; returns its counts (`linked`, `proposed`, `ambiguous`, `unmatched`, `sensors`, `deleted`, `gone`), 502 with PRTG's sentence when it fails. |
| `connections/<id>/rotate-hook-token/` | `POST`. A new push token: `{token, path}`, shown this once. |
| `links/` | List (`?connection=`, `?device=`, `?virtual_machine=`), retrieve, delete (unlink). Each link has its `device` or `virtual_machine`, PRTG object id, name, host, probe, group, `matched_by`, `state`, `sensor_counts` and `url`. |
| `sensors/` | Every imported sensor, read-only. Filters: `connection`, `device`, `virtual_machine`, `state` (comma-separated; `paused` picks the paused sensors), `kind` (raw or display name), `probe`, `group`, `alarms=1` (down and degraded, not paused), `hide_paused=1`, `search`; `ordering` is `name`, `-name` or `alarms` (worst, then newest problem first); `page_size` honoured. Each row has its `device` or `virtual_machine`, PRTG's `status` word, the mapped `state`, `paused`, `acknowledged`, the message, the record above, `url` (the sensor in PRTG) and `device_url`. |
| `sensors/summary/` | Counts for a status strip in one query, with the list's filters: `down`, `degraded`, `up`, `unknown` (not paused), `paused`, `acknowledged`, `total`, `read_at`. |
| `sensors/<id>/channels/` | The sensor's channels, read from PRTG at most once per status interval: `{fetched_at, summary, rows}`, each row `{id, name, value, value_raw, unit, kind, state, status, lookup_label, limits: {warn_min, warn_max, error_min, error_max}, lookup_states: [{value, to, label, state}], min, max, primary}`. `kind` is `number`, `percent`, `lookup` or `text`; a lookup `state` is `ok`, `warning`, `error`, `none` or `unknown`. Needs view on the device or VM. 502 with PRTG's sentence when PRTG cannot be read and nothing is cached; `stale: true` when the last read is served instead. |
| `sensors/<id>/history/?range=1h\|24h\|7d&channel=<id>` | `{range, avg, fetched_at, stale, channels: [{id, name, unit, points: [{t, v}]}]}`, read at most once per range and interval, at most 400 points per channel. `channel` narrows to one. Needs view on the device or VM. |
| `sensor-pins/?device=\|virtual_machine=` | Channels pinned to an Overview, in order: `{id, sensor, channel_id, display, position, device, virtual_machine, sensor_info}`. `POST {sensor, channel_id, display}` pins one (`display` is `auto`, `gauge`, `lookup` or `value`; the device or VM is the sensor's own; a channel pins once, at most 24 per object); `DELETE <id>/` unpins; `POST reorder/ {device \| virtual_machine, order: [pin ids]}` sets the order. Writes need change on PRTG sensor pins; every call needs view on the device or VM. |
| `changes/` | The review queue, the same shape as Zabbix's: list (`?connection=`, `?ignored=1`), `<id>/apply/`, `<id>/dismiss/`, `<id>/restore/`, `apply-all/` (body `{"connection": …}`, skips *Needs a decision*). Kinds: `link_device`, `ambiguous`. |
| `adoption-rules/` | CRUD for where adopted PRTG devices will land: `scope` (`name`, `group`, `probe`, `ip`), `pattern` (glob, `regex:`, or a CIDR for `ip`), `site`, optional `role` and `device_type`, `weight`, `enabled`. Adoption reads them once it ships. |
| `device-status/?device=`, `?virtual_machine=` or `?ip=` | One entry per link: connection, PRTG device and its URL, `matched_by`, the roll-up, counts and the down and degraded sensors. Empty when the caller may not view the device or VM. |
| `device-states/` | `{device id: {state, down, warning, name, url}}` for every linked device the caller may view. Feeds the device-list column. |
| `vm-states/` | The same for virtual machines. Feeds the VM-list column. |
| `hook/<token>/` | `POST`, no session: the push receiver above. 202 when accepted. |

## Coming

Sensors linked to their interfaces, addresses and services, acknowledgements
and maintenance windows in both directions, adopting PRTG devices, and keeping PRTG in step
with Danbyte's inventory. The connection's provisioning scope already defaults
to *every device the policies match* for that last part.

---

PRTG is a trademark of Paessler GmbH. Danbyte is not affiliated with or
endorsed by Paessler.
