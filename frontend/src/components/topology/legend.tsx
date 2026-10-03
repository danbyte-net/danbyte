import { LegendFrame, LegendItems } from "@/components/map-legend"
import type { LegendItem } from "@/components/map-legend"
import type { TopologyGraph } from "@/lib/api"
import { SPEED_TIERS, speedTierOf } from "@/lib/speed"
import { TUNNEL_DASH, typeColor } from "./edge-style"
import type { EdgeColorMode, NodeStyle } from "./topology-canvas"
import { naturalCompare } from "@/lib/natural-sort"

// Line-key legend for the topology views, in the maps' shared legend frame.
// Collapsible, remembered per browser, and its rows adapt to the active view
// + color mode so it only explains lines that are actually on screen.

export type { LegendItem } from "@/components/map-legend"

const KEY = "topology:legend"

// One terse line per mode - the docs explain, the legend just labels. The
// words are the Display popover's Color by options.
const COLOR_MODE_NOTE: Record<EdgeColorMode, string> = {
  cable: "Color by cable",
  type: "Color by type",
  status: "Color by status",
  speed: "Color by speed",
  none: "",
}

/** The most role fills the Diagram legend lists; the rest are on the map. */
const MAX_ROLES = 12
/** The most cable types the legend swatches. */
const MAX_TYPES = 8

/** The speed tiers to key: those the map's cables fall in, in scale order -
 * or the whole scale when the map doesn't say. */
function speedTones(speeds?: readonly string[]): LegendItem[] {
  const present = speeds
    ? new Set(speeds.map((s) => speedTierOf(s)?.label))
    : null
  return SPEED_TIERS.filter((t) => !present || present.has(t.label)).map(
    (t) => ({ kind: "tone", label: t.label, color: t.hex })
  )
}

export interface LegendOptions {
  viewStyle: NodeStyle
  grouped: boolean
  colorMode: EdgeColorMode
  /** Cable types present on the map - swatched when coloring by type. */
  types?: string[]
  /** Cable speeds present on the map - their tiers are keyed when coloring
   * by speed. Absent: the whole scale. */
  speeds?: readonly string[]
  /** Diagram and Hierarchy: the roles on the map - each card (a
   * Hierarchy card's header) is filled with its role's colour. */
  roles?: { name: string; color?: string }[]
  /** Diagram and Hierarchy: some card shows the monitoring pill. */
  monitorPill?: boolean
  /** A map another page embeds (`graphLegend`): only the lines it draws,
   * with a trace's run and the patch panels it passes. */
  present?: LegendPresence
}

/** What an embedded map draws beyond plain cables. */
export interface LegendPresence {
  /** Cables at all: false on a map of tunnels only. Absent = yes. */
  cable?: boolean
  /** A tunnel map's links (tunnels/tunnel-graph.ts). */
  tunnel?: boolean
  bundle?: boolean
  via?: boolean
  ghost?: boolean
  bgp?: boolean
  /** A trace's run: its cables drawn thick in the accent colour. */
  traced?: boolean
  panel?: boolean
}

/** The legend options a map another page embeds (a device's Map tab, a
 * trace map) needs, read off its payload: the roles on it, whether a card
 * can show the monitoring pill, and the lines it draws. */
export function graphLegend(
  graph: TopologyGraph
): Required<Pick<LegendOptions, "roles" | "monitorPill" | "present">> {
  const roles = new Map<string, string | undefined>()
  for (const n of graph.nodes)
    if (n.data.role?.name && !roles.has(n.data.role.name))
      roles.set(n.data.role.name, n.data.role.color || undefined)
  const has = (test: (e: TopologyGraph["edges"][number]) => boolean) =>
    graph.edges.some(test)
  return {
    roles: [...roles]
      .map(([name, color]) => ({ name, color }))
      .sort((a, b) => naturalCompare(a.name, b.name)),
    monitorPill: !!graph.meta?.card?.uses_monitor,
    present: {
      cable: has((e) => (!e.type || e.type === "cable") && !e.data?.tunnel),
      tunnel: has((e) => !!e.data?.tunnel),
      bundle: has((e) => !!(e.data?.lag?.a && e.data.lag.b)),
      via: has((e) => !!e.data?.via?.length),
      ghost: has((e) => e.type === "ghost"),
      bgp: has((e) => e.type === "bgp"),
      traced: has((e) => !!e.data?.marked),
      panel: graph.nodes.some((n) => !!n.data.panel),
    },
  }
}

