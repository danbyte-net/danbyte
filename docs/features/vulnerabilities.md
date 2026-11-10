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
    the settings, the vulnerability records and the upload import. Product
    mappings (which platform or application is which CPE name or package
    URL), matching against your inventory, the Vulnerabilities tabs and page,
    server and browser sync are still to come. Until mappings exist, an NVD
    or OSV upload is refused because nothing in it would be kept.

It is **off by default** and deployment-wide. Nothing is fetched and nothing
leaves the server: the store is filled only by an update a deployment admin
runs.

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
| `update_source` | `upload` (default), `server` or `browser`. Only upload works today. |
| `nvd_url`, `epss_url`, `kev_url`, `osv_url` | Blank uses the public service. A mirror goes here; it must be `https://`. |
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
