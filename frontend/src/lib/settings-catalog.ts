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

import catalog from "./settings-catalog.json"

/**
 * Every settings page and card, declared once (#51).
 *
 * The data lives in `settings-catalog.json` because two languages read it:
 * this module builds the sidebar, the hub grid and the search box, and
 * `agents/settings_catalog.py` answers "where do I change X" for the
 * assistant. A TypeScript literal would have meant a second copy in Python
 * and a slow drift between them.
 *
 * Only the icons stay here - they are React components, which JSON cannot
 * hold, and nothing outside the UI needs them.
 *
 * Grouped by **subject**, not by admin tier. Which tier a setting belongs to
 * is a property of the setting, shown as a scope switch on the page itself -
 * it was never a good way to find anything, and it is what made "Email"
 * appear three times.
 */

/** Who may edit a group of settings. A page lists every scope it can serve. */
export type SettingsScope = "user" | "site" | "tenant" | "deployment"

export type SettingsGroupKey = string

export interface SettingsGroup {
  key: SettingsGroupKey
  label: string
}

export interface SettingsPage {
  /** Stable id - also the key its icon is looked up under. */
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

/** Page key → its icon. A page with no entry falls back to a neutral one,
 * so adding a row to the JSON never breaks the build. */
const ICONS: Record<string, LucideIcon> = {
  directory: Server,
  sso: KeyRound,
  security: Shield,
  separation: SplitSquareHorizontal,
  email: Mail,
  monitoring: Gauge,
  integrations: Plug,
  "device-fields": SlidersHorizontal,
  "table-layouts": Columns3,
  "component-details": Grid2x2,
  floorplans: Boxes,
  maps: Map,
  "snmp-profiles": Radio,
  "snmp-sensors": Cable,
  "connect-protocols": Plug,
  branding: Puzzle,
  "tenant-policy": CalendarClock,
  updates: Bell,
  backups: Database,
  plugins: FileCode,
  preferences: UserCog,
}

export const SETTINGS_GROUPS: SettingsGroup[] = catalog.groups

export const SETTINGS_PAGES: SettingsPage[] = catalog.pages.map((page) => ({
  ...(page as Omit<SettingsPage, "icon">),
  icon: ICONS[page.key] ?? SlidersHorizontal,
}))

export const SETTINGS_CARDS: SettingsCardEntry[] = catalog.cards

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

/**
 * Which scope a page should open on, given the scopes this person holds.
 *
 * Its declared `defaultScope` when they hold it - Monitoring opens on the
 * tenant settings people actually adjust, not on the two deployment
 * schedules - otherwise the first scope they do hold, in catalog order.
 */
export function openingScope<T extends SettingsScope>(
  key: string,
  allowed: readonly T[]
): T | undefined {
  const wanted = SETTINGS_PAGES.find((p) => p.key === key)?.defaultScope
  const preferred = allowed.find((s) => s === wanted)
  return preferred ?? allowed[0]
}

/** Cards on the pages this person can reach. */
export function visibleCards(pages: SettingsPage[]): SettingsCardEntry[] {
  const keys = new Set(pages.map((p) => p.key))
  return SETTINGS_CARDS.filter((c) => keys.has(c.page))
}

/** The page a card lives on. */
export function pageOf(card: SettingsCardEntry): SettingsPage | undefined {
  return SETTINGS_PAGES.find((p) => p.key === card.page)
}
