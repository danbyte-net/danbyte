/**
 * Port status colouring - the ONE source of truth shared by the 2D faceplate
 * (`device-faceplate.tsx`), the 3D room view (`floorplan3d/device-mesh.tsx`)
 * and the speed-scale legend, so a port lights the same way everywhere.
 *
 * Cabled ports wear a SPEED TIER from a cold→hot perceptual ramp (amber for
 * legacy and sub-1G up through fuchsia for 400G+), instead of a flat
 * "connected" green - at a glance the colour answers "how fast", not just "is
 * it plugged in". Free / disabled / unknown stay neutral. Live SNMP overrides
 * with the OBSERVED speed's tier when the link is up, red when it's down.
 *
 * The ramp itself and the speed parser live in `lib/speed.ts`, shared with
 * the topology and the site map; they are re-exported here for the panels.
 *
 * The non-port things a photo panel can carry answer different questions and
 * so get their own (still neutral) treatment: a hardware part wears its own
 * lifecycle status colour, a module bay wears occupied-vs-empty (`bayHex`).
 */

import type { CSSProperties } from "react"

import { parseSpeedMbps, speedTier } from "@/lib/speed"

export { SPEED_TIERS, speedTier, type SpeedTier } from "@/lib/speed"

export type PortState = "fast" | "gig" | "slow" | "cabled" | "free" | "disabled"

/** Neutral tints for the non-speed states. */
export const PORT_NEUTRAL = {
  /** Cabled but speed unknown - visible, but doesn't claim a tier. */
  cabled: "#64748b", // slate-500
  free: "#9ca3af", // gray-400
  disabled: "#6b7280", // gray-500
  /** Live SNMP: link down. */
  down: "#ef4444", // red-500
  /** Live SNMP: admin-shutdown. */
  adminDown: "#52525b", // zinc-600
}

/**
 * Max speed (Mbps) an interface TYPE can do, parsed from its name - display
 * form ("QSFP28 (100GE)", "100BASE-TX (10/100ME)") or slug ("25gbase-x-sfp28",
 * "1000base-t"). Used when no explicit speed is recorded: the type still
 * tells you what the cage is capable of. Null when nothing parses.
 */
export function typeMaxMbps(type?: string | null): number | null {
  if (!type) return null
  const t = type.toLowerCase()
  // Prefer the parenthetical ("…(10/100ME)", "…(100GE)") when present.
  const src = t.match(/\(([^)]*)\)/)?.[1] ?? t
  let max: number | null = null
  // "100ge" / "10ge" / "2.5ge" / "100me" style tokens.
  for (const m of src.matchAll(/(\d+(?:\.\d+)?)\s*(g|m)e?\b/g)) {
    const v = Number(m[1]) * (m[2] === "g" ? 1_000 : 1)
    if (max == null || v > max) max = v
  }
  // Slug fallbacks: "40gbase…" → G; "100base…"/"1000base…" → Mbps.
  if (max == null) {
    const g = t.match(/(\d+(?:\.\d+)?)gbase/)
    const m = t.match(/(\d+)base/)
    if (g) max = Number(g[1]) * 1_000
    else if (m) max = Number(m[1])
  }
  return max
}

/** A port's display state from intent (kept for the 2D free/disabled CSS). */
export function portState(p: {
  enabled: boolean
  cable: unknown
  speed: string
}): PortState {
  if (!p.enabled) return "disabled"
  if (!p.cable) return "free"
  const mbps = parseSpeedMbps(p.speed)
  if (mbps == null) return "cabled"
  if (mbps >= 10_000) return "fast"
  if (mbps >= 1_000) return "gig"
  return "slow"
}

/**
 * A port's display hex from intent: disabled/free neutral; cabled → its speed
 * tier - the explicit speed when recorded, else the TYPE's max speed
 * ("QSFP28 (100GE)" knows it's 100G), else neutral slate. One function,
 * 2D + 3D.
 */
export function portHex(p: {
  enabled: boolean
  cable: unknown
  speed: string
  type?: string | null
}): string {
  if (!p.enabled) return PORT_NEUTRAL.disabled
  if (!p.cable) return PORT_NEUTRAL.free
  const mbps = parseSpeedMbps(p.speed) ?? typeMaxMbps(p.type)
  return mbps == null ? PORT_NEUTRAL.cabled : speedTier(mbps).hex
}

