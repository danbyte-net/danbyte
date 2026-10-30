import { Suspense, lazy } from "react"
import type { ReactNode } from "react"
import { X } from "lucide-react"

import type { FloorPlan, FloorPlanLiveState } from "@/lib/api"
import { Loading } from "@/components/loading"

import type { PlanCapacity } from "./use-plan-capacity"
import type { CadDrawingState } from "./use-cad-drawing"
import type { PlanViewPrefs } from "./use-plan-view-prefs"

// The 3D room view - the only consumer of the three.js stack, lazy-loaded so
// it lives in its own chunk and costs nothing until someone opens it.
const FloorScene3D = lazy(() => import("@/components/floorplan3d/scene"))

/** The 3D room in place of the 2D canvas, with the Color by key and the
 * controls hint. */
export function PlanScene3D({
  plan,
  liveState,
  hiddenTileIds,
  traceCableId,
  prefs,
  capacity,
  rackFocus,
  cad,
  cadFloorUrl,
  colorLegend,
  showHint,
  onDismissHint,
}: {
  plan: FloorPlan
  liveState: FloorPlanLiveState | null
  hiddenTileIds: Set<string>
  traceCableId: string | null
  prefs: PlanViewPrefs
  capacity: PlanCapacity
  rackFocus: { tileId: string; n: number } | null
  cad: CadDrawingState
  cadFloorUrl: string | null
  colorLegend: ReactNode
  showHint: boolean
  onDismissHint: () => void
}) {
  return (
    <>
      <Suspense fallback={<Loading />}>
        <FloorScene3D
          planId={plan.id}
          liveState={liveState}
          hiddenTileIds={hiddenTileIds}
          traceCableId={traceCableId}
          showUNumbers={prefs.show3dU}
          showNames={prefs.show3dNames}
          namesScope={prefs.names3dScope}
          namesAtEdge={prefs.names3dEdge}
          showCables={prefs.show3dCables}
          showAirflow={prefs.show3dAirflow}
          floorPeek={prefs.floorPeek}
          showWalls={prefs.show3dWalls}
          showCeiling={prefs.show3dCeiling}
          shellMode={prefs.shell3d}
          quality={prefs.quality3d}
          cableScale={prefs.cableScale}
          cableLook={prefs.cableLook}
          tints={capacity.tints}
          racks={capacity.rackById}
          pointTileIds={capacity.highlightTileIds}
          focusRack={rackFocus}
          drawingFloor={
            cadFloorUrl && cad.drawing
              ? {
                  url: cadFloorUrl,
                  sizeMm: cad.drawing.size_mm,
                  centreMm: {
                    x:
                      cad.placement.x_mm +
                      (cad.placement.rotation % 180
                        ? cad.drawing.size_mm.height
                        : cad.drawing.size_mm.width) /
                        2,
                    y:
                      cad.placement.y_mm +
                      (cad.placement.rotation % 180
                        ? cad.drawing.size_mm.width
                        : cad.drawing.size_mm.height) /
                        2,
                  },
                  rotation: cad.placement.rotation,
                  opacity: cad.placement.opacity / 100,
                }
              : null
          }
        />
      </Suspense>
      {colorLegend}
      {showHint && (
        <div className="absolute right-3 bottom-3 flex items-center gap-2 rounded-md border border-border bg-popover/90 px-2.5 py-1.5 text-[11px] text-muted-foreground shadow backdrop-blur">
          Drag to orbit · scroll to zoom · right-drag to pan · arrows / WASD
          move · Space/C up-down · Shift sprint · F focus · click a rack
          <button
            onClick={onDismissHint}
            aria-label="Dismiss"
            className="hover:text-foreground"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
    </>
  )
}
