import { useState } from "react"
import { Info, X } from "lucide-react"

import type { EdgeColorMode, NodeStyle } from "./topology-canvas"

// Line-key legend for the topology views. Collapsible, remembered per
// browser, and its rows adapt to the active view + color mode so it only
// explains lines that are actually on screen.

const KEY = "topology:legend"

function Line({
  dash,
  width = 2,
  color = "var(--muted-foreground)",
}: {
  dash?: string
  width?: number
  color?: string
}) {
  return (
    <svg width="26" height="10" className="shrink-0">
      <line
        x1="1"
        y1="5"
        x2="25"
        y2="5"
        stroke={color}
        strokeWidth={width}
        strokeDasharray={dash}
        strokeLinecap="round"
      />
    </svg>
  )
}

function RowItem({ swatch, label }: { swatch: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-2">
      {swatch}
      <span className="min-w-0">{label}</span>
    </div>
  )
}

const COLOR_MODE_NOTE: Record<EdgeColorMode, string> = {
  cable: "Line color = the cable's recorded color",
  type: "Line color = media type (stable hue per type)",
  status: "Line color = status (green up · amber planned · red failed)",
  speed:
    "Line color = link speed (green 1G · blue 10G · violet 25G · amber 40G · red 100G+), labelled with the speed",
  none: "Lines uncolored",
}

export function CanvasLegend({
  viewStyle,
  grouped,
  colorMode,
}: {
  viewStyle: NodeStyle
  grouped: boolean
  colorMode: EdgeColorMode
}) {
  const [open, setOpen] = useState(
    () => localStorage.getItem(KEY) !== "closed"
  )
  const toggle = (v: boolean) => {
    setOpen(v)
    localStorage.setItem(KEY, v ? "open" : "closed")
  }

  if (!open)
    return (
      <button
        type="button"
        onClick={() => toggle(true)}
        className="flex items-center gap-1.5 rounded-md border border-border bg-card/95 px-2 py-1 text-[11px] text-muted-foreground shadow-sm backdrop-blur hover:text-foreground"
      >
        <Info className="h-3 w-3" /> Legend
      </button>
    )

  return (
    <div className="w-60 rounded-md border border-border bg-card/95 p-2.5 text-[11px] shadow-sm backdrop-blur">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="font-semibold tracking-wide text-muted-foreground uppercase">
          Legend
        </span>
        <button
          type="button"
          onClick={() => toggle(false)}
          className="text-muted-foreground hover:text-foreground"
          aria-label="Hide legend"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
      <div className="space-y-1">
        {grouped ? (
          <>
            <RowItem swatch={<Line />} label="Cables between groups (×count)" />
            <RowItem
              swatch={
                <span className="h-3 w-6 shrink-0 rounded-sm border-2 border-border bg-card" />
              }
              label="Site/location — double-click to open"
            />
          </>
        ) : viewStyle === "flat" ? (
          <>
            <RowItem
              swatch={<Line />}
              label="Cable bundle — ×N parallel cables, click to list"
            />
            <RowItem
              swatch={<Line dash="6 4" width={1.5} />}
              label="LLDP-seen link, no cable — click to create"
            />
          </>
        ) : (
          <>
            <RowItem swatch={<Line />} label="Cable (×N = N port pairs)" />
            <RowItem
              swatch={<Line dash="10 4" />}
              label="End-to-end run via patch panels"
            />
            <RowItem
              swatch={<Line dash="6 4" width={1.5} />}
              label="LLDP-seen link, no cable — click to create"
            />
            <RowItem
              swatch={
                <span className="h-3 w-6 shrink-0 rounded-sm border border-dashed border-muted-foreground/60 bg-card" />
              }
              label="Patch panel (dashed card)"
            />
          </>
        )}
        <p className="pt-1 text-muted-foreground">
          {COLOR_MODE_NOTE[colorMode]}. Hover a line to name the cable, raise
          it, and fade the rest.
        </p>
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
        label="VLAN rail (VLAN or zone color)"
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
        label="Virtual machine"
      />
      <RowItem
        swatch={<Line width={3} color="#1d63ed" />}
        label="Untagged / access"
      />
      <RowItem
        swatch={<Line dash="5 5" width={3} color="#1d63ed" />}
        label="Tagged (trunk)"
      />
      <span>Click any rail or box to open it.</span>
    </div>
  )
}
