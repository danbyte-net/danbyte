---
icon: lucide/braces
---

# Discovery: API

Every Discovery endpoint, read from the URL configuration and checked against
the generated OpenAPI schema (tag `discovery`; the Outpost endpoints under
`outpost`). Authentication is the session with CSRF, or an API token, as for
the rest of the [API](../reference/api.md).

General rules:

- Every endpoint works in the active tenant; without one it answers 403 *No
  active tenant selected.*
- Every endpoint but `status/` answers **404** *Discovery is off.* while
  Discovery is off for the deployment or the tenant.
- Lists are paginated like the rest of the API (`page`, `page_size`), except
  where a row says `results` and `count` only.
- Permissions are RBAC on the named type, site scope included; the
  [permission table](discovery-safety.md#permissions) lists them by action.

## Switches and settings

| Method, path | Purpose | Needs |
|---|---|---|
| `GET /api/discovery/status/` | `deployment_enabled`; `deployment` (`enabled`, `source`: `env` or `setting`, `changed_by`, `changed_at`, `can_change`); `enabled` (the tenant switch); `active` (both on); `can_manage`; `first_use_keys_allowed`. Answers while Discovery is off. | any tenant member |
| `PATCH /api/discovery/deployment/` | `{"enabled": true}`: the stored deployment switch. Answers the status. 409 while `DANBYTE_DISCOVERY_ENABLED` is set. | deployment admin |
| `GET /api/discovery/settings/` | `deny_subnets`; `transports` (`ssh_key`, `ssh_password`, `winrm`); `winrm` (`available`, `label`, `reason`); `nmap` (`available`, `enabled`, `path`, `version`, `label`, `reason`, `outposts` with an nmap); `can_change`; `updated_at` | tenant admin, or *view* on Discovery profiles |
| `PATCH /api/discovery/settings/` | Any of `deny_subnets` (a list of at most 500 CIDRs), `transports` (some of the three, each `true`/`false`; `winrm: true` only while available), `nmap` (`true` only while the server or an Outpost has one) | tenant admin |

The tenant switch itself is `discovery_enabled` on the integration settings
(`/api/integrations/settings/`).

## Profiles

`/api/discovery/profiles/` is a standard collection: `GET` lists (filters
`enabled`, `search` on name and description, `kind` comma-separated,
`policy=<monitoring policy id>` for profiles whose own scope names what that
policy is about), `POST` creates, `GET`, `PUT`, `PATCH` and `DELETE` on
`/api/discovery/profiles/<id>/`. They need *view*, *add*, *change* and
*delete* on Discovery profiles. Each profile carries `permissions`
(`change`, `delete`): the caller's rights on that row.

`POST /api/discovery/profiles/bulk-update/` with
`{"ids": [...], "fields": {"enabled": true}}` turns profiles on or off
(`enabled` is the only field; *change*); `POST /api/discovery/profiles/bulk-delete/`
with `{"ids": [...]}` (and `"dry_run": true` for the preview) deletes them
(*delete*). Ids out of reach are left out. A profile's runs and their host
rows go with it; packages and open ports already read stay.

| Field | |
|---|---|
| `id`, `numid` | read-only |
| `name`, `description`, `enabled` | `name` unique in the tenant |
| `kind` | `inventory` or `service_scan`; fixed once created (400 on a change) |
| `site_ids`, `prefix_ids`, `device_ids`, `virtual_machine_ids`, `region_ids`, `vrf_ids`, `platform_ids`, `device_type_ids`, `device_role_ids` | the scope; each id must be in the tenant and visible to the caller |
| `scope_global` | the whole tenant; setting it needs `"confirm_global": true` in the same request |
| `scope` | read-only: the members with their names, and `global` |
| `shared_credential_id` / `shared_credential` | the pinned shared credential (SSH key, SSH password or WinRM certificate) / read-only `{id, name, kind}` |
| `interval_hours` | 0 to 2160 |
| `window_start`, `window_end` | `HH:MM[:SS]` or null |
| `max_concurrency` | 1 to 16 |
| `timeout_seconds` | 10 to 600 |
| `ports` | service scan: ports and `"a-b"` ranges; `[]` is the default list |
| `connects_per_second` | 1 to `rate_cap` |
| `rate_cap` | read-only: the deployment's `DANBYTE_DISCOVERY_SCAN_MAX_RATE` |
| `scan_engine` | `builtin` or `nmap` (service scan only; refused while nmap cannot be used) |
| `nmap_version_intensity`, `nmap_timing` | 0 to 5; 2 to 4 |
| `runs_on`, `outpost_id` / `outpost` | `server`, `outpost` (needs `outpost_id`) or `host` / read-only: the Outpost as `outposts/` shows it |
| `authorisation` | at most 2,000 characters. A non-empty value records the caller and the time; an empty one, or a change without one to the scope, `runs_on`, and for a service scan the ports, `scan_engine`, or a higher `nmap_version_intensity` or `nmap_timing`, clears it. |
| `authorised`, `authorised_by_name`, `authorised_at` | read-only |
| `blocked_reason` | read-only: why it cannot run now, or `""` |
| `last_run_at`, `last_run` | read-only: the newest run's `id`, `status`, times and `counts` |

| Method, path | Purpose | Needs |
|---|---|---|
| `POST /api/discovery/profiles/<id>/run/` | **Run now**. Body `{}` or `{"accept_new_host_keys": true}` (inventory only). 202 with the run. 409 with `detail` when it cannot run (*Discovery is off.*, *The profile is disabled.*, *Record who authorised this profile before it runs.*, *Pick the Outpost this profile runs on.*, *Outside the profile's window.*, *This profile is already running.*). 400 when the deployment forbids first use or the profile is a service scan; 403 without the permissions. | **scan** on the profile; for inventory *view* on device credentials; for first use *change* on SSH host keys |
| `GET /api/discovery/profiles/<id>/hosts/` | The scope as it resolves now: `results` (`kind`, `id`, `name`, `address`, `status` - `ready` or a host status - `message`, `credential`, `credential_source`, `scan_exempt`, `engine`, `permissions.change` - whether you may set its `scan_exempt`; a service scan adds `ip_address`), `count`, `truncated` | *view* on the profile |
| `GET /api/discovery/profiles/<id>/host-keys/` | Observed, not yet accepted SSH host keys of the hosts in scope | *view* on the profile and on SSH host keys |
| `GET /api/discovery/policy-scopes/` | The monitoring policies the caller may view, each as the profile field copying its scope gives: `scope`, `scope_label`, `target`, `global`, `field`, `filters` (the policy narrows its scope), `copyable`, `reason`. `?search=`. | *add* or *change* on Discovery profiles |
| `GET /api/discovery/policy-scopes/<id>/` | One of those | the same, and *view* on the policy |
| `GET /api/discovery/outposts/` | The tenant's Outposts for **Runs on**: `id`, `name`, `enabled`, `transport`, `online`, `last_seen_at`, `agent_version`, `kinds`, `nmap_version`, and `can` per `inventory`, `service_scan`, `nmap` (`ok`, `status`, `reason`); `agent_version` at the top is the version discovery needs. `?search=`. | *view* on Discovery profiles |

## Runs

| Method, path | Purpose | Needs |
|---|---|---|
| `GET /api/discovery/runs/` | Runs of the profiles you may view, newest first. Filters `profile`, `status`, `kind` (comma-separated). Each run: `id`, `profile`, `trigger` (`manual`, `schedule`), `kind`, `started_by_name`, `authorisation` and `authorised_by_name` (the profile's, as recorded when the run was queued), `engine` (`server`, `outposts` or `outpost: <name>`), `status`, `created_at`, `started_at`, `finished_at`, `counts`, `summary`, `accept_new_host_keys`, `errors`, `outstanding` (hosts still with Outposts) | *view* on Discovery profiles |
| `GET /api/discovery/runs/<id>/` | One run, plus `advisories` (below) | the same |
| `GET /api/discovery/runs/<id>/hosts/` | The run's host rows you may view: `device`, `virtual_machine`, `ip_address`, `address`, `status`, `transport`, `credential_source`, `key_first_use`, `attempts` (`transport`, `outcome`, `reason`), `message`, `packages`, `added`, `removed`, `updated`, `services`, `connects`, `engine`, `finished_at`. Filter `status`. | the same |
| `GET /api/discovery/runs/<id>/host-keys/` | Keys to review for the run's hosts | the same, and *view* on SSH host keys |

`counts` holds, for an inventory, `hosts`, `ok`, `packages`, `changed` and
one count per host status that is not `ok`, plus `versions`, `installs`,
`new_packages`, `fetch_queued` and `keys_accepted` when they apply; for a
service scan `hosts`, `ok`, `services`, `new`, `gone`, `connects`, `ports`,
`rate` and `hosts_parallel`.

`advisories` (on a run, and on a host's packages) is null while
vulnerability data is off or the read brought nothing to match; otherwise
`mode` (`server`, `browser`, `upload`), `state` (`fetched`, `not_fetched`,
`queued`, `running`), `last_fetch` and `can_sync`.

## Host keys

| Method, path | Purpose | Needs |
|---|---|---|
| `POST /api/discovery/host-keys/accept/` | `{"ids": [...]}`, 1 to 500 observed keys to accept. Answers `accepted` (ids), `refused` (`id`, `reason`: a key that differs from the host's accepted key) and `not_found` (other tenant, out of scope, unknown). | *change* on SSH host keys, site scope included |

A pending key row has `id`, `device` or `virtual_machine`, `address`,
`key_type`, `fingerprint`, `first_seen`, `last_seen`, `mismatch` and
`can_accept`.

## Do not scan

| Method, path | Purpose | Needs |
|---|---|---|
| `POST /api/discovery/exempt/` | `{"kind": "device" \| "virtual_machine" \| "ipaddress" \| "prefix", "id": "<uuid>", "exempt": true}`. Answers `kind`, `id`, `scan_exempt`; 404 when not found or out of your scope. Or `{"objects": [{"kind": …, "id": …}, …], "exempt": true}`, 1 to 500: answers `updated` (`kind`, `id`), `scan_exempt` and `not_found` - objects of another tenant or out of your scope are counted there, the rest are set. Each change is in the object's change log. | *change* on each object; 403 without any *change* grant on a kind sent |

The device, VM, IP address and prefix APIs return `scan_exempt` read-only; a
`PATCH` there does not change it. An IP address's detail also has
`scan_exempt_via`: `{id, cidr}` of the exempt prefix covering it (`id` and
`cidr` null when you may not view that prefix), or null.

## Packages

| Method, path | Purpose | Needs |
|---|---|---|
| `GET /api/devices/<id>/packages/`, `GET /api/virtual-machines/<id>/packages/` | The host's current packages, paginated, `?search=` on name, source and publisher. Each row: `id`, `name`, `version`, `arch`, `source_name`, `source_version`, `type` (`deb`, `rpm`, `apk`, `generic`), `ecosystem`, `purl`, `publisher`, `first_seen`, `last_seen`, `application` (`{id, name}` or null), `cves` (`{count, severity}`, null while vulnerability data is off). Also `os` (the OS facts, Windows fields included), `advisories`, and `os_build` for a Windows host (`product`, `build`, `flag`: `product_unknown` or `ubr_unknown` or blank, `open`). | *view* on the host and on installed software |

## Service scans and findings

| Method, path | Purpose | Needs |
|---|---|---|
| `GET /api/discovery/services/` | Observed services on addresses you may view. Filters `run`, `profile`, `ip_address`, `device`, `virtual_machine`, `confidence` (comma-separated), `search` (address, product, service, banner), `current=false` for closed ones too. Each: `address`, `port`, `protocol`, `ip_address`, `device`, `virtual_machine`, `service_name`, `banner`, `product`, `vendor`, `version`, `cpe`, `os_guess`, `source`, `rule`, `confidence`, `http`, `tls`, `certificate`, `first_seen`, `last_seen`, `gone_at`, `run`. | *view* on IP addresses |
| `GET /api/discovery/findings/` | Proposals to review: `service`, `software`, `cpe` (with *view* on IP addresses) and `platform`, `application`, `link` (with *view* on installed software). The filters of `services/`, plus `kind` (comma-separated) and `ignored=true`. Each: `id` (`<kind>:<…>`), `kind`, `host`, `title`, `proposal`, `confidence`, `ignored`, `evidence`; inventory rows also `os` or `packages`. `totals` counts the open ones by kind. | *view* on IP addresses or on installed software |
| `POST /api/discovery/findings/accept/` | `{"ids": [...]}`, 1 to 500. Answers `created` (`finding`, `kind`, `id`, `name`, and `created_platform`, `mapped` or `application` when that happened) and `refused` (`id`, `reason`). `cpe:` ids are refused here: accept them with `POST /api/vulnerabilities/mappings/bulk-create/`, `[{"application": "<id>", "identifier": "cpe:2.3:a:…"}]`. | what each accept creates or changes |
| `POST /api/discovery/findings/ignore/` | `{"ids": [...], "ignore": true}` (or `false` to show again). Answers `done` and `refused`. | what accepting would need |

## Outpost endpoints

Authenticated with the Outpost's Bearer token, not a user; described on
[Outposts](../monitoring/outposts.md#discovery-on-an-outpost).

| Method, path | Purpose |
|---|---|
| `GET /api/outpost/discovery-work/` | Claim this Outpost's next batch (one run's items): `{"jobs": [...]}`, credentials included, `Cache-Control: no-store` |
| `POST /api/outpost/discovery-results/` | `{"results": [{"item_id": …, "result": …}]}`, at most 200 per post; answers `accepted` and `refused`; 400 for a malformed body |