/** A FREE port's capability tint (its type's max-speed tier), or null. Drawn
 * as a muted outline - "this cage can do 100G" - never as a lit port. */
export function portCapabilityHex(p: {
  enabled: boolean
  cable: unknown
  speed: string
  type?: string | null
}): string | null {
  if (!p.enabled || p.cable) return null
  const mbps = parseSpeedMbps(p.speed) ?? typeMaxMbps(p.type)
  return mbps == null ? null : speedTier(mbps).hex
}

/**
 * A module bay's colour. A bay answers ONE question - "is this slot free?" -
 * so it borrows the neutral pair the panel already uses for exactly that
 * distinction on ports: occupied wears the "present, claims no speed tier"
 * slate; empty wears the free-port grey, drawn as an outline. No speed ramp (a
 * line card is not fast), and no status palette (a bay has no lifecycle of its
 * own - the module in it does).
 */
export function bayHex(occupied: boolean): string {
  return occupied ? PORT_NEUTRAL.cabled : PORT_NEUTRAL.free
}

/** Live-SNMP colour: admin-down → zinc, link down → red, up → the OBSERVED
 * speed's tier (so a hot 100G link reads violet, not generic green). */
export function liveHex(o: {
  oper_status: string
  admin_status: string
  speed_mbps?: string
}): string {
  if (o.admin_status === "down") return PORT_NEUTRAL.adminDown
  if (o.oper_status !== "up") return PORT_NEUTRAL.down
  const mbps = Number(o.speed_mbps)
  return mbps > 0 ? speedTier(mbps).hex : PORT_NEUTRAL.cabled
}

/** Inline style for 2D port cages tinted by a hex - FULL-opacity border (a
 * washed border on a photo was unreadable) + a light fill + tinted text. The
 * CSS-class analog of the tier colours, generated so 2D can't drift. */
export function portTintStyle(hex: string): CSSProperties {
  return {
    borderColor: hex,
    backgroundColor: `${hex}26`, // 15%
    color: hex,
    // The utilization-card glow rings a matching port in its OWN tier
    // colour - published here so CSS can reach it.
    ["--port-color" as never]: hex,
  }
}

/** Stronger variant for markers drawn ON a photo - opaque border + a fill
 * solid enough to survive any faceplate artwork behind it. */
export function portOverlayStyle(hex: string): CSSProperties {
  return {
    borderColor: hex,
    backgroundColor: `${hex}59`, // 35%
    ["--port-color" as never]: hex,
  }
}

/** What a rendered panel actually contains, so its legend can show only that.
 *
 * A legend is a key to the picture, not a catalogue of everything Danbyte can
 * draw - a shelf of disk bays listing FE…400G+ teaches nothing and buries the
 * two colours that are on screen. Derived from the same inputs the renderers
 * use, so the key and the pixels can't disagree. */
export interface LegendContent {
  /** Speed-tier labels present on cabled ports. */
  tiers: Set<string>
  /** Neutral states present: "idle" (enabled, no cable), "off" (disabled),
   * "down" (observed down). */
  states: Set<string>
  /** A trunk port is drawn. */
  trunk: boolean
  /** Status ids of the hardware parts drawn. Ids, not slugs: a part serializes
   * its status as StatusMini (id/name/color), and the id is what joins it to
   * the tenant's Status catalog the key is drawn from. */
  partStatusIds: Set<string>
  /** Module-bay occupancies drawn: "installed" and/or "empty". A device TYPE
   * has no modules, so its panel keys "empty" alone - which is the honest key
   * for what it draws. */
  bays: Set<string>
  /** Airflow glyphs drawn (3D room only): "intake" and/or "exhaust". */
  airflow: Set<string>
}

/** Airflow glyph + legend-chip colours - one source so the key can never
 * disagree with the cones. The same blue/red these modules already use for
 * meaning (speed tiers / observed-down). */
export const AIRFLOW_HEX: Record<"intake" | "exhaust", string> = {
  intake: "#3b82f6",
  exhaust: "#ef4444",
}

/** Nothing drawn - a panel that resolved no markers at all. */
export const EMPTY_LEGEND: LegendContent = {
  tiers: new Set(),
  states: new Set(),
  trunk: false,
  partStatusIds: new Set(),
  bays: new Set(),
  airflow: new Set(),
}

