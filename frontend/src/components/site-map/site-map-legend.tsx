import { Building2 } from "lucide-react"

import { TileBadge } from "@/components/floorplan/tile-badge"
import {
  LegendFrame,
  LegendLine,
  LegendPills,
  LegendRow,
  LegendTones,
} from "@/components/map-legend"
import { CheckStatusBadge } from "@/components/monitoring/status-badge"
import { KIND_COLOR, NO_VALUE_HEX } from "@/components/site-map/line-style"
import type { LineColorBy, LineKey } from "@/components/site-map/line-style"

/** The dash an un-routed cable is drawn with (`cable-geo-route.ts`). */
const UNROUTED_DASH = "5 4"

/** The words under the pins that say what the line colours mean - the
 * Display popover's Color by option. */
const COLOR_BY_NOTE: Record<Exclude<LineColorBy, "type">, string> = {
  status: "Color by status",
  speed: "Color by speed",
}

/**
 * The site map's key: its pins, clusters and lines, in the maps' shared
 * legend frame. Folded until opened, and remembered per browser. The line
 * rows follow Color by: the kinds' colours, the statuses on the lines as
 * their pills, or the speed tiers on the lines.
 */
export function SiteMapLegend({
  colorBy = "type",
  lines,
}: {
  colorBy?: LineColorBy
  /** What the drawn lines carry - keyed under Status and Speed. */
  lines?: LineKey
}) {
  const neutral = colorBy !== "type"
  const tones =
    colorBy === "speed" && lines
      ? [
          ...lines.tiers.map((t) => ({ label: t.label, color: t.hex })),
          ...(lines.unknown ? [{ label: "Unknown", color: NO_VALUE_HEX }] : []),
        ]
      : []
  return (
    <LegendFrame
      storageKey="site-map:legend"
      defaultOpen={false}
      className="w-fit max-w-64"
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
        {colorBy === "type" && (
          <>
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
          </>
        )}
        {neutral && (
          <div data-slot="line-key" className="grid gap-1 pt-0.5">
            <span className="text-muted-foreground/70">
              {COLOR_BY_NOTE[colorBy]}
            </span>
            {colorBy === "status" && lines && (
              <>
                {/* A status is its pill, here as on the line's popover. */}
                <LegendPills items={lines.statuses} className="pb-0" />
                {lines.noStatus && (
                  <LegendRow
                    swatch={<LegendLine color={NO_VALUE_HEX} length={24} />}
                    label="No status"
                  />
                )}
              </>
            )}
            {colorBy === "speed" && (
              <LegendTones
                tones={tones}
                className="max-w-56 pt-0 whitespace-normal"
              />
            )}
          </div>
        )}
        <LegendRow
          swatch={
            <LegendLine
              color={neutral ? undefined : KIND_COLOR.cable}
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
