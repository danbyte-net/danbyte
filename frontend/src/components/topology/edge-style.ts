import type { CSSProperties } from "react"

import type { TopoEdge } from "@/lib/api"
import { cssColor } from "@/lib/utils"

// How each kind of topology edge is drawn - stroke width, colour, dash and
// label emphasis - kept apart from the layout so the wiring views, the
// diagram and the exporters all draw an edge kind the same way.

export type EdgeColorMode = "cable" | "type" | "status" | "speed" | "none"

/** What an edge stands for: one cable, a folded aggregate, a Flat-view
 * bundle of parallel cables, an LLDP ghost, a BGP session, a trace map's
 * patch pass-through or port membership, or a grouped view's ×N edge. */
export type EdgeSem =
  | "cable"
  | "lagbundle"
  | "bundle"
  | "ghost"
  | "bgp"
  | "through"
  | "membership"
  | "groupedge"

/** The cable fields the colour modes read. `status_mini` is the cable's
 * status record; payloads that predate it carry only the slug. */
export type CableLook = Pick<
  NonNullable<TopoEdge["data"]>,
  "cable_type" | "color" | "status" | "status_mini" | "speed"
>

// Deterministic palette per cable type - informational hue, not state.
const TYPE_PALETTE = [
  "#0ea5e9",
  "#8b5cf6",
  "#f59e0b",
  "#10b981",
  "#ec4899",
  "#14b8a6",
  "#f97316",
  "#6366f1",
  "#84cc16",
  "#e11d48",
  "#06b6d4",
  "#a855f7",
]

export function typeColor(type: string): string {
  let h = 0
  for (let i = 0; i < type.length; i++) h = (h * 31 + type.charCodeAt(i)) | 0
  return TYPE_PALETTE[Math.abs(h) % TYPE_PALETTE.length]
}

/** "10G" / "2.5 Gbps" / "1000" (Mbps) → Mbps, or null when unparsable. */
function speedMbps(s: string): number | null {
  const m = /([\d.]+)\s*([tgm]?)/i.exec(s.trim())
  if (!m) return null
  const n = parseFloat(m[1])
  if (!isFinite(n)) return null
  const u = m[2].toLowerCase()
  return u === "t" ? n * 1e6 : u === "g" ? n * 1000 : n
}

/** Speed tier hue - faster = hotter. Unparsable/absent speeds stay zinc. */
export function speedColor(s?: string | null): string | undefined {
  if (!s) return undefined
  const mb = speedMbps(s)
  if (mb == null) return "#71717a"
  if (mb >= 100000) return "#e11d48" // 100G+
  if (mb >= 40000) return "#f59e0b" // 40G
  if (mb >= 25000) return "#8b5cf6" // 25G
  if (mb >= 10000) return "#0ea5e9" // 10G
  if (mb >= 1000) return "#10b981" // 1G
  return "#71717a"
}

/** A cable's status hue: the status record's own colour, or - for a
 * payload without one - a guess from the slug. */
export function statusColor(data?: CableLook | null): string | undefined {
  const own = cssColor(data?.status_mini?.color)
  if (own) return own
  const slug = data?.status
  if (!slug) return undefined
  if (/(active|connected|up)/.test(slug)) return "#10b981"
  if (/(plan|staged|reserved)/.test(slug)) return "#f59e0b"
  if (/(fail|broken|down|decom)/.test(slug)) return "#ef4444"
  return "#71717a"
}

/** The stroke one cable gets under a colour mode; undefined = the default
 * edge colour. */
export function edgeStroke(
  data: CableLook | undefined,
  mode: EdgeColorMode
): string | undefined {
  if (mode === "type" && data?.cable_type) return typeColor(data.cable_type)
  if (mode === "status") return statusColor(data)
  if (mode === "speed") return speedColor(data?.speed)
  if (mode === "cable" && data?.color) return cssColor(data.color)
  return undefined
}

/** A bundle's stroke: the members' shared colour under the mode, or
 * undefined when they disagree - a mixed bundle stays neutral rather than
 * lying. */
export function bundleStroke(
  cables: CableLook[],
  mode: EdgeColorMode
): string | undefined {
  const strokes = new Set(cables.map((c) => edgeStroke(c, mode) ?? ""))
  return strokes.size === 1 ? [...strokes][0] || undefined : undefined
}

export interface EdgeLook {
  width: number
  stroke?: string
  dash?: string
  opacity?: number
  /** The edge's label chip; absent = the edge carries no label. */
  label?: { italic?: boolean; weight?: number }
}

export interface EdgeLookContext {
  /** The colour-mode stroke (`edgeStroke`) for cables and bundles. */
  stroke?: string
  /** Cables the edge stands for: a cable's endpoint pairs, a grouped edge's
   * cable count. */
  count?: number
  /** The run passes through patch panels. */
  via?: boolean
  /** Trace map: the edge is part of the traced run. */
  marked?: boolean
}

/** The drawn look of one edge kind. */
export function edgeLook(sem: EdgeSem, ctx: EdgeLookContext = {}): EdgeLook {
  const stroke = ctx.stroke ? { stroke: ctx.stroke } : {}
  switch (sem) {
    case "cable":
      // Traced cable (trace map): thick primary stroke so the run stands out.
      if (ctx.marked) return { width: 2.5, stroke: "var(--primary)", label: {} }
      return {
        width: (ctx.count ?? 1) > 1 ? 1.75 : 1.25,
        ...stroke,
        ...(ctx.via ? { dash: "10 4" } : {}),
        label: {},
      }
    case "lagbundle":
      if (ctx.marked)
        return { width: 3, stroke: "var(--primary)", label: { weight: 600 } }
      return { width: 2.5, ...stroke, label: { weight: 600 } }
    case "bundle":
      return { width: 1.75, ...stroke, label: {} }
    case "ghost":
      return {
        width: 1.5,
        stroke: "var(--muted-foreground)",
        dash: "6 4",
        opacity: 0.8,
        label: { italic: true },
      }
    case "bgp":
      return {
        width: 1.25,
        stroke: "var(--primary)",
        dash: "3 5",
        opacity: 0.45,
      }
    case "through":
      return {
        width: 1.5,
        stroke: "var(--muted-foreground)",
        dash: "4 3",
        label: {},
      }
    case "membership":
      return { width: 1, stroke: "var(--border)", opacity: 0.6 }
    case "groupedge": {
      // Width scales gently with the number of cables folded in.
      const n = ctx.count ?? 1
      return { width: Math.min(1 + Math.log2(n + 1) * 0.6, 3), label: {} }
    }
  }
}

/** A look as React Flow edge styling. */
export function flowEdgeStyle(look: EdgeLook): {
  style: CSSProperties
  labelStyle?: CSSProperties
  labelBgStyle?: CSSProperties
} {
  return {
    style: {
      strokeWidth: look.width,
      ...(look.stroke ? { stroke: look.stroke } : {}),
      ...(look.dash ? { strokeDasharray: look.dash } : {}),
      ...(look.opacity != null ? { opacity: look.opacity } : {}),
    },
    ...(look.label
      ? {
          labelStyle: {
            fontSize: 9,
            ...(look.label.italic ? { fontStyle: "italic" } : {}),
            ...(look.label.weight ? { fontWeight: look.label.weight } : {}),
          },
          labelBgStyle: { fill: "var(--card)" },
        }
      : {}),
  }
}
