import {
  Bell,
  Boxes,
  CalendarClock,
  Cable,
  Columns3,
  Database,
  FileCode,
  Gauge,
  Grid2x2,
  KeyRound,
  Mail,
  Map,
  Plug,
  Puzzle,
  Radio,
  Server,
  Shield,
  SlidersHorizontal,
  SplitSquareHorizontal,
  UserCog,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"

/**
 * Every settings page, declared once (#51).
 *
 * This is the single source the settings surfaces read: the sidebar rail,
 * the hub grid at `/settings`, and - once per-card entries land - the search
 * box and the assistant's "where do I change X" lookup. Adding a page means
 * adding a row here; forgetting to list it in one of the two navigations is
 * no longer a thing that can happen.
 *
 * Grouped by **subject**, not by admin tier. Which tier a setting belongs to
 * is a property of the setting, shown as a scope switch on the page itself -
 * it was never a good way to find anything, and it is what made "Email"
 * appear three times.
 */

/** Who may edit a group of settings. A page lists every scope it can serve. */
export type SettingsScope = "user" | "site" | "tenant" | "deployment"

export const SETTINGS_GROUPS = [
  { key: "access", label: "Identity & access" },
  // Integrations is its own subject, not a kind of notification: it governs
  // what Danbyte talks to, and only one of the six cards has anything to do
  // with sending messages.
  { key: "integrations", label: "Integrations" },
  { key: "notifications", label: "Notifications" },
  { key: "data", label: "Your data" },
  { key: "devices", label: "Devices & polling" },
  { key: "install", label: "This install" },
] as const

export type SettingsGroupKey = (typeof SETTINGS_GROUPS)[number]["key"]

export interface SettingsPage {
  /** Stable id - also the anchor a search result will deep-link to. */
  key: string
  label: string
  /** One line, shown under the label on the hub tile. */
  description: string
  to: string
  group: SettingsGroupKey
  /** Every scope this page can edit. Visibility is "you hold at least one". */
  scopes: SettingsScope[]
  /** The scope the page opens on - the one you most likely came for, which
   * is not always the widest one you can manage. */
  defaultScope?: SettingsScope
  /** Extra words search should match, beyond label and description. */
  keywords: string[]
  icon: LucideIcon
}

export const SETTINGS_PAGES: SettingsPage[] = [
  // ── identity & access ──────────────────────────────────────────────
  {
    key: "directory",
    label: "Directory",
    description: "LDAP and Active Directory sign-in",
    to: "/settings/directory",
    group: "access",
    scopes: ["deployment", "tenant"],
    defaultScope: "deployment",
    keywords: ["ldap", "active directory", "ad", "bind", "group mapping"],
    icon: Server,
  },
  {
    key: "sso",
    label: "Single sign-on",
    description: "Identity providers and group mapping",
    to: "/settings/sso",
    group: "access",
    scopes: ["deployment"],
    keywords: ["sso", "saml", "oidc", "oauth", "entra", "okta", "google"],
    icon: KeyRound,
  },
  {
    key: "security",
    label: "Security",
    description: "Sessions, secrets and outbound connections",
    to: "/settings/security",
    group: "access",
    scopes: ["deployment"],
    keywords: ["session", "vault", "ssrf", "proxy", "ssh", "secret store"],
    icon: Shield,
  },
  {
    key: "separation",
    label: "Separation",
    description: "Site boundaries and delegation",
    to: "/settings/separation",
    group: "access",
    scopes: ["deployment", "tenant"],
    defaultScope: "deployment",
    keywords: ["site separation", "delegation", "site admin", "scoped"],
    icon: SplitSquareHorizontal,
  },

  // ── notifications ──────────────────────────────────────────────────
  {
    key: "email",
    label: "Email",
    description: "Mail server, test sends and templates",
    to: "/settings/email",
    group: "notifications",
    scopes: ["deployment", "tenant", "site"],
    defaultScope: "deployment",
    keywords: ["smtp", "relay", "587", "starttls", "from address", "digest"],
    icon: Mail,
  },
  {
    key: "monitoring",
    label: "Monitoring",
    description: "Schedules, alerting, drift and digests",
    to: "/settings/monitoring",
    group: "notifications",
    scopes: ["deployment", "tenant"],
    // The tenant half is the operational one - schedule, thresholds,
    // alerting. Deployment holds two schedules you set once, so opening on
    // it hid the settings people came for behind a tab.
    defaultScope: "tenant",
    keywords: ["checks", "alerts", "drift", "digest", "flapping", "interval"],
    icon: Gauge,
  },

  // ── integrations ───────────────────────────────────────────────────
  {
    key: "integrations",
    label: "Integrations",
    description: "What Danbyte talks to, and what it may change",
    to: "/settings/integrations",
    group: "integrations",
    scopes: ["tenant"],
    keywords: ["vcenter", "proxmox", "dhcp", "dns", "assistant", "webhook"],
    icon: Plug,
  },
  // ── your data ──────────────────────────────────────────────────────
  {
    key: "device-fields",
    label: "Device field visibility",
    description: "Which fields a device shows",
    to: "/settings/device-fields",
    group: "data",
    scopes: ["deployment"],
    keywords: ["device", "fields", "hide", "show", "form"],
    icon: SlidersHorizontal,
  },
  {
    key: "table-layouts",
    label: "Table layouts",
    description: "Default columns for every table",
    to: "/settings/table-defaults",
    group: "data",
    scopes: ["deployment"],
    keywords: ["columns", "table", "default", "layout", "lock"],
    icon: Columns3,
  },
  {
    key: "component-details",
    label: "Component details",
    description: "What a device component's popover shows",
    to: "/settings/components",
    group: "data",
    scopes: ["deployment"],
    keywords: ["popover", "interface", "port", "hover", "component"],
    icon: Grid2x2,
  },
  {
    key: "floorplans",
    label: "Floor plans",
    description: "Tiles and the fields a plan shows",
    to: "/settings/floorplan",
    group: "data",
    scopes: ["tenant", "deployment"],
    defaultScope: "tenant",
    keywords: ["floor", "plan", "tile", "rack", "popover"],
    icon: Boxes,
  },
  {
    key: "maps",
    label: "Maps",
    description: "Tile servers behind the site map",
    to: "/settings/maps",
    group: "data",
    scopes: ["deployment"],
    keywords: ["tiles", "openstreetmap", "osm", "satellite", "basemap"],
    icon: Map,
  },

  // ── devices & polling ──────────────────────────────────────────────
  {
    key: "snmp-profiles",
    label: "SNMP profiles",
    description: "Credentials used to poll devices",
    to: "/settings/snmp",
    group: "devices",
    scopes: ["tenant"],
    keywords: ["snmp", "v2c", "v3", "community", "credential", "poll"],
    icon: Radio,
  },
  {
    key: "snmp-sensors",
    label: "SNMP sensors",
    description: "What to read from each model",
    to: "/settings/snmp-sensors",
    group: "devices",
    scopes: ["tenant"],
    keywords: ["oid", "sensor", "temperature", "psu", "fan", "mib"],
    icon: Cable,
  },
  {
    key: "connect-protocols",
    label: "Connect protocols",
    description: "How the Connect button reaches a device",
    to: "/settings/connect",
    group: "devices",
    scopes: ["tenant"],
    keywords: ["ssh", "console", "https", "rdp", "vnc", "launch"],
    icon: Plug,
  },

  // ── this install ───────────────────────────────────────────────────
  {
    key: "branding",
    label: "Branding & identity",
    description: "Name, logo, IDs and faceplates",
    to: "/settings/admin",
    group: "install",
    scopes: ["deployment"],
    keywords: ["logo", "favicon", "name", "numid", "faceplate", "mac vendor"],
    icon: Puzzle,
  },
  {
    key: "tenant-policy",
    label: "Tenant policy",
    description: "UI rules and date & time for this tenant",
    to: "/settings/tenant",
    group: "install",
    scopes: ["tenant"],
    keywords: ["timezone", "date format", "clock", "ui policy", "human ids"],
    icon: CalendarClock,
  },
  {
    key: "updates",
    label: "Updates",
    description: "Release source and upgrades",
    to: "/settings/updates",
    group: "install",
    scopes: ["deployment"],
    keywords: ["upgrade", "release", "version", "bundle", "changelog"],
    icon: Bell,
  },
  {
    key: "backups",
    label: "Backups",
    description: "Targets, schedules and restores",
    to: "/settings/backups",
    group: "install",
    scopes: ["deployment"],
    keywords: ["backup", "restore", "s3", "archive", "dbk", "schedule"],
    icon: Database,
  },
  {
    key: "plugins",
    label: "Plugins",
    description: "Installed plugins and host services",
    to: "/settings/plugins",
    group: "install",
    scopes: ["tenant", "deployment"],
    defaultScope: "tenant",
    keywords: ["plugin", "service", "restart", "worker", "upload"],
    icon: FileCode,
  },
  {
    key: "preferences",
    label: "Your preferences",
    description: "Display, two-factor and API tokens",
    to: "/settings/preferences",
    group: "install",
    scopes: ["user"],
    keywords: ["theme", "timezone", "2fa", "token", "columns", "display"],
    icon: UserCog,
  },
]

/** What a person can reach, given the tiers they hold. */
export function visiblePages(held: {
  user: boolean
  site: boolean
  tenant: boolean
  deployment: boolean
}): SettingsPage[] {
  return SETTINGS_PAGES.filter((p) => p.scopes.some((s) => held[s]))
}

/** The pages of each group that survive the gate, in catalog order. */
export function groupedPages(pages: SettingsPage[]) {
  return SETTINGS_GROUPS.map((group) => ({
    ...group,
    pages: pages.filter((p) => p.group === group.key),
  })).filter((g) => g.pages.length > 0)
}

/** Which scope a page should open on, given the scopes this person holds.
 *
 * Its declared `defaultScope` when they hold it - Monitoring opens on the
 * tenant settings people actually adjust, not on the two deployment
 * schedules - otherwise the first scope they do hold, in catalog order. */
export function openingScope<T extends SettingsScope>(
  key: string,
  allowed: readonly T[]
): T | undefined {
  const wanted = SETTINGS_PAGES.find((p) => p.key === key)?.defaultScope
  const preferred = allowed.find((s) => s === wanted)
  return preferred ?? allowed[0]
}
