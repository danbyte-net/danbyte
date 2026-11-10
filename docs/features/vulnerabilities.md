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
    This page grows with the feature. Today Danbyte has the **data store**:
    the settings, the vulnerability records, the upload import and the
    [server fetch](#server-mode). Product mappings (which platform or
    application is which CPE name or package URL), matching against your
    inventory, the Vulnerabilities tabs and page and browser sync are still
    to come. Until mappings exist, an NVD or OSV upload is refused and a
    server fetch asks for nothing, because nothing would be kept.

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

A deployment admin (`users.manage` without tenant narrowing) uses
`PATCH /api/vulnerabilities/settings/`; the settings card follows with the
mappings.

| Setting | Meaning |
|---|---|
| `enabled` | Off by default. While off, uploads are refused and nothing runs. |
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
- Mapping a new product (later phase) fetches just that product at once in
  server mode.

### CPE search

`GET /api/vulnerabilities/cpe/search/?q=` finds CPE names for the mapping
picker (deployment admin, feature on):

| Field | Meaning |
|---|---|
| `typed` | `q` written as a `cpe:2.3:` name, checked and reduced to `part:vendor:product`. A name that is not CPE 2.3 answers `400`. |
| `local` | vendor:product pairs already in the store matching every word of `q`, with how many CVEs name them. |
| `remote` | Server mode only: NVD's CPE dictionary (`keywordSearch`), one row per `part:vendor:product` with an example title and how many CPE names NVD has for it. |
| `remote_status` | `ok`, `cached`, `off` (not server mode: NVD was not asked), `limited` (try again after `retry_after` seconds) or `error` (with `remote_error`). |

NVD answers are cached for 24 hours. A user may search 30 times a minute
(`429` past that), and the deployment asks NVD at most 2 times per 30
seconds without an API key (20 with one), well under NVD's limit, so the
picker cannot starve a running fetch.
