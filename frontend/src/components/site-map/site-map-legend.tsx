import { Building2 } from "lucide-react"

import { TileBadge } from "@/components/floorplan/tile-badge"
import { LegendFrame, LegendLine, LegendRow } from "@/components/map-legend"
import { CheckStatusBadge } from "@/components/monitoring/status-badge"
import { KIND_COLOR } from "@/components/site-map/connections-layer"

/** The dash an un-routed cable is drawn with (`cable-geo-route.ts`). */
const UNROUTED_DASH = "5 4"

/**
 * The site map's key: its pins, clusters and lines, in the maps' shared
 * legend frame. Folded until opened, and remembered per browser.
 */
export function SiteMapLegend() {
  return (
    <LegendFrame
      storageKey="site-map:legend"
      defaultOpen={false}
      className="w-fit"
    >
      <div className="grid gap-1.5 whitespace-nowrap text-muted-foreground">
        <LegendRow
          swatch={
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full border-2 border-background bg-primary text-primary-foreground shadow-[0_0_0_1px_var(--border)]">
              <Building2 className="size-3" />
            </span>
          }
          label="Site"
        />
        <LegendRow
          swatch={<TileBadge color="#8b5cf6" />}
          label="Device / marker"
        />
        <LegendRow
          swatch={
            <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full border-2 border-primary bg-background px-1 text-[10px] font-semibold text-foreground shadow-[0_0_0_1px_var(--border)]">
              5
            </span>
          }
          label="Cluster"
        />
        {/* A pin wears its monitoring state as its ring, in the tenant's
            names for the states. */}
        <span className="flex items-center gap-1">
          {(["up", "degraded", "down"] as const).map((c) => (
            <CheckStatusBadge
              key={c}
              status={c}
              className="h-4 px-[7px] text-[9px]"
            />
          ))}
        </span>
        <LegendRow
          swatch={<LegendLine color={KIND_COLOR.circuit} length={24} />}
          label="Circuit"
        />
        <LegendRow
          swatch={<LegendLine color={KIND_COLOR.tunnel} length={24} />}
          label="Tunnel"
        />
        <LegendRow
          swatch={<LegendLine color={KIND_COLOR.cable} length={24} />}
          label="Cable"
        />
        <LegendRow
          swatch={
            <LegendLine
              color={KIND_COLOR.cable}
              dash={UNROUTED_DASH}
              length={24}
            />
          }
          label="Cable without a drawn route"
        />
      </div>
    </LegendFrame>
  )
}
