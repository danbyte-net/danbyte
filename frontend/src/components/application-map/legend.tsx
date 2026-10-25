import { MoveHorizontal, MoveRight } from "lucide-react"

import { SectionLabel } from "@/components/map-panel"
import {
  LegendFrame,
  LegendLine,
  LegendRow,
  LegendStatuses,
  legendSwatch,
} from "@/components/map-legend"
import type { LegendItem } from "@/components/map-legend"
import type { ApplicationFlow, StatusMini } from "@/lib/api"
import { cssColor } from "@/lib/utils"

import type { AppMapView } from "./model"

// The Application map's legend (#163): what the cards are, what the lines
// mean - parent to child and installed on in the Tree; in Flows, a line's
// colour is its flows' status (keyed by the statuses' own pills), dashed
// while planned, faded once retired, arrowed the way the traffic runs, and
// labelled with its protocols and ports. The exports get the same rows
// they can draw (`legendItems`).

const DASH_PLANNED = "6 4"
const DASH_INSTALL = "4 3"

/** The statuses on the map's flows, once each, in the catalog's order of
 * first appearance. */
export function flowStatuses(flows: readonly ApplicationFlow[]): StatusMini[] {
  const seen = new Map<string, StatusMini>()
  for (const f of flows) if (f.status) seen.set(f.status.id, f.status)
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** The legend rows the exports draw. */
export function legendItems(
  view: AppMapView,
  flows: readonly ApplicationFlow[]
): LegendItem[] {
  if (view === "tree")
    return [
      { kind: "line", label: "Parent to child", width: 1.5 },
      { kind: "line", label: "Installed on", width: 1, dash: DASH_INSTALL },
    ]
  return [
    ...flowStatuses(flows).map((s): LegendItem => ({
      kind: "line",
      label: s.name,
      width: 1.5,
      color: cssColor(s.color),
    })),
    { kind: "line", label: "Planned", width: 1.5, dash: DASH_PLANNED },
  ]
}

export function AppMapLegend({
  view,
  flows,
  storageKey = "app-map:legend",
  defaultOpen = true,
}: {
  view: AppMapView
  flows: readonly ApplicationFlow[]
  storageKey?: string
  defaultOpen?: boolean
}) {
  const box = (label: string, dashed = false) => (
    <LegendRow
      swatch={legendSwatch({ kind: "box", label, dashed })}
      label={label}
    />
  )
  return (
    <LegendFrame storageKey={storageKey} defaultOpen={defaultOpen}>
      <div className="space-y-1">
        {view === "tree" ? (
          <>
            {box("Application, device")}
            {box("Virtual machine", true)}
            <LegendRow
              swatch={<LegendLine width={1.5} />}
              label="Parent to child"
            />
            <LegendRow
              swatch={<LegendLine width={1} dash={DASH_INSTALL} />}
              label="Installed on"
            />
            <p className="pt-1 text-muted-foreground">
              Card colour: the first coloured tag
            </p>
          </>
        ) : (
          <>
            {box("Address, range, prefix, Any")}
            {box("VM address", true)}
            <SectionLabel className="mt-2">Line by status</SectionLabel>
            <LegendStatuses statuses={flowStatuses(flows)} />
            <LegendRow
              swatch={<LegendLine width={1.5} dash={DASH_PLANNED} />}
              label="Planned"
            />
            <LegendRow
              swatch={
                <span className="opacity-45">
                  <LegendLine width={1.5} />
                </span>
              }
              label="Retired"
            />
            <LegendRow
              swatch={<MoveRight className="size-4 w-[26px] shrink-0" />}
              label="One way"
            />
            <LegendRow
              swatch={<MoveHorizontal className="size-4 w-[26px] shrink-0" />}
              label="Both ways"
            />
            <LegendRow
              swatch={
                <span className="w-[26px] shrink-0 text-center">
                  <span className="rounded-[5px] border border-border bg-background px-1 text-[9px]">
                    TCP
                  </span>
                </span>
              }
              label="Protocol and ports"
            />
          </>
        )}
      </div>
    </LegendFrame>
  )
}
