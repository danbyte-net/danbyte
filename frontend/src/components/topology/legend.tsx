import { useState } from "react"
import { List, X } from "lucide-react"

import { ColorBadge } from "@/components/cells/color-badge"
import { CheckStatusBadge } from "@/components/monitoring/status-badge"
import { SectionLabel } from "@/components/map-panel"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { TopologyGraph } from "@/lib/api"
import { TUNNEL_DASH, typeColor } from "./edge-style"
import type { EdgeColorMode, NodeStyle } from "./topology-canvas"

// Line-key legend for the topology views. Collapsible, remembered per
// browser, and its rows adapt to the active view + color mode so it only
// explains lines that are actually on screen.

const KEY = "topology:legend"

function Line({
  dash,
  width = 2,
  color = "var(--muted-foreground)",
  length = 26,
}: {
  dash?: string
  width?: number
  color?: string
  length?: number
}) {
  return (
    <svg width={length} height="10" className="shrink-0">
      <line
        x1="1"
        y1="5"
        x2={length - 1}
        y2="5"
        stroke={color}
        strokeWidth={width}
        strokeDasharray={dash}
        strokeLinecap="round"
      />
    </svg>
  )
}

function RowItem({
  swatch,
  label,
}: {
  swatch: React.ReactNode
  label: string
}) {
  return (
    <div className="flex items-center gap-2">
      {swatch}
      <span className="min-w-0">{label}</span>
    </div>
  )
}

// One terse line per mode - the docs explain, the legend just labels. The
// words are the Display popover's Color by options.
const COLOR_MODE_NOTE: Record<EdgeColorMode, string> = {
  cable: "Color by cable",
  type: "Color by type",
  status: "Color by status",
  speed: "",
  none: "",
}

const SPEED_TIERS: [string, string][] = [
  ["#10b981", "1G"],
  ["#0ea5e9", "10G"],
  ["#8b5cf6", "25G"],
  ["#f59e0b", "40G"],
  ["#e11d48", "100G"],
]

/** The most role fills the Diagram legend lists; the rest are on the map. */
const MAX_ROLES = 12
/** The most cable types the legend swatches. */
const MAX_TYPES = 8

/** One legend entry. The canvas legend draws these, and the exports turn
 * them into their own legend rows (to-document.ts `printLegend`). */
export type LegendItem =
  /** A Diagram card fill: the role's colour. */
  | { kind: "role"; label: string; color?: string }
  /** The monitoring pill a card shows while down. */
  | { kind: "pill"; label: string }
  /** A line style. `sem` names the edge kind when the look is that kind's
   * own (the exports draw it with their print colours). */
  | {
      kind: "line"
      label: string
      width?: number
      dash?: string
      color?: string
      sem?: "cable" | "bundle" | "ghost" | "bgp"
    }
  /** A box: a site/location card, or a patch panel's dashed outline. */
  | { kind: "box"; label: string; dashed?: boolean }
  /** A color-mode swatch: a cable type or a speed tier. */
  | { kind: "tone"; label: string; color: string; mono?: boolean }
  /** A color-mode note. */
  | { kind: "note"; label: string }

export interface LegendOptions {
  viewStyle: NodeStyle
  grouped: boolean
  colorMode: EdgeColorMode
  /** Cable types present on the map - swatched when coloring by type. */
  types?: string[]
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
      .sort((a, b) => a.name.localeCompare(b.name)),
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
        color: "var(--primary)",
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
  if (colorMode === "type" && types.length > 0)
    for (const t of types.slice(0, MAX_TYPES))
      out.push({ kind: "tone", label: t, color: typeColor(t), mono: true })
  else if (colorMode === "speed")
    for (const [color, label] of SPEED_TIERS)
      out.push({ kind: "tone", label, color })
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
  const [open, setOpen] = useState(() => {
    try {
      const v = localStorage.getItem(storageKey)
      return v ? v !== "closed" : defaultOpen
    } catch {
      return defaultOpen
    }
  })
  const toggle = (v: boolean) => {
    setOpen(v)
    try {
      localStorage.setItem(storageKey, v ? "open" : "closed")
    } catch {
      /* private window or blocked storage: the choice lasts this visit */
    }
  }

