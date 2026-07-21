// Thin fetch wrapper for the v2 React frontend.
// Same-origin in production (Django serves the SPA), proxied to :8000 in
// dev via vite.config.ts. Carries Django's CSRF cookie automatically.

// Type-only import (erased at compile time — api.ts stays runtime-import-free).
// The faceplate doc types live beside their algorithms in faceplate-layout.ts.
import type { FaceplateDoc } from "@/lib/faceplate-layout"

const CSRF_COOKIE = "csrftoken"

function getCsrf(): string {
  if (typeof document === "undefined") return ""
  const m = document.cookie.match(new RegExp(`${CSRF_COOKIE}=([^;]+)`))
  return m ? decodeURIComponent(m[1]) : ""
}

// A global 401 handler, registered from the router root. When the server
// rejects a request as unauthenticated (session expired server-side), we
// notify the app so it can re-resolve auth (invalidate ["me"]) and the
// layout guard kicks the user to /login — instead of leaving stale chrome.
let onUnauthorized: (() => void) | null = null
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn
}

export class ApiError extends Error {
  status: number
  body: unknown
  constructor(status: number, body: unknown, message?: string) {
    super(message ?? `API ${status}`)
    this.status = status
    this.body = body
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const isMutation =
    init.method &&
    !["GET", "HEAD", "OPTIONS"].includes(init.method.toUpperCase())
  const headers = new Headers(init.headers)
  if (!headers.has("Accept")) headers.set("Accept", "application/json")
  if (isMutation) {
    headers.set("X-CSRFToken", getCsrf())
    // Don't force JSON on FormData — the browser must set its own multipart
    // Content-Type (with boundary). Only default JSON for other bodies.
    if (
      init.body &&
      !headers.has("Content-Type") &&
      !(init.body instanceof FormData)
    ) {
      headers.set("Content-Type", "application/json")
    }
  }
  const res = await fetch(path, { credentials: "include", ...init, headers })
  // Skip the global handler ONLY for the /api/me/ auth probe — a 401 there is
  // the normal "logged out" signal, not a session that just expired. Match the
  // exact path (query string stripped); `includes("/api/me")` wrongly swallowed
  // 401s from sub-paths like /api/me/prefs/.
  const pathname = path.split("?")[0]
  if (res.status === 401 && pathname !== "/api/me/") {
    onUnauthorized?.()
  }
  if (!res.ok) {
    // Read the body ONCE as text, then try to parse JSON from it. Calling
    // both .json() and .text() on the same Response throws — the body
    // stream is single-use.
    const raw = await res.text()
    let body: unknown = raw
    try {
      body = JSON.parse(raw)
    } catch {
      /* keep the raw string */
    }
    const detail =
      body && typeof body === "object" && body !== null && "detail" in body
        ? String(body.detail)
        : raw.slice(0, 200)
    throw new ApiError(res.status, body, `${path} → ${res.status} ${detail}`)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

// Human-readable message for a failed api() call. Prefers the DRF `detail`
// string, then the first field error ("field: message", unprefixed for
// non_field_errors), then the ApiError message with its "path → status "
// debugging prefix stripped. Use this (or apiErrorToast from lib/api-toast)
// instead of `(err as Error).message` — raw messages leak URLs and status
// codes into the UI.
export function apiErrorMessage(
  err: unknown,
  fallback = "Request failed"
): string {
  if (err instanceof ApiError) {
    const body = err.body
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const rec = body as Record<string, unknown>
      if (typeof rec.detail === "string" && rec.detail) return rec.detail
      for (const [key, val] of Object.entries(rec)) {
        const first = Array.isArray(val) ? val[0] : val
        if (typeof first === "string" && first)
          return key === "non_field_errors" ? first : `${key}: ${first}`
      }
    }
    const m = /^\S+ → \d+ ([\s\S]+)$/.exec(err.message)
    return m?.[1].trim() || err.message || fallback
  }
  if (err instanceof Error && err.message) return err.message
  return fallback
}

// ─── Domain types ──────────────────────────────────────────────────────

export interface Tag {
  id: number
  name: string
  slug: string
  color: string
  text_color: string
  /** Number of objects tagged. Only present from the Tags management API. */
  usage_count?: number
  /** Site this catalog entry is scoped to — null means tenant-wide (Global).
   * Only present from the Tags management API. */
  owning_site?: { id: string; name: string } | null
  permissions?: ObjectPerms
}

export interface TagWritePayload {
  name: string
  color?: string
}

// One object (in the active tenant) that carries a tag.
export interface TagUsageItem {
  type: string
  type_label: string
  id: string
  name: string
  /** Frontend detail path, e.g. /prefixes/<uuid>. */
  url: string
}

export interface TagUsage {
  count: number
  results: TagUsageItem[]
}

// Per-object, constraint-aware permission flags for the current user, emitted
// by the API on objects whose serializer mixes in ObjectPermsSerializerMixin
// (Prefix, Device, IPAddress). Prefer this over the type-level `canDo` map when
// present: it accounts for row-level RBAC constraints `canDo` can't see.
export interface ObjectPerms {
  change: boolean
  delete: boolean
}

/** The embedded VLAN mini-shape (VLANMiniSerializer) — zone rides along so
 * tables can render the zone chip without a second fetch. */
export interface VLANMini {
  id: string
  vlan_id: number
  name: string
  zone?: { id: string; name: string; color: string; text_color: string } | null
}

export interface Prefix {
  id: string
  numid: number | null
  cidr: string
  status: StatusMini | null
  family: 4 | 6 | null
  utilisation_pct: number | null
  /** Small enough to enumerate host-by-host (show-available / next-available). */
  is_enumerable: boolean
  ip_count: number
  child_count: number
  has_descendants: boolean
  site: { id: string; name: string } | null
  location: { id: string; name: string } | null
  vlan: VLANMini | null
  vrf: { id: string; name: string; rd: string; color: string } | null
  gateway: string | null
  description: string
  auto_discover: boolean
  auto_assign_site: boolean
  monitoring_engine?: { id: string; name: string; is_local: boolean } | null
  tags: Tag[]
  custom_fields: Record<string, unknown>
  permissions?: ObjectPerms
  created_at: string
  updated_at: string
}

export interface Paginated<T> {
  count: number
  next: string | null
  previous: string | null
  results: T[]
}

// ─── Date & time display settings ────────────────────────────────────────
// Cascade: user pref ("auto" = inherit) → tenant override → deployment
// default. /api/me/ carries the RESOLVED values; the raw editable ones live
// on /api/me/prefs/, /api/tenant-settings/ and /api/deployment/email/.
export type DateFormat =
  | "YYYY-MM-DD"
  | "DD.MM.YYYY"
  | "DD/MM/YYYY"
  | "MM/DD/YYYY"
  | "DD MMM YYYY"
export type TimeStyle = "24h" | "12h"

export interface DateTimeSettings {
  date_format: DateFormat
  time_style: TimeStyle
  /** IANA name, always resolved (never blank). */
  timezone: string
}

// ─── Identity + permissions (GET /auth/me/) ─────────────────────────────
// Anonymous callers get { is_authenticated: false, perms: [] }.
export interface Me {
  is_authenticated: boolean
  username?: string
  email?: string
  is_staff?: boolean
  is_superuser?: boolean
  perms: string[]
  /** Fine-grained RBAC map: object-type slug → granted actions. */
  permissions: Record<string, string[]>
  can_manage_users?: boolean
  /** Deployment-tier admin (global email/LDAP/updates). Stricter than
   * can_manage_users — a tenant-narrowed grant doesn't qualify. */
  can_manage_deployment?: boolean
  can_edit_tenant?: boolean
  deployment_name?: string
  /** Custom browser-tab icon URL (Admin → Identity); null/absent = default. */
  favicon_url?: string | null
  /** Whether to surface per-tenant human-readable numbers (numid) in the UI. */
  human_ids_enabled?: boolean
  active_tenant?: { id: string; name: string; slug: string } | null
  /** Site-editor delegation: global toggle + sites this user may invite
   * viewers to ("all" for admins/global editors, else a list of site ids). */
  site_delegation_enabled?: boolean
  can_delegate_sites?: "all" | string[]
  /** Enhanced site separation (per-tenant effective): when on, forms filter
   * site pickers to editable_sites and lock single-site users' site fields. */
  site_separation?: boolean
  /** Sites this user may WRITE in — "all" for admins/cross-site editors. */
  editable_sites?: "all" | string[]
  /** Per-site settings: the tenant's allow switch + the sites whose settings
   * this user may manage ("all" | ids; [] hides the section). */
  site_settings_enabled?: boolean
  settings_sites?: "all" | string[]
  /** Second-factor state for the current account (preferences page). */
  mfa?: {
    require_mfa: boolean
    totp_confirmed: boolean
    email_available: boolean
  }
  /** Resolved date/time display settings (user → tenant → deployment). */
  datetime?: DateTimeSettings
}

// ─── Session login + MFA (POST /api/auth/...) ───────────────────────────────
export type MfaMethod = "totp" | "email"

export interface LoginResult {
  ok?: boolean
  mfa_required?: boolean
  methods?: MfaMethod[]
  email_hint?: string | null
}

export interface TotpSetup {
  secret: string
  otpauth_uri: string
}

export const auth = {
  login: (username: string, password: string) =>
    api<LoginResult>("/api/auth/login/", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  verifyMfa: (method: MfaMethod, code: string) =>
    api<{ ok: boolean }>("/api/auth/mfa/verify/", {
      method: "POST",
      body: JSON.stringify({ method, code }),
    }),
  resendMfa: () =>
    api<{ ok: boolean }>("/api/auth/mfa/resend/", { method: "POST" }),
  logout: () => api<{ ok: boolean }>("/api/auth/logout/", { method: "POST" }),
  setPassword: (uid: string, token: string, password: string) =>
    api<{ ok: boolean; username: string }>("/api/auth/set-password/", {
      method: "POST",
      body: JSON.stringify({ uid, token, password }),
    }),
  totpSetup: () =>
    api<TotpSetup>("/api/auth/mfa/totp/setup/", { method: "POST" }),
  totpConfirm: (code: string) =>
    api<{ ok: boolean }>("/api/auth/mfa/totp/confirm/", {
      method: "POST",
      body: JSON.stringify({ code }),
    }),
  totpDisable: () =>
    api<{ ok: boolean }>("/api/auth/mfa/totp/disable/", { method: "POST" }),
}

// ─── RBAC admin (users / groups / object permissions) ───────────────────────

export type RBACAction = "view" | "add" | "change" | "delete"

export interface RBACUser {
  id: number
  username: string
  email: string
  first_name: string
  last_name: string
  is_active: boolean
  is_superuser: boolean
  is_staff: boolean
  last_login: string | null
  date_joined: string
  groups: { id: number; name: string }[]
  tenants: { id: string; name: string }[]
  auth_source: "local" | "ldap"
  require_mfa: boolean
  mfa_active: boolean
}

export interface RBACUserWritePayload {
  username: string
  email?: string
  first_name?: string
  last_name?: string
  is_active?: boolean
  is_superuser?: boolean
  password?: string
  /** Email the user a set-your-own-password link instead of setting one. */
  send_invite?: boolean
  group_ids?: number[]
  tenant_ids?: string[]
  set_auth_source?: "local" | "ldap"
  set_require_mfa?: boolean
  /** One-click site scoping — assembles the ObjectPermission combo server-side. */
  site_role?: SiteRolePayload
}

/** Site-scoped access assembled on user/group create (see assemble_site_role). */
export interface SiteRolePayload {
  role: "editor" | "viewer"
  site_ids: string[]
  /** editor only: no read-all grant → can't see other sites. */
  silo?: boolean
}

/** GET /api/users/<id>/access-summary/ — plain-language read of a user's reach. */
export interface UserAccessSummary {
  is_admin: boolean
  edit_scope: "all" | "sites" | "none"
  read_scope: "all" | "sites" | "none"
  editable_sites: { id: string; name: string }[]
}

export interface RBACGroup {
  id: number
  name: string
  description: string
  built_in: boolean
  user_count: number
  permission_count: number
}

export interface RBACGroupWritePayload {
  name: string
  set_description?: string
  site_role?: SiteRolePayload
}

export interface ObjectPermission {
  id: string
  name: string
  description: string
  enabled: boolean
  object_types: string[]
  actions: RBACAction[]
  constraints: unknown | null
  tenants: { id: string; name: string }[]
  sites: { id: string; name: string }[]
  groups: { id: number; name: string }[]
  users: { id: number; username: string }[]
  created_at: string
  updated_at: string
}

export interface ObjectPermissionWritePayload {
  name: string
  description?: string
  enabled?: boolean
  object_types: string[]
  actions: RBACAction[]
  constraints?: unknown | null
  group_ids?: number[]
  user_ids?: number[]
  tenant_ids?: string[]
  site_ids?: string[]
}

export interface ObjectTypeMeta {
  slug: string
  label: string
  group: string
  actions: RBACAction[]
}

export interface RBACObjectTypes {
  object_types: ObjectTypeMeta[]
  actions: RBACAction[]
}

// ─── Per-table column preferences (/auth/prefs/columns/<table_id>/) ──────
export interface ColumnPrefData {
  /** Column ids in the user's chosen order (manageable columns only). */
  order: string[]
  /** Column ids the user has hidden. */
  hidden: string[]
}

export interface ColumnPref {
  /** Where the effective layout came from. `tenant_forced` = admin lock. */
  source: "user" | "default" | "tenant_forced" | "none"
  data: ColumnPrefData | null
  is_forced: boolean
}

/** One row of the bulk summary (GET /api/prefs/columns/) — table_id → this. */
export interface ColumnPrefSummary {
  source: ColumnPref["source"]
  is_forced: boolean
  has_user_row: boolean
}

// ─── Space map ─────────────────────────────────────────────────────────

export interface SpaceMapCell {
  cidr: string
  used: boolean
  dirty: boolean
  ip_count: number
  overlap_with: string[]
  /** Only populated for used cells — UUID of the prefix already covering
   * this CIDR, so the map can deep-link to its detail page. */
  prefix_id?: string | null
}

export interface SpaceMapRow {
  prefixlen: number
  count: number
  free_count: number
  dirty_count: number
  cells: SpaceMapCell[]
}

export interface SubnetDetailRow {
  label: string
  value: string
  mono: boolean
  copy: string
}

export interface SpaceMap {
  supported: boolean
  /** The CIDR the map is currently rooted at (the prefix, or a descended cell). */
  root?: string | null
  subnet_details: SubnetDetailRow[] | null
  next_available: string[]
  rows: SpaceMapRow[]
}

// ─── Picker shapes ─────────────────────────────────────────────────────

export interface VRFOption {
  id: string
  name: string
  rd: string
  color: string
}

export interface SiteOption {
  id: string
  name: string
}

export interface VLANOption {
  id: string
  vlan_id: number
  name: string
}

export interface TagOption {
  id: number
  name: string
  slug: string
  color: string
  text_color: string
}

// ─── Write payloads ────────────────────────────────────────────────────

export interface PrefixWritePayload {
  cidr: string
  status_id?: string | null
  vrf_id?: string | null
  site_id?: string | null
  location_id?: string | null
  vlan_id?: string | null
  gateway?: string | null
  description?: string
  auto_assign_site?: boolean
  tag_ids?: number[]
  custom_fields?: Record<string, unknown>
}

// ─── IP ranges ─────────────────────────────────────────────────────────

export interface IPRange {
  id: string
  numid: number | null
  start_address: string
  end_address: string
  status: StatusMini | null
  family: number | null
  size: number | null
  vrf: { id: string; name: string; rd: string; color: string } | null
  prefix: PrefixMini | null
  role: IPRoleMini | null
  description: string
  tags: Tag[]
  custom_fields: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface IPRangeWritePayload {
  start_address: string
  end_address: string
  status_id?: string | null
  vrf_id?: string | null
  prefix_id?: string | null
  role_id?: string | null
  description?: string
  tag_ids?: number[]
  custom_fields?: Record<string, unknown>
}

export interface IPRangeAvailable {
  size: number
  used: number
  available: number
  results: string[]
  truncated: boolean
}

// ─── RIRs + aggregates ─────────────────────────────────────────────────────

export interface RIR {
  id: string
  numid: number | null
  name: string
  slug: string
  is_private: boolean
  description: string
  aggregate_count: number
  created_at: string
  updated_at: string
}

export interface RIRWritePayload {
  name: string
  slug?: string
  is_private: boolean
  description?: string
}

export interface RIROption {
  id: string
  name: string
  slug: string
  is_private: boolean
}

export interface Aggregate {
  id: string
  numid: number | null
  prefix: string
  family: number | null
  utilisation_pct: number | null
  rir: { id: string; name: string; slug: string; is_private: boolean } | null
  date_added: string | null
  description: string
  tags: Tag[]
  custom_fields: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface AggregateWritePayload {
  prefix: string
  rir_id: string
  date_added?: string | null
  description?: string
  tag_ids?: number[]
  custom_fields?: Record<string, unknown>
}

// ─── ASNs ──────────────────────────────────────────────────────────────────

export interface ASN {
  id: string
  numid: number | null
  asn: number
  rir: { id: string; name: string; slug: string; is_private: boolean } | null
  sites: { id: string; name: string }[]
  description: string
  tags: Tag[]
  custom_fields: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface ASNWritePayload {
  asn: number
  rir_id?: string | null
  site_ids?: string[]
  description?: string
  tag_ids?: number[]
  custom_fields?: Record<string, unknown>
}

// ─── IP addresses ──────────────────────────────────────────────────────

export interface StatusMini {
  id: string
  name: string
  color: string
  text_color: string
}

export interface IPRoleMini {
  id: string
  name: string
  color: string
  text_color: string
  icon: string
  is_gateway: boolean
  is_virtual: boolean
}

export interface DeviceMini {
  id: string
  name: string
}

export interface PrefixMini {
  id: string
  cidr: string
  vrf: { id: string; name: string; rd: string; color: string } | null
  site: { id: string; name: string } | null
  vlan: VLANMini | null
  gateway: string | null
}

export interface IPAddress {
  id: string
  numid: number | null
  ip_address: string
  prefix: PrefixMini | null
  site: { id: string; name: string } | null
  status: StatusMini | null
  role: IPRoleMini | null
  assigned_device: DeviceMini | null
  assigned_interface: {
    id: string
    name: string
    device: { id: string; name: string }
  } | null
  assigned_vm?: { id: string; name: string; status: string } | null
  assigned_vm_interface?: {
    id: string
    name: string
    vm: { id: string; name: string }
  } | null
  /** L2 edge: the access switch + physical port this IP is reached through
   * (distinct from assigned_interface, which is the IP's own L3 port). */
  switch?: DeviceMini | null
  switch_interface?: {
    id: string
    name: string
    device: { id: string; name: string }
    virtual_chassis: { id: string; name: string } | null
  } | null
  mac_address: string
  dns_name: string
  last_seen: string | null
  discovered: boolean
  flap_exclude: boolean
  is_primary_for_device: boolean
  is_secondary_for_device?: boolean
  is_oob_for_device?: boolean
  description: string
  reservation_note: string
  custom_fields: Record<string, unknown>
  tags: Tag[]
  permissions?: ObjectPerms
  created_at: string
  updated_at: string
}

export interface StatusOption {
  id: string
  name: string
  slug: string
  color: string
  text_color: string
  is_default: boolean
  is_available: boolean
  requires_note: boolean
  weight: number
}

export interface IPRoleOption {
  id: string
  name: string
  slug: string
  color: string
  text_color: string
  icon: string
  is_gateway: boolean
  is_virtual: boolean
  weight: number
}

// ─── IP status / role catalogs (full read+write) ───────────────────────────

// Object types a Status can be made "available to" — mirrors the backend
// api/status_registry.STATUSABLE_MODELS.
export const STATUSABLE_MODELS: { value: string; label: string }[] = [
  { value: "ipaddress", label: "IP addresses" },
  { value: "device", label: "Devices" },
  { value: "prefix", label: "Prefixes" },
  { value: "iprange", label: "IP ranges" },
  { value: "rack", label: "Racks" },
  { value: "cluster", label: "Clusters" },
  { value: "virtualmachine", label: "Virtual machines" },
  { value: "cable", label: "Cables" },
  { value: "circuit", label: "Circuits" },
  { value: "powerfeed", label: "Power feeds" },
  { value: "wirelesslan", label: "Wireless LANs" },
  { value: "tunnel", label: "Tunnels" },
  { value: "location", label: "Locations" },
]

export interface Status {
  id: string
  name: string
  slug: string
  color: string
  text_color: string
  description: string
  weight: number
  available_to: string[]
  default_for: string[]
  is_available: boolean
  requires_note: boolean
  usage_count: number
  owning_site?: { id: string; name: string } | null
  permissions?: ObjectPerms
  created_at: string
  updated_at: string
}

export interface StatusWritePayload {
  name: string
  color?: string
  description?: string
  weight?: number
  available_to?: string[]
  default_for?: string[]
  is_available?: boolean
  requires_note?: boolean
}

export interface IPRole {
  id: string
  name: string
  slug: string
  color: string
  text_color: string
  description: string
  weight: number
  is_gateway: boolean
  is_virtual: boolean
  icon: string
  usage_count: number
  owning_site?: { id: string; name: string } | null
  permissions?: ObjectPerms
  created_at: string
  updated_at: string
}

export interface IPRoleWritePayload {
  name: string
  color?: string
  description?: string
  weight?: number
  is_gateway?: boolean
  is_virtual?: boolean
  icon?: string
}

export interface DeviceOption {
  id: string
  name: string
}

// ─── DCIM: manufacturers / device types / devices ───────────────────────────

export interface Manufacturer {
  id: string
  numid: number | null
  name: string
  slug: string
  url: string
  description: string
  tags: Tag[]
  device_type_count: number
  owning_site?: { id: string; name: string } | null
  permissions?: ObjectPerms
  created_at: string
  updated_at: string
}

export interface ManufacturerWritePayload {
  name: string
  url?: string
  description?: string
  tag_ids?: number[]
}

export interface ManufacturerOption {
  id: string
  name: string
}

export type DeviceStatus =
  | "active"
  | "planned"
  | "staged"
  | "offline"
  | "inventory"
  | "decommissioning"

// ─── Site map (geographic) ───────────────────────────────────────────────
export interface SiteMapSite {
  id: string
  name: string
  latitude: number | null
  longitude: number | null
  device_count: number
  floor_plan_count: number
  /** First few floor plans — popover jump-offs into the drill-down. */
  floor_plans: { id: string; name: string }[]
  /** Worst monitoring status across the site's device IPs, or null. */
  check: string | null
  can_edit: boolean
}

export interface SiteMapDevice {
  id: string
  name: string
  latitude: number
  longitude: number
  site: { id: string; name: string } | null
  role: { name: string; color: string } | null
  status: { name: string; color: string } | null
  device_type: string | null
  /** Front rack-face image of the device type, if uploaded. */
  front_image: string | null
  fov: SiteMapFov | null
  /** Role allows a field-of-view cone (cameras). */
  has_fov: boolean
  /** Worst monitoring status across the device's IPs, or null. */
  check: string | null
  can_edit: boolean
}

export interface SiteMapFov {
  direction: number | null
  deg: number | null
  distance_m: number | null
  ptz: boolean
}

/** A free-standing marker (tile-type / device-role vocabulary). */
export interface SiteMapMarker {
  id: string
  latitude: number
  longitude: number
  label: string
  description: string
  device: { id: string; name: string } | null
  type: {
    id: string
    name: string
    color: string
    icon: string
    has_fov: boolean
  } | null
  fov: SiteMapFov | null
}

/** A derived site-to-site connection edge (circuit / tunnel / cable). */
export interface SiteMapConnection {
  id: string
  kind: "circuit" | "tunnel" | "cable"
  name: string
  site_a: { id: string; name: string; latitude: number; longitude: number }
  site_z: { id: string; name: string; latitude: number; longitude: number }
  color: string
  status: { name: string; color: string } | null
  meta: Record<string, unknown>
}

export interface SiteMapPayload {
  tiles: {
    url: string
    attribution: string
    osm_default: boolean
    satellite: { url: string; attribution: string }
  }
  sites: SiteMapSite[]
  devices: SiteMapDevice[]
  markers: SiteMapMarker[]
}

/** Derived, most-severe-passed-milestone lifecycle state. "" = no dates. */
export type LifecycleState = "" | "supported" | "eos" | "security_ended" | "eol"

/** Vendor lifecycle window (LifecycleMixin) — DeviceType + Platform. */
export interface LifecycleInfo {
  /** GA / first-ship date — the start of the lifetime bar. */
  release_date: string | null
  end_of_sale: string | null
  end_of_security_updates: string | null
  /** End of life — the end of the lifetime bar. */
  end_of_support: string | null
  /** Vendor EoL notice URL. */
  lifecycle_url: string
  lifecycle_state: LifecycleState
}

export interface DeviceType extends LifecycleInfo {
  id: string
  numid: number | null
  name: string
  manufacturer: { id: string; name: string } | null
  model: string
  part_number: string
  /** Default OS platform for devices of this type (effective-platform fallback). */
  platform: { id: string; name: string } | null
  u_height: number
  /** Horizontal rack footprint — "half" mounts two side-by-side per U. */
  rack_width: "full" | "half"
  description: string
  /** Absolute URL of the front rack-face image, or null. */
  front_image: string | null
  /** Absolute URL of the rear rack-face image, or null. */
  rear_image: string | null
  /** Saved front-panel layout (drag-and-drop builder); null = auto layout. */
  faceplate: FaceplateDoc | null
  /** Occupies both rack faces (hatched on the opposite face in elevations). */
  is_full_depth: boolean
  airflow: string
  weight: string | null
  weight_unit: string
  subdevice_role: string
  exclude_from_utilization: boolean
  tags: Tag[]
  custom_fields: Record<string, unknown>
  device_count: number
  owning_site?: { id: string; name: string } | null
  permissions?: ObjectPerms
  created_at: string
  updated_at: string
}

export interface DeviceTypeWritePayload {
  subdevice_role?: string
  exclude_from_utilization?: boolean
  name: string
  manufacturer_id?: string | null
  model?: string
  part_number?: string
  platform_id?: string | null
  u_height?: number
  rack_width?: "full" | "half"
  description?: string
  tag_ids?: number[]
  custom_fields?: Record<string, unknown>
  faceplate?: FaceplateDoc | null
  is_full_depth?: boolean
  airflow?: string
  weight?: string | null
  weight_unit?: string
  release_date?: string | null
  end_of_sale?: string | null
  end_of_security_updates?: string | null
  end_of_support?: string | null
  lifecycle_url?: string
}

/** Picker shape (?picker=1) — DeviceTypeMiniSerializer. */
export interface DeviceTypeOption {
  id: string
  name: string
  u_height: number
  rack_width: "full" | "half"
}

export interface ImageAttachment {
  id: string
  image: string
  name: string
  sort_order: number
  created_at: string
  updated_at: string
}

export interface Device {
  id: string
  numid: number | null
  name: string
  device_type: {
    id: string
    name: string
    u_height: number
    rack_width: "full" | "half"
    is_full_depth: boolean
    front_image: string | null
    rear_image: string | null
    release_date?: string | null
    end_of_support?: string | null
    lifecycle_state?: LifecycleState
  } | null
  site: { id: string; name: string } | null
  role: { id: string; name: string; slug: string; color: string } | null
  platform: {
    id: string
    name: string
    slug: string
    release_date?: string | null
    end_of_support?: string | null
    lifecycle_state?: LifecycleState
  } | null
  /** Read-only: the device's own platform, else its type's default. */
  effective_platform: { id: string; name: string } | null
  status: StatusMini | null
  serial_number: string
  asset_tag: string
  description: string
  // ─── Promoted built-in fields (visibility is admin-controlled) ──────────
  comments: string
  airflow: string
  latitude: string | null
  longitude: string | null
  location: { id: string; name: string } | null
  cluster: { id: string; name: string } | null
  virtual_chassis: {
    id: string
    name: string
    is_master: boolean
    member_count: number
  } | null
  vc_position: number | null
  vc_priority: number | null
  config_template: {
    own: { id: string; name: string } | null
    resolved: { id: string; name: string } | null
  } | null
  primary_ip: { id: string; ip_address: string; dns_name: string } | null
  secondary_ip?: { id: string; ip_address: string; dns_name: string } | null
  oob_ip?: { id: string; ip_address: string; dns_name: string } | null
  tags: Tag[]
  custom_fields: Record<string, unknown>
  interface_count: number
  ip_count: number
  hardware_count: number
  console_count: number
  power_count: number
  service_count: number
  // ─── Rack placement (DCIM racks) ─────────────────────────────────────
  /** Lowest rack unit the device occupies, or null if unplaced. */
  position: number | null
  /** Mounted face; "" means full-depth (occupies both faces). */
  face: "front" | "rear" | ""
  /** Which half of the U a half-width device sits in; "" for full-width. */
  rack_side: "left" | "right" | ""
  /** Read-only, derived from the device type. */
  u_height: number
  /** Read-only, derived from the device type ("full" when untyped). */
  rack_width: "full" | "half"
  rack: {
    id: string
    name: string
    u_height: number
    starting_unit: number
    desc_units: boolean
  } | null
  permissions?: ObjectPerms
  created_at: string
  updated_at: string
}

export interface DeviceWritePayload {
  name: string
  device_type_id?: string | null
  site_id?: string | null
  role_id?: string | null
  platform_id?: string | null
  status_id?: string | null
  serial_number?: string
  asset_tag?: string
  description?: string
  tag_ids?: number[]
  custom_fields?: Record<string, unknown>
  rack_id?: string | null
  position?: number | null
  face?: "front" | "rear" | ""
  rack_side?: "left" | "right" | ""
  // ─── Promoted built-in fields (visibility is admin-controlled) ──────────
  comments?: string
  airflow?: string
  latitude?: string | null
  longitude?: string | null
  location_id?: string | null
  cluster_id?: string | null
  virtual_chassis_id?: string | null
  vc_position?: number | null
  vc_priority?: number | null
  config_template_id?: string | null
}

// Admin-controlled visibility for the promoted built-in Device fields.
// Served by GET /api/deployment/device-fields/ (all booleans). When the
// endpoint is unavailable (404 before it lands, or a network error) the form
// and detail page fall back to DEFAULT_DEVICE_FIELD_VISIBILITY below.
export interface DeviceFieldVisibility {
  comments: boolean
  location: boolean
  cluster: boolean
  airflow: boolean
  latitude: boolean
  longitude: boolean
}

/** Floor-plan tile popover config — the deployment-default editor's shape
 * (GET/PUT /api/deployment/floorplan-popover/). `available` + `defaults` come
 * from the server so the field vocabulary lives in one place. */
export interface FloorplanPopoverSettings {
  popover_fields: string[]
  tile_overrides: Record<string, string[]>
  available: string[]
  defaults: string[]
  /** Tenant layer only: whether this tenant overrides the deployment default.
   * Its own switch, independent of the UI-policy group. */
  override?: boolean
  /** Tenant layer only: what it inherits when `override` is false. */
  deployment_defaults?: {
    popover_fields: string[]
    tile_overrides: Record<string, string[]>
  }
}

/** The EFFECTIVE config for the active tenant (GET /api/floorplan-popover/) —
 * what the canvas renders from. A tile-type slug absent from `tile_overrides`
 * inherits `fields`. */
export interface FloorplanPopoverConfig {
  fields: string[]
  tile_overrides: Record<string, string[]>
}

export const DEFAULT_DEVICE_FIELD_VISIBILITY: DeviceFieldVisibility = {
  comments: true,
  location: true,
  cluster: false,
  airflow: false,
  latitude: false,
  longitude: false,
}

// ─── DCIM: device roles ─────────────────────────────────────────────────────

export interface DeviceRole {
  id: string
  numid: number | null
  name: string
  slug: string
  color: string
  is_patch_panel: boolean
  has_fov: boolean
  config_template: { id: string; name: string } | null
  description: string
  custom_fields: Record<string, unknown>
  tags: Tag[]
  device_count: number
  vm_count: number
  created_at: string
  updated_at: string
}

export interface DeviceRoleWritePayload {
  is_patch_panel?: boolean
  has_fov?: boolean
  name: string
  slug?: string
  color?: string
  config_template_id?: string | null
  description?: string
  custom_fields?: Record<string, unknown>
  tag_ids?: number[]
}

export interface DeviceRoleOption {
  id: string
  name: string
  slug: string
  color: string
}

// ─── DCIM: platforms ────────────────────────────────────────────────────────

export interface PlatformGroup {
  id: string
  numid: number | null
  name: string
  slug: string
  parent: { id: string; name: string; slug: string } | null
  description: string
  platform_count: number
  child_count: number
  created_at: string
  updated_at: string
}

export interface PlatformGroupWritePayload {
  name: string
  slug?: string
  parent_id?: string | null
  description?: string
}

/** Picker shape (?picker=1) — PlatformGroupMiniSerializer. */
export interface PlatformGroupOption {
  id: string
  name: string
  slug: string
}

export interface Platform extends LifecycleInfo {
  id: string
  numid: number | null
  name: string
  slug: string
  group: { id: string; name: string; slug: string } | null
  manufacturer: { id: string; name: string; slug: string } | null
  config_template: { id: string; name: string } | null
  description: string
  tags: Tag[]
  device_count: number
  created_at: string
  updated_at: string
}

export interface PlatformWritePayload {
  name: string
  slug?: string
  group_id?: string | null
  manufacturer_id?: string | null
  config_template_id?: string | null
  description?: string
  release_date?: string | null
  end_of_sale?: string | null
  end_of_security_updates?: string | null
  end_of_support?: string | null
  lifecycle_url?: string
  tag_ids?: number[]
}

export interface PlatformOption {
  id: string
  name: string
  slug: string
}

// ─── DCIM: rack roles / racks ───────────────────────────────────────────────

export interface RackRole {
  id: string
  numid: number | null
  name: string
  slug: string
  color: string
  description: string
  rack_count: number
  created_at: string
  updated_at: string
}

export interface RackRoleWritePayload {
  name: string
  slug?: string
  color?: string
  description?: string
}

export interface RackRoleOption {
  id: string
  name: string
}

export type RackStatus =
  | "active"
  | "planned"
  | "reserved"
  | "available"
  | "deprecated"

export type RackWidth = 10 | 19 | 21 | 23

export interface Rack {
  id: string
  numid: number | null
  name: string
  facility_id: string
  site: { id: string; name: string }
  role: { id: string; name: string; slug: string; color: string } | null
  status: StatusMini | null
  location: { id: string; name: string } | null
  width: RackWidth
  max_weight: string | null
  max_weight_unit: string
  /** Sum of racked devices' type weights, normalised to kg. */
  total_weight_kg: number
  max_weight_kg: number | null
  /** Supply from primary feeds vs the racked devices' power-port draws. */
  power: { available_w: number; allocated_w: number; maximum_w: number }
  u_height: number
  starting_unit: number
  desc_units: boolean
  description: string
  device_count: number
  used_units: number
  tags: Tag[]
  custom_fields: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface RackWritePayload {
  location_id?: string | null
  max_weight?: string | null
  max_weight_unit?: string
  site_id: string
  role_id?: string | null
  name: string
  facility_id?: string
  status_id?: string | null
  width?: RackWidth
  u_height?: number
  starting_unit?: number
  desc_units?: boolean
  description?: string
  tag_ids?: number[]
  custom_fields?: Record<string, unknown>
}

/** Picker shape (?picker=1) — RackMiniSerializer, includes unit geometry. */
export interface RackOption {
  id: string
  name: string
  u_height: number
  starting_unit: number
  desc_units: boolean
}

// ─── DCIM: interfaces / cables ──────────────────────────────────────────────

export type TerminationKind =
  | "interface"
  | "front_port"
  | "rear_port"
  | "console_port"
  | "console_server_port"
  | "power_port"
  | "power_outlet"
  | "power_feed"
  | "aux_port"

/** A cable's endpoint: a port and which device it's on. */
export interface Termination {
  kind: TerminationKind
  id: string
  name: string
  device: { id: string; name: string }
}

/** Lightweight cable a port is on (or null). */
export interface CableMini {
  id: string
  type: string
  color: string
  status: StatusMini | null
}

/** Choice option for the interface/cable type dropdowns (GET /api/dcim/choices/). */
export interface DcimChoice {
  value: string
  label: string
  /** Sub-category heading, e.g. "10 Gigabit Ethernet" — drives optgroups. */
  group?: string
}
export interface DcimChoices {
  interface_duplex: DcimChoice[]
  interface_modes: DcimChoice[]
  poe_modes: DcimChoice[]
  poe_types: DcimChoice[]
  interface_types: DcimChoice[]
  cable_types: DcimChoice[]
  front_port_types: DcimChoice[]
  console_port_types: DcimChoice[]
  power_port_types: DcimChoice[]
  power_outlet_types: DcimChoice[]
  aux_port_types: DcimChoice[]
  feed_legs: DcimChoice[]
  /** Connector value → fibre count, to pre-fill FrontPort.positions. */
  connector_fibers: Record<string, number>
  common_speeds: string[]
}

export interface Interface {
  id: string
  device: { id: string; name: string }
  name: string
  /** Media type slug (e.g. 10gbase-x-sfpp), or "" if unset. */
  type: string
  type_display: string
  speed: string
  mtu: number | null
  enabled: boolean
  mgmt_only: boolean
  duplex: string
  poe_mode: string
  poe_type: string
  wwn: string
  mac_address: string
  /** First-class MAC objects this interface bears (primary flagged). */
  mac_addresses: { id: string; mac_address: string; is_primary: boolean }[]
  /** 802.1Q mode: "" | "access" | "tagged" | "tagged-all". */
  mode: string
  mode_display: string
  /** Untagged / access (native) VLAN. */
  vlan: VLANMini | null
  /** Tagged VLANs carried on a trunk (mode = tagged). */
  tagged_vlans: { id: string; vlan_id: number; name: string }[]
  /** The VRF this interface routes in (null = Global). */
  vrf: { id: string; name: string } | null
  tags: Tag[]
  cable: CableMini | null
  cable_count: number
  ip_addresses: { id: string; ip_address: string }[]
  /** VPN tunnel ends this interface terminates (the "in a tunnel" chip). */
  tunnel_terminations: {
    id: string
    role: TunnelTerminationRole
    role_display: string
    tunnel: { id: string; name: string }
  }[]
  /** Virtual / logical interface (sub-interface, LAG, loopback, tunnel). */
  virtual: boolean
  /** The interface this one nests under (sub-interface parent), if any. */
  parent: { id: string; name: string } | null
  /** Number of interfaces nested under this one. */
  child_count: number
  /** The LAG/aggregate interface this one is a member of, if any. */
  lag: { id: string; name: string } | null
  /** Number of member interfaces (set when this interface IS a LAG). */
  lag_member_count: number
  /** The bridge interface this one belongs to, if any. */
  bridge: { id: string; name: string } | null
  created_at: string
  updated_at: string
}

export interface InterfaceWritePayload {
  mgmt_only?: boolean
  duplex?: string
  poe_mode?: string
  poe_type?: string
  wwn?: string
  device_id: string
  name: string
  type?: string
  speed?: string
  mtu?: number | null
  enabled?: boolean
  mac_address?: string
  mode?: string
  vlan_id?: string | null
  tagged_vlan_ids?: string[]
  vrf_id?: string | null
  tag_ids?: number[]
  virtual?: boolean
  parent_id?: string | null
  lag_id?: string | null
  bridge_id?: string | null
}

// ─── Patch-panel ports ──────────────────────────────────────────────────────

export interface RearPort {
  id: string
  device: { id: string; name: string }
  name: string
  positions: number
  is_splitter?: boolean
  type: string
  tags: Tag[]
  cable: CableMini | null
  front_port_count: number
  created_at: string
  updated_at: string
}

export interface RearPortWritePayload {
  device_id: string
  name: string
  positions?: number
  is_splitter?: boolean
  type?: string
  tag_ids?: number[]
}

export interface FrontPort {
  id: string
  device: { id: string; name: string }
  name: string
  rear_port: {
    id: string
    name: string
    device: { id: string; name: string }
    positions: number
  }
  rear_port_position: number
  positions: number
  type: string
  tags: Tag[]
  cable: CableMini | null
  created_at: string
  updated_at: string
}

export interface FrontPortWritePayload {
  device_id: string
  name: string
  rear_port_id: string
  rear_port_position?: number
  positions?: number
  type?: string
  tag_ids?: number[]
}

// ─── Console + device power components ──────────────────────────────────────
export interface ConsolePort {
  id: string
  device: { id: string; name: string }
  name: string
  type: string
  type_display: string
  speed: number | null
  description: string
  tags: Tag[]
  cable: CableMini | null
  created_at: string
  updated_at: string
}

export interface ConsolePortWritePayload {
  device_id: string
  name: string
  type?: string
  speed?: number | null
  description?: string
  tag_ids?: number[]
}

export type ConsoleServerPort = ConsolePort
export type ConsoleServerPortWritePayload = ConsolePortWritePayload

export interface PowerPort {
  id: string
  device: { id: string; name: string }
  name: string
  type: string
  type_display: string
  maximum_draw: number | null
  allocated_draw: number | null
  description: string
  outlet_count: number
  tags: Tag[]
  cable: CableMini | null
  created_at: string
  updated_at: string
}

export interface PowerPortWritePayload {
  device_id: string
  name: string
  type?: string
  maximum_draw?: number | null
  allocated_draw?: number | null
  description?: string
  tag_ids?: number[]
}

export interface PowerOutlet {
  id: string
  device: { id: string; name: string }
  name: string
  type: string
  type_display: string
  power_port: { id: string; name: string } | null
  feed_leg: "" | "A" | "B" | "C"
  description: string
  tags: Tag[]
  cable: CableMini | null
  created_at: string
  updated_at: string
}

export interface PowerOutletWritePayload {
  device_id: string
  name: string
  type?: string
  power_port_id?: string | null
  feed_leg?: "" | "A" | "B" | "C"
  description?: string
  tag_ids?: number[]
}

// ─── Device-type component templates ────────────────────────────────────────
// Materialised onto every new device of the type (NetBox semantics).
// ─── Modules (pluggable line cards) ─────────────────────────────────────────

export interface ModuleTypeOption {
  id: string
  name: string
  part_number: string
}

export interface ModuleType {
  id: string
  numid: number | null
  name: string
  manufacturer: { id: string; name: string } | null
  part_number: string
  faceplate: FaceplateDoc | null
  description: string
  custom_fields: Record<string, unknown>
  tags: Tag[]
  interface_template_count: number
  module_count: number
  created_at: string
  updated_at: string
}

export interface ModuleTypeWritePayload {
  name: string
  manufacturer_id?: string | null
  part_number?: string
  description?: string
  tag_ids?: number[]
  custom_fields?: Record<string, unknown>
}

export interface ModuleInterfaceTemplate {
  id: string
  name: string
  type: string
  enabled: boolean
  mgmt_only: boolean
  description: string
  created_at: string
  updated_at: string
}

export interface InventoryItemRow {
  id: string
  device: { id: string; name: string }
  parent: { id: string; name: string } | null
  name: string
  manufacturer: { id: string; name: string } | null
  part_id: string
  serial_number: string
  asset_tag: string
  description: string
  tags: Tag[]
}

export interface DeviceBayRow {
  id: string
  device: { id: string; name: string }
  name: string
  installed_device: { id: string; name: string } | null
  description: string
  tags: Tag[]
}

export interface ModuleBayRow {
  id: string
  device: { id: string; name: string }
  name: string
  position: string
  description: string
  /** Installed module, or null when the bay is empty. */
  module: {
    id: string
    module_type: { id: string; name: string }
    serial_number: string
  } | null
  tags: Tag[]
}

export interface ModuleWritePayload {
  device_id: string
  module_bay_id: string
  module_type_id: string
  serial_number?: string
  description?: string
}

export interface ComponentTemplateBase {
  id: string
  name: string
  type: string
  description: string
  created_at: string
  updated_at: string
}

export interface InterfaceTemplate extends ComponentTemplateBase {
  enabled: boolean
  mgmt_only: boolean
}

export type ConsolePortTemplate = ComponentTemplateBase
export type ConsoleServerPortTemplate = ComponentTemplateBase

export interface PowerPortTemplate extends ComponentTemplateBase {
  maximum_draw: number | null
  allocated_draw: number | null
}

export interface PowerOutletTemplate extends ComponentTemplateBase {
  power_port_template: { id: string; name: string } | null
  feed_leg: "" | "A" | "B" | "C"
}

export interface RearPortTemplate extends ComponentTemplateBase {
  positions: number
  is_splitter?: boolean
}

export interface FrontPortTemplate extends ComponentTemplateBase {
  rear_port_template: { id: string; name: string }
  rear_port_position: number
}

export interface ComponentTemplateWritePayload {
  device_type_id: string
  name: string
  type?: string
  description?: string
  // Per-kind extras (enabled/mgmt_only, draws, positions, rear-port link…)
  [key: string]: unknown
}

// ─── Cables (N-ary terminations: 1:1, breakout 1:N, M:N) ────────────────────

export type CableStatus = "connected" | "planned" | "decommissioning"

export interface Cable {
  id: string
  numid: number | null
  label: string
  type: string
  type_display: string
  status: StatusMini | null
  length: string | null
  length_unit: string
  color: string
  description: string
  /** Optical fibre: number of strands, or null for non-fibre. */
  fiber_count: number | null
  /** Sparse per-strand annotations keyed by 1-based position (as a string). */
  strands: Record<string, { label?: string; status?: string }>
  /** True when `type` is an optical-fibre medium (smf/mmf). */
  is_fiber: boolean
  a_terminations: Termination[]
  b_terminations: Termination[]
  tags: Tag[]
  custom_fields: Record<string, unknown>
  created_at: string
  updated_at: string
}

/** Tenant fibre-strand colour palette (GET/POST /api/fiber-settings/). */
export type StrandModelling = "off" | "count" | "accurate"

export interface FiberSettings {
  id: string
  colors: { name: string; hex: string }[]
  strand_modelling: StrandModelling
  updated_at: string
}

/** One termination in a write payload. */
export interface TerminationInput {
  kind: TerminationKind
  id: string
}

export interface CableWritePayload {
  a: TerminationInput[]
  b: TerminationInput[]
  label?: string
  type?: string
  status_id?: string | null
  length?: string | null
  length_unit?: string
  color?: string
  description?: string
  fiber_count?: number | null
  strands?: Record<string, { label?: string; status?: string }>
  tag_ids?: number[]
  custom_fields?: Record<string, unknown>
}

// ─── Topology / trace graph (React Flow shape) ──────────────────────────────

export type TopoPortKind =
  | "interface"
  | "front"
  | "rear"
  | "console"
  | "power"
  | "aux"

export interface TopoPort {
  name: string
  kind: TopoPortKind
  /** Rear port sharing this row — a panel's front ⇄ rear pass-through. */
  pair?: string
}

export interface TopoNode {
  id: string
  type: "device" | "interface" | "front_port" | "rear_port"
  data: {
    name: string
    device_id?: string
    interface_id?: string
    status?: string
    status_display?: string
    device_type?: string | null
    role?: { name: string; color: string; is_patch_panel?: boolean } | null
    site?: string | null
    location?: string | null
    primary_ip?: string | null
    interface_count?: number
    device_name?: string
    /** Pass-through-only device (patch panel). */
    panel?: boolean
    /** Cabled ports, ordered — each is an edge anchor on the stencil card. */
    ports?: TopoPort[]
  }
}

export interface TopoEdge {
  id: string
  source: string
  target: string
  type?: string
  data?: {
    cable_id?: string
    cable_type?: string
    color?: string
    status?: string
    pairs?: { a: string; b: string; a_port?: string; b_port?: string }[]
    cable_numid?: number | null
    cable_label?: string
    length?: string | null
    length_unit?: string
    /** Panels this collapsed end-to-end link passes through. */
    via?: string[]
    /** Trace map: this cable is part of the traced run. */
    marked?: boolean
    /** Device-map edges: the port names this collapsed link ran through. */
    endpoints?: { a: string; b: string }
    /** Device-map edges touching the origin: the origin's own port name. */
    origin_port?: string
    a_label?: string
    b_label?: string
    /** Ghost (LLDP) edges: the device + port ids needed to materialise a cable. */
    source_device?: string
    target_device?: string
    local_port?: string
    remote_port?: string
  }
}

/** One LLDP ghost edge (GET /api/monitoring/topology/ghosts/). */
export interface GhostEdgeData {
  source_device: string
  target_device: string
  local_port: string
  remote_port: string
  pairs: { a: string; b: string }[]
}

export interface DevicePathRun {
  origin: { name: string; kind: TopoPortKind }
  steps: (
    | {
        t: "chip"
        device_id: string
        device: string
        ports: { name: string; interface_id: string | null }[]
        panel: boolean
        origin?: boolean
      }
    | {
        t: "seg"
        cable_id: string
        cable_numid: number | null
        label: string
        cable_label: string | null
        color: string | null
        fiber?: boolean
        fiber_count?: number | null
        strand?: number
        strand_color?: { name: string; hex: string }
      }
  )[]
  complete: boolean
}

export interface TopologyViewState {
  filters?: Record<string, unknown>
  positions?: Record<string, [number, number]>
}

export interface TopologyViewSaved {
  id: string
  numid: number | null
  name: string
  state: TopologyViewState
  created_at: string
  updated_at: string
}

export interface TopologyGraph {
  nodes: TopoNode[]
  edges: TopoEdge[]
}

/** Trace adds an origin + a completeness flag to the same graph shape. */
export interface TraceGraph extends TopologyGraph {
  origin: { type: string; id: string }
  complete: boolean
  /** Device-level view (adaptive stencil cards) of the traced devices, with
   * the traced cables flagged (edge.data.marked). Rendered as the trace map. */
  device_graph?: TopologyGraph
}

export interface InterfaceOption {
  id: string
  name: string
  device_id: string
}

export interface IPWritePayload {
  ip_address: string
  prefix_id?: string
  status_id?: string | null
  role_id?: string | null
  assigned_device_id?: string | null
  assigned_interface_id?: string | null
  switch_id?: string | null
  switch_interface_id?: string | null
  mac_address?: string
  dns_name?: string
  description?: string
  reservation_note?: string
  tag_ids?: number[]
  custom_fields?: Record<string, unknown>
}

/** One row on the MAC addresses page: a MAC and everything it's paired with. */
/** A MAC's interface assignment, as returned by the aggregation views. */
export interface MacIfaceRef {
  id: string
  name: string
  device: { id: string; name: string }
}

/** A first-class MAC object (row-level view on the aggregation pages). */
export interface MacObject {
  id: string
  numid: number | null
  mac_address: string
  description: string
  assigned_interface: MacIfaceRef | null
  tags: Tag[]
}

/** MAC object on the detail page — adds its editable custom-field values. */
export interface MacObjectDetail extends MacObject {
  custom_fields: Record<string, unknown>
}

export interface MacEntry {
  mac: string
  interfaces: MacIfaceRef[]
  ips: {
    id: string
    ip_address: string
    device: { id: string; name: string } | null
  }[]
  objects: MacObject[]
}

/** MAC detail — richer than the list row (interface enabled, IP status). */
export interface MacDetail {
  mac: string
  objects: MacObjectDetail[]
  interfaces: {
    id: string
    name: string
    enabled: boolean
    device: { id: string; name: string }
  }[]
  ips: {
    id: string
    ip_address: string
    status: { name: string; color: string; text_color: string } | null
    device: { id: string; name: string } | null
    interface: { id: string; name: string } | null
  }[]
}

/** Full first-class MAC object — the `/api/mac-addresses/` CRUD serializer.
 * Same shape as the detail-page object, plus timestamps. */
export interface MACAddress extends MacObjectDetail {
  created_at: string
  updated_at: string
}

export interface MACAddressWritePayload {
  mac_address: string
  assigned_interface_id: string | null
  description: string
  tag_ids: number[]
  custom_fields: Record<string, unknown>
}

export interface IPBulkUpdateFields {
  status_id?: string | null
  role_id?: string | null
  description?: string
  add_tag_ids?: number[]
  remove_tag_ids?: number[]
}

// Nested IPs endpoint returns a flat list (no DRF pagination on this
// action). Carries the same Paginated-ish shape so the React side can
// reuse list helpers.
export interface IPListResponse {
  count: number
  results: IPAddress[]
}

export interface BulkUpdateFields {
  status_id?: string | null
  vrf_id?: string | null
  site_id?: string | null
  vlan_id?: string | null
  description?: string
  add_tag_ids?: number[]
  remove_tag_ids?: number[]
}

// ─── VLAN (full read+write shape, separate from VLANOption picker shape) ─

export interface VLAN {
  id: string
  numid: number | null
  vlan_id: number
  name: string
  site: { id: string; name: string } | null
  group: { id: string; name: string } | null
  zone: { id: string; name: string; color: string; text_color: string } | null
  description: string
  tags: Tag[]
  prefix_count: number
  custom_fields: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface VLANWritePayload {
  vlan_id: number
  name: string
  site_id?: string | null
  group_id?: string | null
  zone_id?: string | null
  description?: string
  tag_ids?: number[]
  custom_fields?: Record<string, unknown>
}

export interface VLANGroup {
  id: string
  numid: number | null
  name: string
  slug: string
  site: { id: string; name: string } | null
  cluster: { id: string; name: string } | null
  min_vid: number
  max_vid: number
  description: string
  vlan_count: number
  created_at: string
  updated_at: string
}

export interface VLANGroupWritePayload {
  name: string
  slug?: string
  site_id?: string | null
  cluster_id?: string | null
  min_vid: number
  max_vid: number
  description?: string
}

export interface VLANGroupOption {
  id: string
  name: string
  slug: string
  min_vid: number
  max_vid: number
}

// ─── Zones (Palo-Alto-style firewall zones, full read+write) ─────────────

export interface Zone {
  id: string
  name: string
  slug: string
  color: string
  text_color: string
  description: string
  weight: number
  usage_count: number
  owning_site: { id: string; name: string } | null
  permissions?: ObjectPerms
  tags: Tag[]
  custom_fields: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface ZoneWritePayload {
  name: string
  slug?: string
  color?: string
  description?: string
  weight?: number
  tag_ids?: number[]
  custom_fields?: Record<string, unknown>
  owning_site_id?: string | null
}

/** Picker shape (?picker=1). */
export interface ZoneOption {
  id: string
  name: string
  slug: string
  color: string
  text_color: string
  weight: number
}

// ─── FHRP groups ───────────────────────────────────────────────────────────

export type FHRPProtocol = "vrrp2" | "vrrp3" | "hsrp" | "glbp" | "carp"

export interface FHRPGroupAssignment {
  id: string
  interface: {
    id: string
    name: string
    device: { id: string; name: string }
  } | null
  vm_interface: {
    id: string
    name: string
    vm: { id: string; name: string }
  } | null
  priority: number
  created_at: string
  updated_at: string
}

export interface FHRPGroup {
  id: string
  numid: number | null
  name: string
  protocol: FHRPProtocol
  protocol_display: string
  group_id: number
  auth_type: "" | "plaintext" | "md5"
  auth_type_display: string
  auth_key: string
  virtual_ip: { id: string; ip_address: string } | null
  assignments: FHRPGroupAssignment[]
  assignment_count: number
  description: string
  tags: Tag[]
  custom_fields: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface FHRPGroupWritePayload {
  name?: string
  protocol: FHRPProtocol
  group_id: number
  auth_type?: "" | "plaintext" | "md5"
  auth_key?: string
  virtual_ip_id?: string | null
  description?: string
  tag_ids?: number[]
  custom_fields?: Record<string, unknown>
}

// ─── Contacts ────────────────────────────────────────────────────────────────

export interface ContactGroup {
  id: string
  numid: number | null
  name: string
  slug: string
  parent: { id: string; name: string; slug: string } | null
  description: string
  contact_count: number
  child_count: number
  created_at: string
  updated_at: string
}

export interface ContactGroupWritePayload {
  name: string
  slug?: string
  parent_id?: string | null
  description?: string
}

export interface ContactGroupOption {
  id: string
  name: string
  slug: string
}

export interface ContactRole {
  id: string
  numid: number | null
  name: string
  slug: string
  description: string
  assignment_count: number
  created_at: string
  updated_at: string
}

export interface ContactRoleWritePayload {
  name: string
  slug?: string
  description?: string
}

export interface ContactRoleOption {
  id: string
  name: string
  slug: string
}

export interface Contact {
  id: string
  numid: number | null
  name: string
  title: string
  phone: string
  email: string
  address: string
  link: string
  comments: string
  group: { id: string; name: string; slug: string } | null
  assignment_count: number
  tags: Tag[]
  custom_fields: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface ContactMini {
  id: string
  name: string
  title: string
  email: string
  phone: string
}

export interface ContactWritePayload {
  name: string
  title?: string
  phone?: string
  email?: string
  address?: string
  link?: string
  comments?: string
  group_id?: string | null
  tag_ids?: number[]
  custom_fields?: Record<string, unknown>
}

export type ContactPriority = "primary" | "secondary" | "tertiary" | "inactive"

export interface ContactAssignment {
  id: string
  contact: ContactMini
  role: { id: string; name: string; slug: string } | null
  object_type: string
  object_id: string
  priority: ContactPriority
  priority_display: string
  created_at: string
  updated_at: string
}

export interface ContactAssignmentWritePayload {
  contact_id: string
  role_id?: string | null
  object_type: string
  object_id: string
  priority: ContactPriority
}

export interface VLANBulkUpdateFields {
  site_id?: string | null
  zone_id?: string | null
  description?: string
  add_tag_ids?: number[]
  remove_tag_ids?: number[]
}

// ─── VRF + Route Target (full read+write) ────────────────────────────────

export interface RouteTarget {
  id: string
  numid: number | null
  name: string
  description: string
  import_vrf_count: number
  export_vrf_count: number
  tags: Tag[]
  custom_fields: Record<string, unknown>
  owning_site?: { id: string; name: string } | null
  permissions?: ObjectPerms
  created_at: string
  updated_at: string
}

export interface RouteTargetMini {
  id: string
  name: string
}

export interface VRF {
  id: string
  numid: number | null
  name: string
  rd: string
  color: string
  description: string
  enforce_unique: boolean
  import_targets: RouteTargetMini[]
  export_targets: RouteTargetMini[]
  tags: Tag[]
  prefix_count: number
  ip_count: number
  custom_fields: Record<string, unknown>
  owning_site?: { id: string; name: string } | null
  permissions?: ObjectPerms
  created_at: string
  updated_at: string
}

export interface VRFWritePayload {
  name: string
  rd?: string
  color?: string
  description?: string
  enforce_unique?: boolean
  import_target_ids?: string[]
  export_target_ids?: string[]
  tag_ids?: number[]
  custom_fields?: Record<string, unknown>
}

export interface RouteTargetWritePayload {
  name: string
  description?: string
  tag_ids?: number[]
  custom_fields?: Record<string, unknown>
}

// ─── Site (full read+write) ──────────────────────────────────────────────

export type SiteGatewayPolicy = "first" | "last" | "none"

export interface Site {
  id: string
  numid: number | null
  name: string
  region: { id: string; name: string } | null
  location: string
  latitude: string | null
  longitude: string | null
  description: string
  gateway_policy: SiteGatewayPolicy
  /** The prefix new addresses here come from by default — a hint for staff at
   * this site, not a constraint. */
  default_prefix: { id: string; cidr: string } | null
  vrfs: { id: string; name: string; rd: string; color: string }[]
  tags: Tag[]
  prefix_count: number
  vlan_count: number
  custom_fields: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface SiteWritePayload {
  name: string
  region_id?: string | null
  location?: string
  latitude?: string | null
  longitude?: string | null
  description?: string
  gateway_policy?: SiteGatewayPolicy
  default_prefix_id?: string | null
  vrf_ids?: string[]
  tag_ids?: number[]
  custom_fields?: Record<string, unknown>
}

// ─── Regions & Locations (org-tree nesting) ─────────────────────────────
export interface RegionOption {
  id: string
  name: string
  slug: string
}

export interface Region {
  id: string
  numid: number | null
  name: string
  slug: string
  parent: RegionOption | null
  description: string
  site_count: number
  child_count: number
  created_at: string
  updated_at: string
}

export interface RegionWritePayload {
  name: string
  slug?: string
  parent_id?: string | null
  description?: string
}

export type LocationStatus =
  | "active"
  | "planned"
  | "decommissioning"
  | "retired"

export interface LocationOption {
  id: string
  name: string
  slug: string
}

export interface Location {
  id: string
  numid: number | null
  name: string
  slug: string
  site: SiteOption | null
  parent: LocationOption | null
  status: StatusMini | null
  description: string
  child_count: number
  created_at: string
  updated_at: string
}

export interface LocationWritePayload {
  name: string
  slug?: string
  site_id: string
  parent_id?: string | null
  status_id?: string | null
  description?: string
}

// ─── Virtualization: cluster types / groups / clusters ──────────────────────

export interface ClusterType {
  id: string
  numid: number | null
  name: string
  slug: string
  description: string
  cluster_count: number
  created_at: string
  updated_at: string
}

export interface ClusterTypeWritePayload {
  name: string
  slug?: string
  description?: string
}

export interface ClusterGroup {
  id: string
  numid: number | null
  name: string
  slug: string
  description: string
  cluster_count: number
  created_at: string
  updated_at: string
}

export interface ClusterGroupWritePayload {
  name: string
  slug?: string
  description?: string
}

export type ClusterStatus =
  | "active"
  | "planned"
  | "staging"
  | "offline"
  | "decommissioning"

export interface Cluster {
  id: string
  numid: number | null
  name: string
  type: { id: string; name: string; slug: string }
  group: { id: string; name: string; slug: string } | null
  site: { id: string; name: string } | null
  status: StatusMini | null
  description: string
  vm_count: number
  tags: Tag[]
  custom_fields: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface ClusterWritePayload {
  name: string
  type_id: string
  group_id?: string | null
  site_id?: string | null
  status_id?: string | null
  description?: string
  tag_ids?: number[]
  custom_fields?: Record<string, unknown>
}

// ─── Virtual machine (full read+write) ───────────────────────────────────

export type VMStatus =
  | "active"
  | "offline"
  | "planned"
  | "staged"
  | "decommissioning"

export interface VirtualMachine {
  id: string
  numid: number | null
  name: string
  cluster: { id: string; name: string; status: StatusMini | null }
  device: { id: string; name: string } | null
  site: { id: string; name: string } | null
  role: { id: string; name: string; slug: string; color: string } | null
  platform: { id: string; name: string; slug: string } | null
  status: StatusMini | null
  vcpus: number | null
  memory_mb: number | null
  disk_gb: number | null
  primary_ip: { id: string; ip_address: string; dns_name: string } | null
  description: string
  tags: Tag[]
  custom_fields: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface VirtualMachineWritePayload {
  name: string
  cluster_id: string
  device_id?: string | null
  site_id?: string | null
  role_id?: string | null
  platform_id?: string | null
  primary_ip_id?: string | null
  status_id?: string | null
  vcpus?: number | null
  memory_mb?: number | null
  disk_gb?: number | null
  description?: string
  tag_ids?: number[]
  custom_fields?: Record<string, unknown>
}

// ─── VM interfaces (full read+write) ─────────────────────────────────────

export interface VMInterface {
  id: string
  vm: { id: string; name: string; status: StatusMini | null }
  name: string
  enabled: boolean
  mac_address: string
  mtu: number | null
  vlan: VLANMini | null
  mode: "" | "access" | "tagged" | "tagged-all"
  mode_display: string
  tagged_vlans: { id: string; vlan_id: number; name: string }[]
  vrf: { id: string; name: string } | null
  description: string
  ip_addresses: { id: string; ip_address: string }[]
  tags: Tag[]
  custom_fields: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface VMInterfaceWritePayload {
  vm_id: string
  name: string
  enabled?: boolean
  mac_address?: string
  mtu?: number | null
  vlan_id?: string | null
  mode?: string
  tagged_vlan_ids?: string[]
  vrf_id?: string | null
  description?: string
  tag_ids?: number[]
}

// ─── Services (port/protocol exposed by a device or VM) ──────────────────

export type ServiceProtocol = "tcp" | "udp"

export interface Service {
  id: string
  numid: number | null
  name: string
  protocol: ServiceProtocol
  protocol_display: string
  ports: number[]
  device: { id: string; name: string } | null
  virtual_machine: { id: string; name: string } | null
  ip_address: { id: string; ip_address: string } | null
  /** Source of truth for whether this service is watched. */
  monitored: boolean
  /** Ports actually scheduled now. 0 with monitored=true → no target IP yet. */
  check_count: number
  description: string
  tags: Tag[]
  custom_fields: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface ServiceWritePayload {
  name: string
  protocol?: ServiceProtocol
  ports?: number[]
  device_id?: string | null
  virtual_machine_id?: string | null
  ip_address_id?: string | null
  monitored?: boolean
  description?: string
  tag_ids?: number[]
}

/** POST /api/services/{id}/monitor/ — spawns TCP/UDP checks per port. */
export interface ServiceMonitorResponse {
  monitored: number
  ip: string
}

// ─── Device-type service templates (materialise onto new devices) ─────────

export interface DeviceTypeService {
  id: string
  name: string
  protocol: ServiceProtocol
  protocol_display: string
  ports: number[]
  monitor: boolean
  description: string
  created_at: string
  updated_at: string
}

export interface DeviceTypeServiceWritePayload {
  device_type_id: string
  name: string
  protocol: ServiceProtocol
  ports: number[]
  monitor: boolean
  description: string
}

// ─── Sync a device to its device type's component templates ───────────────

export interface DeviceSyncDiffEntry {
  add: string[]
  extra: string[]
}

/** POST /api/devices/{id}/sync-from-type/ — dry-run when apply omitted. */
export interface DeviceSyncResponse {
  applied: boolean
  diff: Record<string, DeviceSyncDiffEntry>
  risk: { interfaces_with_ips: number }
  result?: {
    added: Record<string, number>
    removed: Record<string, number>
  }
}

// ─── Service templates (reusable service definitions) ────────────────────

export interface ServiceTemplate {
  id: string
  numid: number | null
  name: string
  slug: string
  protocol: ServiceProtocol
  protocol_display: string
  ports: number[]
  description: string
  service_count?: number
  created_at: string
  updated_at: string
}

export interface ServiceTemplateWritePayload {
  name: string
  protocol: ServiceProtocol
  ports: number[]
  description: string
}

// ─── Tenant (full read+write + switch) ───────────────────────────────────

export interface Tenant {
  id: string
  name: string
  slug: string
  color: string
  description: string
  is_active: boolean
  group: { id: string; name: string; slug: string } | null
  site_count: number
  prefix_count: number
  vlan_count: number
  ip_count: number
  created_at: string
  updated_at: string
}

export interface TenantPicker {
  id: string
  name: string
  slug: string
  color: string
  is_active: boolean
}

export interface TenantWritePayload {
  name: string
  slug: string
  color?: string
  description?: string
  is_active?: boolean
  group_id?: string | null
}

export interface TenantGroup {
  id: string
  name: string
  slug: string
  parent: { id: string; name: string; slug: string } | null
  description: string
  tenant_count: number
  child_count: number
  created_at: string
  updated_at: string
}

export interface TenantGroupWritePayload {
  name: string
  slug?: string
  parent_id?: string | null
  description?: string
}

export interface SiteBulkUpdateFields {
  gateway_policy?: SiteGatewayPolicy
  location?: string
  add_tag_ids?: number[]
  remove_tag_ids?: number[]
}

// ─── Custom field definitions ──────────────────────────────────────────────

export type CustomFieldType =
  | "text"
  | "textarea"
  | "integer"
  | "decimal"
  | "boolean"
  | "date"
  | "url"
  | "select"
  | "multiselect"
  | "object"

export interface CustomField {
  id: string
  key: string
  label: string
  type: CustomFieldType
  /** Model slugs this field attaches to (see lib/custom-fields.ts). */
  applies_to: string[]
  /** Allowed options for select / multiselect. */
  choices: string[]
  /** Object fields: the reference-model slug the value points at. */
  related_model: string
  scope_rules: CustomFieldScopeRules
  required: boolean
  default: string
  description: string
  weight: number
  /** Optional section this field belongs to (CustomFieldGroup id), or null. */
  group: string | null
  /** Read-only group attributes, so sections render from the field list alone. */
  group_name: string | null
  group_weight: number | null
  group_collapsed: boolean | null
  owning_site?: { id: string; name: string } | null
  permissions?: ObjectPerms
  created_at: string
  updated_at: string
}

export interface CustomFieldScopeRule {
  include?: string[]
  exclude?: string[]
}

export type CustomFieldScopeRules = Partial<
  Record<
    | "models"
    | "device_types"
    | "device_roles"
    | "tags"
    | "vlan_ranges"
    | "ip_ranges"
    | "prefix_ranges"
    | "name_patterns",
    CustomFieldScopeRule
  >
>

export interface CustomFieldWritePayload {
  related_model?: string
  key: string
  label: string
  type: CustomFieldType
  applies_to: string[]
  choices: string[]
  scope_rules?: CustomFieldScopeRules
  required: boolean
  default?: string
  description?: string
  weight?: number
  group?: string | null
}

export interface CustomFieldGroup {
  id: string
  name: string
  slug: string
  description: string
  weight: number
  collapsed: boolean
  field_count: number
  owning_site?: { id: string; name: string } | null
  permissions?: ObjectPerms
  created_at: string
  updated_at: string
}

export interface CustomFieldGroupWritePayload {
  name: string
  slug?: string
  description?: string
  weight?: number
  collapsed?: boolean
}

// ─── Global search ───────────────────────────────────────────────────────

export interface SearchHit {
  id: string | number
  label: string
  sublabel: string
  extras: Record<string, unknown>
  /** Frontend route (no /api prefix). Navigate via TanStack Router. */
  url: string
}

export interface SearchResponse {
  q: string
  total: number
  groups: {
    prefixes: SearchHit[]
    ips: SearchHit[]
    vlans: SearchHit[]
    vrfs: SearchHit[]
    route_targets: SearchHit[]
    sites: SearchHit[]
    tenants: SearchHit[]
    devices: SearchHit[]
    tags: SearchHit[]
  }
}

export const SEARCH_GROUPS: Array<{
  key: keyof SearchResponse["groups"]
  label: string
}> = [
  { key: "prefixes", label: "Prefixes" },
  { key: "ips", label: "IP addresses" },
  { key: "vlans", label: "VLANs" },
  { key: "vrfs", label: "VRFs" },
  { key: "route_targets", label: "Route Targets" },
  { key: "sites", label: "Sites" },
  { key: "devices", label: "Devices" },
  { key: "tags", label: "Tags" },
  { key: "tenants", label: "Tenants" },
]

// ─── Monitoring / check engine ─────────────────────────────────────────────

export type CheckKind =
  | "icmp"
  | "tcp"
  | "udp"
  | "http"
  | "snmp"
  | "ssh"
  | "telnet"
  | "exec"
export type CheckStatus =
  | "up"
  | "down"
  | "degraded"
  | "unknown"
  | "stale"
  | "skipped"
export type ScheduleMode = "follow_global" | "custom_on" | "custom_off"

export interface CheckTemplate {
  id: string
  name: string
  slug: string
  kind: CheckKind
  params: Record<string, unknown>
  has_secrets: boolean
  usage_count: number
  interval_seconds: number
  timeout_ms: number
  retries: number
  rise: number
  fall: number
  degraded_enabled: boolean
  enabled: boolean
  created_at: string
  updated_at: string
}

export interface CheckResultRow {
  id: number
  template: string | null
  template_name: string | null
  kind: CheckKind
  status: CheckStatus
  latency_ms: number | null
  detail: Record<string, unknown>
  timestamp: string
}

export interface SparkPoint {
  timestamp: string
  status: CheckStatus
  latency_ms: number | null
}

export interface EffectiveCheckState {
  status: CheckStatus
  since: string | null
  last_checked: string | null
  last_latency_ms: number | null
  consecutive_success: number
  consecutive_fail: number
  next_run: string | null
}

export interface EffectiveCheck {
  template_id: string
  template_name: string
  kind: CheckKind
  /** "policy" = configured on a Monitoring → Configuration policy, not per-IP. */
  source: "direct" | "inherited" | "policy"
  prefix_id: string | null
  /** Null for policy-sourced checks (no per-IP CheckAssignment). */
  assignment_id: string | null
  interval_seconds: number
  degraded_enabled: boolean
  params: Record<string, unknown>
  enabled: boolean
  schedule_mode: ScheduleMode | null
  overrides: AssignmentOverrides
  template_defaults: { interval_seconds: number; rise: number; fall: number }
  state: EffectiveCheckState | null
  sparkline: SparkPoint[]
}

export interface IpChecksResponse {
  ip_id: string
  ip_address: string
  checks: EffectiveCheck[]
}

export interface CheckNowResult {
  template_id: string
  template_name: string
  kind: CheckKind
  source: string
  prefix_id: string | null
  status: CheckStatus
  latency_ms: number | null
  detail: Record<string, unknown>
}

export interface CheckNowResponse {
  ip_id: string
  ip_address: string
  count: number
  results: CheckNowResult[]
}

// ─── Monitoring — prefix rollup + bulk status ──────────────────────────────

export interface AssignmentOverrides {
  interval_seconds?: number
  rise?: number
  fall?: number
  degraded_enabled?: boolean
  params?: Record<string, unknown>
}

export interface PrefixCheckAssignment {
  id: string
  template: {
    id: string
    name: string
    kind: CheckKind
    interval_seconds: number
    rise: number
    fall: number
  }
  enabled: boolean
  apply_to_children: boolean
  schedule_mode: ScheduleMode
  overrides: AssignmentOverrides
  interval_seconds: number
  exclusions: string[]
}

export interface PrefixRollup {
  status: CheckStatus | null
  counts: Partial<Record<CheckStatus, number>>
  monitored_ips: number
  total_ips: number
}

export interface PrefixIpStatus {
  id: string
  ip_address: string
  status: CheckStatus | null
  checks: number
  counts?: Partial<Record<CheckStatus, number>>
}

export interface PrefixChecksResponse {
  prefix_id: string
  cidr: string
  /** Which engine monitors this prefix — an Outpost, or the built-in local. */
  engine: { id: string; name: string; is_local: boolean }
  /** Last time this prefix was ICMP-swept (ISO), or null. */
  last_discovered_at: string | null
  assignments: PrefixCheckAssignment[]
  rollup: PrefixRollup
  ips: PrefixIpStatus[]
  truncated: boolean
}

// Device monitoring rolls up across the device's assigned IPs (a service's
// check lives on its IP, so service monitoring is included). Reuses the same
// rollup + per-IP grid shapes as prefixes.
export interface DeviceChecksResponse {
  device_id: string
  name: string
  rollup: PrefixRollup
  ips: PrefixIpStatus[]
  truncated: boolean
}

export interface BulkStatusEntry {
  status: CheckStatus | null
  checks?: number
  counts?: Partial<Record<CheckStatus, number>>
  monitored_ips?: number
}

export interface BulkStatusResponse {
  statuses: Record<string, BulkStatusEntry>
}

// ─── Monitoring — settings + global stats ──────────────────────────────────

export interface MonitoringSkipStatus {
  id: string
  name: string
  color: string
  text_color: string
}

export interface MonitoringSettings {
  global_enabled: boolean
  default_interval_seconds: number
  stale_after_scans: number
  stale_after_days: number
  skip_ip_statuses: string[]
  skip_ip_status_detail: MonitoringSkipStatus[]
  dns_sync_enabled: boolean
  dns_clear_on_missing: boolean
  dns_preserve_if_alive: boolean
  renotify_enabled: boolean
  renotify_interval_minutes: number
  escalate_enabled: boolean
  escalate_after_minutes: number
  flap_threshold: number
  flap_window_minutes: number
  group_notifications: boolean
  group_threshold: number
  discovery_enabled: boolean
  discovery_min_prefix_length: number
  discovery_interval_minutes: number
  discovery_all_prefixes: boolean
  cleanup_enabled: boolean
  cleanup_after_days: number
  flap_exclude_ip_statuses: string[]
  flap_exclude_ip_status_detail: MonitoringSkipStatus[]
  /** Tenant default monitoring engine (id) — null = the local built-in. */
  default_engine: string | null
  /** GitHub repo of the Outpost agent — powers the version dropdown. */
  outpost_repo_url: string
  outpost_repo_token_set: boolean
  updated_at: string
}

export interface MonitoringProfile {
  id: string
  name: string
  slug: string
  description: string
  enabled: boolean
  templates: string[]
  template_detail: { id: string; name: string; kind: CheckKind }[]
  created_at: string
  updated_at: string
}

export type MonitoringPolicyScope =
  | "global"
  | "vrf"
  | "device_type"
  | "device_role"
  | "device"
  | "prefix"

export interface MonitoringPolicy {
  id: string
  scope: MonitoringPolicyScope
  vrf: string | null
  device_type: string | null
  device_role: string | null
  device: string | null
  prefix: string | null
  enabled: boolean
  inherit: boolean
  /** Device/type/role scopes: which of the device's IPs the checks target. */
  target: "all" | "interfaces" | "primary" | "oob"
  /** Per-scope check frequency override, seconds. Null = global default. */
  interval_seconds: number | null
  profiles: string[]
  templates: string[]
  profile_detail: MonitoringProfile[]
  template_detail: { id: string; name: string; kind: CheckKind }[]
  created_at: string
  updated_at: string
}

export interface MonitoringDenySubnet {
  id: string
  vrf: string | null
  vrf_detail: { id: string; name: string; rd: string } | null
  cidr: string
  description: string
  created_at: string
  updated_at: string
}

/** A monitoring engine — the built-in `local` (core workers) or a remote
 * **Outpost** installed at a site. GET /api/monitoring/engines/. */
export interface MonitoringEngine {
  id: string
  name: string
  slug: string
  description: string
  kind: "local" | "remote"
  /** pull = Outpost dials out (HTTPS 443); ssh = Danbyte dials in (SSH 22). */
  transport: "pull" | "ssh"
  enabled: boolean
  token_set: boolean
  is_local: boolean
  poll_interval_seconds: number
  /** Self-update to the golden (default) release when the version differs. */
  auto_update: boolean
  ssh_host: string
  ssh_port: number
  ssh_user: string
  ssh_host_key: string
  ssh_configured: boolean
  last_seen_at: string | null
  agent_version: string
  agent_hostname: string
  agent_ip: string
  binding_count: number
  check_count: number
  created_at: string
  updated_at: string
}

export interface MonitoringEngineWritePayload {
  name: string
  description?: string
  transport?: "pull" | "ssh"
  enabled?: boolean
  poll_interval_seconds?: number
  ssh_host?: string
  ssh_port?: number
  ssh_user?: string
  ssh_host_key?: string
  ssh_credential?: { private_key?: string; password?: string }
}

/** GET /api/system/upgrade/status — progress of an in-flight upgrade. */
export interface SystemUpgradeStatus {
  state: "idle" | "running" | "done" | "failed"
  step?: string
  pct?: number
  version_to?: string
  version_from?: string
  error?: string
}

/** GET /api/system/info — instant, network-free runtime + version facts. */
export interface SystemInfo {
  version: string
  commit: string
  tag: string
  git_install: boolean
  python: string
  django: string
  postgres: string
  redis: string
  platform: string
}

/** GET /api/system/updates — current version + the release repo's versions. */
export interface SystemUpdates {
  current: { version: string; commit: string }
  repo_url: string
  update_available: boolean
  releases: {
    tag: string
    name: string
    body: string
    published_at: string | null
    prerelease: boolean
    has_binary: boolean
    is_current: boolean
  }[]
  error?: string
}

/** Releases available in the configured Outpost repo (for the version dropdown). */
export interface OutpostAvailable {
  repo_url: string
  versions: {
    tag: string
    name: string
    has_binary: boolean
    imported?: boolean
  }[]
  error?: string
}

/** A stored Outpost build (the package store). GET /api/monitoring/outpost-releases/. */
export interface OutpostRelease {
  id: string
  version: string
  source: "file" | "git"
  git_url: string
  git_ref: string
  description: string
  is_default: boolean
  size_bytes: number
  has_artifact: boolean
  created_at: string
}

export interface MonitoringEngineStats {
  total_checks: number
  is_default: boolean
  by_status: Record<string, number>
  sites: { id: string; name: string }[]
  locations: { id: string; name: string }[]
  recent: {
    ip: string | null
    from_status: string
    to_status: string
    at: string
  }[]
}

export interface FlappingRow {
  ip_id: string
  ip_address: string
  dns_name: string | null
  template_id: string | null
  template_name: string | null
  kind: CheckKind
  flap_count: number
  window_minutes: number
  last_at: string
}

export interface CheckListRow {
  id: string
  target_ip: { id: string; ip_address: string }
  template: { id: string; name: string }
  kind: CheckKind
  status: CheckStatus
  last_latency_ms: number | null
  last_checked: string | null
  since: string | null
  consecutive_fail: number
}

export interface CheckListResponse {
  count: number
  page: number
  page_size: number
  status_counts: Partial<Record<CheckStatus | "all", number>>
  results: CheckListRow[]
}

export interface MonitoringSeriesPoint {
  t: string
  up: number
  degraded: number
  down: number
}

export interface MonitoringStats {
  by_status: Partial<Record<CheckStatus, number>>
  by_kind: Partial<Record<CheckKind, number>>
  total_checks: number
  monitored_ips: number
  templates: number
  channels: number
  series: MonitoringSeriesPoint[]
  recent_transitions: Array<{
    id: number
    target_ip: { id: string; ip_address: string } | null
    template: string | null
    template_name: string | null
    kind: CheckKind
    from_status: CheckStatus
    to_status: CheckStatus
    at: string
    detail: Record<string, unknown>
  }>
}

// ─── Alerting ──────────────────────────────────────────────────────────────

export type AlertSeverity = "critical" | "warning" | "info"
export type AlertLifecycle = "firing" | "resolved"

export interface MonitoringAlert {
  id: string
  target_ip: { id: string; ip_address: string }
  template: { id: string; name: string; kind: CheckKind } | null
  rule_name: string | null
  kind: CheckKind
  severity: AlertSeverity
  status: AlertLifecycle
  check_status: CheckStatus
  opened_at: string
  last_status_at: string
  resolved_at: string | null
  detail: Record<string, unknown>
  acknowledged: boolean
  acknowledged_at: string | null
  acknowledged_by_name: string | null
  ack_note: string
  silenced: boolean
  flapping: boolean
  escalated: boolean
  notify_count: number
}

export interface AlertsResponse {
  counts: Partial<
    Record<AlertSeverity | AlertLifecycle | "acknowledged", number>
  >
  results: MonitoringAlert[]
}

export interface Silence {
  id: string
  reason: string
  match_kinds: CheckKind[]
  match_statuses: CheckStatus[]
  match_tag_slugs: string[]
  match_prefix: string | null
  match_prefix_cidr: string | null
  match_ip: string | null
  match_ip_address: string | null
  starts_at: string
  ends_at: string
  created_by_name: string | null
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface AlertRule {
  id: string
  name: string
  enabled: boolean
  weight: number
  match_kinds: CheckKind[]
  match_statuses: CheckStatus[]
  match_tag_slugs: string[]
  match_prefix: string | null
  match_prefix_cidr: string | null
  severity: AlertSeverity
  alert_count: number
  created_at: string
  updated_at: string
}

export interface UptimeCheck {
  template_id: string
  template_name: string | null
  kind: CheckKind
  current_status: CheckStatus
  uptime_pct: number | null
  up_seconds: number
  down_seconds: number
  excluded_seconds: number
  incidents: number
  mttr_seconds: number | null
}

export interface IpUptime {
  days: number
  overall_uptime_pct: number | null
  total_incidents: number
  measured_checks: number
  checks: UptimeCheck[]
}

export interface DashDist {
  name: string
  count: number
  color: string
}
export interface DashTopPrefix {
  id: string
  cidr: string
  ip_count: number
  utilisation_pct: number | null
}
export interface DashActivity {
  ip_id: string | null
  ip: string
  kind: CheckKind
  from_status: CheckStatus
  to_status: CheckStatus
  at: string
}
export interface DashRecentPrefix {
  id: string
  cidr: string
  status: string
  site: string | null
  ip_count: number
}
export interface DashRecentDevice {
  id: string
  name: string
  status: string
  type: string | null
  site: string | null
}
export interface DashRecentIp {
  id: string
  ip: string
  status: string | null
  status_color: string | null
  dns: string | null
}
export interface DashboardData {
  counts: Record<string, number>
  recent_activity: DashActivity[]
  recent_prefixes: DashRecentPrefix[]
  recent_devices: DashRecentDevice[]
  recent_ips: DashRecentIp[]
  ip_by_status: DashDist[]
  ip_by_role: DashDist[]
  ip_by_scope: DashDist[]
  prefix_by_family: DashDist[]
  prefix_by_status: DashDist[]
  top_prefixes: DashTopPrefix[]
  device_by_status: DashDist[]
  device_by_type: DashDist[]
  device_by_site: DashDist[]
  device_by_manufacturer: DashDist[]
  check_by_status: DashDist[]
  alerts_by_severity: DashDist[]
  reachable_pct: number | null
}

export type ComplianceCheck =
  | "required"
  | "forbidden"
  | "regex"
  | "required_tag"
  | "required_cf"
export type ComplianceSeverity = "critical" | "warning" | "info"
export interface ComplianceRule {
  id: string
  name: string
  description: string
  /** Markdown "how to fix" guide, shown alongside the rule's violations. */
  remediation: string
  enabled: boolean
  severity: ComplianceSeverity
  object_type: string
  object_type_label: string
  check_type: ComplianceCheck
  check_type_display: string
  field: string
  pattern: string
  tag: string
  cf_key: string
  created_at: string
  updated_at: string
}
export interface ComplianceViolation {
  rule_id: string
  rule_name: string
  severity: ComplianceSeverity
  object_type: string
  object_type_label: string
  object_route: string | null
  object_id: string
  object_repr: string
}
export interface ComplianceEvaluation {
  rules: {
    id: string
    name: string
    object_type: string
    severity: ComplianceSeverity
    violations: number
  }[]
  violations: ComplianceViolation[]
  total_violations: number
}

/** Response of GET /api/compliance-rules/<id>/violations/ — the objects one
 * rule currently fails, for its detail page. */
export interface ComplianceRuleViolations {
  rule: {
    id: string
    name: string
    severity: ComplianceSeverity
    object_type: string
    object_type_label: string
    enabled: boolean
  }
  violations: ComplianceViolation[]
  /** Failing rows serialized with the type's real serializer — feeds the
   * genuine per-type table on the rule detail page. */
  objects: Record<string, unknown>[]
  total: number
}

/** One failed rule on the per-device compliance status page. */
export interface DeviceComplianceViolation {
  rule_id: string
  rule_name: string
  severity: ComplianceSeverity
  description: string
  /** Markdown "how to fix" guide (may be empty). */
  remediation: string
  check_type: string
  field: string
  pattern: string
  tag: string
  cf_key: string
}

/** Response of GET /api/compliance/devices/<id>/ — one device's compliance
 * status: all-clear, or the rules it currently fails (grouped per rule). */
export interface DeviceComplianceStatus {
  device: { id: string; name: string }
  all_clear: boolean
  total: number
  violations: DeviceComplianceViolation[]
}

/** Live progress for a fanned-out discovery run (polled while shards drain). */
export interface DiscoverRun {
  run_id: string
  found?: boolean
  cidr: string
  shards_total: number
  shards_done: number
  hosts_total: number
  hosts_done: number
  responders: number
  created: number
  done: boolean
  percent: number
}

/** Live progress for a bulk Check-now run (polled while checks drain). */
export interface CheckRun {
  run_id: string
  found?: boolean
  total: number
  done_count: number
  pending: number
  done: boolean
  percent: number
}

/** A per-user saved page link (dashboard Bookmarks + topbar star). */
export interface Bookmark {
  id: string
  label: string
  url: string
  folder: string | null
  folder_name: string | null
  weight: number
  created_at: string
}

export interface BookmarkFolder {
  id: string
  name: string
  parent: string | null
  weight: number
  created_at: string
  updated_at: string
}

export type JournalKind = "info" | "success" | "warning" | "danger"
/** A free-form, user-authored note attached to an object (a journal-style note). */
export interface JournalEntry {
  id: string
  object_type: string
  object_id: string
  kind: JournalKind
  kind_display: string
  comments: string
  author_name: string
  created_at: string
  updated_at: string
  can_edit: boolean
}

export type ChangeAction = "create" | "update" | "delete"
/** One field's before/after. FK fields also carry a resolved `*_label`
 * (e.g. the VLAN name) so the UI can show a name beside the raw UUID. */
export interface FieldChange {
  old: unknown
  new: unknown
  old_label?: string
  new_label?: string
}
export interface ChangeLogEntry {
  id: string
  timestamp: string
  user_name: string
  action: ChangeAction
  action_display: string
  object_type: string
  object_label: string
  object_id: string
  object_repr: string
  changes: Record<string, FieldChange>
  change_count: number
  request_id: string
  /** Full row snapshots — only present on the detail endpoint. Pre is null
   * for a create, post is null for a delete. */
  pre_change?: Record<string, unknown> | null
  post_change?: Record<string, unknown> | null
  /** `{uuid: human label}` for every resolvable FK value in this entry
   * (changes + snapshots) — detail endpoint only. Lets the UI show the
   * related object's name wherever its UUID appears. */
  related_labels?: Record<string, string>
}

export type SmtpSecurity = "none" | "starttls" | "ssl"

// ─── SNMP discovery (Phase 1: observed facts) ──────────────────────────────

export interface SnmpProfileOption {
  id: string
  name: string
  slug: string
  version: string
  is_default: boolean
  has_secrets: boolean
  params?: Record<string, string>
}

export interface SnmpInterface {
  if_index: string
  name: string
  descr: string
  alias: string
  type: string
  type_name: string
  mtu: string
  mac: string
  admin_status: string
  oper_status: string
  speed_mbps: string
  // OSI hints from SNMP: L3 if the interface has an IP (ipAddrTable), else L2.
  layer: "L2" | "L3" | ""
  ip_addresses: string[]
  // Access (PVID) VLAN from Q-BRIDGE-MIB, when the device is a switch.
  vlan: string
  vlan_name: string
}

export interface SnmpBinding {
  scope: "device" | "device_role" | "device_type" | "location" | "site"
  object_id: string
  profile_id: string | null
  profile_name: string | null
  effective: {
    profile_id: string | null
    profile_name: string | null
    source:
      | "device"
      | "device_role"
      | "device_type"
      | "location"
      | "site"
      | "tenant_default"
      | null
  } | null
}

export type SnmpDriftItem =
  | {
      kind: "device_field"
      field: string
      label: string
      intended: string
      observed: string
    }
  | {
      kind: "interface_missing"
      name: string
      if_index: string
      observed: { mac: string; admin_status: string }
    }
  | {
      kind: "interface_mismatch"
      interface_id: string
      name: string
      field: string
      intended: string | boolean
      observed: string | boolean
    }
  | { kind: "interface_stale"; interface_id: string; name: string }
  | {
      kind: "ip_missing"
      interface_id: string
      name: string
      ip: string
      observed: string
      has_prefix: boolean
      suggested_prefix: string
    }
  | {
      kind: "switch_link_suggested"
      ip_id: string
      ip: string
      interface_id: string
      name: string
      intended: string
      observed: string
    }

export interface SnmpNeighbor {
  local_port: string
  remote_device: string
  remote_port: string
}
export interface SnmpArpEntry {
  ip: string
  mac: string
  if_index: string
}

export interface DeviceSnmp {
  device: string
  profile: string | null
  profile_name: string | null
  data: Record<string, string>
  interfaces: SnmpInterface[]
  neighbors: SnmpNeighbor[]
  arp: SnmpArpEntry[]
  reachable: boolean | null
  error: string
  polled_at: string | null
}

export interface DeploymentSettings {
  email_enabled: boolean
  smtp_host: string
  smtp_port: number
  smtp_security: SmtpSecurity
  smtp_username: string
  smtp_password_set: boolean
  email_from: string
  public_base_url: string
  webhook_timeout: number
  outbound_proxy: string
  deployment_name: string
  changelog_retention_days: number
  /** Absolute URL of the custom favicon; null = the Danbyte default. */
  favicon_url: string | null
  ssrf_allowlist: string[]
  map_tile_url: string
  map_tile_attribution: string
  map_satellite_url: string
  map_satellite_attribution: string
  enhanced_site_separation: boolean
  allow_site_settings: boolean
  allow_site_editor_delegation: boolean
  config_drift_enabled: boolean
  config_drift_interval_minutes: number
  config_drift_last_run: string | null
  digest_enabled: boolean
  digest_frequency: "daily" | "weekly"
  digest_weekday: number
  digest_recipients: string
  human_ids_enabled: boolean
  date_format: DateFormat
  time_style: TimeStyle
  /** Raw stored value — blank inherits the server's TIME_ZONE. */
  display_timezone: string
  release_repo_url: string
  release_repo_token_set: boolean
  disable_update_check: boolean
  auto_update_enabled: boolean
  update_channel: "stable" | "any"
  update_window_days: string
  update_window_start: string
  update_window_end: string
  updated_at: string
}

// ─── Per-SITE settings (GET/PUT /api/sites/<id>/settings/) ──────────────────
export interface SiteSettingsPayload {
  override_email: boolean
  email_enabled: boolean
  smtp_host: string
  smtp_port: number
  smtp_security: SmtpSecurity
  smtp_username: string
  smtp_password_set: boolean
  email_from: string
  updated_at: string
  site: { id: string; name: string }
  /** The values the site inherits (tenant-or-deployment effective). */
  parent_defaults: {
    email_enabled: boolean
    smtp_host: string
    smtp_port: number
    smtp_security: SmtpSecurity
    smtp_username: string
    email_from: string
  }
}

// ─── Per-tenant settings overrides (GET/PUT /api/tenant-settings/) ──────────
/** Non-secret deployment values shown as the "inherit" summary. */
export interface TenantSettingsDefaults {
  email_enabled: boolean
  smtp_host: string
  smtp_port: number
  smtp_security: SmtpSecurity
  smtp_username: string
  email_from: string
  device_field_visibility: Record<string, boolean>
  human_ids_enabled: boolean
  enhanced_site_separation: boolean
  allow_site_settings: boolean
  allow_site_editor_delegation: boolean
  ldap_enabled: boolean
  ldap_server_uri: string
  date_format: DateFormat
  time_style: TimeStyle
  /** Resolved for the "inherit" summary — never blank. */
  display_timezone: string
}

export interface TenantSettings {
  override_email: boolean
  override_ui: boolean
  override_sharing: boolean
  override_separation: boolean
  enhanced_site_separation: boolean
  allow_site_settings: boolean
  email_enabled: boolean
  smtp_host: string
  smtp_port: number
  smtp_security: SmtpSecurity
  smtp_username: string
  smtp_password_set: boolean
  email_from: string
  device_field_visibility: Record<string, boolean>
  human_ids_enabled: boolean
  allow_site_editor_delegation: boolean
  override_datetime: boolean
  date_format: DateFormat
  time_style: TimeStyle
  /** Raw stored value — blank inherits the server's TIME_ZONE. */
  display_timezone: string
  updated_at: string
  deployment_defaults: TenantSettingsDefaults
}

// ─── LDAP / Active Directory (admin) ────────────────────────────────────────
export type LdapGroupType = "ad" | "group_of_names" | "posix"

export interface LdapSettings {
  ldap_enabled: boolean
  ldap_server_uri: string
  ldap_start_tls: boolean
  ldap_ignore_cert: boolean
  ldap_bind_dn: string
  ldap_user_search_base: string
  ldap_user_search_filter: string
  ldap_attr_first_name: string
  ldap_attr_last_name: string
  ldap_attr_email: string
  ldap_group_search_base: string
  ldap_group_type: LdapGroupType
  ldap_require_group: string
  bind_password_set: boolean
  updated_at: string
}

/** Tenant LDAP override — the deployment fields + the override toggle and
 * login-domain routing (GET/PUT /api/tenant-settings/ldap/). */
export interface TenantLdapSettings extends LdapSettings {
  override_ldap: boolean
  ldap_login_domains: string[]
}

/** A group discovered in the directory (browse endpoint). */
export interface LdapDirGroup {
  dn: string
  cn: string
}

/** A directory-group → Danbyte-group mapping. */
export interface LdapGroupMapping {
  id: number
  ldap_group_dn: string
  ldap_group_cn: string
  group_id: number
  group_name: string
  created_at: string
  updated_at: string
}

export type ChannelKind =
  | "webhook"
  | "email"
  | "slack"
  | "teams"
  | "discord"
  | "pagerduty"

export type MinSeverity = "info" | "warning" | "critical"

export interface NotificationChannel {
  id: string
  name: string
  kind: ChannelKind
  config: Record<string, unknown>
  on_statuses: CheckStatus[]
  min_severity: MinSeverity
  enabled: boolean
  created_at: string
  updated_at: string
}

// ─── Circuits ──────────────────────────────────────────────────────────
export interface ProviderOption {
  id: string
  name: string
  slug: string
}

export interface Provider {
  id: string
  numid: number | null
  name: string
  slug: string
  account: string
  portal_url: string
  noc_email: string
  noc_phone: string
  comments: string
  circuit_count: number
  tags: Tag[]
  custom_fields: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface ProviderWritePayload {
  name: string
  slug?: string
  account?: string
  portal_url?: string
  noc_email?: string
  noc_phone?: string
  comments?: string
  tag_ids?: number[]
  custom_fields?: Record<string, unknown>
}

export interface CircuitTypeOption {
  id: string
  name: string
  slug: string
  color: string
}

export interface CircuitType {
  id: string
  numid: number | null
  name: string
  slug: string
  color: string
  description: string
  circuit_count: number
  created_at: string
  updated_at: string
}

export interface CircuitTypeWritePayload {
  name: string
  slug?: string
  color?: string
  description?: string
}

export type CircuitStatus =
  | "planned"
  | "provisioning"
  | "active"
  | "offline"
  | "deprovisioning"
  | "decommissioned"

export interface ProviderNetworkOption {
  id: string
  name: string
}

export interface ProviderNetwork {
  id: string
  numid: number | null
  name: string
  provider: ProviderOption
  service_id: string
  description: string
  comments: string
  circuit_count: number
  tags: Tag[]
  custom_fields: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface ProviderNetworkWritePayload {
  name: string
  provider_id: string
  service_id?: string
  description?: string
  comments?: string
  tag_ids?: number[]
  custom_fields?: Record<string, unknown>
}

export type CircuitTermSide = "A" | "Z"

export interface CircuitTermination {
  id: string
  term_side: CircuitTermSide
  site: SiteOption | null
  provider_network: ProviderNetworkOption | null
  port_speed_kbps: number | null
  upstream_speed_kbps: number | null
  xconnect_id: string
  pp_info: string
  description: string
  created_at: string
  updated_at: string
}

export interface CircuitTerminationWritePayload {
  circuit_id: string
  term_side: CircuitTermSide
  site_id?: string | null
  provider_network_id?: string | null
  port_speed_kbps?: number | null
  upstream_speed_kbps?: number | null
  xconnect_id?: string
  pp_info?: string
  description?: string
}

export interface Circuit {
  id: string
  numid: number | null
  cid: string
  provider: ProviderOption
  type: CircuitTypeOption | null
  status: StatusMini | null
  install_date: string | null
  termination_date: string | null
  commit_rate_kbps: number | null
  terminations: CircuitTermination[]
  description: string
  comments: string
  tags: Tag[]
  custom_fields: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface CircuitWritePayload {
  cid: string
  provider_id: string
  type_id?: string | null
  status_id?: string | null
  install_date?: string | null
  termination_date?: string | null
  commit_rate_kbps?: number | null
  description?: string
  comments?: string
  tag_ids?: number[]
  custom_fields?: Record<string, unknown>
}

// ─── Power ─────────────────────────────────────────────────────────────
export interface PowerPanelOption {
  id: string
  name: string
}

export interface PowerPanel {
  id: string
  numid: number | null
  name: string
  site: SiteOption | null
  comments: string
  feed_count: number
  tags: Tag[]
  custom_fields: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface PowerPanelWritePayload {
  name: string
  site_id: string
  comments?: string
  tag_ids?: number[]
  custom_fields?: Record<string, unknown>
}

export type PowerFeedStatus = "planned" | "active" | "offline" | "failed"
export type PowerFeedType = "primary" | "redundant"
export type PowerSupply = "ac" | "dc"
export type PowerPhase = "single" | "three"

export interface PowerFeed {
  id: string
  numid: number | null
  name: string
  power_panel: PowerPanelOption
  rack: { id: string; name: string } | null
  status: StatusMini | null
  type: PowerFeedType
  type_display: string
  supply: PowerSupply
  supply_display: string
  phase: PowerPhase
  phase_display: string
  voltage: number | null
  amperage: number | null
  max_utilization: number
  comments: string
  tags: Tag[]
  custom_fields: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface PowerFeedWritePayload {
  name: string
  power_panel_id: string
  rack_id?: string | null
  status_id?: string | null
  type?: PowerFeedType
  supply?: PowerSupply
  phase?: PowerPhase
  voltage?: number | null
  amperage?: number | null
  max_utilization?: number
  comments?: string
  tag_ids?: number[]
  custom_fields?: Record<string, unknown>
}

// ─── Wireless ──────────────────────────────────────────────────────────
export interface WirelessLANGroupOption {
  id: string
  name: string
  slug: string
}

export interface WirelessLANGroup {
  id: string
  numid: number | null
  name: string
  slug: string
  description: string
  wlan_count: number
  created_at: string
  updated_at: string
}

export interface WirelessLANGroupWritePayload {
  name: string
  slug?: string
  description?: string
}

export type WirelessLANStatus =
  | "active"
  | "reserved"
  | "disabled"
  | "deprecated"
export type WirelessAuthType =
  | ""
  | "open"
  | "wep"
  | "wpa-personal"
  | "wpa-enterprise"
export type WirelessAuthCipher = "" | "auto" | "tkip" | "aes"

export interface WirelessLAN {
  id: string
  numid: number | null
  ssid: string
  group: WirelessLANGroupOption | null
  status: StatusMini | null
  vlan: VLANOption | null
  auth_type: WirelessAuthType
  auth_type_display: string
  auth_cipher: WirelessAuthCipher
  description: string
  comments: string
  tags: Tag[]
  custom_fields: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface WirelessLANWritePayload {
  ssid: string
  group_id?: string | null
  status_id?: string | null
  vlan_id?: string | null
  auth_type?: WirelessAuthType
  auth_cipher?: WirelessAuthCipher
  description?: string
  comments?: string
  tag_ids?: number[]
  custom_fields?: Record<string, unknown>
}

// ─── VPN ───────────────────────────────────────────────────────────────
export interface TunnelGroupOption {
  id: string
  name: string
  slug: string
}

export interface TunnelGroup {
  id: string
  numid: number | null
  name: string
  slug: string
  description: string
  tunnel_count: number
  created_at: string
  updated_at: string
}

export interface TunnelGroupWritePayload {
  name: string
  slug?: string
  description?: string
}

export type IkeVersion = 1 | 2
export type IPSecEncryption =
  | "aes-128-cbc"
  | "aes-192-cbc"
  | "aes-256-cbc"
  | "aes-128-gcm"
  | "aes-256-gcm"
  | "3des-cbc"
export type IPSecAuth =
  | "hmac-sha1"
  | "hmac-sha256"
  | "hmac-sha384"
  | "hmac-sha512"
  | "hmac-md5"

export interface IPSecProfileOption {
  id: string
  name: string
}

export interface IPSecProfile {
  id: string
  numid: number | null
  name: string
  ike_version: IkeVersion
  ike_version_display: string
  encryption: IPSecEncryption
  encryption_display: string
  authentication: IPSecAuth
  authentication_display: string
  dh_group: number
  pfs_group: number | null
  sa_lifetime: number | null
  description: string
  tunnel_count: number
  created_at: string
  updated_at: string
}

export interface IPSecProfileWritePayload {
  name: string
  ike_version?: IkeVersion
  encryption?: IPSecEncryption
  authentication?: IPSecAuth
  dh_group?: number
  pfs_group?: number | null
  sa_lifetime?: number | null
  description?: string
}

export type TunnelStatus = "planned" | "active" | "disabled"
export type TunnelEncapsulation =
  | "ipsec-tunnel"
  | "ipsec-transport"
  | "gre"
  | "ip-ip"
  | "wireguard"

export type TunnelTerminationRole = "peer" | "hub" | "spoke"

export interface TunnelTermination {
  id: string
  role: TunnelTerminationRole
  role_display: string
  interface: {
    id: string
    name: string
    device: { id: string; name: string }
  } | null
  vm_interface: {
    id: string
    name: string
    vm: { id: string; name: string }
  } | null
  outside_ip: { id: string; ip_address: string } | null
  created_at: string
  updated_at: string
}

export interface TunnelTerminationWritePayload {
  tunnel_id: string
  role?: TunnelTerminationRole
  interface_id?: string | null
  vm_interface_id?: string | null
  outside_ip_id?: string | null
}

export interface Tunnel {
  id: string
  numid: number | null
  name: string
  status: StatusMini | null
  encapsulation: TunnelEncapsulation
  encapsulation_display: string
  tunnel_id: number | null
  group: TunnelGroupOption | null
  ipsec_profile: IPSecProfileOption | null
  terminations: TunnelTermination[]
  description: string
  comments: string
  tags: Tag[]
  custom_fields: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface TunnelWritePayload {
  name: string
  status_id?: string | null
  encapsulation?: TunnelEncapsulation
  tunnel_id?: number | null
  group_id?: string | null
  ipsec_profile_id?: string | null
  description?: string
  comments?: string
  tag_ids?: number[]
  custom_fields?: Record<string, unknown>
}

// ─── Webhooks ──────────────────────────────────────────────────────────
export type WebhookMethod = "POST" | "PUT" | "PATCH"

export interface Webhook {
  id: string
  name: string
  enabled: boolean
  object_types: string[]
  on_create: boolean
  on_update: boolean
  on_delete: boolean
  payload_url: string
  http_method: WebhookMethod
  http_content_type: string
  secret_set: boolean
  additional_headers: string
  ssl_verification: boolean
  created_at: string
  updated_at: string
}

export interface WebhookWritePayload {
  name: string
  enabled?: boolean
  object_types: string[]
  on_create?: boolean
  on_update?: boolean
  on_delete?: boolean
  payload_url: string
  http_method?: WebhookMethod
  http_content_type?: string
  secret?: string
  additional_headers?: string
  ssl_verification?: boolean
}

// ─── Config contexts ───────────────────────────────────────────────────
interface NamedRef {
  id: string
  name: string
}

export interface ConfigContext {
  id: string
  numid: number | null
  name: string
  weight: number
  is_active: boolean
  description: string
  data: Record<string, unknown>
  regions: { id: string; name: string; slug: string }[]
  sites: { id: string; name: string }[]
  device_roles: NamedRef[]
  platforms: NamedRef[]
  created_at: string
  updated_at: string
}

export interface ConfigContextWritePayload {
  name: string
  weight?: number
  is_active?: boolean
  description?: string
  data: Record<string, unknown>
  region_ids?: string[]
  site_ids?: string[]
  device_role_ids?: string[]
  platform_ids?: string[]
}

/** Rendered config context for a device/VM (GET .../config-context/). */
export interface RenderedConfigContext {
  rendered: Record<string, unknown>
  applied: string[]
}

// ─── Export templates ──────────────────────────────────────────────────
export interface ExportTemplate {
  id: string
  numid: number | null
  name: string
  object_type: string
  object_type_label: string
  description: string
  template_code: string
  mime_type: string
  file_extension: string
  as_attachment: boolean
  created_at: string
  updated_at: string
}

export interface ExportTemplateWritePayload {
  name: string
  object_type: string
  description?: string
  template_code: string
  mime_type?: string
  file_extension?: string
  as_attachment?: boolean
}

// ─── Bulk import ───────────────────────────────────────────────────────
export interface ImportFieldInfo {
  name: string
  kind: string
  required: boolean
  natural_key?: boolean
}

export interface ImportResult {
  total: number
  created: number
  updated?: number
  errors: { row: number; error: string; action?: string }[]
  dry_run: boolean
  preview?: {
    row: number
    action: "create" | "update"
    key: string
    changes: Record<string, [unknown, unknown]>
  }[]
}

// ─── Round-trip export/import (generic, any IO-capable type) ─────────────
export interface IOTypeMeta {
  slug: string
  label: string
  group: string
  natural_key: string[]
  can_export: boolean
  can_import: boolean
}

export interface IOFields {
  fields: ImportFieldInfo[]
  columns: string[]
  natural_key: string[]
}

export type IOFormat = "csv" | "xlsx" | "json"

/** Server round-trip export URL (downloadable anchor). `filter` narrows by
 * model field, e.g. `{ prefix: prefixId }` to export only a prefix's IPs. */
export function ioExportUrl(
  slug: string,
  opts: { fmt: IOFormat; ids?: string[]; filter?: Record<string, string> } = {
    fmt: "csv",
  }
): string {
  const p = new URLSearchParams({ fmt: opts.fmt })
  if (opts.ids && opts.ids.length) p.set("ids", opts.ids.join(","))
  for (const [k, v] of Object.entries(opts.filter ?? {})) {
    if (v) p.set(k, v)
  }
  return `/api/io/${slug}/export/?${p.toString()}`
}

export const ioFields = (slug: string) =>
  api<IOFields>(`/api/io/${slug}/fields/`)

/** Import via JSON body (csv/json text) or a multipart xlsx file. */
export function ioImport(
  slug: string,
  payload:
    | { format: "csv" | "json"; content: string; dry_run: boolean }
    | { file: File; dry_run: boolean }
): Promise<ImportResult> {
  if ("file" in payload) {
    const fd = new FormData()
    fd.append("file", payload.file)
    fd.append("dry_run", String(payload.dry_run))
    return api<ImportResult>(`/api/io/${slug}/import/`, {
      method: "POST",
      body: fd,
    })
  }
  return api<ImportResult>(`/api/io/${slug}/import/`, {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

// ─── API tokens (runner auth) ──────────────────────────────────────────
export interface ApiToken {
  id: string
  name: string
  tenant: { id: string; name: string }
  prefix: string
  last_used_at: string | null
  expires_at: string | null
  is_expired: boolean
  created_at: string
}

/** Create response — `key` is present only here, once. */
export interface ApiTokenCreated extends ApiToken {
  key: string
}

// ─── Automation targets + deploy (Phase 2) ─────────────────────────────
export type AutomationKind = "awx" | "webhook"

export interface AutomationTarget {
  id: string
  name: string
  kind: AutomationKind
  kind_display: string
  enabled: boolean
  base_url: string
  job_template_id: string
  token_set: boolean
  ssl_verify: boolean
  extra_vars: Record<string, unknown>
  auto_on_change: boolean
  object_types: string[]
  created_at: string
  updated_at: string
}

export interface AutomationTargetWritePayload {
  name: string
  kind: AutomationKind
  enabled?: boolean
  base_url: string
  job_template_id?: string
  token?: string
  ssl_verify?: boolean
  extra_vars?: Record<string, unknown>
  auto_on_change?: boolean
  object_types?: string[]
}

export interface DeployRun {
  id: string
  target_name: string
  event: string
  device_ids: string[]
  status: "queued" | "launched" | "failed"
  detail: string
  created_at: string
  finished_at: string | null
  attempt: number
  retry_of: string | null
  can_retry: boolean
  duration_ms: number | null
}

export type DriftStatus = "in_sync" | "drift" | "unknown" | "error"

export interface DeviceConfigState {
  id: string
  device: string
  status: DriftStatus
  intended_config: string
  actual_config: string
  diff: string
  source: string
  template: string | null
  template_name: string | null
  reported_at: string | null
  updated_at: string
}

// Light row from the tenant-wide drift list (/api/config-states/) — no blobs.
export interface DeviceConfigStateRow {
  id: string
  device: string
  device_name: string
  status: DriftStatus
  source: string
  template_name: string | null
  reported_at: string | null
}

// One row of the tenant-wide SNMP drift list (/api/monitoring/snmp-drift/) —
// observed SNMP state vs the device's intended source of truth, summarised.
export type SnmpDriftStatus = "drift" | "in_sync" | "unreachable"
export interface SnmpDriftRow {
  device: string
  device_name: string
  status: SnmpDriftStatus
  reachable: boolean | null
  drift_count: number
  by_kind: {
    device_field: number
    interface_missing: number
    interface_mismatch: number
    interface_stale: number
  }
  // Distinct interfaces that drifted (one interface can have >1 mismatch item).
  interfaces_drifted: number
  profile_name: string | null
  polled_at: string | null
}

// One drift-transition event (/api/config-snapshots/?device=).
export interface DeviceConfigSnapshot {
  id: string
  device: string
  status: DriftStatus
  diff: string
  source: string
  created_at: string
}

// Collaborative presence — who else is viewing/editing an object.
export type PresenceMode = "viewing" | "editing"

export interface PresentUser {
  user_id: string
  name: string
  mode: PresenceMode
  since: number | null
}

// ---- Background jobs (RQ queue admin) -------------------------------------

export type JobState =
  | "queued"
  | "started"
  | "deferred"
  | "scheduled"
  | "finished"
  | "failed"

// ─── NetBox import (GET/POST /api/netbox-import/) ───────────────────────────
export interface NetBoxTestResult {
  ok: boolean
  netbox_version?: string
  counts?: Record<string, number>
  error?: string
}

export interface NetBoxTypeTotals {
  fetched: number
  created: number
  existed: number
  updated: number
  failed: number
  /** Rows deliberately not imported (missing parent, unsupported shape).
   *  Absent in reports from runs before v0.4.3. */
  skipped?: number
}

export interface NetBoxImportRun {
  id: string
  url: string
  status: "queued" | "running" | "success" | "failed"
  dry_run: boolean
  update_existing: boolean
  only: string[]
  skip: string[]
  progress: {
    step?: number
    total?: number
    key?: string
    pct?: number
    totals?: NetBoxTypeTotals
    by_type?: Record<string, NetBoxTypeTotals>
  }
  report: {
    totals?: NetBoxTypeTotals
    by_type?: Record<string, NetBoxTypeTotals>
    notes?: string[]
    failures?: string[]
  }
  error: string
  started_at: string | null
  finished_at: string | null
  created_at: string
}

export interface JobBrief {
  id: string
  state: JobState | string
  queue: string
  func_name: string | null
  func_short: string
  description: string
  corrupt: boolean
  enqueued_at: string | null
  started_at: string | null
  ended_at: string | null
  duration: number | null
  worker_name: string | null
}

export interface JobDetail extends JobBrief {
  args: string[]
  kwargs: Record<string, string>
  meta: Record<string, string>
  timeout: number | string | null
  result_ttl: number | null
  result: string | null
  exc_info: string | null
  created_at: string | null
}

export interface JobWorker {
  name: string
  hostname: string | null
  pid: number | null
  state: string
  queues: string[]
  current_job_id: string | null
  successful_jobs: number | null
  failed_jobs: number | null
  last_heartbeat: string | null
  birth_date: string | null
}

export interface JobsResponse {
  jobs: JobBrief[]
  total: number
  limit: number
  offset: number
  truncated: boolean
  counts: {
    by_state: Record<string, number>
    by_queue: Record<string, Record<string, number>>
  }
  workers: JobWorker[]
  queues: string[]
  states: string[]
  system?: SystemJobStatus
}

export interface SystemJobStatus {
  upgrade: {
    state: string
    step: string | null
    pct: number | null
    version_to: string | null
    version_from: string | null
    error: string | null
    active: boolean
  }
  auto_update: {
    enabled: boolean
    /** Unix seconds of the next scheduled check, or null. */
    next_check: number | null
  }
}

// ─── Virtual chassis (switch stacks) ─────────────────────────────────────

export interface VirtualChassisMember {
  id: string
  name: string
  vc_position: number | null
  vc_priority: number | null
  is_master: boolean
  serial_number: string
  /** For the stack faceplates — saved layouts live on the type. */
  device_type_id: string | null
  status: StatusMini | null
}

export interface VirtualChassis {
  id: string
  numid: number | null
  name: string
  domain: string
  master: { id: string; name: string } | null
  members: VirtualChassisMember[]
  member_count: number
  primary_ip: { id: string; ip_address: string } | null
  oob_ip: { id: string; ip_address: string } | null
  description: string
  comments: string
  tags: Tag[]
  custom_fields: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface VirtualChassisWritePayload {
  name: string
  domain?: string
  master_id?: string | null
  description?: string
  comments?: string
  tag_ids?: number[]
  custom_fields?: Record<string, unknown>
}

// ─── L2VPN (EVPN / VXLAN / VPWS overlays) ────────────────────────────────

export type L2VPNType =
  | "vxlan"
  | "vxlan-evpn"
  | "mpls-evpn"
  | "pbb-evpn"
  | "vpws"
  | "vpls"
  | "epl"
  | "evpl"
  | "spb"
  | "trill"

export interface L2VPNTermination {
  id: string
  l2vpn: { id: string; name: string; slug: string; type: L2VPNType }
  vlan: VLANMini | null
  interface: {
    id: string
    name: string
    device: { id: string; name: string }
  } | null
  vm_interface: {
    id: string
    name: string
    vm: { id: string; name: string }
  } | null
  created_at: string
  updated_at: string
}

export interface L2VPNTerminationWritePayload {
  l2vpn_id: string
  vlan_id?: string | null
  interface_id?: string | null
  vm_interface_id?: string | null
}

export interface L2VPN {
  id: string
  numid: number | null
  name: string
  slug: string
  type: L2VPNType
  type_display: string
  identifier: number | null
  status: StatusMini | null
  import_targets: { id: string; name: string }[]
  export_targets: { id: string; name: string }[]
  terminations: L2VPNTermination[]
  termination_count: number
  description: string
  comments: string
  tags: Tag[]
  custom_fields: Record<string, unknown>
  created_at: string
  updated_at: string
}

export interface L2VPNWritePayload {
  name: string
  slug?: string
  type: L2VPNType
  identifier?: number | null
  status_id?: string | null
  import_target_ids?: string[]
  export_target_ids?: string[]
  description?: string
  comments?: string
  tag_ids?: number[]
}

// ─── Floor plans ─────────────────────────────────────────────────────────────

export interface FloorTileType {
  id: string
  numid: number | null
  name: string
  slug: string
  color: string
  /** Lucide icon name the user picked (e.g. "server", "wind", "cctv"). */
  icon: string
  default_width: number
  default_height: number
  is_zone: boolean
  has_fov: boolean
  description: string
  tile_count: number
  created_at: string
  updated_at: string
}

/** Picker shape (?picker=1) — FloorTileTypeMiniSerializer. */
export interface FloorTileTypeOption {
  id: string
  name: string
  slug: string
  color: string
  icon: string
  default_width: number
  default_height: number
  is_zone: boolean
  has_fov: boolean
}

export interface FloorTileTypeWritePayload {
  name: string
  slug?: string
  color?: string
  icon?: string
  default_width?: number
  default_height?: number
  is_zone?: boolean
  has_fov?: boolean
  description?: string
}

export type FovAnchor = "" | "tl" | "tr" | "bl" | "br"

export type FloorPlanLinkKind =
  | "rack"
  | "device"
  | "powerpanel"
  | "powerfeed"
  | "floorplan"

export type FloorTileStatus =
  | ""
  | "active"
  | "planned"
  | "reserved"
  | "decommissioning"

export interface FloorPlanTile {
  id: string
  /** The plan this tile belongs to (read-only mini). */
  floor_plan?: {
    id: string
    name: string
    grid_width: number
    grid_height: number
  }
  x: number
  y: number
  width: number
  height: number
  tile_type: FloorTileTypeOption | null
  role_type: {
    id: string
    name: string
    slug: string
    color: string
    is_patch_panel: boolean
    has_fov: boolean
  } | null
  orientation: 0 | 90 | 180 | 270
  label: string
  color: string
  status: FloorTileStatus
  link_kind: "" | FloorPlanLinkKind
  linked: {
    kind: FloorPlanLinkKind
    id: string
    name: string
    route: string
  } | null
  fov_deg: number | null
  fov_distance: number | null
  fov_direction: number | null
  /** Where on the tile the cone emits from ("" = center). */
  fov_anchor: FovAnchor
  /** PTZ: coverage is a full 360° ring (radius = reach), not a cone. */
  fov_ptz: boolean
  created_at: string
  updated_at: string
}

export interface FloorPlanTileWritePayload {
  floor_plan_id?: string
  x?: number
  y?: number
  width?: number
  height?: number
  tile_type_id?: string | null
  role_type_id?: string | null
  orientation?: number
  label?: string
  color?: string
  status?: FloorTileStatus
  link_kind?: "" | FloorPlanLinkKind
  link_id?: string
  fov_deg?: number | null
  fov_distance?: number | null
  fov_direction?: number | null
  fov_anchor?: FovAnchor
  fov_ptz?: boolean
}

/** POST /api/floor-plans/<id>/tiles/bulk/ — one transaction, fresh list back. */
export interface FloorPlanTilesBulkPayload {
  create?: FloorPlanTileWritePayload[]
  update?: (FloorPlanTileWritePayload & { id: string })[]
  delete?: string[]
}

export interface FloorPlan {
  id: string
  numid: number | null
  name: string
  location: LocationOption
  site: SiteOption
  grid_width: number
  grid_height: number
  /** Relative /media/… URL for the blueprint under the grid, or null. */
  background_image: string | null
  background_opacity: number
  /** View prefs (overlay mode, grid on/off…) — free schema. */
  state: Record<string, unknown>
  description: string
  tile_count: number
  tags: Tag[]
  custom_fields: Record<string, unknown>
  created_at: string
  updated_at: string
}

/** A compact cable, as attached to a tray. */
export interface TrayCableMini {
  id: string
  numid: number | null
  label: string
  type: string
  color: string
}

/** A cable tray / conduit run: a named polyline on the plan's half-cell
 * lattice, with the physical cables routed through it. */
export interface FloorPlanTray {
  id: string
  name: string
  /** Free-text ("tray", "conduit", "ladder"…). */
  kind: string
  color: string
  /** [[x, y], …] in cell units, snapped to 0.5 steps. */
  points: [number, number][]
  description: string
  cables: TrayCableMini[]
  created_at: string
  updated_at: string
}

export interface FloorPlanTrayWritePayload {
  floor_plan_id?: string
  name?: string
  kind?: string
  color?: string
  points?: [number, number][]
  description?: string
  cable_ids?: string[]
}

/** A geographic cable run on the site map — the outside-plant tray. */
export interface CableRoute {
  id: string
  numid: number | null
  name: string
  kind: string
  color: string
  waypoints: [number, number][]
  description: string
  cables: TrayCableMini[]
  created_at: string
  updated_at: string
}

export interface SiteMapCableEnd {
  lat: number
  lng: number
  device_id: string
  device_name: string
  port: string
  kind: string
}

export interface SiteMapCable {
  id: string
  label: string
  type: string
  color: string
  status: { name: string; color: string } | null
  fiber_count: number | null
  a: SiteMapCableEnd
  z: SiteMapCableEnd
  route_ids: string[]
  same_point: boolean
}

export interface CableRouteWritePayload {
  name?: string
  kind?: string
  color?: string
  waypoints?: [number, number][]
  description?: string
  cable_ids?: string[]
}

/** One cable resolved to its endpoint tiles on a plan (A↔B). */
export interface FloorPlanCablePath {
  id: string
  label: string
  color: string
  type: string
  /** Tile ids at each end (device tile, else the device's rack tile). */
  a_tiles: string[]
  b_tiles: string[]
  tray_ids: string[]
}

export interface FloorPlanWritePayload {
  name?: string
  location_id?: string
  grid_width?: number
  grid_height?: number
  background_opacity?: number
  state?: Record<string, unknown>
  description?: string
  tag_ids?: number[]
}

/** GET /api/floor-plans/<id>/state/ — live per-tile metrics, keyed by tile id. */
export type FloorTileCheck =
  | "up"
  | "down"
  | "degraded"
  | "stale"
  | "unknown"
  | "skipped"

export interface FloorTileRackState {
  kind: "rack"
  used_units: number
  u_height: number
  power: { available_w: number; allocated_w: number; maximum_w: number }
  total_weight_kg: number
  max_weight_kg: number | null
  device_count: number
  check: FloorTileCheck | null
}

export interface FloorTileDeviceState {
  kind: "device"
  status: string | null
  check: FloorTileCheck | null
}

export interface FloorPlanLiveState {
  as_of: string
  tiles: Record<string, FloorTileRackState | FloorTileDeviceState>
}
