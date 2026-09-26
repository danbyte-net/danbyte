# Tenant settings - global defaults, per-tenant overrides

How settings split between the **deployment** (one install, all tenants) and a
**tenant** (its own slice), and how per-tenant LDAP login works.

## The model

Two settings stores:

| Store | Scope | Holds |
|---|---|---|
| `DeploymentSettings` (`core/models.py`, singleton `pk=1`) | whole install | SMTP defaults (Settings → Email), deployment LDAP (Settings → Directory), updates/release repo, `public_base_url`, proxy/timeouts (Settings → Security → Outbound delivery), drift scheduler, retention, deployment name, branding (`favicon`, `login_logo`) - plus the **defaults** for every overridable group |
| `TenantSettings` (`core/models.py`, OneToOne per tenant) | one tenant | overrides for **Email/SMTP**, **LDAP/AD**, **UI policy** (device-field visibility, human-IDs), **Delegation** (site-editor delegation), **Site separation** (`enhanced_site_separation`, `allow_site_settings` - its own `override_separation` toggle, like the floor-plan popover group), **Date & time** (`date_format`, `time_style`, `display_timezone` - its own `override_datetime` toggle), **Topology card lines** (`topology_card_fields`, `topology_card_role_overrides` - its own `override_topology_card` toggle) |
| `SiteSettings` (`core/models.py`, OneToOne per site) | one site | **Email/SMTP only (v1)** - site-local relay + From address, for orgs whose sites run their own IT. Gated by `allow_site_settings` + site-admin qualification (`core/site_settings.py`) |

Each group on `TenantSettings` carries an `override_*` toggle. **Off (and no
row at all) = inherit the deployment default.** Field names mirror
`DeploymentSettings` exactly, so consumers (`build_email_connection`, the LDAP
backend builder, the sharing gates) accept either object unchanged.

Resolution lives in `core/effective_settings.py`:
`effective_email(tenant, site=None)` / `effective_sharing(tenant)` /
`effective_ui(tenant)` / `effective_separation(tenant)` /
`effective_datetime(tenant)` return the most specific row whose toggle is on,
else `DeploymentSettings.load()`.
(`separation_enabled(tenant)` is the bool shortcut the RBAC fencing reads -
see [Enhanced site separation](../access/site-separation.md).)

**Topology card lines have two more layers below the tenant.** What a device
card on the topology Diagram shows under its name is an ordered list of keys
from `core.deployment.TOPOLOGY_CARD_FIELDS` (`status`, `monitor`,
`primary_ip`, `secondary_ip`, `oob_ip`, `loopback`, `serial`, `asset_tag`,
`device_type`, `manufacturer`, `platform`, `role`, `site`, `location`, `rack`,
`tags`, plus `cf_<key>` for device custom fields), at most 8. `status` and
`monitor` draw the pill in the card's corner rather than a line.
`effective_topology_card(tenant)` returns `{fields, role_overrides, source}`
from the tenant row when `override_topology_card` is on, else the deployment
row; a tenant override replaces the global and per-role lists wholesale.
`resolve_card_fields(device, eff, view_fields=None)` then picks, first hit
wins:

1. the device's own `Device.topology_card`;
2. the saved view's list;
3. the device role's list, keyed `role:<slug>` in `role_overrides`;
4. the effective global list (`source` `tenant` or `deployment`);
5. the built-in default: monitoring pill, IP, Loopback, Serial (`source`
   `default`).

Null (or an absent role key) inherits the next level; `[]` means **name
only** and is allowed at every level. Writes refuse unknown keys and lists
over 8 with a field error; reads drop keys the vocabulary no longer knows,
and a list that loses every key inherits rather than turning into name only.
That holds on every endpoint that carries the lists, the generic
`/api/tenant-settings/` included, so a payload read and written straight
back is never refused.

