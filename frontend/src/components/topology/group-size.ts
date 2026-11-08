import { measureText, wrapText } from "@/lib/diagram/measure"
import type { Measure, Weight } from "@/lib/diagram/measure"

// The box a site or location card (group-node.tsx) or a provider network
// card (provider-network-node.tsx) renders at: kept apart from the
// components so the Diagram's builder, which runs in a worker, needs no
// React to size one.
//
// A card is at least `GROUP_W` wide and grows to fit its whole name, up to
// `GROUP_MAX_W`; past that the name wraps onto more rows and the card
// grows taller. A name is never cut.

export const GROUP_W = 212
export const GROUP_H = 76
/** Twice the least width: past it a name wraps. */
export const GROUP_MAX_W = 2 * GROUP_W

export const GROUP_TEXT = {
  /** `px-3` and the 2px border, each side. */
  CHROME_X: 2 * (12 + 2),
  /** `gap-2`: between the name and its count (and the cloud icon). */
  GAP: 8,
  NAME_SIZE: 13,
  NAME_WEIGHT: 600 as Weight,
  /** A name row's line box. */
  NAME_LH: 18,
  COUNT_SIZE: 11,
  COUNT_WEIGHT: 400 as Weight,
  /** A provider network's cloud icon (`size-4`), and the provider row's
   * indent under the name (`pl-6`). */
  ICON: 16,
  INDENT: 24,
  SLACK: 2,
} as const

export interface GroupBox {
  width: number
  height: number
  /** The name, whole, one row per entry. */
  rows: string[]
}

/** What the sizing reads off a site, location or provider network card. */
export interface GroupSizeData {
  kind?: string
  name?: string
  device_count?: number
  circuit_count?: number
  provider?: { name?: string } | null
}

/** "N devices" or "N circuits", as the card writes it. */
export function groupCount(d: GroupSizeData): string {
  if (d.kind === "provider_network") {
    const n = d.circuit_count ?? 0
    return `${n} ${n === 1 ? "circuit" : "circuits"}`
  }
  const n = d.device_count ?? 0
  return `${n} ${n === 1 ? "device" : "devices"}`
}

/** A site, location or provider network card's box and its name's rows. */
export function groupBox(
  d: GroupSizeData,
  measure: Measure = measureText
): GroupBox {
  const T = GROUP_TEXT
  const pn = d.kind === "provider_network"
  const name = d.name ?? ""
  const nameW = Math.ceil(measure(name, T.NAME_SIZE, T.NAME_WEIGHT))
  const countW = Math.ceil(measure(groupCount(d), T.COUNT_SIZE, T.COUNT_WEIGHT))
  // Everything on the name's row but the name itself, and a pixel or two
  // for the page's own rounding.
  const around =
    T.CHROME_X + (pn ? T.ICON + T.GAP : 0) + T.GAP + countW + T.SLACK
  const provider = pn ? (d.provider?.name ?? "") : ""
  const providerW = provider
    ? T.CHROME_X +
      T.INDENT +
      Math.ceil(measure(provider, T.COUNT_SIZE, T.COUNT_WEIGHT))
    : 0
  const room = Math.max(1, GROUP_MAX_W - around)
  const rows = wrapText(name, room, T.NAME_SIZE, T.NAME_WEIGHT, measure)
  const rowsW = Math.max(
    0,
    ...rows.map((r) => Math.ceil(measure(r, T.NAME_SIZE, T.NAME_WEIGHT)))
  )
  const width = Math.max(
    GROUP_W,
    rows.length > 1 ? around + rowsW : Math.min(GROUP_MAX_W, around + nameW),
    // A provider's name, as far as the card may grow for it.
    Math.min(GROUP_MAX_W, providerW)
  )
  return {
    width,
    height: GROUP_H + Math.max(0, rows.length - 1) * T.NAME_LH,
    rows: rows.length ? rows : [""],
  }
}

/** A site, location or provider network card's box. */
export function groupSize(
  d: GroupSizeData,
  measure: Measure = measureText
): { width: number; height: number } {
  const { width, height } = groupBox(d, measure)
  return { width, height }
}
