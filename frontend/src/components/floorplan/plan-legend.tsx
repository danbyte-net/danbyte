import { Children } from "react"
import type { ReactNode } from "react"

import { LegendFrame } from "@/components/map-legend"

/** A legend's rows without a frame of their own: a section of the plan's
 * one legend card. Takes LegendFrame's props so a legend can swap one for
 * the other. */
export function BareFrame({
  children,
}: {
  hideable?: boolean
  className?: string
  children: ReactNode
}) {
  return <div data-legend-section="">{children}</div>
}

/**
 * The 2D plan's legend: one card in the corner for the Color by key, the
 * cables' key and the area types, each a section under a rule, so the keys
 * never stack as separate boxes over the plan. Folds to a *Legend* chip,
 * remembered per browser; the PNG export carries the open card without
 * its Hide button.
 */
export function PlanLegend({ children }: { children: ReactNode }) {
  const sections = Children.toArray(children).filter(Boolean)
  if (!sections.length) return null
  return (
    <div className="pointer-events-auto">
      <LegendFrame
        storageKey="danbyte:floorplan-legend"
        className="w-fit max-w-80"
      >
        <div className="divide-y divide-border [&>*]:py-1.5 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">
          {sections}
        </div>
      </LegendFrame>
    </div>
  )
}