**Date & time has a third, per-user layer.** `auth_api.user_prefs` carries
`date_format` / `time_style` / `timezone` prefs whose default is `"auto"` =
inherit the tenant-effective value; `datetime_prefs(user, tenant)` resolves
the full cascade (user → tenant → deployment; a blank stored timezone falls
back to the server's `TIME_ZONE`). `/api/me/` exposes the **resolved** values
as `datetime` - the SPA's single read point for date/time formatting
(`frontend/src/lib/datetime.ts`, `useDateFormat()`).

**Nothing formats a date on its own.** `new Date(x).toLocaleString()` renders
in the *browser's* timezone, which is a different instant from every other
screen. Reach for `TimeCell`, the `useDateFormat()` hook, or the plain
helpers; `formatCustom(value, opts)` takes Intl options of your own (a chart
axis wants `14:00`, not a full timestamp) and still applies the effective
timezone. A test (`frontend/src/lib/-raw-dates.test.ts`) fails the build if a
raw call comes back.

**What site email affects (v1)** - only sends that are about a single
site-bound object resolve the site layer: per-object monitoring alerts and
prefix-utilization warnings (`notify_event(..., site_id=…)`), plus the
per-site test-email endpoint. Batched change digests, sign-in/MFA codes, and
invites stay on the tenant/deployment relay - a digest mixes sites and login
happens before any site is known. Site SMTP hosts are SSRF-guarded like
tenant ones (`build_email_connection`).

**Who is a site admin** - tenant admins always; otherwise `allow_site_settings`
must be on and the user either holds a `sitesettings` change grant scoped to
the site (grantable to users or groups - build a "Site X admins" group) or is
a site editor there. Holding only the `sitesettings` grant does NOT make
someone an infrastructure editor (it's excluded from `editable_sites`).
Deployment-only groups (updates, public URL, proxy, drift, retention) have no
tenant counterpart by design - updates patch the shared process.

## Branding

`deployment_name` (blank = `"Danbyte"`) drives the sidebar header, the browser
tab **title**, and the login page. The tab **icon** is the `favicon` image:
blank = the shipped default (the blue Danbyte "D", `frontend/public/favicon.*`),
else the uploaded file served from media. Both live on `DeploymentSettings` and
are set from Settings → Branding & identity → **Identity** (`users.manage`). The favicon
uploads via `POST /api/deployment/favicon/` (multipart; `DELETE` clears it) -
only Pillow-decodable raster images are accepted, which rules out SVG so no
active content lands on the media origin. `me_json` returns `favicon_url`
(null = default) and the SPA swaps the `<link rel="icon">` href at runtime
(`__root.tsx`), the same pattern that brands the tab title from
`deployment_name`.

The **login-page logo** works the same way: `login_logo` on
`DeploymentSettings`, uploaded via `POST /api/deployment/logo/` (multipart
`logo`; `DELETE` clears; raster only, max 2 MB / 2400px), shown above the
sign-in form. Blank = the bundled Danbyte wordmark
(`frontend/public/branding/logo-full*.png`, one variant per theme). Branding -
name, favicon and logo - also rides the **anonymous** `me_json` answer, since
the login page shows it before anyone signs in.

## Sessions

Two deployment-wide session controls live on `DeploymentSettings` and are set
from **Settings → Security** (`users.manage`):

- **Idle timeout** (`session_idle_timeout_minutes`, `0` = off). A rolling
  inactivity timeout: `core.middleware.SessionIdleTimeoutMiddleware` resets each
  authenticated session's expiry on every request, so a session untouched for
  the configured span is signed out. The value is cached for ~60s (cleared on
  save) to keep it off the hot path; API-token requests carry no session and are
  unaffected.
- **End all sessions** (`POST /api/deployment/end-all-sessions/`). Deletes every
  `django_session` row - an emergency "log everyone out" switch after a
  suspected compromise or a permissions overhaul. It signs the caller out too;
  API tokens keep working.

## Plugins & service control

Plugins follow the same tiering. A plugin is **installed** deployment-wide (a
package in `PLUGINS`, applied on restart), then **enabled/disabled** per scope:
`plugins.PluginConfig` holds a row per `(tenant, plugin)` - a NULL-tenant row is
the deployment default - and `plugins.resolve.plugin_enabled()` resolves the
cascade (tenant row → deployment default → the plugin's `default_enabled`).
Tenant admins toggle their tenant (`PATCH /api/plugins/<slug>/config/` scope
`tenant`, `can_manage_admin`); the deployment default is `can_manage_deployment`.
**Service control** (restart units, apply plugin migrations) is stricter still -
**superuser only**, since it restarts production processes. See
[Plugins](plugins.md).

## Two admin tiers

| Tier | Gate | Surfaces |
|---|---|---|
| **Tenant admin** | `can_manage_admin(user, tenant)` - a `users.manage`/user-change grant *narrowed to the tenant* suffices | Settings → **This tenant**: General (UI + sharing overrides), Email, Directory, Monitoring, SNMP profiles. API: `/api/tenant-settings/*` |
| **Deployment admin** | `can_manage_deployment(user)` - superuser, global `users.manage`, or a user-change grant with **no** tenant narrowing | Settings → **Deployment**: General, Updates, Email, Directory, Identity providers (SSO). API: `/api/deployment/*`, `/api/system/*`, `/api/identity-providers/` |

`me_json` exposes both flags (`can_manage_users`, `can_manage_deployment`);
the SPA nav (`settings.tsx`) renders the two sections accordingly.

## Per-tenant LDAP (the interesting part)

Login happens **before** a tenant is selected, so the backend resolves an
ordered **directory chain** (`ldap_directory_chain(username)`):

1. `user@corp.com` whose domain matches a tenant's **login domains** → only
   that tenant's directory, searched as `user`. The Django username keeps the
   full `user@domain` form - collision-proof against bare local names. A login
   domain may be claimed by **at most one tenant** deployment-wide (enforced in
   `TenantLDAPSettingsSerializer.validate`); otherwise routing would be
   ambiguous and a tenant could siphon another's `@domain` logins.
2. Otherwise: deployment directory first, then each overriding tenant
   directory ordered by tenant slug. First successful bind wins; local
   accounts still fall through to `ModelBackend`.

### Security invariants (`auth_api/ldap.py`)

- **Ownership anchor:** `UserProfile.ldap_source_tenant` records which tenant's
  directory owns an LDAP account (NULL = deployment directory / local).
- **Pre-bind guard** (before any directory I/O): a tenant directory may only
  match a username it owns or one that doesn't exist. It can never
  authenticate as a local user, a deployment-LDAP user, or another tenant's
  user - so a tenant admin pointing at a malicious directory can't impersonate
  anyone outside their tenant. The deployment directory keeps its historical
  "adopt a local account" semantics but refuses tenant-owned accounts.
- **Collision policy:** a new tenant-directory user whose bare username already
  exists elsewhere is rejected (logged to `danbyte.ldap`). Use login domains to
  avoid collisions entirely.
- **Membership:** a successful tenant-directory login grants
  `UserProfile.tenants` membership to **that tenant only**.
- **Group-mapping escalation guard:** `LDAPGroupMapping` now carries a nullable
  `tenant` FK (NULL = deployment mapping). A tenant-scoped mapping may only
  target an `auth.Group` whose enabled `ObjectPermission`s are all narrowed to
  exactly that tenant - enforced at mapping creation **and** re-checked at
  every group sync, so widening a group's permissions later can't be laundered
  through an old mapping into deployment-wide access.

## API summary

- `GET/PUT /api/tenant-settings/` - overrides + non-secret
  `deployment_defaults` for the UI's inherit summaries (tenant admin).
- `POST /api/tenant-settings/email/test/` - test through the *effective* SMTP.
- `GET /api/device-fields/` - effective device-field visibility (any member).
- `GET/PUT /api/deployment/topology-card/` - deployment card lines
  (`can_manage_deployment`); `GET/PUT /api/tenant-settings/topology-card/` -
  this tenant's, with `override` and `deployment_defaults` (tenant admin);
  `GET /api/topology-card/` - the effective config (any member). Payload keys:
  `card_fields` (null on PUT resets to the built-in default), `is_default`,
  `role_overrides`, and the vocabulary `available`, `pills`, `defaults`,
  `max_fields`. The per-device list is `topology_card` on
  `PATCH /api/devices/<id>/` (`device.change`); a device clone carries it.
- `GET/PUT /api/tenant-settings/ldap/` + `test/`, `test-login/`, `groups/`,
  and `/api/tenant-ldap-group-mappings/` (tenant admin).
- Deployment endpoints unchanged in shape but now require
  `can_manage_deployment`.

## What emails use which relay

Alert/notification channels resolve via `channel.tenant`; MFA codes via the
user's `current_tenant` (best-effort - a user with no tenant yet gets the
deployment relay); invites via the inviting admin's active tenant. Deep-link
URLs always use the deployment `public_base_url`.
