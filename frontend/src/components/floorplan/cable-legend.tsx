import {
  LegendFrame,
  LegendLine,
  LegendRow,
  LegendStatuses,
  LegendTones,
} from "@/components/map-legend"
import type { StatusMini } from "@/lib/api"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

import { BareFrame } from "./plan-legend"
import { CABLE_LINE, CABLE_NONE, bundleWidth } from "./cable-draw"
import type { CableCounts, CableLegend as CableLegendData } from "./cable-draw"

/**
 * The key to the plan's cables, beside the Color by legend and inside the
 * export area: their colours under **Color cables by** - statuses as their
 * pills, types and jacket colours as short lines - then the line styles in
 * use and, when any run is bundled, the bundle. Under them, how many of the
 * plan's cables are drawn, have one end here (stubs) and have no end here;
 * a click on the middle figure (`onPlaceFar`) offers their far ends to
 * place.
 */
export function CableLegend({
  legend,
  counts,
  onPlaceFar,
  bare = false,
}: {
  legend: CableLegendData
  counts?: CableCounts
  onPlaceFar?: () => void
  /** Its rows only, for the plan's one legend card (plan-legend.tsx). */
  bare?: boolean
}) {
  const Frame = bare ? BareFrame : LegendFrame
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
    <Frame hideable={false} className="w-fit max-w-80">
      <p className="pb-1 font-medium whitespace-nowrap">{legend.title}</p>
      {legend.colors.length === 0 ? null : byStatus ? (
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
                // At the line's own strength, so Inferred keys as the
                // fainter line it is; Out of date with the amber mark its
                // moved end wears on the plan.
                <span
                  className="relative flex shrink-0"
                  style={{ opacity: CABLE_LINE[s].opacity }}
                >
                  <LegendLine
                    color={CABLE_NONE}
                    width={CABLE_LINE[s].width}
                    dash={CABLE_LINE[s].dash}
                    cap={CABLE_LINE[s].cap}
                  />
                  {s === "stale" && (
                    <span
                      aria-hidden
                      data-part="stale-mark"
                      className="absolute top-1/2 right-0 size-2 -translate-y-1/2 rounded-full bg-amber-500 ring-2 ring-background"
                    />
                  )}
                </span>
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
      {counts && <CableCountsRow counts={counts} onPlaceFar={onPlaceFar} />}
    </Frame>
  )
}

/** "N drawn · M with one end here · K not placed", with a hint on what
 * draws a cable. */
function CableCountsRow({
  counts,
  onPlaceFar,
}: {
  counts: CableCounts
  onPlaceFar?: () => void
}) {
  const oneEnd = `${counts.oneEnd} with one end here`
  return (
    <div
      data-cable-counts
      className="pointer-events-auto mt-1.5 flex items-center gap-1 border-t border-border pt-1.5 whitespace-nowrap text-muted-foreground"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <span tabIndex={0}>{counts.drawn} drawn</span>
        </TooltipTrigger>
        <TooltipContent variant="panel" className="max-w-64">
          A cable draws as a run when both its ends are placed on this plan.
          With one end here it draws as a stub pointing off the plan.
        </TooltipContent>
      </Tooltip>
      <span>·</span>
      {onPlaceFar && counts.oneEnd > 0 ? (
        <button
          type="button"
          className="underline decoration-dotted underline-offset-2 hover:text-foreground"
          onClick={onPlaceFar}
        >
          {oneEnd}
        </button>
      ) : (
        <span>{oneEnd}</span>
      )}
      <span>·</span>
      <span>{counts.notPlaced} not placed</span>
    </div>
  )
}