/** A canonical string for a legend's CONTENT, so consumers can compare two of
 * them by value. Sets and booleans have no useful `===`, and comparing the
 * objects by identity is what turns "report what you drew" into a render loop. */
export function legendSignature(c: LegendContent): string {
  const sorted = (s: Set<string>) => [...s].sort().join(",")
  return [
    sorted(c.tiers),
    sorted(c.states),
    c.trunk ? 1 : 0,
    sorted(c.partStatusIds),
    sorted(c.bays),
    sorted(c.airflow),
  ].join("|")
}

/** True when nothing on screen needs a key - hide the legend entirely. */
export function legendIsEmpty(c: LegendContent): boolean {
  return (
    c.tiers.size === 0 &&
    c.states.size === 0 &&
    !c.trunk &&
    c.partStatusIds.size === 0 &&
    c.bays.size === 0 &&
    c.airflow.size === 0
  )
}

/** Union of several panels' content, for one legend under several faceplates
 * (a virtual chassis' members, every rack in a 3D room). */
export function mergeLegend(parts: LegendContent[]): LegendContent {
  const out: LegendContent = {
    tiers: new Set(),
    states: new Set(),
    trunk: false,
    partStatusIds: new Set(),
    bays: new Set(),
    airflow: new Set(),
  }
  for (const p of parts) {
    for (const t of p.tiers) out.tiers.add(t)
    for (const s of p.states) out.states.add(s)
    for (const s of p.partStatusIds) out.partStatusIds.add(s)
    for (const b of p.bays) out.bays.add(b)
    for (const a of p.airflow) out.airflow.add(a)
    out.trunk = out.trunk || p.trunk
  }
  return out
}

/** Derive a panel's legend from the components it DREW.
 *
 * `observed` must hold only the rows for those same components - passing a
 * whole device's SNMP map would claim a "down" swatch for a port that isn't on
 * this panel. */
export function legendContent(input: {
  ports?: {
    enabled: boolean
    cable?: unknown
    speed?: string | null
    type?: string | null
    mode?: string | null
  }[]
  observed?: Map<string, { oper_status: string; admin_status: string }> | null
  parts?: { status?: { id: string } | null }[]
  /** Module bays drawn - one entry per bay marker that resolved. */
  bays?: { occupied: boolean }[]
}): LegendContent {
  const tiers = new Set<string>()
  const states = new Set<string>()
  let trunk = false
  for (const p of input.ports ?? []) {
    if (p.mode === "tagged" || p.mode === "tagged-all") trunk = true
    if (!p.enabled) {
      states.add("off")
      continue
    }
    if (p.cable) {
      // Same resolution order the colours use: explicit speed, else what the
      // cage type is capable of.
      const mbps = parseSpeedMbps(p.speed) ?? typeMaxMbps(p.type) ?? 0
      tiers.add(speedTier(mbps).label)
    } else states.add("idle")
  }
  for (const o of (input.observed ?? new Map()).values())
    if (o.admin_status !== "down" && o.oper_status !== "up") states.add("down")
  const partStatusIds = new Set<string>()
  for (const it of input.parts ?? [])
    if (it.status?.id) partStatusIds.add(it.status.id)
  const bays = new Set<string>()
  for (const b of input.bays ?? []) bays.add(b.occupied ? "installed" : "empty")
  // 2D faceplates never draw airflow glyphs; only the 3D room reports them.
  return { tiers, states, trunk, partStatusIds, bays, airflow: new Set() }
}

/**
 * Colour for a power feed leg / redundancy side - the vertical PDU strip's
 * outlet cells and body. Derived from data (the outlet's `feed_leg` or the
 * PDU's upstream feed `type`), never from a name, per the house rule.
 *
 * A / primary → blue, B / redundant → red, C → amber. Anything unknown →
 * neutral zinc, so an unwired strip reads as "no feed known", not a false A.
 */
export function feedTint(leg: string, feedType: string): string {
  const k = (leg || "").toUpperCase()
  if (k === "A") return "#3b82f6"
  if (k === "B") return "#ef4444"
  if (k === "C") return "#f59e0b"
  if (feedType === "primary") return "#3b82f6"
  if (feedType === "redundant") return "#ef4444"
  return "#52525b"
}
