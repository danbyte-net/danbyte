import type { SiteMapCapacity, SiteMapLink } from "@/lib/api"

// The site map's Utilization colouring: live traffic on each line, from the
// interfaces at its ends (`GET /api/monitoring/interfaces/live/`). Each line
// is split at its midpoint and each half shows one direction - the half at
// A carries A → Z, the half at Z carries Z → A - so a line reads like a
// two-lane road. Leaflet-free, so the layers, the legend and the tests read
// one rule.

type Pt = [number, number]

/** One interface's live rate, as `iface_live.live_rates` sends it. */
export interface LiveRate {
  in_bps: number | null
  out_bps: number | null
  speed_mbps: number | null
  at: string
  interval_s: number
}

export interface LiveRatesPayload {
  as_of: string | null
  interfaces: Record<string, LiveRate | null>
}

/** A band of utilisation, slowest first. */
export interface UtilBand {
  key: string
  label: string
  /** The band holds percentages below this (the last one: everything). */
  below: number
  hex: string
  /** The line's stroke width in the band. */
  weight: number
}

export const UTIL_BANDS: readonly UtilBand[] = [
  { key: "lt10", label: "< 10%", below: 10, hex: "#0ea5e9", weight: 2 },
  { key: "10-25", label: "10–25%", below: 25, hex: "#10b981", weight: 2.5 },
  { key: "25-50", label: "25–50%", below: 50, hex: "#84cc16", weight: 3 },
  { key: "50-75", label: "50–75%", below: 75, hex: "#eab308", weight: 3.5 },
  { key: "75-90", label: "75–90%", below: 90, hex: "#f97316", weight: 4 },
  { key: "ge90", label: "≥ 90%", below: Infinity, hex: "#ef4444", weight: 5 },
]

/** No live rate for that direction. */
export const UTIL_NO_DATA = { label: "No data", hex: "#71717a", weight: 2 }

export function utilBand(pct: number): UtilBand {
  return (
    UTIL_BANDS.find((b) => pct < b.below) ?? UTIL_BANDS[UTIL_BANDS.length - 1]
  )
}

/** One direction of a line: its traffic and its share of the capacity. */
export interface DirectionUtil {
  bps: number
  /** Null when no capacity is known to measure against. */
  pct: number | null
}

export interface LineUtil {
  /** A → Z: the half at A. */
  az: DirectionUtil | null
  /** Z → A: the half at Z. */
  za: DirectionUtil | null
  /** The newest sample behind the figures. */
  at: string | null
}

/** What the colouring reads off a line: its links (with their end ports)
 * and its capacity. */
export interface UtilLine {
  id: string
  capacity?: Pick<SiteMapCapacity, "kbps"> | null
  links?: SiteMapLink[]
}

/** An end's interface id, when it lands on a device interface. */
function endInterface(end: SiteMapLink["a"]): string | null {
  return end.port && end.port.kind === "interface" && !end.restricted
    ? end.port.id
    : null
}

/** Every device interface at an end of `lines`' links, for one batch. */
export function lineInterfaceIds(lines: Iterable<UtilLine>): string[] {
  const ids = new Set<string>()
  for (const l of lines)
    for (const link of l.links ?? []) {
      const a = endInterface(link.a)
      const z = endInterface(link.z)
      if (a) ids.add(a)
      if (z) ids.add(z)
    }
  return [...ids].sort()
}

/** The bps a link carries from `from` to `to`: what leaves `from`, else what
 * arrives at `to`. */
function flow(
  from: LiveRate | null | undefined,
  to: LiveRate | null | undefined
): number | null {
  return from?.out_bps ?? to?.in_bps ?? null
}

