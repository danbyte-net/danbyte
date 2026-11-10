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
    (settings, records, upload import), **product mappings**, **matching**
    against your inventory with a **priority**, and the API for them. The
    Vulnerabilities tabs and page, the mapping picker, server and browser
    sync are still to come. Until a mapping exists, an NVD or OSV upload
    keeps nothing.

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

`GET/PATCH /api/vulnerabilities/policy/` reads and sets them:
`kev_is_fix_first`, `fix_first_epss`, `fix_first_cvss`, `high_cvss`,
`high_epss`, `high_epss_cvss`, `medium_cvss` (EPSS 0-1, CVSS 0-10). Anyone
who may view devices or VMs reads the policy; a tenant admin changes it, and
the change is in the change log.

## API

Every endpoint below answers 404 while vulnerability data is off and works
on the active tenant. A match is visible when its device or VM is to the
caller; an application match also needs `view` on installed software. So a
site role sees only its own sites' matches, everywhere.

| Endpoint | Answers |
|---|---|
| `GET/POST /api/vulnerabilities/mappings/`, `GET/PATCH/DELETE …/<id>/` | Mappings. `POST {platform\|device_type\|application, identifier?, version_scheme?, enabled?}`. Filters `platform`, `device_type`, `application`, `kind`, `enabled`. |
| `GET /api/vulnerabilities/` | One row per matched record: score, severity, KEV, EPSS, worst priority, devices and VMs affected, first seen. |
| `GET /api/vulnerabilities/<id>/` | The record (CVE id, OSV id or an alias) with its open matches (`affected`, first 1,000; `affected_count`). 404 unless the tenant matched it or maps one of its products. |
| `GET /api/vulnerabilities/matches/` | Match rows, worst priority first. |
| `GET /api/devices/<id>/vulnerabilities/` | One device's matches; likewise `virtual-machines`, `platforms` (through its mappings) and `applications`. |
| `GET /api/vulnerabilities/summary/` | Open records per priority, KEV and critical records, devices and VMs affected. |
| `GET /api/vulnerabilities/coverage/` | Per mapping: objects tested, matched, with a blank version, with a version the scheme cannot read; and from the last run the records it could not decide (`unparsed_bounds`, `range_not_understood`). Filters `platform`, `device_type`, `application`. |
| `GET/PATCH /api/vulnerabilities/policy/` | Priority thresholds. |

The record and match lists take `status` (`open` by default, `resolved`,
`all`), `device`, `virtual_machine`, `platform`, `application`, `mapping`,
`site`, `cve`, `priority`, `confidence`, `via` (`platform`/`application`),
`severity`, `kev`, `epss_min` and `q` (id or description). Values of one
filter are comma-separated or repeated.
