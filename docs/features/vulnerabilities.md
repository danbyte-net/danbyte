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
    the [browser sync](#browser-mode),
    **product mappings** with their [picker](#map-your-products),
    **matching** against your inventory with a [priority](#priority), the
    [Vulnerabilities tab](#where-it-shows) on devices, VMs, platforms and
    applications, the [Vulnerabilities page](#the-vulnerabilities-page) with
    a [page per record](#a-records-page), [list columns](#on-the-devices-and-vms-lists),
    a [dashboard widget](dashboard.md), [exceptions](#exceptions), the
    [compliance rule](#compliance-rule), [notifications](#notifications),
    [match history retention](#match-history), the
    [VEX in the SBOM](sbom.md#vulnerabilities-vex) and the API for them.
    [Discovery](discovery.md) adds the packages it reads from Linux hosts
    as a third match source (**Via: Package**), and the Windows builds it
    reads as a fourth, against [Microsoft's own data](#windows-hosts-microsoft-data)
    (**Via: OS build**).
    Until a mapping exists, an NVD or OSV upload keeps nothing and a server fetch
    asks for nothing.

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
| Windows CVE | Microsoft's monthly security update documents ([MSRC CVRF](#windows-hosts-microsoft-data)) | per Windows release the fixed builds and KB numbers, the title, CWEs, Microsoft's CVSS |
| KEV entry | CISA KEV catalog | date added, due date, required action, known ransomware use |
| EPSS score | FIRST EPSS | probability of exploitation in the next 30 days and its percentile, with the score date |

An OSV advisory that names a CVE as an alias is filed under that CVE, so its
KEV and EPSS data apply to it; the CVE then lists the advisory ids as
aliases. An advisory without a CVE keeps its own id. When both exist, NVD's
description and score win and OSV adds the affected packages.

A CVE Microsoft's data names is the same row as the NVD one: one record per
CVE id, never two. Description and CVSS come first from NVD, then from
Microsoft (the CNA for its own CVEs), then from OSV; Microsoft's fixed
builds are kept beside NVD's configurations whichever arrived first, and an
NVD record arriving later replaces Microsoft's description and score but not
its builds.

Only records that name a **mapped product** are kept: an NVD year feed names
tens of thousands of products, and Danbyte stores the CVEs for the products
you have mapped - or, with [discovery](discovery.md) on, the packages it
found on your hosts and the Windows releases they run. A CVE NVD has not analysed yet (*Awaiting Analysis*, no
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
  server reaches NVD, OSV, FIRST and CISA; *Browser* - an admin's browser
  fetches NVD, EPSS and OSV on **Sync now** and the server stays offline.
- In server mode: the **NVD API key** (a password field; it shows *Set*
  when one is stored, never the key, and **Clear key** removes it),
  **Fetch EPSS scores**, **Fetch the CISA KEV catalog**, **Fetch Microsoft's
  Windows data** and the five mirror URLs.
- In browser mode: **Fetch EPSS scores**, the NVD, EPSS and OSV mirror URLs
  and **Sync now from this browser**, which opens the
  [sync page](#browser-mode).
- How many records are stored, how many of Microsoft's months (the newest,
  when one was last read), the last run (status, who started it, what it
  stored, its error) and **Refresh now** in server mode.
- **Import file** with the **File kind** (NVD records, OSV advisories,
  Microsoft month, CISA KEV, EPSS scores). The run is followed until it ends. In upload mode the
  card lists the `curl` commands from [Upload](#upload-airgapped-installs).

The card saves only the fields you changed; a blank key field keeps the
stored key.

| Setting | Meaning |
|---|---|
| `enabled` | Off by default. While off, uploads are refused, nothing runs and every vulnerability tab and card is hidden. |
| `update_source` | `upload` (default), `server` or [`browser`](#browser-mode). |
| `nvd_url`, `epss_url`, `kev_url`, `osv_url`, `msrc_url` | Blank uses the public service. A mirror goes here; it must be `https://`. For NVD, EPSS, OSV and Microsoft it is the base URL the API paths are added to (`https://services.nvd.nist.gov`, `https://api.first.org`, `https://api.osv.dev`, `https://api.msrc.microsoft.com/cvrf/v3.0`); for KEV it is the catalog file itself. |
| `sync_epss`, `sync_kev` | Whether a server sync also fetches EPSS and KEV (on by default). A browser sync reads `sync_epss`; it never fetches the KEV file (see [browser mode](#browser-mode)). |
| `sync_msrc` | Whether a server sync also fetches [Microsoft's monthly documents](#windows-hosts-microsoft-data) (on by default). Nothing is fetched until discovery has read a Windows host, so on costs nothing without one. Server mode only. |
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
| `msrc` | One of Microsoft's monthly security update documents as CVRF JSON (`2026-Nov.json`); `.json` or `.json.gz`. Refused until discovery has read a Windows host. |
| `kev` | The CISA KEV catalog, `.json` or `.csv` |
| `epss` | The EPSS scores, `.csv` or `.csv.gz` (with its `#model_version…,score_date…` first line) |

For example:

```sh
curl -o ios_xe.json 'https://services.nvd.nist.gov/rest/json/cves/2.0?virtualMatchString=cpe:2.3:o:cisco:ios_xe&resultsPerPage=2000'
curl -O https://nvd.nist.gov/feeds/json/cve/2.0/nvdcve-2.0-modified.json.gz
curl -O https://osv-vulnerabilities.storage.googleapis.com/PyPI/all.zip
curl -H 'Accept: application/json' -o 2026-Nov.json https://api.msrc.microsoft.com/cvrf/v3.0/cvrf/2026-Nov
curl -O https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json
curl -LO https://epss.empiricalsecurity.com/epss_scores-current.csv.gz
```

The Microsoft URL needs `Accept: application/json` (without it the answer is
XML, which is not read). Upload one file per month; builds are cumulative,
so the last twelve months are plenty.

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
| Microsoft month, unpacked | 256 MB (the largest seen is 30 MB) |

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
| OSV (`api.osv.dev`) | `POST /v1/querybatch`, then `GET /v1/vulns/<id>` | one batch per 1000 mapped packages, then one request per advisory that is new or changed | the package URLs, without versions; for a Debian, Ubuntu or Alpine package whose hosts' releases are all known, the ecosystem and package name instead (`Debian:12` + `openssl`, see [Distro packages](#distro-packages)) |
| Microsoft (`api.msrc.microsoft.com`) | `GET /cvrf/v3.0/updates`, then `GET /cvrf/v3.0/cvrf/<month>` | when `sync_msrc` is on and discovery has read a Windows host: the index once per run, then each changed month of the last twelve ([`DANBYTE_VULN_MSRC_MONTHS`](../reference/settings.md#microsoft-data-window-danbyte_vuln_msrc_months)) | month ids (`2026-Nov`) only - never a host, a build or a product name |
| CISA (`www.cisa.gov`) | `GET` the KEV catalog JSON | once per run, when `sync_kev` is on | nothing |
| FIRST (`api.first.org`) | `GET /data/v1/epss?cve=…` | 100 CVEs per request, when `sync_epss` is on | CVE ids of stored records |

Danbyte asks for whole products, not versions: every CVE that names
`cisco:ios_xe` is fetched and matched to your versions locally, and the
inventory itself (device names, versions, addresses) never leaves the server.
A proxy or firewall needs to allow those five hosts (or the mirrors you set).
`HTTPS_PROXY` / `NO_PROXY` in the service environment are honoured.

Every request goes through the [outbound-request guard](../reference/settings.md#outbound-requests-ssrf-guard):
the host must resolve to a public address (or one a deployment admin
allow-listed), the connection is pinned to that address, and redirects are
never followed. Each answer is read as a stream with a size cap (an NVD page
256 MB, an OSV batch answer 32 MB, an OSV record 8 MB, the KEV catalog
64 MB, an EPSS answer 4 MB, Microsoft's index 8 MB and a Microsoft month
192 MB) and parsed by the same code as an upload, so the
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
  A deb or apk package is asked for per release (`{"ecosystem": "Debian:12",
  "name": "openssl"}`) when every host it is tracked on has a known release,
  so advisories for releases you do not run are not stored; otherwise, and
  for RPM packages, it is asked for by package URL, all releases. A purl
  qualifier such as `distro=debian-12` is never sent: OSV answers nothing for
  it.
- **EPSS** - only CVEs without a score from yesterday or today are asked
  for. An empty answer to a batch fails that batch.
- **KEV** - the catalog is one file and is read whole each run.
- **Microsoft** - the index lists each month's `CurrentReleaseDate`. A month
  of the last twelve (the deployment setting [`DANBYTE_VULN_MSRC_MONTHS`](../reference/settings.md#microsoft-data-window-danbyte_vuln_msrc_months), 1 to 36) is read when
  it was never read, when Microsoft revised
  it since, or when it was read for fewer Windows releases than discovery
  now sees. Microsoft revises old months often (every month of the past two
  years had a revision in the first ten days of November 2026), so in
  practice most of the window is read again each week: 4 to 30 MB a month.
  A Windows release discovery reads for the first time is fetched at once
  after the run that found it (server mode, Microsoft's data on; one job
  per run, nothing in upload or browser mode) rather than at the next daily
  refresh. That fetch adds the release to the months it reads and leaves
  their revision dates for the daily run.

Replaying data that is already stored writes nothing.

### Rate limits and retries

NVD allows 5 requests per rolling 30 seconds without an API key and 50 with
one, so Danbyte spaces its NVD requests 6.5 seconds apart without a key and
0.7 seconds with one. EPSS requests are 1 second apart, OSV requests 0.2
seconds, Microsoft requests 2 seconds. A `403`, `429` or `5xx` answer, a timeout or a dropped connection is
retried after 30, 60 and 120 seconds (or the server's `Retry-After`, at most
5 minutes); after the fourth try the product or batch is marked failed and
the run goes on with the next one.

Request an NVD API key at <https://nvd.nist.gov/developers/request-an-api-key>
and store it as `nvd_api_key`. It is sent only to the NVD host, as a header;
it is never logged, never written to a run and never returned by the API.

### Runs

A server fetch is a run like an upload: one at a time (a second answers
`409`), with `progress` saved after every page and `counts` per source
(`nvd`, `osv`, `msrc`, `kev`, `epss`, plus `requests` and `retries`). A run that has
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
  contacts nothing. The same unit then runs `manage.py vuln_maintenance`
  ([exception expiry](#expiry) and the [match purge](#match-history)), even
  when the fetch failed; it has its own row, **Vulnerability upkeep**.
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
| `update_source` | The deployment's update source. In browser mode the picker says NVD search isn't available in this mode: the browser sync fetches records, not the CPE dictionary. |

NVD answers are cached for 24 hours and shared by everyone who searches. A
user may search 30 times a minute (`429` past that), and the deployment asks
NVD at most 2 times per 30 seconds without an API key (20 with one), well
under NVD's limit, so the picker cannot starve a running fetch.

## Browser mode

For a server without internet that should still stay current: with the
feature on and `update_source` set to `browser`, a deployment admin opens
**Settings → General → Vulnerability data → Sync now from this browser**
(`/settings/vulnerabilities/sync`). *Their* browser fetches the public data
and posts each answer to Danbyte; the Danbyte server contacts nothing.
Nothing updates by itself: run it after mapping new products, and every week
or so.

### What the browser contacts

| Service | Request | Cross-origin |
|---|---|---|
| NVD (`services.nvd.nist.gov`) | `GET /rest/json/cves/2.0?virtualMatchString=…&resultsPerPage=500&startIndex=…` (plus the date window), one per 500 CVEs of a mapped CPE product | `Access-Control-Allow-Origin: *` |
| FIRST (`api.first.org`) | `GET /data/v1/epss?cve=…`, 100 CVEs per request, when **Fetch EPSS scores** is on | `Access-Control-Allow-Origin: *` |
| OSV (`api.osv.dev`) | `POST /v1/querybatch` for the mapped packages, then `GET /v1/vulns/<id>` per new or changed advisory | answers with the page's origin, allows `POST` with JSON |
| CISA KEV | - | the catalog sends no CORS header, so a browser cannot read it |
| Microsoft | - | `api.msrc.microsoft.com` sends no CORS header (checked 2026-11-11 with a preflight and a plain `GET` from two origins: no `Access-Control-Allow-Origin` either time), so a browser cannot read it. Microsoft's data is not part of browser mode: [upload](#upload-airgapped-installs) the months as `msrc`. |

The browser sends no cookies to these hosts and no referrer. What leaves the
browser is what [server mode](#what-is-contacted) sends: product names
(`cisco:ios_xe`, `pkg:pypi/django`), the distro releases of tracked distro
packages (`Debian:12`) and CVE ids, never your inventory.

**KEV** dates (date added, due date, required action) come inside the NVD
records, so browser mode needs no KEV file. The *known ransomware use* flag
is only in CISA's catalog: [upload](#upload-airgapped-installs) it as `kev`
when you want it (an upload works in every update source).

**The NVD API key** is typed on the sync page. It is kept in the page's
memory only, sent to NVD as the `apiKey` header and never to Danbyte; the key
stored for server mode is never sent to the browser. Without a key NVD
allows 5 requests per 30 seconds (the page sends up to 5, then waits for the
window), with one 50. NVD's preflight answer for the key header could not be
checked from a real browser while this was written: if NVD refuses the keyed
request cross-origin, the sync pauses with *NVD could not be reached with the
API key from this browser*; clear the key and resume at the slower pace.

### The sync page

- A line naming the hosts this browser contacts (the mirrors when set).
- **NVD API key** (optional, see above), **Start sync**, **Pause** /
  **Resume** and **Stop**.
- A bar per phase (NVD products, EPSS batches, OSV advisories) with an
  estimate from the pacing, and a table of the products: *Waiting*,
  *Fetching*, *Posted* or *Failed* with the reason and **Retry**.
- An NVD `403`, `429` or `5xx` is retried after 30 and 60 seconds, then the
  product is marked failed and the sync goes on. A network or cross-origin
  error, or the browser going offline, **pauses** the sync with the message
  - it never retries in a loop.

Reloading the page, or opening it in another browser, continues where the
run stopped: the server keeps which pages, batches and advisories arrived.
While the page is open and syncing, closing the tab asks first.

### Runs and resume

A browser sync is a run with `via: browser`, owned by the admin who started
it. Only one update runs at a time. While it runs, no other admin can post
to it (`403`), and starting another answers `409` with who is syncing. A run
with nothing posted for **30 minutes** is marked *abandoned* (a paused page
counts as idle); the next **Start sync** within 20 hours - by the same or
another admin - resumes it, adding any product mapped since. **Stop** leaves
the run abandoned on purpose. When the page finishes, the run is *ok* if
every product, EPSS batch and advisory arrived, else *failed* listing what is
missing (resume it the same way), and every tenant's matches are recomputed.

### What the server checks

The trust boundary is the deployment admin - the same person who may upload
a file. Everything the browser posts is the service's answer **verbatim**,
parsed by the same code as an upload and a server fetch:

- deployment admin, session login and CSRF token only (an API token cannot
  drive a sync), the run is open, `via: browser` and the caller's;
- the body is `application/json` with a `Content-Length`: at most 8 MB for an
  NVD page or an OSV post, 1 MB for an EPSS answer (`413` past it);
- NVD: `format NVD_CVE`, `version 2.0`, `startIndex` equal to the posted
  `start_index`, `resultsPerPage` at most 2000 and no more records than it;
  pages are taken in order (`409` with the `expected` index otherwise), a
  page already taken is answered `duplicate: true` and writes nothing;
- a record is kept only when its configurations name the product the page
  was asked for (`not_tracked` otherwise), so a page cannot write CVEs for
  another product;
- CVSS 3.x is [recomputed from the vector](#cvss); a claimed score that does
  not match is dropped (`cvss_mismatch`) and the severity always comes from
  the score;
- EPSS: rows only for the CVEs of the posted batch, scores 0 to 1, a score
  date not in the future and not older than 30 days; a batch with no usable
  row is refused (`422`);
- OSV: only advisories in the list the server answered, at most 25 per post;
- per run at most 200,000 NVD records and 100,000 EPSS rows; per admin at
  most 20 posts per 10 seconds (`429`).

Records stored this way show `source: browser`, and the run records who
synced.

### Content-Security-Policy

The page fetches from the browser, so the site's nginx
`Content-Security-Policy` must allow the three hosts in `connect-src`. The
shipped template does (`https://services.nvd.nist.gov https://api.first.org
https://api.osv.dev`); a site rendered before 0.20 gets them from the
[upgrade step](../getting-started/upgrading.md) or by adding them by hand.
A **mirror** set under Vulnerability data must be added the same way, and
must answer cross-origin requests itself. When the policy blocks a host, the
sync page says which one. The Docker image's nginx sets no CSP and needs
nothing.

If your proxy or the services refuse the browser, use
[upload](#upload-airgapped-installs) or [server mode](#server-mode) instead.

### Browser-sync API

All `POST`, deployment admin, session + CSRF:

| Endpoint | Body | Answers |
|---|---|---|
| `/api/vulnerabilities/sync/` | `{"via": "browser"}` | The open, resumed or new run with its `plan` (URLs, page size, pacing, per product the `params` and date window) and `progress`. `409` outside browser mode, with no product mapped, or while another update runs. |
| `…/sync/<run>/nvd/?product=o:cisco:ios_xe&start_index=0` | the NVD page | `start_index` (next), `total`, `done`, `created`, `updated`, `not_tracked`, `cvss_mismatch`, `invalid`; or `duplicate: true`. |
| `…/sync/<run>/epss-plan/` | - | `batches` (CVE ids, 100 each) and `done`. |
| `…/sync/<run>/epss/?batch=0` | the EPSS answer | `stored`, `dropped`, `stale`, `invalid`. |
| `…/sync/<run>/osv-ids/` | `{"vulns": {id: modified}}` | `to_fetch`: the advisories that are new or changed. |
| `…/sync/<run>/osv/` | a JSON list of OSV records | `stored`, `dropped`, `posted`, `done`. |
| `…/sync/<run>/finish/` | `{"errors": [...], "stop": false}` | The run, `ok`, `failed` or (with `stop`) `abandoned`. |

`GET /api/vulnerabilities/sync/<run>/` answers a browser run with its
`progress` too.

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

### Suggest mappings

Instead of mapping one object at a time, **Suggest mappings** proposes a
product for everything already documented. The button is on the
Vulnerabilities page (toolbar and empty state) and on the **Vulnerability
data** settings card, for anyone who may change platforms, applications or
device types.

It lists every platform, application and device type you may change that
has no enabled mapping and is in use - hosts on the platform, installs of
the application, devices of the type, counted over what you may see. Each
row shows how many it would cover and how many of those have **no version**:
a blank version never matches, so fill those in for the mapping to find
anything. Candidates come best first:

| Source | From | Confidence |
|---|---|---|
| SBOM | The object's own **Package URL** or **CPE** field. | High |
| Known | A built-in table of about 60 well-known network operating systems, hypervisors, server operating systems and server software (Cisco IOS / IOS XE / IOS XR / NX-OS / ASA, Junos, Arista EOS, FortiOS, PAN-OS, ESXi, vCenter, Proxmox VE, Ubuntu, Debian, RHEL, Windows Server, RouterOS, ArubaOS, AOS-CX, Dell OS10, ExtremeXOS, pfSense, OPNsense, PostgreSQL, nginx, …), found by the words of the name, slug and manufacturer (`IOS-XE`, `Cisco IOS XE 17` and `ios_xe` all find `cisco:ios_xe`). Every name in it was checked against NVD's CPE dictionary. | High; medium for a bare word that needs its maker (`IOS` without Cisco) or a maker alone (a MikroTik platform) |
| In store | Products the stored records already name, whose product name is in the object's name. | Medium when the vendor is in the name or is the manufacturer, else low |
| NVD | Server mode only: NVD's CPE dictionary, for rows with no other candidate, on **Search NVD**. | Medium or low |

Only rows whose best candidate is high confidence start ticked. Pick another
candidate per row, change the version scheme (*Automatic* shows the scheme
it resolves to), filter by type or confidence, and **Pick…** opens the
picker for a row without a candidate. **Create N mappings** creates the
ticked rows in one request; then, in server mode, their records are fetched
at once; in browser mode **Sync now** fetches them; in upload mode, import
NVD or OSV files for the products named. Nothing is created until you press
it.

**Search NVD** uses the picker's cache and limits (see
[CPE search](#cpe-search)): cached answers are free, at most three live
searches run per press, and what is left is counted on the button.

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
| `rpm` | `1:3.0.7-25.el9_3` | rpmvercmp per part (epoch, version, release; `~` before the end, `^` after it, letters before digits) | `rpm` (only through `auto`) |
| `winbuild` | `10.0.20348.2849` (major, minor, build, UBR; all four required) | by UBR within one build line only | Microsoft's data (not offered for mappings) |
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

### Distro packages

Packages [discovery](discovery.md) reads from a host are matched the same
way, with no mapping: each one under the name its distro advises (the
source package for Debian and Ubuntu, the origin for Alpine) at the release
the host's os-release names. Those matches say **Via: Package**, read with
*installed software* view, and exist only while Discovery is on for the
tenant ([Vulnerabilities](discovery.md#vulnerabilities)).

OSV writes Debian, Ubuntu, Alpine, Rocky Linux, AlmaLinux and Red Hat
advisories **per release**: one advisory carries an entry for `Debian:11`,
one for `Debian:12` and one for `Debian:13`, each with its own fixed version
(the backport). A deb, rpm or apk package is therefore tested only against
the entry for its host's release. Other ecosystems (PyPI, npm, Go, crates,
Maven, …) have no release and are tested as above.

The host's release comes from, first to last:

| Source | Example |
|---|---|
| The install's package URL, `distro=` qualifier | `pkg:deb/debian/openssl@{version}?distro=bookworm` (or `debian-12`, `12`); `ubuntu-22.04` or `jammy`; `alpine-3.20` or `v3.20`; `el9`, `rocky-9` |
| The platform's package URL, `distro=` qualifier | the platform's **Package URL** template |
| The platform's name, else the host's running version | *Debian 12*, *Ubuntu 22.04 LTS*, *Debian Bookworm*; *Rocky Linux* on a host at `9.3` |

The release must be the package's distro (`pkg:deb/debian/…` reads only a
Debian release). Debian and Ubuntu codenames are known up to *duke* (15) and
*resolute* (26.04); RPM distros compare the major release only.

When the release is not known, a record still matches if **every** release
it names agrees the version is affected; the match is `partial`. When the
releases disagree (fixed on one, not on another) it does not match, and the
mapping's coverage counts it as `release_unknown` - *2 records need the
distro release* on the Vulnerability data card. Give the install a
`distro=` qualifier or name the platform's release to resolve it.

**Source packages.** Debian and Ubuntu advisories name the **source**
package (`openssl`), not the binary one (`libssl3`). Map the source package,
or record it on the install's package URL with the `upstream=` qualifier
(`pkg:deb/debian/libssl3@3.0.15-1~deb12u1?upstream=openssl&distro=bookworm`,
or `upstream=openssl@<version>` when the source version differs): the
install is then tested against `openssl`'s advisories, and the fetch tracks
`openssl` too. Without either, a binary name that differs from its source
finds no advisory; Danbyte does not guess the source name.

Records stored before this change already carry each entry's ecosystem,
so no re-import is needed; an entry stored without one is tested as an
entry without a release.

**A package and its application report a record once.** When an
application names the host's package ([package
names](applications.md#package-names), say OpenSSL ← `deb:libssl3`) and is
also mapped to a CPE, both would judge the same CVE on the same host: the
package by its distribution's advisory, the application by the upstream
version. The package decides. Wherever an advisory for one of the host's
linked packages names the record - affected or fixed - the application's
match for that host and record is not made, and an open one resolves. A
distribution's advisory knows its backports: a Debian `3.0.11-1~deb12u2`
that carries the fix is fixed, although the upstream range (before 3.0.15)
would call 3.0.11 affected. A record the
distribution says nothing about still matches through the application, and
another host whose package is not linked keeps its application match.

Each match records its `confidence`: `exact`, `range` or `partial`.

### Windows hosts (Microsoft data)

For Windows hosts [discovery](discovery.md#what-is-stored) reads, Danbyte uses
Microsoft's own advisory data - the monthly security update documents of
the Microsoft Security Response Center (MSRC), in CVRF form - rather than
NVD's version ranges. Microsoft lists, per CVE and per Windows release, the
build that fixes it (`FixedBuild`, for example `10.0.20348.5870`) and the KB
that ships it. Discovery reads the host's build and update build revision
(UBR) from the registry, so the test is exact: a Windows Server 2022 host at
`10.0.20348.2849` is affected by a CVE Microsoft fixed in `10.0.20348.5870`.
Those matches say **Via: OS build**, have no mapping and no package, and
carry the host's build as their version.

**Which product a host is.** Microsoft names products, not builds: *Windows
Server 2022*, *Windows Server 2022 (Server Core installation)*, *Windows 11
Version 24H2 for x64-based Systems*. Windows Server 2025 and Windows 11 24H2
share build 26100 but have their own fixes, so the build alone is not
enough. A table in the code (`vulnerabilities/msrc_products.py`) maps each
release to its build line, and the host's caption, edition and release
(`21H2`) decide between server and client and confirm the release:

| Microsoft product | Build line |
|---|---|
| Windows Server 2012 / 2012 R2 (and Server Core) | `6.2.9200` / `6.3.9600` |
| Windows Server 2016 (and Server Core) | `10.0.14393` |
| Windows Server 2019 (and Server Core) | `10.0.17763` |
| Windows Server 2022 (and Server Core) | `10.0.20348` |
| Windows Server 2022, 23H2 Edition (Server Core) | `10.0.25398` |
| Windows Server 2025 (and Server Core) | `10.0.26100` |
| Windows 10 1607, 1809, 21H2, 22H2 (x64, ARM64, 32-bit) | `10.0.14393`, `10.0.17763`, `10.0.19044`, `10.0.19045` |
| Windows 11 22H2, 23H2, 24H2, 25H2, 26H1, 26H2 (x64, ARM64) | `10.0.22621`, `10.0.22631`, `10.0.26100`, `10.0.26200`, `10.0.28000`, `10.0.26300` |

Desktop Experience and Server Core are separate products, as are the CPU
architectures of a client release. Discovery stores the registry's
`InstallationType` (`Server` is Desktop Experience, `Server Core`) and the
OS architecture (kept as `x64`, `arm64` or `x86`, whatever spelling the host
used), so a Core host is matched only against Microsoft's Server Core
products and a Windows 11 ARM64 host only against the ARM64 ones. When
either is not known (an older read, an installation type Danbyte does not
recognise) the host keeps every variant of its release, and a CVE matches
only when **every** variant agrees it is affected. A change of either fact
re-matches the host.

**Never a guess.** A host gets no OS-build match, and its Packages tab says
*OS build not matched*, when:

- its build is not in the table (Windows 11 21H2, Windows Server semi-annual
  releases, Azure Stack HCI, a release newer than the table), or its caption
  names another release than its build;
- it reported no UBR.

**The comparison.** Builds are compared only within one build line
(`10.0.20348.x` never against `10.0.17763.x`; the `winbuild` scheme). Windows
updates are cumulative, so the host is fixed from the **lowest** build
Microsoft lists for its product: a hotpatch build counts (its number sits
between the previous and the next regular update), and superseded KBs need
no handling. A product Microsoft lists as affected without a fixed build on
its line does not match. A CVE that does not list the host's product does
not match, even on the same build line (a Windows 11 only CVE never matches
Windows Server 2025).

**What is kept.** Only the CVEs that name a Windows release one of your
hosts runs (in a tenant with Discovery on) are stored. Microsoft's
advisories without a CVE id (`ADV…`) are skipped. The months are listed on
the Vulnerability data card. A record's page lists Microsoft's fixed builds
and KB numbers per product (`msrc_fixed_in`).

**What leaves the server.** In server mode the requests name months
(`2026-Nov`) and nothing else: no host, build, product or address. In
upload mode nothing leaves the server. Browser mode cannot read Microsoft's
API (it sends no CORS header).

**Terms.** Microsoft publishes the API for programmatic use, without a key
since 2021, and its documents carry Microsoft's "as is" disclaimer. No
separate licence for the data is published; the general Microsoft terms of
use apply. Danbyte fetches the documents for the deployment's own use,
stores only the facts it needs (CVE ids, product names, fixed builds, KB
numbers, CVSS, titles, dates) and never redistributes them. The test
fixtures in the repository are trimmed to those facts.

**Rights.** OS-build matches read with *installed software* view, like the
package list they come from; without it they are left out of every list,
count and badge. Exceptions for a host or the whole tenant cover them;
platform and application exceptions do not (there is no mapping). They are
left out of the [VEX](sbom.md#vulnerabilities-vex): the operating system
component there is the documented platform, not what discovery read.

### Match history

A match is one row per record, host, mapping and install. When the version
moves off the record the row is **resolved** (`resolved_at`) and kept, so the
time to patch can be read back; going back to a vulnerable version opens a
new row. Matches are not in the change log: they are computed, thousands at a
time.

Resolved matches are kept for **365 days** after they were resolved, then
deleted by the daily `vuln_maintenance` run (open matches are never deleted).
The purge runs even while vulnerability data is off.

### When matching runs

| Event | Recomputes |
|---|---|
| Records, KEV or EPSS stored (upload, sync) | every tenant whose mappings name a changed record, once per burst (60 s); for Microsoft's records, every tenant with Discovery on and a Windows host read |
| A discovery run whose read changed a host's packages or OS facts (build, UBR, edition, release, caption) | that host |
| A mapping created, changed or deleted | the tenant |
| An exception created, changed or deleted | the `excepted` mark on that record's matches, at once |
| A device's or VM's running version, platform or device type changes | that host |
| An install created, deleted or its version, application or package URL changed | its host |
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
are re-prioritised, and the change is in the change log. The card beside
it, **Vulnerability notifications**, sets what is
[sent](#notifications).

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
| Via | Platform, application, package or OS build ([discovery](discovery.md)) - device and VM tabs. |
| Confidence | *Exact*, *Range*, or *Partial* - the record also names hardware or an OS that is not mapped. |
| Product, Summary, First seen | The mapping, the record's description, when the match appeared. |

The rail filters by **Status** (open by default; tick *Resolved* for the
history, which adds a Resolved column), priority, severity, KEV, confidence,
via and excepted. The **Exception** column shows the exception that covers a
match, linked to [its page](#an-exceptions-page). Whoever may add exceptions
gets a tick box per row and **Add exception** for the ticked open rows, and
the shield button on a row for that one (see [Adding one](#adding-one)). The filters are in the address (`?vstatus=resolved&priority=fix_first`),
so a link keeps them. The tab is gone entirely while the feature is off.

On a device or VM the tab shows how many matches are open (what it lists by
default: open, no exception), and the header's badge row has one badge for
the worst open severity with the top score - *Critical 9.8*. Its hover reads
*4 open · 2 fix first · 1 KEV*, and a click opens the tab. A host with
nothing open has neither.

Priority and severity share one colour scale:

| Colour | Priority | Severity |
|---|---|---|
| Solid red | Fix first | Critical |
| Soft red | High | High |
| Yellow | Medium | Medium |
| Green | Low | Low |
| Plain | - | None |

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

**Exceptions** is one row per [exception](#exceptions), active and
expired, as far as you may see its subject:

| Column | Shows |
|---|---|
| Id | The exception's number, linked to [its page](#an-exceptions-page). |
| Record, Scope, Subject | What it is about; the subject linked to its Vulnerabilities tab, or *Whole tenant*. |
| Status | *Not applicable* or *Risk accepted*. |
| Owner | Who answers for it. |
| Expires | The date; a *N days* badge within 30 days of it, *Expired* after. |
| Covers | Open matches it covers now that you may see. |
| Reason, Created | Why, and when it was made (Created is hidden by default). |

The rail filters by scope, status, owner and expiry (*Expiring*,
*Expired*, *Later*, *No expiry*), the search box by id, reason or owner.
Edit and Delete are on each row as your role allows; tick rows to delete
several (their matches reopen). **Download** exports the list.

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
  under Status for the history (with when each was resolved). Ticked rows
  take **Add exception**.
- **Exceptions** - the exceptions for the record, with the Exceptions
  view's columns, Edit and Delete.

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
in the list's Download. **CVE score** shows the host's top open score as a
badge in its severity's colour (`9.8` in solid red for Critical), the
counts on hover, linked to its Vulnerabilities tab, and sorts by the top
score.

## Exceptions

An **exception** records a decision about one record in your tenant:

| Status | Means | Expiry |
|---|---|---|
| `not_applicable` | The record does not apply here (the feature is not used, the code is not reachable, …). | Optional; not in the past |
| `risk_accepted` | It applies, and the risk is accepted until a date. | Required: from today to 365 days ahead |

Each exception has a **reason** and an **owner** (a member of the tenant),
both required, and one scope:

| Scope | Covers the record's matches on |
|---|---|
| Device | that device (its platform and its installs) |
| Virtual machine | that VM |
| Platform | every host, through a mapping of that platform |
| Application | every install, through a mapping of that application |
| *none* | the whole tenant |

A covered match is marked **excepted**: it stays listed, with its exception,
but drops out of the counts, the priority lists, the summary, the
[compliance rule](#compliance-rule) and [notifications](#notifications).
When several exceptions cover one match, the most specific wins (host, then
platform or application, then tenant). An exception applies through its
expiry date. A record and scope have at most one exception in force; the
record and scope of an exception do not change (remove it and add another).

### CycloneDX analysis

Each exception also carries the CycloneDX 1.5 VEX `analysis` fields, so the
SBOM's vulnerabilities section can say what was decided:

| Field | Values | Default |
|---|---|---|
| `analysis_state` | `not_affected` or `false_positive` for not applicable; `exploitable` for risk accepted | `not_affected` / `exploitable` |
| `analysis_justification` | `code_not_present`, `code_not_reachable`, `requires_configuration`, `requires_dependency`, `requires_environment`, `protected_by_compiler`, `protected_at_runtime`, `protected_at_perimeter`, `protected_by_mitigating_control`; only with `not_affected` | blank |
| `analysis_response` | a list of `can_not_fix`, `will_not_fix`, `update`, `rollback`, `workaround_available` | `["will_not_fix"]` for risk accepted |

The reason (and the expiry date) becomes the analysis `detail`. Reads return
the whole analysis as `cyclonedx`.

### Adding one

**Add exception** (on ticked rows of a Vulnerabilities tab or a record's
Affected tab, or a row's shield button) asks for:

| Field | |
|---|---|
| Scope | *This device* / *This VM* (or *Its device or VM*), *Its platform or application* (*This platform* / *This application* on those pages), or *Whole tenant*. Only scopes you may create are offered: a role limited to sites gets the device or VM only, and a platform or application needs `view` on it. With several rows the choice reads *N of M* when only some can take it (a match through a device type mapping has no platform). |
| Status | *Not applicable* or *Risk accepted*. |
| Reason | Required. |
| Owner | A member of the tenant; required. Picked from the tenant's people when you may use the [people picker](permissions.md#picking-people-outside-admin); otherwise it is you, and an edit keeps the owner it has (the API refuses any other `owner_id`). |
| Expires | Required for a risk acceptance, today to 365 days ahead; optional for not applicable. |
| Advanced | The CycloneDX analysis: state, justification (with *Not affected*) and response, starting from the status's defaults. |

Several ticked rows make one exception per record and subject; one that
already has an exception for that scope is skipped. The API's field errors
show on their fields. **Edit** changes status, reason, owner, expiry and
analysis; the record and scope stay.

### An exception's page

`/vulnerabilities/exceptions/<id>` has **Overview** (the reason, the
decision and its CycloneDX analysis), **Covers** (the open matches it
covers now) and **Change log**, with **Edit** and **Delete** as your role
allows.

### Expiry

The day after its expiry date an exception stops applying. The daily
`vuln_maintenance` run (05:50, after the fetch) then, once per exception:

- reopens its matches (another exception may still cover some);
- sends one message per tenant to its notification channels listing what
  expired and how many matches reopened (when the policy's
  `notify_enabled` is on); the reopened matches are not announced again as
  new;
- tells each owner in the notifications bell.

Expired exceptions stay as history. Moving the expiry date of one into the
future makes it apply again, and it is told about again when it next
expires. Expiry is skipped for an inactive tenant and while vulnerability
data is off.

### Who may do what

Exceptions are their own permission type, **Vulnerability exceptions**
(`vulnerabilityexception`): *view*, *add*, *change*, *delete*. The built-in
Administrator, Operator and Read-only roles cover it as they cover every
type. An exception for a device or VM follows the host's site: a role
limited to sites writes them only for hosts at its sites, and reads those
plus the ones without a site. An exception for a platform, an application or
the whole tenant has no site, so a role limited to sites cannot write one
(the API answers with a field error). The subject must be one you may view,
on create and when listing. Only someone who may use the
[people picker](permissions.md#picking-people-outside-admin) names another
owner; anyone else owns what they add. Exceptions are in the
[change log](change-log.md).

## Compliance rule

The **Known vulnerabilities** [compliance check](compliance.md#check-types)
fails a device or VM with an open match that no exception covers, of a
record that meets `vuln_fail_on`:

| `vuln_fail_on` | Fails on |
|---|---|
| `kev` | a record in CISA KEV |
| `fix_first` | a match with priority fix first |
| `high` | priority high or fix first |
| `cvss` | a CVSS score at or over `cvss_min` (0.1 - 10) |

The violation names the worst three records (`CVE-2023-20198 (KEV),
CVE-2024-1234 and 4 more`) and links to the object's vulnerabilities. While
vulnerability data is off the rule passes everything.

## Notifications

After each recompute, a tenant gets **one** message through its
[notification channels](monitoring.md#notifications) (email and webhook)
when it found matches the policy asks about (`notify_on`):

| `notify_on` | A new match whose |
|---|---|
| `fix_first` | priority is fix first |
| `critical` | record's CVSS severity is critical |
| `kev` | record is in CISA KEV; also an earlier match whose record has since joined KEV |

For example *3 new vulnerabilities to fix first on 12 devices*, then one line
per record (`CVE-2023-20198 (KEV, CVSS 10.0, fix first) on 9 devices`, at
most 20) and a link when the deployment's public URL is set. A webhook gets
`{"event": "vulnerabilities_matched", "count", "records", "hosts",
"matches": [the first 200], "url"}`; each match has `vuln_id`, `kind`
(`new` or `kev`), `priority`, `cvss_score`, `kev`, `version`, `host_type`
and `host`. When every match is at one site, the site's mail settings apply.

Each match is told about once: replaying a sync, a second recompute or a
resync says nothing more. Matches an exception covers are never named.
`notify_enabled: false` in the policy sends nothing; matches found while it
was off are told about in the next message after it is turned on.

A tenant admin sets both on **Settings → Tenant policy → Vulnerability
notifications**: **Send notifications** (`notify_enabled`) and which new
matches count - *Fix first*, *Critical CVSS*, *CISA KEV* (`notify_on`).

## API

Every endpoint below answers 404 while vulnerability data is off and works
on the active tenant. A match is visible when its device or VM is to the
caller; an application match also needs `view` on installed software, and so
do the matches discovery's reads produce (`package`, `os_build`). So a site
role sees only its own sites' matches, everywhere.

| Endpoint | Answers |
|---|---|
| `GET/POST /api/vulnerabilities/mappings/`, `GET/PATCH/DELETE …/<id>/` | Mappings. `POST {platform\|device_type\|application, identifier?, version_scheme?, enabled?}`. Filters `platform`, `device_type`, `application`, `kind`, `enabled`. |
| `GET /api/vulnerabilities/mappings/suggestions/` | [Suggest mappings](#suggest-mappings): per unmapped, in-use subject you may change `subject_type`, `id`, `name`, `manufacturer`, `in_use`, `without_version` and `candidates` (`identifier`, `kind`, `part`, `vendor`, `product`, `source` `sbom`/`known`/`local`/`nvd`, `confidence` `high`/`medium`/`low`, `title`, `scheme` = `auto` resolved, `records` for `local`). Best confidence first, then most used. Filters `subject_type`, `confidence` (of the best candidate; `none` = no candidate), `q` (name) and `nvd=true` (server mode: look up the page's rows without a candidate). Adds `totals`, `update_source`, `nvd_status` (`off`, `not_asked`, `ok`, `limited` with `retry_after`, `error`) and `nvd_pending`. Creates nothing. |
| `POST /api/vulnerabilities/mappings/bulk-create/` | `[{platform\|device_type\|application, identifier, version_scheme?}]`, up to 500. Each row is checked as a single create; any error answers `{errors: {<index>: {...}}}` (`403` when one is a refusal, else `400`) and nothing is created. Answers `201 {created, update_source}`. Change-log entries as usual; one recompute and one fetch are queued for the lot. |
| `GET /api/vulnerabilities/` | One row per matched record: score, severity, KEV, EPSS, worst priority, devices, VMs and installs affected, first seen. |
| `GET /api/vulnerabilities/facets/`, `GET /api/vulnerabilities/matches/facets/` | The page's rail: `{facets: {id: [{value, label, count}]}, sortable: [...]}`. Each facet counts records (or matches) over what the other filters leave. |
| `GET /api/vulnerabilities/<id>/` | The record (CVE id, OSV id or an alias) with its open matches (`affected`, first 1,000; `affected_count`), and `msrc_fixed_in` (`[{product, month, fixed, kbs}]`, Microsoft's fixed builds). 404 unless the tenant matched it or maps one of its products. |
| `GET /api/vulnerabilities/matches/` | Match rows, worst priority first. |
| `GET /api/devices/<id>/vulnerabilities/` | One device's matches; likewise `virtual-machines`, `platforms` (through its mappings) and `applications`. |
| `GET /api/vulnerabilities/summary/` | Open records per priority, KEV and critical records, records new this week (`new_this_week`: a match first seen in the last 7 days), devices and VMs affected. |
| `GET /api/vulnerabilities/coverage/` | Per mapping: objects tested, matched, with a blank version, with a version the scheme cannot read; and from the last run the records it could not decide (`unparsed_bounds`, `range_not_understood`, `release_unknown`). Filters `platform`, `device_type`, `application`. |
| `GET/PATCH /api/vulnerabilities/policy/` | Priority thresholds and notification settings (`notify_on`, `notify_enabled`). |
| `GET /api/vulnerability-exceptions/scopes/` | The scopes the caller may create an exception for (`{scopes, site_limited, can_pick_owner, you}`: whether you may name another owner, and yourself); needs `add`. |
| `GET/POST /api/vulnerability-exceptions/`, `GET/PATCH/DELETE …/<id>/`, `POST …/bulk-delete/` | [Exceptions](#exceptions). `POST {vuln_id, status, reason, owner_id, expires_on?, device_id \| virtual_machine_id \| platform_id \| application_id?, analysis_state?, analysis_justification?, analysis_response?}`. Reads add `cve`, `scope`, the subject, `owner`, `owner_name`, `active`, `cyclonedx`, `matches` (open matches it covers that you may see) and `expiry_notified_at`. Filters `vuln_id`, `status`, `scope` (`device`, `virtual_machine`, `platform`, `application`, `tenant`), `device`, `virtual_machine`, `platform`, `application`, `owner`, `active` and `q`. |

The record and match lists take `status` (`open` by default, `resolved`,
`all`), `device`, `virtual_machine`, `platform`, `application`, `mapping`,
`site`, `cve`, `priority`, `confidence`, `via` (`platform`/`application`/`package`/`os_build`),
`severity`, `kev`, `epss_min`, `q` (id or description) and `excepted`:
`false` (the default) leaves out matches an exception covers, `true` lists
only them, `all` both. Values of one filter are comma-separated or repeated.

Every match carries `exception` (`id`, `numid`, `status`, `scope`,
`expires_on`, `owner_name`, or `null`) and its `mapping` (`id`,
`identifier`, `platform`). The record list adds `excepted` (its
matches an exception covers); a record's page lists every open match by
default (`excepted=all`) with `excepted_count`; the summary adds `excepted`
and `excepted_records`.

The two lists also take what the page sends: `search` (as `q`),
`ordering=<column>` or `-<column>` (`record`, `priority`, `severity`,
`score`, `kev`, `epss`, `first_seen`; records also `devices`,
`virtual_machines`, `installs`; matches also `host`, `application`,
`version`, `via`, `confidence`, `mapping`, `resolved`) and the rail's
`f_<facet>=a,b` - `priority`, `severity` (`unscored` for no score), `kev`
(`yes`/`no`), `first_seen` (`7d`/`30d`/`older`), `epss` (`min..max`), `site`,
`platform`, `application`, `excepted` (`yes`/`no`; without it, excepted
matches are left out as with `excepted=false`), and on matches
`confidence` and `via`. An unknown facet or sort is a `400`.

On `GET /api/devices/` and `GET /api/virtual-machines/`:

| Parameter | Lists |
|---|---|
| `vuln_priority=fix_first,high` | Hosts whose worst open priority is one of these; `none` for hosts with none open. |
| `vuln_kev=true` | Hosts with an open record in CISA KEV (`false`: without). |
| `cve_severity=critical,high` | Hosts with an open record of that CVSS severity. |

The table rows (`view=table`) carry `vulnerabilities: {open, priority,
kev}` while the feature is on (`null` otherwise), and take
`f_vulnerabilities` / `f_vuln_kev` and `ordering=vulnerabilities`. While the
feature is off the parameters are accepted and do nothing.

The table rows and the detail read (`GET /api/devices/<id>/`,
`GET /api/virtual-machines/<id>/`) also carry `vulnerability_summary`:

| Field | Is |
|---|---|
| `open` | Open matches no exception covers - the host's tab count. |
| `worst_severity` | The worst CVSS severity among them; `""` when none is open or scored. |
| `max_cvss` | The top CVSS score among them, or `null`. |
| `fix_first`, `kev` | How many of them are fix first, and in CISA KEV. |

It is `null` while the feature is off and on the plain list. A page of rows
costs one correlated subquery, not a query per row.
`ordering=vuln_score` (or `-vuln_score`) sorts the table by `max_cvss`, hosts
with none last both ways. Counted like
everything here: an application match needs `view` on its install, and a
match an exception covers is not counted.
