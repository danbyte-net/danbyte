/**
 * Port status colouring — the ONE source of truth shared by the 2D faceplate
 * (`device-faceplate.tsx`), the 3D room view (`floorplan3d/device-mesh.tsx`)
 * and the speed-scale legend, so a port lights the same way everywhere.
 *
 * Cabled ports wear a SPEED TIER from a cold→hot perceptual ramp (amber for
 * legacy FE up through fuchsia for 400G+), instead of a flat "connected"
 * green — at a glance the colour answers "how fast", not just "is it plugged
 * in". Free / disabled / unknown stay neutral. Live SNMP overrides with the
 * OBSERVED speed's tier when the link is up, red when it's down.
 */

import type { CSSProperties } from "react"

export type PortState = "fast" | "gig" | "slow" | "cabled" | "free" | "disabled"

// ─── Speed tiers ─────────────────────────────────────────────────────────────

export interface SpeedTier {
  /** Lower bound (Mbps) — a speed belongs to the highest tier it reaches. */
  minMbps: number
  label: string
  hex: string
}

/** The ramp, slow → fast. Tailwind -500 tints, hue-ordered so speed reads as
 * temperature: amber (legacy) → emerald/teal (access) → sky/blue/indigo
 * (aggregation) → violet/purple/fuchsia (core, 100G–1.6T). */
export const SPEED_TIERS: SpeedTier[] = [
  { minMbps: 0, label: "FE", hex: "#f59e0b" }, // ≤100M
  { minMbps: 1_000, label: "1G", hex: "#10b981" },
  { minMbps: 2_500, label: "2.5G", hex: "#14b8a6" }, // 2.5/5G multigig
  { minMbps: 10_000, label: "10G", hex: "#0ea5e9" },
  { minMbps: 25_000, label: "25G", hex: "#3b82f6" },
  { minMbps: 40_000, label: "40G", hex: "#6366f1" }, // 40/50G
  { minMbps: 100_000, label: "100G", hex: "#8b5cf6" },
  { minMbps: 200_000, label: "200G", hex: "#a855f7" }, // 200/300G
  { minMbps: 400_000, label: "400G+", hex: "#d946ef" }, // 400G…1.6T
]

/** Neutral tints for the non-speed states. */
export const PORT_NEUTRAL = {
  /** Cabled but speed unknown — visible, but doesn't claim a tier. */
  cabled: "#64748b", // slate-500
  free: "#9ca3af", // gray-400
  disabled: "#6b7280", // gray-500
  /** Live SNMP: link down. */
  down: "#ef4444", // red-500
  /** Live SNMP: admin-shutdown. */
  adminDown: "#52525b", // zinc-600
}

/** Parse Danbyte's short speed strings ("100M", "1G", "25G", "1.6T") → Mbps. */
export function speedMbps(speed: string): number | null {
  const m = speed.trim().match(/^([\d.]+)\s*([MGT])/i)
  if (!m) return null
  const n = Number(m[1])
  const unit = m[2].toUpperCase()
  return unit === "T" ? n * 1_000_000 : unit === "G" ? n * 1_000 : n
}

/** The tier a speed (Mbps) falls in — the highest bound it reaches. */
export function speedTier(mbps: number): SpeedTier {
  let tier = SPEED_TIERS[0]
  for (const t of SPEED_TIERS) if (mbps >= t.minMbps) tier = t
  return tier
}

/**
 * Max speed (Mbps) an interface TYPE can do, parsed from its name — display
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
  const mbps = speedMbps(p.speed)
  if (mbps == null) return "cabled"
  if (mbps >= 10_000) return "fast"
  if (mbps >= 1_000) return "gig"
  return "slow"
}

/**
 * A port's display hex from intent: disabled/free neutral; cabled → its speed
 * tier — the explicit speed when recorded, else the TYPE's max speed
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
  const mbps = speedMbps(p.speed) ?? typeMaxMbps(p.type)
  return mbps == null ? PORT_NEUTRAL.cabled : speedTier(mbps).hex
}

/** A FREE port's capability tint (its type's max-speed tier), or null. Drawn
 * as a muted outline — "this cage can do 100G" — never as a lit port. */
export function portCapabilityHex(p: {
  enabled: boolean
  cable: unknown
  speed: string
  type?: string | null
}): string | null {
  if (!p.enabled || p.cable) return null
  const mbps = speedMbps(p.speed) ?? typeMaxMbps(p.type)
  return mbps == null ? null : speedTier(mbps).hex
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

/** Inline style for 2D port cages tinted by a hex — FULL-opacity border (a
 * washed border on a photo was unreadable) + a light fill + tinted text. The
 * CSS-class analog of the tier colours, generated so 2D can't drift. */
export function portTintStyle(hex: string): CSSProperties {
  return {
    borderColor: hex,
    backgroundColor: `${hex}26`, // 15%
    color: hex,
  }
}

/** Stronger variant for markers drawn ON a photo — opaque border + a fill
 * solid enough to survive any faceplate artwork behind it. */
export function portOverlayStyle(hex: string): CSSProperties {
  return {
    borderColor: hex,
    backgroundColor: `${hex}59`, // 35%
  }
}
