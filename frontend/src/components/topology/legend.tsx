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

// One terse line per mode - the docs explain, the legend just labels.
const COLOR_MODE_NOTE: Record<EdgeColorMode, string> = {
  cable: "Color: cable",
  type: "Color: media type",
  status: "Color: status",
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
            <RowItem swatch={<Line />} label="Cables between groups" />
            <RowItem
              swatch={
                <span className="h-3 w-6 shrink-0 rounded-sm border-2 border-border bg-card" />
              }
              label="Site / location"
            />
          </>
        ) : viewStyle === "flat" ? (
          <>
            <RowItem swatch={<Line />} label="Cable bundle (×N)" />
            <RowItem
              swatch={<Line dash="6 4" width={1.5} />}
              label="LLDP, no cable"
            />
          </>
        ) : (
          <>
            <RowItem swatch={<Line />} label="Cable" />
            <RowItem swatch={<Line dash="10 4" />} label="Via patch panels" />
            <RowItem
              swatch={<Line dash="6 4" width={1.5} />}
              label="LLDP, no cable"
            />
            <RowItem
              swatch={
                <span className="h-3 w-6 shrink-0 rounded-sm border border-dashed border-muted-foreground/60 bg-card" />
              }
              label="Patch panel"
            />
          </>
        )}
        {colorMode === "speed" ? (
          <div className="flex items-center gap-2 pt-1">
            {SPEED_TIERS.map(([c, l]) => (
              <span key={l} className="flex items-center gap-1">
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ background: c }}
                />
                <span className="text-muted-foreground">{l}</span>
              </span>
            ))}
          </div>
        ) : COLOR_MODE_NOTE[colorMode] ? (
          <p className="pt-1 text-muted-foreground">
            {COLOR_MODE_NOTE[colorMode]}
          </p>
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
