import { useState } from "react"
import type { ReactNode } from "react"
import { Move, Pencil } from "lucide-react"

import type {
  Cabinet,
  CabinetSizes,
  Device,
  DinRail,
  DinRailKey,
} from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import {
  ArrangeActions,
  ArrangePlate,
  useArrangement,
} from "@/components/cabinet-arrange"
import { CabinetDeviceBodies } from "@/components/cabinet-devices"
import { CabinetElevation } from "@/components/cabinet-elevation"
import { DinRailEditor } from "@/components/din-rail-editor"

/** The mounting plate on a cabinet's or a cabinet type's Overview: drawn to
 * scale with its rails - and a cabinet's devices on them - plus "Edit rails"
 * for whoever may change the parent. On a cabinet, **Arrange** lets whoever
 * may change devices move them about on the plate and save the lot. */
export function CabinetPlateSection({
  sizes,
  rails,
  endpoint,
  railKey,
  editTitle,
  canEdit,
  devices,
  cabinet,
  actions,
}: {
  sizes: CabinetSizes
  rails: DinRail[]
  /** The parent's detail endpoint, which the editor PATCHes. */
  endpoint: string
  railKey: DinRailKey
  /** The editor's title, naming the parent. */
  editTitle: string
  canEdit: boolean
  /** A cabinet's devices, drawn on their rails. */
  devices?: Device[]
  /** The cabinet itself, whose devices Arrange moves. */
  cabinet?: Cabinet
  /** More of the heading's controls, before Edit rails. */
  actions?: ReactNode
}) {
  const [editing, setEditing] = useState(false)
  const { canDo } = useMe()
  const arrangement = useArrangement(cabinet, devices)
  const arranging = arrangement.on && !!cabinet
  const canArrange =
    !!cabinet && cabinet.rails.length > 0 && canDo("device", "change")
  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-[11px] font-semibold tracking-wide text-foreground uppercase">
          Plate
        </h2>
        <div className="flex items-center gap-1">
          {arranging ? (
            <ArrangeActions arrangement={arrangement} />
          ) : (
            <>
              {actions}
              {canArrange && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="-my-1 h-6 px-2 text-xs"
                  onClick={arrangement.start}
                >
                  <Move className="h-3 w-3" /> Arrange
                </Button>
              )}
              {canEdit && (
                <Button
                  size="sm"
                  variant="ghost"
                  // Kept to the heading's line, so this card's top lines up
                  // with the cards beside it.
                  className="-my-1 h-6 px-2 text-xs"
                  onClick={() => setEditing(true)}
                >
                  <Pencil className="h-3 w-3" /> Edit rails
                </Button>
              )}
            </>
          )}
        </div>
      </div>
      <div className="rounded-lg border border-border bg-card p-4">
        {arranging ? (
          <ArrangePlate cabinet={cabinet} arrangement={arrangement} />
        ) : (
          <CabinetElevation
            width={sizes.inner_width_mm}
            height={sizes.inner_height_mm}
            outerWidth={sizes.outer_width_mm}
            outerHeight={sizes.outer_height_mm}
            rails={rails.map((r) => ({ key: r.id, ...r }))}
            emptyText="No rails yet."
            railLabels={!devices?.length}
          >
            {devices && devices.length > 0 && (
              <CabinetDeviceBodies rails={rails} devices={devices} />
            )}
          </CabinetElevation>
        )}
      </div>
      {canEdit && (
        <DinRailEditor
          open={editing}
          onOpenChange={setEditing}
          endpoint={endpoint}
          railKey={railKey}
          title={editTitle}
          sizes={sizes}
          rails={rails}
        />
      )}
    </section>
  )
}