/** A link's speed in bps from its ends: the slower end's reported speed. */
function endSpeed(
  link: SiteMapLink,
  a: LiveRate | null | undefined,
  z: LiveRate | null | undefined
): number | null {
  const speeds = [
    a?.speed_mbps ? a.speed_mbps * 1e6 : (link.a.port?.speed_kbps ?? 0) * 1e3,
    z?.speed_mbps ? z.speed_mbps * 1e6 : (link.z.port?.speed_kbps ?? 0) * 1e3,
  ].filter((s) => s > 0)
  return speeds.length ? Math.min(...speeds) : null
}

/**
 * A line's two directions. Traffic adds up over its links; it is measured
 * against the line's capacity, falling back to the ports' reported speed.
 * A direction no link has a rate for is null - No data.
 */
export function lineUtilization(
  line: UtilLine,
  rates: Record<string, LiveRate | null | undefined>
): LineUtil {
  let az: number | null = null
  let za: number | null = null
  let speed = 0
  let at: string | null = null
  for (const link of line.links ?? []) {
    const aId = endInterface(link.a)
    const zId = endInterface(link.z)
    const a = aId ? rates[aId] : null
    const z = zId ? rates[zId] : null
    const fwd = flow(a, z)
    const back = flow(z, a)
    if (fwd != null) az = (az ?? 0) + fwd
    if (back != null) za = (za ?? 0) + back
    if (fwd != null || back != null) speed += endSpeed(link, a, z) ?? 0
    for (const r of [a, z]) if (r?.at && (!at || r.at > at)) at = r.at
  }
  const kbps = line.capacity?.kbps ?? 0
  const capacity = kbps > 0 ? kbps * 1e3 : speed
  const dir = (bps: number | null): DirectionUtil | null =>
    bps == null
      ? null
      : { bps, pct: capacity > 0 ? (bps / capacity) * 100 : null }
  return { az: dir(az), za: dir(za), at }
}

/** The colour and width of one half. */
export function halfLook(d: DirectionUtil | null): {
  color: string
  weight: number
} {
  if (!d || d.pct == null)
    return { color: UTIL_NO_DATA.hex, weight: UTIL_NO_DATA.weight }
  const band = utilBand(d.pct)
  return { color: band.hex, weight: band.weight }
}

/** "42%", "< 1%", or the rate itself when no capacity is known. */
export function directionLabel(d: DirectionUtil | null): string {
  if (!d) return "No data"
  if (d.pct == null) return fmtBps(d.bps)
  if (d.pct > 0 && d.pct < 1) return "< 1%"
  return `${Math.round(d.pct)}%`
}

/** "850 bps", "12.4 Mbps", "1.2 Gbps". */
export function fmtBps(bps: number): string {
  const units = ["bps", "kbps", "Mbps", "Gbps", "Tbps"]
  let v = bps
  let i = 0
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000
    i++
  }
  return `${i === 0 ? Math.round(v) : Number(v.toPrecision(3))} ${units[i]}`
}

/** A path cut in two at its halfway point (by length), both halves holding
 * the midpoint, so the two colours meet without a gap. */
export function splitAtMidpoint(path: readonly Pt[]): [Pt[], Pt[]] {
  if (path.length < 2) return [[...path], [...path]]
  const k = Math.cos((path[0][0] * Math.PI) / 180)
  const seg: number[] = []
  let total = 0
  for (let i = 1; i < path.length; i++) {
    const d = Math.hypot(
      path[i][0] - path[i - 1][0],
      (path[i][1] - path[i - 1][1]) * k
    )
    seg.push(d)
    total += d
  }
  if (total === 0)
    return [
      [path[0], path[0]],
      [path[0], path[0]],
    ]
  let walked = 0
  for (let i = 0; i < seg.length; i++) {
    if (walked + seg[i] >= total / 2 && seg[i] > 0) {
      const t = (total / 2 - walked) / seg[i]
      const p0 = path[i]
      const p1 = path[i + 1]
      const mid: Pt = [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t]
      return [
        [...path.slice(0, i + 1), mid],
        [mid, ...path.slice(i + 1)],
      ]
    }
    walked += seg[i]
  }
  return [[...path], [path[path.length - 1]]]
}