  // A chip on the canvas: bordered, no shadow (shadows are for overlays).
  if (!open)
    return (
      <Button
        variant="outline"
        size="xs"
        onClick={() => toggle(true)}
        className="bg-background/95 text-muted-foreground shadow-none"
      >
        <List /> Legend
      </Button>
    )

  const items = legendRows(props)
  const roles = items.filter((i) => i.kind === "role").slice(0, MAX_ROLES)
  const tones = items.filter((i) => i.kind === "tone")
  const note = items.find((i) => i.kind === "note")
  return (
    <div className="w-60 rounded-md border border-border bg-background/95 p-2.5 pt-1.5 text-[11px]">
      <div className="mb-1 flex items-center justify-between">
        <SectionLabel className="mb-0">Legend</SectionLabel>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="-mr-1.5"
              aria-label="Hide legend"
              onClick={() => toggle(false)}
            >
              <X />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" variant="default">
            Hide legend
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="space-y-1">
        {roles.length > 0 && (
          <div className="flex flex-wrap gap-1 pb-1">
            {roles.map((r) => (
              <ColorBadge
                key={r.label}
                name={r.label}
                color={r.color}
                className="h-4 px-1.5 text-[10px]"
              />
            ))}
          </div>
        )}
        {items.map((r, i) =>
          r.kind === "pill" ? (
            <RowItem
              key={i}
              swatch={
                <CheckStatusBadge
                  status="down"
                  className="h-4 px-[7px] text-[9px]"
                />
              }
              label={r.label}
            />
          ) : r.kind === "line" ? (
            <RowItem
              key={i}
              swatch={<Line dash={r.dash} width={r.width} color={r.color} />}
              label={r.label}
            />
          ) : r.kind === "box" ? (
            <RowItem
              key={i}
              swatch={
                r.dashed ? (
                  <span className="h-3 w-6 shrink-0 rounded-sm border border-dashed border-muted-foreground/60 bg-card" />
                ) : (
                  <span className="h-3 w-6 shrink-0 rounded-sm border-2 border-border bg-card" />
                )
              }
              label={r.label}
            />
          ) : null
        )}
        {tones.length > 0 ? (
          <div
            className={
              props.colorMode === "speed"
                ? "flex items-center gap-2 pt-1"
                : "flex flex-wrap items-center gap-x-2 gap-y-0.5 pt-1"
            }
          >
            {tones.map((t) => (
              // A tone colours the lines: its swatch is a line, as in
              // the exports.
              <span key={t.label} className="flex items-center gap-1">
                <Line color={t.color} width={2.5} length={14} />
                <span
                  className={
                    t.mono
                      ? "font-mono text-muted-foreground"
                      : "text-muted-foreground"
                  }
                >
                  {t.label}
                </span>
              </span>
            ))}
          </div>
        ) : note ? (
          <p className="pt-1 text-muted-foreground">{note.label}</p>
        ) : null}
      </div>
    </div>
  )
}

/** Inline legend under the Logical (VLAN-rail) diagram. */
export function LogicalLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
      <RowItem
        swatch={<span className="h-2.5 w-6 shrink-0 rounded-sm bg-[#1d63ed]" />}
        label="VLAN"
      />
      <RowItem
        swatch={
          <span className="h-3 w-6 shrink-0 rounded-sm border border-border bg-card" />
        }
        label="Device"
      />
      <RowItem
        swatch={
          <span className="h-3 w-6 shrink-0 rounded-sm border border-dashed border-muted-foreground/60 bg-card" />
        }
        label="VM"
      />
      <RowItem swatch={<Line width={3} color="#1d63ed" />} label="Untagged" />
      <RowItem
        swatch={<Line dash="5 5" width={3} color="#1d63ed" />}
        label="Tagged"
      />
    </div>
  )
}