/** The legend's entries for a view, in order: only what is on screen. */
export function legendRows({
  viewStyle,
  grouped,
  colorMode,
  types = [],
  speeds,
  roles = [],
  monitorPill = false,
  present,
}: LegendOptions): LegendItem[] {
  const out: LegendItem[] = []
  // Every line row, or on an embedded map only those it draws.
  const shows = (k: keyof LegendPresence) => !present || !!present[k]
  if (grouped)
    out.push(
      { kind: "line", label: "Cables between groups", sem: "cable" },
      { kind: "box", label: "Site / location" }
    )
  else if (viewStyle === "diagram") {
    for (const r of roles)
      out.push({ kind: "role", label: r.name, color: r.color || undefined })
    if (monitorPill) out.push({ kind: "pill", label: "Monitoring" })
    if (present?.cable !== false)
      out.push({ kind: "line", label: "Cable", sem: "cable" })
    if (present?.tunnel)
      out.push({
        kind: "line",
        label: "Tunnel",
        width: 1.5,
        dash: TUNNEL_DASH,
        sem: "cable",
      })
    if (present?.traced)
      out.push({
        kind: "line",
        label: "Traced run",
        width: 2.5,
        color: "var(--map-accent)",
      })
    if (shows("bundle"))
      out.push({ kind: "line", label: "Bundle", width: 2.5, sem: "bundle" })
    if (shows("via"))
      out.push({ kind: "line", label: "Via patch panels", dash: "10 4" })
    if (shows("ghost"))
      out.push({
        kind: "line",
        label: "LLDP, no cable",
        dash: "6 4",
        width: 1.5,
        sem: "ghost",
      })
    if (shows("bgp"))
      out.push({
        kind: "line",
        label: "BGP session",
        dash: "3 5",
        width: 1.25,
        color: "var(--primary)",
        sem: "bgp",
      })
    if (present?.panel)
      out.push({ kind: "box", label: "Patch panel", dashed: true })
  } else {
    // The Hierarchy's headers are Diagram cards: the same role fills and
    // pill.
    if (viewStyle === "hierarchy") {
      for (const r of roles)
        out.push({ kind: "role", label: r.name, color: r.color || undefined })
      if (monitorPill) out.push({ kind: "pill", label: "Monitoring" })
    }
    out.push(
      { kind: "line", label: "Cable", sem: "cable" },
      {
        kind: "line",
        label: "LAG bundle",
        width: 2.5,
        sem: "bundle",
      },
      { kind: "line", label: "Via patch panels", dash: "10 4" },
      {
        kind: "line",
        label: "LLDP, no cable",
        dash: "6 4",
        width: 1.5,
        sem: "ghost",
      },
      {
        kind: "line",
        label: "BGP session",
        dash: "3 5",
        width: 1.25,
        color: "var(--primary)",
        sem: "bgp",
      },
      { kind: "box", label: "Patch panel", dashed: true }
    )
  }
  const tiers = colorMode === "speed" ? speedTones(speeds) : []
  if (colorMode === "type" && types.length > 0)
    for (const t of types.slice(0, MAX_TYPES))
      out.push({ kind: "tone", label: t, color: typeColor(t), mono: true })
  else if (tiers.length > 0) out.push(...tiers)
  // A type or speed legend with nothing to key says which mode it is.
  else if (COLOR_MODE_NOTE[colorMode])
    out.push({ kind: "note", label: COLOR_MODE_NOTE[colorMode] })
  return out
}

export function CanvasLegend({
  storageKey = KEY,
  defaultOpen = true,
  ...props
}: LegendOptions & {
  /** Where the open state is remembered: the map's legend and an embedded
   * map's are remembered apart. */
  storageKey?: string
  /** Open until the viewer closes it; an embedded map starts on the chip. */
  defaultOpen?: boolean
}) {
  return (
    <LegendFrame storageKey={storageKey} defaultOpen={defaultOpen}>
      {/* A tone colours the lines: its swatch is a line, as in the exports. */}
      <LegendItems rows={legendRows(props)} maxRoles={MAX_ROLES} />
    </LegendFrame>
  )
}
