import type { TopologyCardConfig } from "@/lib/api"
import type {
  FieldGroup,
  FieldMeta,
} from "@/components/settings/field-list-editor"
import { cardFieldLabel } from "./card-fields"

// The card-line picker every editor shares - Settings → Topology, the device
// form, the map's Display popover and the per-device dialog - and the
// inherit rule they preview. The server resolves the lines a card actually
// shows (`resolve_card_fields`); this only mirrors it for a preview.

/** One line of help per built-in key. Labels come from the card itself
 * (`cardFieldLabel`), so an editor and the card never name a line
 * differently. */
export const CARD_LINE_HINTS: Readonly<Partial<Record<string, string>>> = {
  monitor: "Pill while down or degraded",
  status: "Lifecycle status pill",
  primary_ip: "Primary address",
  secondary_ip: "Secondary address",
  oob_ip: "Out-of-band address",
  loopback: "Addresses with the loopback role",
  serial: "Serial number",
  asset_tag: "Inventory tag",
  device_type: "Model",
  manufacturer: "The type's manufacturer",
  platform: "Or the type's platform",
  role: "Device role",
  site: "Site name",
  location: "Location in the site",
  rack: "Rack and position",
  tags: "Tag names",
}

/** The add picker. A key the server adds later lands in "Other". */
export const CARD_LINE_GROUPS: readonly FieldGroup[] = [
  { title: "Pill", keys: ["monitor", "status"] },
  {
    title: "Addresses",
    keys: ["primary_ip", "secondary_ip", "oob_ip", "loopback"],
  },
  {
    title: "Hardware",
    keys: ["serial", "asset_tag", "device_type", "manufacturer", "platform"],
  },
  { title: "Placement", keys: ["role", "site", "location", "rack"] },
  { title: "Other", keys: ["tags"] },
]

export interface CardLineOptions {
  meta: (key: string) => FieldMeta
  groups: FieldGroup[]
  /** Every key that may be added: the server's vocabulary, then the
   * tenant's device custom fields. */
  available: string[]
}

/** What a `FieldListEditor` needs for card lines: the server's vocabulary
 * plus the tenant's device custom fields (`useCustomFieldMeta` output). */
export function cardLineOptions(
  vocabulary: readonly string[],
  cfMeta: Readonly<Partial<Record<string, FieldMeta>>>
): CardLineOptions {
  const cfKeys = Object.keys(cfMeta)
  const cfLabels = Object.fromEntries(
    cfKeys.map((k) => [k.slice(3), cfMeta[k]?.label ?? k])
  )
  const meta = (key: string): FieldMeta => ({
    label: cardFieldLabel(key, cfLabels),
    hint:
      CARD_LINE_HINTS[key] ??
      cfMeta[key]?.hint ??
      (key.startsWith("cf_") ? "Custom field" : ""),
  })
  const grouped = new Set(CARD_LINE_GROUPS.flatMap((g) => g.keys))
  const extra = vocabulary.filter((k) => !grouped.has(k))
  const groups: FieldGroup[] = [
    ...CARD_LINE_GROUPS.map((g) =>
      g.title === "Other" ? { ...g, keys: [...g.keys, ...extra] } : g
    ),
    ...(cfKeys.length ? [{ title: "Custom fields", keys: cfKeys }] : []),
  ]
  return { meta, groups, available: [...vocabulary, ...cfKeys] }
}

/** Where an inherited list comes from, most specific first. */
export type CardLinesFrom =
  | { level: "view" }
  | { level: "role"; slug: string }
  | { level: "all" }

/**
 * The lines a device (or a view) gets while it has none of its own: the
 * saved view's list, else the device role's, else All devices - the same
 * order as the server's `resolve_card_fields` below the device level. A
 * list replaces the ones under it, and `[]` (name only) counts as a list.
 */
export function inheritedCardLines(
  config: Pick<TopologyCardConfig, "fields" | "role_overrides">,
  roleSlug?: string | null,
  viewFields?: readonly string[] | null
): { fields: string[]; from: CardLinesFrom } {
  if (viewFields) return { fields: [...viewFields], from: { level: "view" } }
  if (roleSlug) {
    // A role absent from the map inherits All devices.
    const key = `role:${roleSlug}`
    if (Object.hasOwn(config.role_overrides, key))
      return {
        fields: [...config.role_overrides[key]],
        from: { level: "role", slug: roleSlug },
      }
  }
  return { fields: [...config.fields], from: { level: "all" } }
}

/** How many roles have lines of their own - what "All devices" does not
 * cover. */
export function rolesWithOwnLines(
  config: Pick<TopologyCardConfig, "role_overrides">
): number {
  return Object.keys(config.role_overrides).length
}
