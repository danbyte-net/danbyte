# Tenant settings — global defaults, per-tenant overrides

How settings split between the **deployment** (one install, all tenants) and a
**tenant** (its own slice), and how per-tenant LDAP login works.

## The model

Two settings stores:

| Store | Scope | Holds |
|---|---|---|
| `DeploymentSettings` (`core/models.py`, singleton `pk=1`) | whole install | SMTP defaults, deployment LDAP, updates/release repo, `public_base_url`, proxy/timeouts, drift scheduler, retention, deployment name — plus the **defaults** for every overridable group |
| `TenantSettings` (`core/models.py`, OneToOne per tenant) | one tenant | overrides for **Email/SMTP**, **LDAP/AD**, **UI policy** (device-field visibility, human-IDs), **Delegation** (site-editor delegation), **Site separation** (`enhanced_site_separation`, `allow_site_settings` — its own `override_separation` toggle, like the floor-plan popover group) |
| `SiteSettings` (`core/models.py`, OneToOne per site) | one site | **Email/SMTP only (v1)** — site-local relay + From address, for orgs whose sites run their own IT. Gated by `allow_site_settings` + site-admin qualification (`core/site_settings.py`) |

Each group on `TenantSettings` carries an `override_*` toggle. **Off (and no
row at all) = inherit the deployment default.** Field names mirror
`DeploymentSettings` exactly, so consumers (`build_email_connection`, the LDAP
backend builder, the sharing gates) accept either object unchanged.

Resolution lives in `core/effective_settings.py`:
`effective_email(tenant, site=None)` / `effective_sharing(tenant)` /
`effective_ui(tenant)` / `effective_separation(tenant)` return the most
specific row whose toggle is on, else `DeploymentSettings.load()`.
(`separation_enabled(tenant)` is the bool shortcut the RBAC fencing reads —
see [Enhanced site separation](../access/site-separation.md).)

**What site email affects (v1)** — only sends that are about a single
site-bound object resolve the site layer: per-object monitoring alerts and
prefix-utilization warnings (`notify_event(..., site_id=…)`), plus the
per-site test-email endpoint. Batched change digests, sign-in/MFA codes, and
invites stay on the tenant/deployment relay — a digest mixes sites and login
happens before any site is known. Site SMTP hosts are SSRF-guarded like
tenant ones (`build_email_connection`).

**Who is a site admin** — tenant admins always; otherwise `allow_site_settings`
must be on and the user either holds a `sitesettings` change grant scoped to
the site (grantable to users or groups — build a "Site X admins" group) or is
a site editor there. Holding only the `sitesettings` grant does NOT make
someone an infrastructure editor (it's excluded from `editable_sites`).
Deployment-only groups (updates, public URL, proxy, drift, retention) have no
tenant counterpart by design — updates patch the shared process.

## Two admin tiers

| Tier | Gate | Surfaces |
|---|---|---|
| **Tenant admin** | `can_manage_admin(user, tenant)` — a `users.manage`/user-change grant *narrowed to the tenant* suffices | Settings → **This tenant**: General (UI + sharing overrides), Email, Directory, Monitoring, SNMP profiles. API: `/api/tenant-settings/*` |
| **Deployment admin** | `can_manage_deployment(user)` — superuser, global `users.manage`, or a user-change grant with **no** tenant narrowing | Settings → **Deployment**: General, Updates, Email & Delivery, Directory. API: `/api/deployment/*`, `/api/system/*` |

`me_json` exposes both flags (`can_manage_users`, `can_manage_deployment`);
the SPA nav (`settings.tsx`) renders the two sections accordingly.

## Per-tenant LDAP (the interesting part)

Login happens **before** a tenant is selected, so the backend resolves an
ordered **directory chain** (`ldap_directory_chain(username)`):

1. `user@corp.com` whose domain matches a tenant's **login domains** → only
   that tenant's directory, searched as `user`. The Django username keeps the
   full `user@domain` form — collision-proof against bare local names. A login
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
  user — so a tenant admin pointing at a malicious directory can't impersonate
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
  exactly that tenant — enforced at mapping creation **and** re-checked at
  every group sync, so widening a group's permissions later can't be laundered
  through an old mapping into deployment-wide access.

## API summary

- `GET/PUT /api/tenant-settings/` — overrides + non-secret
  `deployment_defaults` for the UI's inherit summaries (tenant admin).
- `POST /api/tenant-settings/email/test/` — test through the *effective* SMTP.
- `GET /api/device-fields/` — effective device-field visibility (any member).
- `GET/PUT /api/tenant-settings/ldap/` + `test/`, `test-login/`, `groups/`,
  and `/api/tenant-ldap-group-mappings/` (tenant admin).
- Deployment endpoints unchanged in shape but now require
  `can_manage_deployment`.

## What emails use which relay

Alert/notification channels resolve via `channel.tenant`; MFA codes via the
user's `current_tenant` (best-effort — a user with no tenant yet gets the
deployment relay); invites via the inviting admin's active tenant. Deep-link
URLs always use the deployment `public_base_url`.
