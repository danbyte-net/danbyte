---
icon: lucide/shield-alert
---

# Known vulnerabilities

Danbyte keeps a local copy of public vulnerability data - NVD CVE records,
OSV package advisories, the CISA Known Exploited Vulnerabilities (KEV)
catalog and FIRST EPSS scores - so it can tell which devices, VMs and
installed applications run software with known vulnerabilities, inside your
tenant and site scope ([#451](https://github.com/danbyte-net/danbyte/issues/451)).

!!! note "Work in progress"
    This page grows with the feature. Today Danbyte has the **data store**
    (settings, records, upload import), the [server fetch](#server-mode),
    **product mappings** with their [picker](#map-your-products),
    **matching** against your inventory with a [priority](#priority), the
    [Vulnerabilities tab](#where-it-shows) on devices, VMs, platforms and
    applications, the [Vulnerabilities page](#the-vulnerabilities-page) with
    a [page per record](#a-records-page), [list columns](#on-the-devices-and-vms-lists),
    a [dashboard widget](dashboard.md), the [VEX in the SBOM](sbom.md#vulnerabilities-vex)
    and the API for them. Exceptions and browser sync are still to come.
    Until a mapping exists, an NVD or OSV upload keeps nothing and a server
    fetch asks for nothing.

It is **off by default** and deployment-wide. By default nothing is fetched
and nothing leaves the server: the update source is *upload* until a
deployment admin picks another, and the server contacts the public services
only with the feature on **and** the update source set to *server*.

## What is stored

The records are public data, shared by every tenant on the deployment (like
the [end-of-life catalog](end-of-life-data.md)). What a tenant maps, what
matches its inventory and its exceptions will be per tenant.

| Data | From | Kept |
|---|---|---|
| CVE record | NVD CVE API 2.0 or the NVD JSON 2.0 feeds | description, published/modified, status, CVSS, CWEs, the first 50 references, the configurations (which product versions are affected), fixed-in versions, CISA KEV dates |
| Package advisory | OSV (`GHSA-…`, `PYSEC-…`, `GO-…`, …) | affected packages with their version ranges and fixed versions, aliases, CVSS |
| KEV entry | CISA KEV catalog | date added, due date, required action, known ransomware use |
| EPSS score | FIRST EPSS | probability of exploitation in the next 30 days and its percentile, with the score date |

An OSV advisory that names a CVE as an alias is filed under that CVE, so its
KEV and EPSS data apply to it; the CVE then lists the advisory ids as
aliases. An advisory without a CVE keeps its own id. When both exist, NVD's
description and score win and OSV adds the affected packages.

Only records that name a **mapped product** are kept: an NVD year feed names
tens of thousands of products, and Danbyte stores the CVEs for the products
you have mapped. A CVE NVD has not analysed yet (*Awaiting Analysis*, no
configurations) names no product and is not kept until NVD adds them.

### CVSS

Danbyte uses NVD's own score (*Primary*) of the newest CVSS version, else the
newest score a CNA published. A CVSS 3.0 or 3.1 score is **recomputed from
its vector**; when the record's score does not match the vector (more than
0.05 apart), the score is dropped and the CVE is stored without one. The
severity always comes from the score - the record's own severity label is
ignored:

| Score | Severity |
|---|---|
| 0.0 | None |
| 0.1 - 3.9 | Low |
| 4.0 - 6.9 | Medium |
| 7.0 - 8.9 | High |
| 9.0 - 10.0 | Critical |

CVSS 4.0 and 2.0 scores are kept as published and marked unverified (CVSS 2.0
has no Critical: 7.0 and up is High). OSV advisories carry only a vector, so a
4.0 or 2.0 vector from OSV is kept without a score.

## Turn it on

A deployment admin (`users.manage` without tenant narrowing) opens
**Settings → General → Vulnerability data** (or uses
`PATCH /api/vulnerabilities/settings/`). The card has:

- **Enabled** and the **Update source**. Under the source, one line says
  what it needs: *Upload* - nothing reaches the internet; *Server* - the
  server reaches NVD, OSV, FIRST and CISA. *Browser* is listed but not
  available yet.
- In server mode: the **NVD API key** (a password field; it shows *Set*
  when one is stored, never the key, and **Clear key** removes it),
  **Fetch EPSS scores**, **Fetch the CISA KEV catalog** and the four mirror
  URLs.
- How many records are stored, the last run (status, who started it, what
  it stored, its error) and **Refresh now** in server mode.
- **Import file** with the **File kind** (NVD records, OSV advisories, CISA
  KEV, EPSS scores). The run is followed until it ends. In upload mode the
  card lists the `curl` commands from [Upload](#upload-airgapped-installs).

The card saves only the fields you changed; a blank key field keeps the
stored key.

| Setting | Meaning |
|---|---|
| `enabled` | Off by default. While off, uploads are refused, nothing runs and every vulnerability tab and card is hidden. |
| `update_source` | `upload` (default), `server` or `browser`. Upload and [server](#server-mode) work today. |
| `nvd_url`, `epss_url`, `kev_url`, `osv_url` | Blank uses the public service. A mirror goes here; it must be `https://`. For NVD, EPSS and OSV it is the base URL the API paths are added to (`https://services.nvd.nist.gov`, `https://api.first.org`, `https://api.osv.dev`); for KEV it is the catalog file itself. |
| `sync_epss`, `sync_kev` | Whether a server sync also fetches EPSS and KEV (on by default). |
| `nvd_api_key` | Write-only. Stored encrypted; reads show `nvd_api_key_set`. A blank value keeps the stored key, `nvd_api_key_clear: true` removes it. |

Everyone signed in can read `enabled`; everything else, and every change, is
deployment-admin. Settings changes are in the [change log](change-log.md),
with the key shown only as set or not set. Run bookkeeping (last sync time,
status, error) is not.

## Upload (airgapped installs)

On a machine with internet, download the files and upload them with
`POST /api/vulnerabilities/import/` (multipart `file` and `kind`):

| `kind` | File |
|---|---|
| `nvd` | A saved NVD CVE API 2.0 response, or an NVD JSON 2.0 feed (`nvdcve-2.0-2024.json.gz`, `nvdcve-2.0-modified.json.gz`); `.json`, `.json.gz` or a `.zip` of them |
| `osv` | An OSV ecosystem archive (`all.zip`), one OSV record, a JSON list of records, or an OSV API response with `vulns`; `.zip`, `.json` or `.json.gz` |
| `kev` | The CISA KEV catalog, `.json` or `.csv` |
| `epss` | The EPSS scores, `.csv` or `.csv.gz` (with its `#model_version…,score_date…` first line) |

For example:

```sh
curl -o ios_xe.json 'https://services.nvd.nist.gov/rest/json/cves/2.0?virtualMatchString=cpe:2.3:o:cisco:ios_xe&resultsPerPage=2000'
curl -O https://nvd.nist.gov/feeds/json/cve/2.0/nvdcve-2.0-modified.json.gz
curl -O https://osv-vulnerabilities.storage.googleapis.com/PyPI/all.zip
curl -O https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json
curl -LO https://epss.empiricalsecurity.com/epss_scores-current.csv.gz
```

The request saves the file and answers `202` with the run; a background job
on the `low` queue parses it. Poll `GET /api/vulnerabilities/sync/<run id>/`
until `status` is `ok` or `failed`. The run's `counts` say what happened:

| Count | Meaning |
|---|---|
| `records` | Records read from the file. |
| `created`, `updated` | Records stored new, or replacing an older version. |
| `unchanged` | Already stored at the same or a newer version. Uploading the same file twice writes nothing. |
| `not_tracked` | Records that name no mapped product, so were not kept. |
| `not_in_store` | KEV or EPSS rows for a CVE that is not stored. Upload NVD/OSV data first. |
| `cvss_mismatch` | Scores dropped because they did not match their vector. |
| `invalid` | Records that failed validation and were skipped; `errors` shows the first 20. |

Upload KEV and EPSS after the NVD and OSV files: they only add to CVEs that
are already stored. An EPSS file older than the stored scores does not roll
them back.

### Limits

Uploads are deployment-admin only, and one update runs at a time (a second
upload answers `409`). A run that has said nothing for two hours is marked
*abandoned* so it cannot block the next one.

| Limit | Value |
|---|---|
| Upload size | 512 MB ([`DANBYTE_VULN_IMPORT_MAX_BYTES`](../reference/settings.md#vulnerability-data-uploads-danbyte_vuln_import_max_bytes)) |
| Unpacked content (gzip or zip) | 3 GB |
| One record | 8 MB of JSON |
| Records per file | 500,000 |
| Files in a zip | 500,000; an OSV record file at most 8 MB |
| KEV file / EPSS file, unpacked | 64 MB / 512 MB |

Everything is read as a stream, one record at a time, so a large feed does
not have to fit in memory; a file past a limit, a zip or gzip bomb, or
malformed JSON fails the run with a message. Records stored before the
failure stay. The uploaded file is deleted when the run ends; it is kept
under `MEDIA_ROOT/vuln-imports/` while it waits, which is not served.

## Server mode

With the feature on and `update_source` set to `server`, the Danbyte server
fetches the data itself, daily and on **Refresh now**. In any other mode, or
while the feature is off, nothing below is contacted - an airgapped install
on the default *upload* source never makes a request.

### What is contacted

| Service | Request | When | What Danbyte sends |
|---|---|---|---|
| NVD (`services.nvd.nist.gov`) | `GET /rest/json/cves/2.0?virtualMatchString=cpe:2.3:<part>:<vendor>:<product>&resultsPerPage=2000&startIndex=…` | once per mapped CPE product, one request per 2000 CVEs | the CPE product, the date window; the API key as the `apiKey` header when one is set |
| OSV (`api.osv.dev`) | `POST /v1/querybatch`, then `GET /v1/vulns/<id>` | one batch per 1000 mapped packages, then one request per advisory that is new or changed | the package URLs, without versions |
| CISA (`www.cisa.gov`) | `GET` the KEV catalog JSON | once per run, when `sync_kev` is on | nothing |
| FIRST (`api.first.org`) | `GET /data/v1/epss?cve=…` | 100 CVEs per request, when `sync_epss` is on | CVE ids of stored records |

Danbyte asks for whole products, not versions: every CVE that names
`cisco:ios_xe` is fetched and matched to your versions locally, and the
inventory itself (device names, versions, addresses) never leaves the server.
A proxy or firewall needs to allow those four hosts (or the mirrors you set).
`HTTPS_PROXY` / `NO_PROXY` in the service environment are honoured.

Every request goes through the [outbound-request guard](../reference/settings.md#outbound-requests-ssrf-guard):
the host must resolve to a public address (or one a deployment admin
allow-listed), the connection is pinned to that address, and redirects are
never followed. Each answer is read as a stream with a size cap (an NVD page
256 MB, an OSV batch answer 32 MB, an OSV record 8 MB, the KEV catalog
64 MB, an EPSS answer 4 MB) and parsed by the same code as an upload, so the
same validation and CVSS recomputation apply.

### Incremental updates

- **NVD** - each product keeps a cursor: when it was last fetched in full
  and whether that worked. A product fetched less than 110 days ago asks only
  for CVEs modified since (`lastModStartDate`/`lastModEndDate`, with ten
  minutes of overlap; NVD allows at most 120 days). A product never fetched,
  or last fetched longer ago, is fetched whole. The cursor moves only when
  every page of the product arrived.
- **OSV** - the batch query answers each advisory's id and modified time;
  only advisories that are new or modified since they were stored are
  fetched. Packages of type `generic` have no OSV ecosystem and are skipped.
- **EPSS** - only CVEs without a score from yesterday or today are asked
  for. An empty answer to a batch fails that batch.
- **KEV** - the catalog is one file and is read whole each run.

Replaying data that is already stored writes nothing.

### Rate limits and retries

NVD allows 5 requests per rolling 30 seconds without an API key and 50 with
one, so Danbyte spaces its NVD requests 6.5 seconds apart without a key and
0.7 seconds with one. EPSS requests are 1 second apart, OSV requests 0.2
seconds. A `403`, `429` or `5xx` answer, a timeout or a dropped connection is
retried after 30, 60 and 120 seconds (or the server's `Retry-After`, at most
5 minutes); after the fourth try the product or batch is marked failed and
the run goes on with the next one.

Request an NVD API key at <https://nvd.nist.gov/developers/request-an-api-key>
and store it as `nvd_api_key`. It is sent only to the NVD host, as a header;
it is never logged, never written to a run and never returned by the API.

### Runs

A server fetch is a run like an upload: one at a time (a second answers
`409`), with `progress` saved after every page and `counts` per source
(`nvd`, `osv`, `kev`, `epss`, plus `requests` and `retries`). A run that has
said nothing for two hours is marked *abandoned*. When a run fails or is
abandoned, the next start within 20 hours **resumes** it: finished products
are skipped and a product stopped mid-way continues from the page it
reached. A run ends *failed* when any product or batch failed; the `error`
lists them, and what did arrive is stored.

- `POST /api/vulnerabilities/refresh/` - deployment admin; starts (or
  resumes) a run on the `low` queue and answers it (`202`). `409` while the
  feature is off, outside server mode, or with a run already going. Poll
  `GET /api/vulnerabilities/sync/<run id>/`.
- The `danbyte-vuln-refresh` timer (`manage.py vuln_refresh`, daily at
  05:50; `run_scheduler` in a container) does the same and appears under
  **Jobs → Scheduled tasks**. In any mode but server it records a skip and
  contacts nothing.
- Mapping a new product - or enabling a mapping, or pointing one at
  another product - fetches just that product at once in server mode, on
  the `low` queue. The same product asked for again within five minutes
  (another save, another tenant mapping it) is not fetched twice, and
  hardware CPEs are never fetched. If another run is going, the next daily
  run picks the product up.

### CPE search

`GET /api/vulnerabilities/cpe/search/?q=` finds CPE names for the mapping
picker. It answers a deployment admin and anyone who may change a platform,
device type or application in the active tenant (the people who use the
picker), while the feature is on. The answer is public NVD data and never
holds the API key:

| Field | Meaning |
|---|---|
| `typed` | `q` written as a `cpe:2.3:` name, checked and reduced to `part:vendor:product`. A name that is not CPE 2.3 answers `400`. |
| `local` | vendor:product pairs already in the store matching every word of `q`, with how many CVEs name them. |
| `remote` | Server mode only: NVD's CPE dictionary (`keywordSearch`), one row per `part:vendor:product` with an example title and how many CPE names NVD has for it. |
| `remote_status` | `ok`, `cached`, `off` (not server mode: NVD was not asked), `limited` (try again after `retry_after` seconds) or `error` (with `remote_error`). |

NVD answers are cached for 24 hours and shared by everyone who searches. A
user may search 30 times a minute (`429` past that), and the deployment asks
NVD at most 2 times per 30 seconds without an API key (20 with one), well
under NVD's limit, so the picker cannot starve a running fetch.

## Map your products

A **product mapping** says which public product one of your catalog entries
is. Matching only looks at mapped products, and the store only keeps records
for products some tenant maps.

| Subject | Maps to | Example | Version tested |
|---|---|---|---|
| Platform | CPE 2.3 operating system (`o`), or a package URL | `cpe:2.3:o:cisco:ios_xe` | each device's and VM's running version |
| Application | package URL, or a CPE application (`a`) | `pkg:pypi/django`, `cpe:2.3:a:postgresql:postgresql` | each install's version |
| Device type | CPE 2.3 hardware (`h`) | `cpe:2.3:h:cisco:catalyst_9300` | none: hardware context only |

A subject can have several mappings. A device without its own platform uses
its device type's. Only the product part of the identifier is kept: a full
CPE (`cpe:2.3:o:cisco:ios_xe:17.9.4a:*:…`) or a package URL with a version
(`pkg:pypi/django@5.2`) is cut to the product. Without an identifier the
mapping takes the subject's own SBOM package URL or CPE template (the
**Package URL** and **CPE** fields, see [SBOM](sbom.md#package-urls-and-cpes)).

Mappings are per tenant. Reading one needs `view` on its subject, changing
one `change` on it - a site-scoped role edits the mappings of the platforms
and applications it may edit. Mapping changes are in the
[change log](change-log.md).

| Field | Meaning |
|---|---|
| `version_scheme` | How versions are read and ordered. `auto` (default) picks from the product, see below. |
| `enabled` | Off stops matching it; its open matches are resolved. |

### The picker

Platform, device type and application pages have a **Vulnerability data**
card on their Overview while the feature is on. It lists each mapping with
its version scheme and a coverage line from `/api/vulnerabilities/coverage/`
- *41 of 44 hosts matched · 3 with a version Danbyte cannot read* (installs
for an application; a device type reads *Hardware context for N devices*).
Whoever may change the object sees **Map product**, **Change** and
**Remove**.

**Map product** opens the picker:

| Choice | What it maps |
|---|---|
| SBOM identifier | The object's own **Package URL** or **CPE** field, cut to the product. Offered first when the object has one and no mapping yet. |
| CPE | Type words (`ios xe`) or a `cpe:2.3:` name. The list shows the typed name, products already in the store (with how many records name them) and, in server mode, NVD's CPE dictionary, one row per product; a device type only offers hardware (`h`) names, the others operating systems and applications. The **CPE** field below takes a name by hand. |
| Package URL | `pkg:pypi/django`, for an application or platform. |

**Version scheme** (not for a device type) is *Automatic* unless you pick
one. Changing a mapping can also switch it off.

## Version schemes

| Scheme | Reads | Order | `auto` for |
|---|---|---|---|
| `cisco_iosxe` | `17.9.4a`, `17.09.04a` (zero padding ignored) | 17.9.4 < 17.9.4a < 17.9.5 | `cisco:ios_xe` |
| `cisco_ios` | `15.2(7)E8`, `12.2(55)SE12` | within one train only (15.2 E): a range in another train never matches | `cisco:ios` |
| `cisco_nxos` | `9.3(10)`, `10.2(5)M`, `7.0(3)I7(9)` | numbers; the F/M tag of a 10.x release is not an order | `cisco:nx-os` |
| `junos` | `21.4R3-S5.4` | release then service; the build (`.4`) is dropped; X releases (`15.1X49-D200`) only against X releases | `juniper:junos` |
| `arista_eos` | `4.28.3M` | numbers; the letter is a tag | `arista:eos` |
| `semver` | `1.24.0`, `1.0.0-rc.1`, `16.4`, `14.13 (Debian …)`, `1.1.1w`, `9.6beta1` | semver precedence; a letter after the number sorts after it | CPE applications, `npm`, `cargo`, `golang` |
| `pep440` | Python versions | PEP 440 | `pypi` |
| `dpkg` | `1:2.3-4+deb12u1` | dpkg's own (epoch, `~` before anything) | `deb` |
| `apk` | `1.2.3_rc1-r0` | Alpine's | `apk` |
| `generic` | anything with a digit | exact matches only | every other product |

A version the scheme cannot read matches no range; a record that lists that
exact version string still matches. Blank versions never match.

## How matching works

Matching runs on the server, per tenant, over every enabled mapping.

**NVD records.** Each configuration entry is tested on its own; any entry
that holds is a match. Inside an entry, nodes combine with the entry's AND/OR
and a node's CPE list is OR (`negate` is honoured). A CPE naming the mapped
product tests the version: an exact CPE version must equal it (Junos takes
the CPE update field, `21.4:r3-s5`), a `*` version must fall within the
start/end bounds. A bound the scheme cannot read makes that entry unusable.
A CPE naming another product is context:

| Context in the record | Holds when |
|---|---|
| Hardware (`h`) | the device type's hardware mapping names it. A device type with no hardware mapping, and every VM, skips the node: the match is **partial**. |
| Operating system (`o`), for an application | the host's platform mapping names it; skipped (partial) when the platform has none. |

Rejected records never match; neither do records NVD has not analysed yet
(no configurations).

**OSV advisories.** An advisory for the mapped package matches when it lists
the version (`exact`) or one of its `ECOSYSTEM` or `SEMVER` ranges covers it
(`range`). An `ECOSYSTEM` range uses the mapping's scheme; under `generic`
(Maven, NuGet, RubyGems, …) only listed versions match. `GIT` ranges are not
used.

Each match records its `confidence`: `exact`, `range` or `partial`.

### Match history

A match is one row per record, host, mapping and install. When the version
moves off the record the row is **resolved** (`resolved_at`) and kept, so the
time to patch can be read back; going back to a vulnerable version opens a
new row. Matches are not in the change log: they are computed, thousands at a
time.

### When matching runs

| Event | Recomputes |
|---|---|
| Records, KEV or EPSS stored (upload, sync) | every tenant whose mappings name a changed record, once per burst (60 s) |
| A mapping created, changed or deleted | the tenant |
| A device's or VM's running version, platform or device type changes | that host |
| An install created, deleted or its version or application changed | its host |
| The policy changed | the priorities of the tenant's open matches |
| The feature switched on | every tenant with a mapping |

All of it runs as background jobs on the `low` queue; a bulk edit queues one
job. A job re-reads its scope when it runs: nothing happens while the
feature is off or for an inactive tenant.

## Priority

Every match carries a priority from the record's CVSS score, EPSS and KEV
entry, with thresholds per tenant:

| Priority | When (defaults) |
|---|---|
| Fix first | in CISA KEV; or EPSS ≥ 0.5 and CVSS ≥ 9.0 |
| High | CVSS ≥ 9.0; or CVSS ≥ 7.0 and EPSS ≥ 0.1 |
| Medium | CVSS ≥ 4.0 |
| Low | everything else, including a record without a score |

A tenant admin sets them on **Settings → Tenant policy → Vulnerability
priority** (shown while the feature is on), or with
`GET/PATCH /api/vulnerabilities/policy/`: `kev_is_fix_first`,
`fix_first_epss`, `fix_first_cvss`, `high_cvss`, `high_epss`,
`high_epss_cvss`, `medium_cvss` (EPSS 0-1, CVSS 0-10). Anyone who may view
devices or VMs reads the policy; a tenant admin changes it, the open matches
are re-prioritised, and the change is in the change log.

## Where it shows

While the feature is on, devices, VMs, platforms and applications have a
**Vulnerabilities** tab (before Journal and Change log). It lists the
object's matches, worst priority first:

| Column | Shows |
|---|---|
| Record | The CVE or advisory id, linked to [its page](#a-records-page). |
| Priority | *Fix first*, *High*, *Medium*, *Low*. |
| Severity, CVSS | From the record's score. |
| KEV | *KEV* when CISA lists it; the date added and the due date on hover. |
| EPSS | The probability of exploitation, as a percentage. |
| Host | The device or VM (platform and application tabs). |
| Application, Version | The install that matched, and the version tested. |
| Via | Platform or application (device and VM tabs). |
| Confidence | *Exact*, *Range*, or *Partial* - the record also names hardware or an OS that is not mapped. |
| Product, Summary, First seen | The mapping, the record's description, when the match appeared. |

The rail filters by **Status** (open by default; tick *Resolved* for the
history, which adds a Resolved column), priority, severity, KEV, confidence
and via. The filters are in the address (`?vstatus=resolved&priority=fix_first`),
so a link keeps them. The tab is gone entirely while the feature is off.

### The Vulnerabilities page

**Software & lifecycle → Vulnerabilities** (`/vulnerabilities`, next to
Lifecycle) lists every record matched in the tenant, as far as you can see
it. It is in the menu for anyone who may view devices or VMs, while the
feature is on; while it is off the page says so and points a deployment
admin to **Settings → General → Vulnerability data**.

**Records** (the default) is one row per record:

| Column | Shows |
|---|---|
| Record | The id, linked to [its page](#a-records-page). |
| Priority, Severity, CVSS, KEV, EPSS | As on the tab. |
| Devices, VMs, Installs | How many of each it affects - open matches you can see. |
| First seen | When its first open match appeared. |
| Summary | The record's description. |

**By object** is one row per match - a record on a host, through a platform
or an install - with the tab's columns. The rail and the search box work the
same in both views:

| Filter | |
|---|---|
| Priority, Severity, KEV | As on the tab; *No score* for a record without one. |
| First seen | *Last 7 days*, *Last 30 days*, *Older*: when a match appeared. |
| EPSS | A range, 0 to 1 (`0.5..` is 50 % and up). |
| Site | The host's site. |
| Platform, Application | The platform or application whose mapping matched. |
| Confidence, Via | *By object* only. |

Everything is paged, sorted and counted on the server, and kept in the
address (`/vulnerabilities?priority=fix_first&kev=yes&view=objects`), so a
link or a [saved view](saved-views.md) keeps it. **Download** exports
every row the filters match (CSV, Excel, HTML, print), not just the page.

### A record's page

`/vulnerabilities/<id>` - a CVE id, an OSV id or one of its aliases - has two
tabs:

- **Overview** - the description, then the record (id, aliases, priority,
  published and modified dates, NVD status, where the data came from), its
  CVSS (score and severity, version, vector, whether Danbyte recomputed it,
  attack vector, CWEs), exploitation (CISA KEV dates, required action and
  ransomware use; EPSS with its percentile and date), the versions it is
  fixed in, and the references. **NVD** (or **OSV**) opens the public
  record. Links out open in a new tab.
- **Affected** - every host and install it matched: host, application,
  version tested, via, confidence, product and first seen. Tick *Resolved*
  under Status for the history (with when each was resolved).

The page opens for a record the tenant matched or maps a product of, and
404s otherwise. Records are public data and not in the change log, so the
page has no Journal or Change log.

### On the Devices and VMs lists

While the feature is on, the Devices and Virtual machines lists have a
**Vulnerabilities** column: the worst open priority, how many records are
open and *KEV* when one is known exploited (`Fix first · 4 · KEV`). It
sorts worst first and its rail facet filters by worst priority (*None open*
for a clean host); **Known exploited** (a hidden column) filters by the KEV
flag. Both are computed on the server for the whole list, and the column is
in the list's Download.

## API

Every endpoint below answers 404 while vulnerability data is off and works
on the active tenant. A match is visible when its device or VM is to the
caller; an application match also needs `view` on installed software. So a
site role sees only its own sites' matches, everywhere.

| Endpoint | Answers |
|---|---|
| `GET/POST /api/vulnerabilities/mappings/`, `GET/PATCH/DELETE …/<id>/` | Mappings. `POST {platform\|device_type\|application, identifier?, version_scheme?, enabled?}`. Filters `platform`, `device_type`, `application`, `kind`, `enabled`. |
| `GET /api/vulnerabilities/` | One row per matched record: score, severity, KEV, EPSS, worst priority, devices, VMs and installs affected, first seen. |
| `GET /api/vulnerabilities/facets/`, `GET /api/vulnerabilities/matches/facets/` | The page's rail: `{facets: {id: [{value, label, count}]}, sortable: [...]}`. Each facet counts records (or matches) over what the other filters leave. |
| `GET /api/vulnerabilities/<id>/` | The record (CVE id, OSV id or an alias) with its open matches (`affected`, first 1,000; `affected_count`). 404 unless the tenant matched it or maps one of its products. |
| `GET /api/vulnerabilities/matches/` | Match rows, worst priority first. |
| `GET /api/devices/<id>/vulnerabilities/` | One device's matches; likewise `virtual-machines`, `platforms` (through its mappings) and `applications`. |
| `GET /api/vulnerabilities/summary/` | Open records per priority, KEV and critical records, records new this week (`new_this_week`: a match first seen in the last 7 days), devices and VMs affected. |
| `GET /api/vulnerabilities/coverage/` | Per mapping: objects tested, matched, with a blank version, with a version the scheme cannot read; and from the last run the records it could not decide (`unparsed_bounds`, `range_not_understood`). Filters `platform`, `device_type`, `application`. |
| `GET/PATCH /api/vulnerabilities/policy/` | Priority thresholds. |

The record and match lists take `status` (`open` by default, `resolved`,
`all`), `device`, `virtual_machine`, `platform`, `application`, `mapping`,
`site`, `cve`, `priority`, `confidence`, `via` (`platform`/`application`),
`severity`, `kev`, `epss_min` and `q` (id or description). Values of one
filter are comma-separated or repeated.

The two lists also take what the page sends: `search` (as `q`),
`ordering=<column>` or `-<column>` (`record`, `priority`, `severity`,
`score`, `kev`, `epss`, `first_seen`; records also `devices`,
`virtual_machines`, `installs`; matches also `host`, `application`,
`version`, `via`, `confidence`, `mapping`, `resolved`) and the rail's
`f_<facet>=a,b` - `priority`, `severity` (`unscored` for no score), `kev`
(`yes`/`no`), `first_seen` (`7d`/`30d`/`older`), `epss` (`min..max`), `site`,
`platform`, `application`, and on matches `confidence` and `via`. An
unknown facet or sort is a `400`.

On `GET /api/devices/` and `GET /api/virtual-machines/`:

| Parameter | Lists |
|---|---|
| `vuln_priority=fix_first,high` | Hosts whose worst open priority is one of these; `none` for hosts with none open. |
| `vuln_kev=true` | Hosts with an open record in CISA KEV (`false`: without). |
| `cve_severity=critical,high` | Hosts with an open record of that CVSS severity. |

The table rows (`view=table`) carry `vulnerabilities: {open, priority,
kev}` while the feature is on (`null` otherwise), and take
`f_vulnerabilities` / `f_vuln_kev` and `ordering=vulnerabilities`. While the
feature is off the parameters are accepted and do nothing. Counted like
everything here: an application match needs `view` on its install.
