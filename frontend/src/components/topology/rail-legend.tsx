import { useState } from "react"
import { List, X } from "lucide-react"

import { ColorBadge } from "@/components/cells/color-badge"
import { SectionLabel } from "@/components/map-panel"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { RAIL } from "@/lib/diagram/rails"
import { cn } from "@/lib/utils"
import type { LegendItem } from "./legend"

// The rail diagram's legend: the topology legend's panel in the canvas
// corner, folding to a Legend chip, open or closed as the topology legend
// is (one choice per browser). It lists the roles on the cards as their
// badges, then the rail, the card kinds and the legs. The exports print the
// same list (to-document `printLegend` keeps the roles and the lines).

const KEY = "topology:legend"

/** The rails' and legs' key color: the shape is the point, not the hue. */
const KEY_COLOR = "var(--muted-foreground)"

/** A rail's key: a line this wide or wider reads as a rail. */
const BAR_W = 8

export type RailLegendKind = "logical" | "virtual"

/** The legend's entries for a rail diagram, in order. */
export function railLegendRows(
  kind: RailLegendKind,
  opts: {
    roles?: readonly { name: string; color?: string }[]
    /** Virtual: some switch shows its host NICs. */
    adapters?: boolean
  } = {}
): LegendItem[] {
  const out: LegendItem[] = (opts.roles ?? []).map((r) => ({
    kind: "role",
    label: r.name,
    ...(r.color ? { color: r.color } : {}),
  }))
  if (kind === "logical")
    out.push(
      { kind: "line", label: "VLAN", width: BAR_W, color: KEY_COLOR },
      { kind: "box", label: "Device" },
      { kind: "box", label: "VM", dashed: true },
      { kind: "line", label: "Untagged", width: RAIL.LEG_W, color: KEY_COLOR },
      {
        kind: "line",
        label: "Tagged",
        width: RAIL.LEG_W,
        dash: RAIL.DASH,
        color: KEY_COLOR,
      }
    )
  else {
    out.push(
      { kind: "line", label: "Network", width: BAR_W, color: KEY_COLOR },
      { kind: "box", label: "VM", dashed: true }
    )
    if (opts.adapters) out.push({ kind: "box", label: "Host NIC" })
  }
  return out
}

function Swatch({ item }: { item: LegendItem }) {
  if (item.kind === "box")
    return (
      <span
        className={cn(
          "h-3 w-6 shrink-0 rounded-sm border bg-muted",
          item.dashed
            ? "border-dashed border-muted-foreground/60"
            : "border-border"
        )}
      />
    )
  if (item.kind !== "line") return null
  const w = item.width ?? 2
  if (w >= BAR_W)
    return (
      <span
        className="h-2.5 w-6 shrink-0 rounded-sm"
        style={{ backgroundColor: item.color }}
      />
    )
  return (
    <svg width="26" height="10" className="shrink-0">
      <line
        x1="1"
        y1="5"
        x2="25"
        y2="5"
        stroke={item.color ?? KEY_COLOR}
        strokeWidth={w}
        strokeDasharray={item.dash}
        strokeLinecap={item.dash ? "butt" : "round"}
      />
    </svg>
  )
}

function readOpen(): boolean {
  try {
    return localStorage.getItem(KEY) !== "closed"
  } catch {
    return true
  }
}

export function RailLegend({ rows }: { rows: readonly LegendItem[] }) {
  const [open, setOpen] = useState(readOpen)
  const toggle = (v: boolean) => {
    setOpen(v)
    try {
      localStorage.setItem(KEY, v ? "open" : "closed")
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
        className="bg-background text-muted-foreground shadow-none"
      >
        <List /> Legend
      </Button>
    )

  const roles = rows.filter(
    (r): r is Extract<LegendItem, { kind: "role" }> => r.kind === "role"
  )
  return (
    <div className="w-60 rounded-md border border-border bg-background p-2.5 pt-1.5 text-[11px]">
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
        {rows
          .filter((r) => r.kind === "line" || r.kind === "box")
          .map((r) => (
            <div key={r.label} className="flex items-center gap-2">
              <Swatch item={r} />
              <span className="min-w-0">{r.label}</span>
            </div>
          ))}
      </div>
    </div>
  )
}
