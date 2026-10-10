/**
 * Rack capacity - how full a rack is in space, power and ports - read the
 * same way on every surface: the racks table, the rack page, the floor
 * plan's tiles and popover, and the 3D room.
 *
 * One scale for all three figures: above the tenant's warning level (80 %
 * unless changed) a rack is filling up, above its critical level (95 %) it
 * is full. The levels are a tenant setting, served on `/api/me/` as
 * `capacity_thresholds`; `useMe` hands them to `setCapacityThresholds` as it
 * loads, before anything is drawn. The colours are the status colours
 * (emerald / amber / red), never the accent: capacity is a state. IPAM prefix
 * utilisation keeps its own scale (`cells/util-cell.tsx`).
 */
import { useSyncExternalStore } from "react"

import type { RackPower } from "@/lib/api"

/** The default levels, as shares: above 80 % warn, above 95 % critical. */
export const CAPACITY_WARN = 0.8
export const CAPACITY_CRITICAL = 0.95

/** The levels in force, as shares of capacity. */
export interface CapacityThresholds {
  warn: number
  critical: number
}

let thresholds: CapacityThresholds = {
  warn: CAPACITY_WARN,
  critical: CAPACITY_CRITICAL,
}
const listeners = new Set<() => void>()

/** Set the levels from the tenant's percentages (`me.capacity_thresholds`).
 * Anything missing or out of order keeps the defaults. */
export function setCapacityThresholds(
  pct: { warn?: number; critical?: number } | null | undefined
) {
  const warn = (pct?.warn ?? 80) / 100
  const critical = (pct?.critical ?? 95) / 100
  const next =
    Number.isFinite(warn) && Number.isFinite(critical) && warn < critical
      ? { warn, critical }
      : { warn: CAPACITY_WARN, critical: CAPACITY_CRITICAL }
  if (next.warn === thresholds.warn && next.critical === thresholds.critical)
    return
  thresholds = next
  for (const l of listeners) l()
}

export function capacityThresholds(): CapacityThresholds {
  return thresholds
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The levels in force, re-rendering the caller when the tenant's change. */
export function useCapacityThresholds(): CapacityThresholds {
  return useSyncExternalStore(subscribe, capacityThresholds, capacityThresholds)
}

/** "80–95%" - a level band for a legend. */
export function capacityBandLabel(
  level: CapacityLevel,
  t: CapacityThresholds = thresholds
): string {
  const w = Math.round(t.warn * 100)
  const c = Math.round(t.critical * 100)
  if (level === "critical") return `> ${c}%`
  if (level === "warn") return `${w}–${c}%`
  return `≤ ${w}%`
}

export type CapacityLevel = "good" | "warn" | "critical"

/** The level a used / total ratio is at. */
export function capacityLevel(
  ratio: number,
  t: CapacityThresholds = thresholds
): CapacityLevel {
  if (ratio > t.critical) return "critical"
  if (ratio > t.warn) return "warn"
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

/** What the rack's supply figure is: its power budget, its feeds, or its
 * PDUs' rating. */
export function powerSupplyNote(p: RackPower): string {
  if (p.supply === "budget") return "budget"
  if (p.supply === "pdu_rating") return "PDU rating"
  return ""
}

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
