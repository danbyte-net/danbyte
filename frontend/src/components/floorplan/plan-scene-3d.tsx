import { Suspense, useMemo } from "react"
import type { ReactNode } from "react"
import { X } from "lucide-react"

import type { FloorPlan, FloorPlanLiveState } from "@/lib/api"
import { Loading } from "@/components/loading"

import type { Building3D } from "@/components/floorplan3d/scene"

import type { CameraView } from "./camera-view"
import type { PlanShape } from "./shapes"
import type { PlanCapacity } from "./use-plan-capacity"
import type { CadDrawingState } from "./use-cad-drawing"
import type { PlanViewPrefs } from "./use-plan-view-prefs"
import { lazyChunk } from "@/lib/lazy-chunk"

// The 3D room view - the only consumer of the three.js stack, lazy-loaded so
// it lives in its own chunk and costs nothing until someone opens it.
const FloorScene3D = lazyChunk(() => import("@/components/floorplan3d/scene"))

/** The 3D room in place of the 2D canvas, with the Color by key and the
 * controls hint. */
export function PlanScene3D({
  plan,
  liveState,
  hiddenTileIds,
  traceCableId,
  onOpenCable,
  onOpenDevice,
  focusTarget,
  prefs,
  capacity,
  rackFocus,
  cad,
  cadFloorUrl,
  colorLegend,
  areas,
  showHint,
  onDismissHint,
  building = null,
  cameraViews,
}: {
  /** The cameras' views on show (Display > Camera FOV cones). */
  cameraViews?: readonly CameraView[]
  /** An aligned floor plan: the building around this level. */
  building?: Building3D | null
  /** The plan's areas and labels on show: flat tints on the floor, with
   * their names and the labels written on it. */
  areas?: PlanShape[]
  plan: FloorPlan
  liveState: FloorPlanLiveState | null
  hiddenTileIds: Set<string>
  traceCableId: string | null
  /** A cable run clicked: the plan's cable panel (null: clicked away). */
  onOpenCable?: (cableId: string | null) => void
  /** A device clicked: the plan's device panel. */
  onOpenDevice?: (tileId: string, deviceId: string) => void
  /** Fly to a cable's run or a tile; a new `n` flies again. */
  focusTarget?: { kind: "cable" | "tile"; id: string; n: number } | null
  prefs: PlanViewPrefs
  capacity: PlanCapacity
  rackFocus: { tileId: string; n: number } | null
  cad: CadDrawingState
  cadFloorUrl: string | null
  colorLegend: ReactNode
  showHint: boolean
  onDismissHint: () => void
}) {
  // Stable while their inputs are: a background refetch or an unrelated
  // editor render hands the scene the same arrays, so its text and floor
  // memos hold.
  const areaShapes = useMemo(
    () => areas?.filter((s) => s.kind === "area"),
    [areas]
  )
  const labelShapes = useMemo(
    () => areas?.filter((s) => s.kind === "label"),
    [areas]
  )
  const drawing = cad.drawing
  const placement = cad.placement
  const drawingFloor = useMemo(
    () =>
      cadFloorUrl && drawing
        ? {
            url: cadFloorUrl,
            sizeMm: drawing.size_mm,
            centreMm: {
              x:
                placement.x_mm +
                (placement.rotation % 180
                  ? drawing.size_mm.height
                  : drawing.size_mm.width) /
                  2,
              y:
                placement.y_mm +
                (placement.rotation % 180
                  ? drawing.size_mm.width
                  : drawing.size_mm.height) /
                  2,
            },
            rotation: placement.rotation,
            opacity: placement.opacity / 100,
          }
        : null,
    [cadFloorUrl, drawing, placement]
  )
  return (
    <>
      <Suspense fallback={<Loading />}>
        <FloorScene3D
          planId={plan.id}
          building={building}
          cameraViews={cameraViews}
          liveState={liveState}
          hiddenTileIds={hiddenTileIds}
          traceCableId={traceCableId}
          onOpenCable={onOpenCable}
          onOpenDevice={onOpenDevice}
          focusTarget={focusTarget}
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
          areas={areaShapes}
          labels={labelShapes}
          showPlanLabels={prefs.show3dLabels}
          showAreaNames={prefs.show3dAreaNames}
          showZoneLabels={prefs.showZoneLabels}
          readableNames={prefs.objectSize === "readable"}
          readableIcons={prefs.iconTiles}
          readableCallouts={prefs.callouts === "auto"}
          muteBackground={prefs.muteBackground}
          drawingFloor={drawingFloor}
        />
      </Suspense>
      {colorLegend}
      {showHint && (
        <div className="absolute right-3 bottom-3 flex items-center gap-2 rounded-md border border-border bg-popover/90 px-2.5 py-1.5 text-[11px] text-muted-foreground shadow backdrop-blur">
          Drag to orbit · scroll to zoom at the cursor · right-drag to pan ·
          double-click to frame · F focus · 0 fit all · WASD move · Space/C
          up-down
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
