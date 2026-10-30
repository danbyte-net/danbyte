import {
  LegendFrame,
  LegendLine,
  LegendRow,
  LegendStatuses,
  LegendTones,
} from "@/components/map-legend"
import type { StatusMini } from "@/lib/api"

import { CABLE_LINE, CABLE_NONE, bundleWidth } from "./cable-draw"
import type { CableLegend as CableLegendData } from "./cable-draw"

/**
 * The key to the plan's cables, beside the Color by legend and inside the
 * export area: their colours under **Color cables by** - statuses as their
 * pills, types and jacket colours as short lines - then the line styles in
 * use and, when any run is bundled, the bundle.
 */
export function CableLegend({ legend }: { legend: CableLegendData }) {
  const statuses = legend.colors.map((c) =>
    c.status
      ? c.status
      : ({
          id: `__${c.label}`,
          name: c.label,
          color: "",
          text_color: "",
        } satisfies StatusMini)
  )
  const byStatus = legend.mode === "status"
  return (
    <LegendFrame hideable={false} className="w-fit max-w-64">
      <p className="pb-1 font-medium whitespace-nowrap">{legend.title}</p>
      {byStatus ? (
        <LegendStatuses className="pb-0" statuses={statuses} />
      ) : (
        <LegendTones
          className="pt-0"
          tones={legend.colors.map((c) => ({
            label: c.label,
            color: c.color,
            mono: c.color === c.label,
          }))}
        />
      )}
      {(legend.states.length > 0 || legend.bundles) && (
        <div className="mt-1.5 space-y-0.5 border-t border-border pt-1.5">
          {legend.states.map((s) => (
            <LegendRow
              key={s}
              swatch={
                <LegendLine
                  color={CABLE_NONE}
                  width={CABLE_LINE[s].width}
                  dash={CABLE_LINE[s].dash}
                  cap={CABLE_LINE[s].cap}
                />
              }
              label={
                <span className="whitespace-nowrap">{CABLE_LINE[s].label}</span>
              }
            />
          ))}
          {legend.bundles && (
            <LegendRow
              swatch={<LegendLine color={CABLE_NONE} width={bundleWidth(4)} />}
              label={<span className="whitespace-nowrap">Bundle · count</span>}
            />
          )}
        </div>
      )}
    </LegendFrame>
  )
}
