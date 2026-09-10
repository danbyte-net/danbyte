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

/* ── cards ───────────────────────────────────────────────────────────── */

/**
 * One entry per card, so search finds the *setting* rather than the page it
 * sits on: someone looking for "session timeout" should not have to guess
 * that it lives under Security.
 *
 * `label` has to match the card's own `title` exactly - that is what derives
 * the anchor a result links to, and `settings-catalog.test.ts` fails the
 * build if a label here no longer exists in the page it claims.
 */
export interface SettingsCardEntry {
  /** Stable id, unique across the catalog. */
  key: string
  /** The card's title, verbatim. */
  label: string
  description: string
  /** Catalog key of the page it lives on. */
  page: string
  keywords: string[]
}

export const SETTINGS_CARDS: SettingsCardEntry[] = [
  // Email
  {
    key: "email.server",
    label: "Mail server",
    page: "email",
    description: "Host, port, credentials and the From address",
    keywords: ["smtp", "relay", "587", "465", "starttls", "from address"],
  },
  {
    key: "email.test",
    label: "Send a test",
    page: "email",
    description: "Check the relay actually works",
    keywords: ["test email", "verify", "try"],
  },
  {
    key: "email.templates",
    label: "Preview templates",
    page: "email",
    description: "Send a sample of any message Danbyte writes",
    keywords: ["template", "preview", "digest", "invite", "sample"],
  },

  // Security
  {
    key: "security.sessions",
    label: "Sessions",
    page: "security",
    description: "Idle timeout, and signing everyone out",
    keywords: ["session", "idle", "timeout", "sign out", "logout"],
  },
  {
    key: "security.secrets",
    label: "Secret store",
    page: "security",
    description: "Where credentials are kept at rest",
    keywords: ["vault", "azure key vault", "secret", "encryption", "kms"],
  },
  {
    key: "security.outbound",
    label: "Outbound connections",
    page: "security",
    description: "Internal hosts the server may reach despite the SSRF guard",
    keywords: ["ssrf", "allowlist", "internal", "cidr", "egress"],
  },
  {
    key: "security.delivery",
    label: "Outbound delivery",
    page: "security",
    description: "Public base URL, webhook timeout and proxy",
    keywords: ["proxy", "webhook timeout", "base url", "deep link"],
  },
  {
    key: "security.ssh",
    label: "In-browser SSH terminal",
    page: "security",
    description: "Whether operators can open a shell from a device page",
    keywords: ["ssh", "terminal", "console", "shell"],
  },
  {
    key: "security.model",
    label: "Assistant model",
    page: "security",
    description: "Which model the in-app chat and MCP server talk to",
    keywords: ["ai", "llm", "anthropic", "openai", "ollama", "local model"],
  },

  // Branding & identity
  {
    key: "branding.identity",
    label: "Identity",
    page: "branding",
    description: "Install name, logo and favicon",
    keywords: ["logo", "favicon", "name", "brand", "login page"],
  },
  {
    key: "branding.datetime",
    label: "Date & time",
    page: "branding",
    description: "Deployment default date format, clock and timezone",
    keywords: ["timezone", "date format", "clock", "24h", "12h"],
  },
  {
    key: "branding.numids",
    label: "Human-readable IDs",
    page: "branding",
    description: "Short per-tenant numbers beside UUIDs",
    keywords: ["numid", "id", "number", "short id"],
  },
  {
    key: "branding.faceplates",
    label: "Faceplates",
    page: "branding",
    description: "How device front and rear panels are drawn",
    keywords: ["faceplate", "panel", "render", "port drawing"],
  },
  {
    key: "branding.macvendors",
    label: "MAC vendors",
    page: "branding",
    description: "The OUI database behind MAC vendor lookup",
    keywords: ["oui", "mac", "vendor", "ieee"],
  },

  // Tenant policy
  {
    key: "tenant.ui",
    label: "UI policy",
    page: "tenant-policy",
    description: "Optional device fields and human-readable numbers",
    keywords: ["device fields", "numid", "optional fields"],
  },
  {
    key: "tenant.datetime",
    label: "Date & time",
    page: "tenant-policy",
    description: "This tenant's date format, clock and timezone",
    keywords: ["timezone", "date format", "clock"],
  },
  {
    key: "tenant.onboarding",
    label: "First-time setup",
    page: "tenant-policy",
    description: "Re-open the guided setup wizard",
    keywords: ["wizard", "onboarding", "getting started"],
  },

  // Separation
  {
    key: "separation.sites",
    label: "Site separation",
    page: "separation",
    description: "Each site behaves like a mini-tenant for site-scoped users",
    keywords: ["site scoped", "isolation", "mini tenant", "boundary"],
  },
  {
    key: "separation.delegation",
    label: "Delegation",
    page: "separation",
    description: "Whether site editors may invite their own viewers",
    keywords: ["delegate", "invite", "viewer", "site admin"],
  },

  // Monitoring
  {
    key: "monitoring.drift",
    label: "Config drift",
    page: "monitoring",
    description: "How often drift runs are dispatched",
    keywords: ["drift", "baseline", "automation", "interval"],
  },
  {
    key: "monitoring.digest",
    label: "Email digest",
    page: "monitoring",
    description: "The recurring monitoring summary and who gets it",
    keywords: ["digest", "summary", "weekly", "recipients"],
  },

  // SSO. Directory has no card entries yet: LdapDirectory draws its own
  // sections rather than SettingsCards, so there is no anchor to link to -
  // the Directory *page* is still found by its own keywords.
  {
    key: "sso.providers",
    label: "Providers",
    page: "sso",
    description: "Each identity provider offered on the login page",
    keywords: ["oidc", "saml", "entra", "okta", "google", "provider"],
  },
  {
    key: "sso.mappings",
    label: "Group mappings",
    page: "sso",
    description: "Which Danbyte group an asserted group grants",
    keywords: ["group", "claim", "mapping", "role"],
  },
  {
    key: "sso.local",
    label: "Local sign-in",
    page: "sso",
    description: "Whether the username and password form still shows",
    keywords: ["local login", "password", "hide login"],
  },

  // Your data
  {
    key: "data.device-fields",
    label: "Device fields",
    page: "device-fields",
    description: "Which fields a device form and page show",
    keywords: ["device", "fields", "hide", "show"],
  },
  {
    key: "data.table-defaults",
    label: "Tenant defaults",
    page: "table-layouts",
    description: "Publish or lock a table's column layout",
    keywords: ["columns", "layout", "publish", "lock", "table"],
  },
  {
    key: "data.components",
    label: "Fields",
    page: "component-details",
    description: "What a component popover shows, top to bottom",
    keywords: ["popover", "hover", "interface", "port"],
  },
  {
    key: "data.maps",
    label: "Map tiles",
    page: "maps",
    description: "Tile server URLs and attribution",
    keywords: ["tiles", "openstreetmap", "osm", "satellite", "esri"],
  },

  // Devices & polling
  {
    key: "devices.snmp-profiles",
    label: "Profiles",
    page: "snmp-profiles",
    description: "Reusable SNMP credentials for polling",
    keywords: ["snmp", "v2c", "v3", "community", "credential"],
  },
  {
    key: "devices.snmp-sensors",
    label: "Sensors",
    page: "snmp-sensors",
    description: "Vendor OIDs mapped to inventory item health",
    keywords: ["oid", "sensor", "temperature", "psu", "fan"],
  },
  {
    key: "devices.connect",
    label: "Protocols",
    page: "connect-protocols",
    description: "The launch actions on a device's Connect menu",
    keywords: ["ssh", "rdp", "vnc", "https", "telnet", "launch"],
  },

  // This install
  {
    key: "install.version",
    label: "This install",
    page: "updates",
    description: "Version, commit and the versions of what it runs on",
    keywords: ["version", "commit", "python", "django", "postgres", "redis"],
  },
  {
    key: "install.notes",
    label: "After this upgrade",
    page: "updates",
    description: "Steps a release still needs from an operator",
    keywords: ["upgrade notes", "manual step", "post upgrade"],
  },
  {
    key: "install.source",
    label: "Release source",
    page: "updates",
    description: "Which repo releases are read from, and automatic updates",
    keywords: ["repo", "release", "token", "airgap", "auto update"],
  },
  {
    key: "install.bundle",
    label: "Upgrade from a bundle",
    page: "updates",
    description: "Upload a release tarball for an offline install",
    keywords: ["offline", "airgap", "tarball", "bundle", "upload"],
  },
  {
    key: "install.releases",
    label: "Releases",
    page: "updates",
    description: "Available versions and their changelogs",
    keywords: ["changelog", "version", "upgrade", "rollback"],
  },
  {
    key: "install.backup-targets",
    label: "Targets",
    page: "backups",
    description: "Where archives are written",
    keywords: ["s3", "local", "target", "archive", "bucket"],
  },
  {
    key: "install.backup-schedules",
    label: "Schedules",
    page: "backups",
    description: "When backups run and how many are kept",
    keywords: ["schedule", "retention", "cron", "nightly"],
  },
  {
    key: "install.plugins",
    label: "Installed plugins",
    page: "plugins",
    description: "Enable a plugin for this tenant, or upload one",
    keywords: ["plugin", "upload", "enable", "module"],
  },
  {
    key: "install.services",
    label: "Services",
    page: "plugins",
    description: "Restart the web and worker processes",
    keywords: ["restart", "worker", "service", "systemd", "rq"],
  },

  // Preferences
  {
    key: "prefs.display",
    label: "Display",
    page: "preferences",
    description: "Your own theme, date format, clock and timezone",
    keywords: ["theme", "dark mode", "timezone", "clock", "link icons"],
  },
  {
    key: "prefs.tables",
    label: "Table layouts",
    page: "preferences",
    description: "Your saved column layouts, and resetting one",
    keywords: ["columns", "reset", "layout"],
  },
]

/** Cards on the pages this person can reach. */
export function visibleCards(pages: SettingsPage[]): SettingsCardEntry[] {
  const keys = new Set(pages.map((p) => p.key))
  return SETTINGS_CARDS.filter((c) => keys.has(c.page))
}

/** The page a card lives on. */
export function pageOf(card: SettingsCardEntry): SettingsPage | undefined {
  return SETTINGS_PAGES.find((p) => p.key === card.page)
}
