import { LegendFrame, LegendItems, LegendLine } from "@/components/map-legend"
import type { LegendItem } from "@/components/map-legend"
import { RAIL } from "@/lib/diagram/rails"
import { cn } from "@/lib/utils"

// The rail diagram's legend: the maps' legend frame in the canvas corner,
// folding to a Legend chip, open or closed as the topology legend is (one
// choice per browser). It lists the roles on the cards as their badges,
// then the rail, the card kinds and the legs, each keyed as the rail
// diagram draws it. The exports print the same list (to-document
// `printLegend` keeps the roles and the lines).

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

/** A rail-diagram row's key: a rail as a bar, a card as the muted box the
 * diagram draws, a leg as its line (dashed legs with square ends). */
function railSwatch(item: LegendItem) {
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
    <LegendLine
      color={item.color ?? KEY_COLOR}
      width={w}
      dash={item.dash}
      cap={item.dash ? "butt" : "round"}
    />
  )
}

export function RailLegend({ rows }: { rows: readonly LegendItem[] }) {
  return (
    <LegendFrame storageKey={KEY}>
      <LegendItems
        // Only the roles, the lines and the boxes: a rail map has no
        // colour modes.
        rows={rows.filter(
          (r) => r.kind === "role" || r.kind === "line" || r.kind === "box"
        )}
        swatch={railSwatch}
      />
    </LegendFrame>
  )
}
