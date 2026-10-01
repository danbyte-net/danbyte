import { useState } from "react"
import { Pencil } from "lucide-react"

import type { CabinetSizes, DinRail, DinRailKey } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { CabinetElevation } from "@/components/cabinet-elevation"
import { DinRailEditor } from "@/components/din-rail-editor"

/** The mounting plate on a cabinet's or a cabinet type's Overview: drawn to
 * scale with its rails, plus "Edit rails" for whoever may change the
 * parent. */
export function CabinetPlateSection({
  sizes,
  rails,
  endpoint,
  railKey,
  editTitle,
  canEdit,
}: {
  sizes: CabinetSizes
  rails: DinRail[]
  /** The parent's detail endpoint, which the editor PATCHes. */
  endpoint: string
  railKey: DinRailKey
  /** The editor's title, naming the parent. */
  editTitle: string
  canEdit: boolean
}) {
  const [editing, setEditing] = useState(false)
  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="text-[11px] font-semibold tracking-wide text-foreground uppercase">
          Plate
        </h2>
        {canEdit && (
          <Button
            size="sm"
            variant="ghost"
            // Kept to the heading's line, so this card's top lines up with
            // the cards beside it.
            className="-my-1 h-6 px-2 text-xs"
            onClick={() => setEditing(true)}
          >
            <Pencil className="h-3 w-3" /> Edit rails
          </Button>
        )}
      </div>
      <div className="rounded-lg border border-border bg-card p-4">
        <CabinetElevation
          width={sizes.inner_width_mm}
          height={sizes.inner_height_mm}
          outerWidth={sizes.outer_width_mm}
          outerHeight={sizes.outer_height_mm}
          rails={rails.map((r) => ({ key: r.id, ...r }))}
          emptyText="No rails yet."
        />
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
