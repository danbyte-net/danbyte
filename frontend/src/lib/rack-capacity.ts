/**
 * Rack capacity - how full a rack is in space, power and ports - read the
 * same way on every surface: the racks table, the rack page, the floor
 * plan's tiles and popover, and the 3D room.
 *
 * One fixed scale for all three figures until thresholds become a setting:
 * above 80 % is a warning, above 95 % critical. The colours are the status
 * colours (emerald / amber / red), never the accent: capacity is a state.
 * IPAM prefix utilisation keeps its own scale (`cells/util-cell.tsx`).
 */

import type { RackPower } from "@/lib/api"

/** Above this share of capacity a rack is filling up. */
export const CAPACITY_WARN = 0.8
/** Above this share it is full, or over. */
export const CAPACITY_CRITICAL = 0.95

export type CapacityLevel = "good" | "warn" | "critical"

/** The level a used / total ratio is at. */
export function capacityLevel(ratio: number): CapacityLevel {
  if (ratio > CAPACITY_CRITICAL) return "critical"
  if (ratio > CAPACITY_WARN) return "warn"
  return "good"
}

/** used / total, or null when there is no total to measure against. */
export function capacityRatio(used: number, total: number): number | null {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0)
    return null
  return Math.max(0, used) / total
}

/** Hex per level, for what can't take a class: SVG fills, the 3D room. */
export const CAPACITY_HEX: Record<CapacityLevel, string> = {
  good: "#10b981", // emerald-500
  warn: "#f59e0b", // amber-500
  critical: "#ef4444", // red-500
}

/** A figure with nothing to measure (no feed, no ports): neutral grey. */
export const CAPACITY_NONE_HEX = "#a1a1aa" // zinc-400

/** The fill for a ratio - its level's hex, or the no-data grey. */
export function capacityColor(ratio: number | null | undefined): string {
  return ratio == null || !Number.isFinite(ratio)
    ? CAPACITY_NONE_HEX
    : CAPACITY_HEX[capacityLevel(ratio)]
}

/** Bar fill classes per level, for DOM bars. */
export const CAPACITY_BAR_CLASS: Record<CapacityLevel, string> = {
  good: "bg-emerald-500",
  warn: "bg-amber-500",
  critical: "bg-red-500",
}

/** "850 W", "2.35 kW", "12.3 kW", "1.2 MW": three significant figures. */
export function formatWatts(watts: number): string {
  if (!Number.isFinite(watts)) return ""
  const w = Math.round(watts)
  if (Math.abs(w) < 1_000) return `${w} W`
  const sig = (n: number) => Number(n.toPrecision(3))
  const kw = sig(w / 1_000)
  if (Math.abs(kw) < 1_000) return `${kw} kW`
  return `${sig(w / 1_000_000)} MW`
}

// ─── Power ───────────────────────────────────────────────────────────────────

/** A rack's power roll-up as the server sends it on a rack, a floor-plan
 * tile and the rack's port state (`api/capacity.py rack_power`): supply is
 * the primary feeds, else the PDUs' inlet rating (`supply: "pdu_rating"`),
 * 0 when neither is known. */
export type { RackPower }

/** The demand a rack reports: the allocated draw where it is recorded,
 * else the nameplate sum - and which it is. */
export function rackPowerDemand(p: RackPower): {
  watts: number
  nameplate: boolean
} {
  if (p.allocated_w > 0) return { watts: p.allocated_w, nameplate: false }
  return { watts: p.maximum_w, nameplate: p.maximum_w > 0 }
}

/** Demand over supply, or null without a feed to measure against. */
export function rackPowerRatio(p: RackPower): number | null {
  return capacityRatio(rackPowerDemand(p).watts, p.available_w)
}

/** Anything to say about the rack's power at all. */
export function hasPowerData(p: RackPower | null | undefined): p is RackPower {
  return !!p && (p.allocated_w > 0 || p.maximum_w > 0 || p.available_w > 0)
}
