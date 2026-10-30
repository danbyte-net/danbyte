import { useMemo, useState } from "react"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { Crop as CropIcon, Map as MapIcon } from "lucide-react"

import { api } from "@/lib/api"
import type {
  FloorPlan,
  FloorPlanArea,
  FloorPlanContents,
  FloorPlanCrop,
  FloorPlanLiveState,
  FloorPlanRegion,
  FloorPlanRegionArea,
} from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { useTheme } from "@/components/theme-provider"
import { Button } from "@/components/ui/button"

import { AreaMask } from "./area-mask"
import { CadLayer, useCadSource } from "./cad-layer"
import { CELL } from "./canvas-geometry"
import { FloorCanvas } from "./floor-canvas"
import { shapesOf } from "./shapes"
import { SnapshotDialog } from "./snapshot-dialogs"
import { useCadDrawing } from "./use-cad-drawing"

/** Which page the Floor plan tab is on: a room's or a location's. */
export type AreaPlanOwner = "rooms" | "locations"

/** The part of a floor plan a room or location is drawn on (``?area=``
 * picks one of its areas; none: the first). Live: read again every 30 s. */
export function useAreaPlan(
  owner: AreaPlanOwner,
  id: string,
  areaId: string | null = null
) {
  return useQuery({
    queryKey: ["area-plan", owner, id, areaId],
    queryFn: () =>
      api<FloorPlanRegion>(
        `/api/${owner}/${id}/plan/${areaId ? `?area=${encodeURIComponent(areaId)}` : ""}`
      ),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  })
}

/** "HQ · Ground", or the floor's name when its floor plan is named alike. */
export function floorLabel(a: FloorPlanRegionArea): string {
  const fp = a.floor_plan
  return fp.stack && fp.stack.name !== fp.name
    ? `${fp.stack.name} · ${fp.name}`
    : fp.name
}

/** An area of a region's contents moved back into its floor's cells - what
 * the Snapshot dialog measures. */
function onFloor(
  a: FloorPlanArea,
  crop: { x: number; y: number }
): FloorPlanArea {
  return {
    ...a,
    x: a.x + crop.x,
    y: a.y + crop.y,
    points: a.points.map(([x, y]): [number, number] => [
      x + crop.x,
      y + crop.y,
    ]),
  }
}

/** A room's or location's Floor plan tab: its part of the plan, read-only
 * and live, drawn by the editor's canvas with everything outside its
 * outline dimmed. A switcher when it is drawn on several floors; "Open in
 * floor plan" and "Make snapshot…". */
export function AreaPlanTab({
  owner,
  id,
}: {
  owner: AreaPlanOwner
  id: string
}) {
  const [areaId, setAreaId] = useState<string | null>(null)
  const q = useAreaPlan(owner, id, areaId)
  if (q.isLoading) return <Loading />
  if (q.isError) return <QueryError error={q.error} />
  const r = q.data
  if (!r?.area || !r.floor_plan || !r.crop || !r.contents) return null
  return (
    <RegionView
      region={r}
      floor={r.floor_plan}
      crop={r.crop}
      contents={r.contents}
      onPick={setAreaId}
    />
  )
}

function RegionView({
  region: r,
  floor,
  crop,
  contents,
  onPick,
}: {
  region: FloorPlanRegion
  floor: FloorPlan
  crop: FloorPlanCrop
  contents: FloorPlanContents
  onPick: (id: string) => void
}) {
  const nav = useNavigate()
  const { canDo } = useMe()
  const { theme } = useTheme()
  const [snapshotting, setSnapshotting] = useState(false)
  // The floor at the crop's size: the canvas draws it as a view of it.
  const plan = useMemo<FloorPlan>(
    () => ({ ...floor, grid_width: crop.w, grid_height: crop.h }),
    [floor, crop.w, crop.h]
  )
  const shapes = useMemo(
    () => shapesOf(contents.areas, contents.labels),
    [contents]
  )
  const liveState = useQuery({
    queryKey: ["floor-plan-state", floor.id],
    queryFn: () =>
      api<FloorPlanLiveState>(`/api/floor-plans/${floor.id}/state/`),
    refetchInterval: 30_000,
  })
  const cad = useCadDrawing(floor, false)
  const cadSource = useCadSource(floor.id, cad.drawing, cad.placement)
  const area = contents.areas.find((a) => a.id === r.area)
  const multi = r.areas.length > 1
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {multi ? (
          <SegmentedTabs
            items={r.areas.map((a) => ({ value: a.id, label: floorLabel(a) }))}
            value={r.area ?? ""}
            onValueChange={onPick}
          />
        ) : (
          <span className="text-sm text-muted-foreground">
            {floorLabel(r.areas[0])}
          </span>
        )}
        <div className="ml-auto flex gap-2">
          {canDo("floorplan", "add") && area && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setSnapshotting(true)}
            >
              <CropIcon className="h-3.5 w-3.5" /> Make snapshot…
            </Button>
          )}
          <Button size="sm" variant="outline" asChild>
            <Link
              to="/floorplans/$id"
              params={{ id: floor.id }}
              search={{ area: r.area ?? undefined }}
            >
              <MapIcon className="h-3.5 w-3.5" /> Open in floor plan
            </Link>
          </Button>
        </div>
      </div>
      <div
        data-part="area-plan"
        className="relative h-[60vh] min-h-80 overflow-hidden rounded-lg border border-border"
      >
        <FloorCanvas
          key={`${r.area}:${crop.x}:${crop.y}:${crop.w}:${crop.h}`}
          plan={plan}
          tiles={contents.tiles}
          selectedId={null}
          editable={false}
          showGrid={false}
          armed={null}
          raisedFloors={contents.raised_floors}
          walls={contents.walls}
          trays={contents.trays}
          showTrays
          shapes={shapes}
          liveState={liveState.data ?? null}
          clipToGrid
          backgroundFrame={{
            x: -crop.x,
            y: -crop.y,
            width: floor.grid_width,
            height: floor.grid_height,
          }}
          underlay={
            cad.drawing?.status === "ready" && (
              <g transform={`translate(${-crop.x * CELL} ${-crop.y * CELL})`}>
                <CadLayer
                  drawing={cad.drawing}
                  source={cadSource}
                  placement={cad.placement}
                  pxPerMm={CELL / (floor.cell_mm || 600)}
                  theme={theme}
                />
              </g>
            )
          }
          worldOverlay={
            r.outline && (
              <AreaMask outline={r.outline} width={crop.w} height={crop.h} />
            )
          }
          onOpenTile={(tile) =>
            void nav({
              to: "/floorplans/$id",
              params: { id: floor.id },
              search: { tile: tile.id },
            })
          }
        />
      </div>
      {area && (
        <SnapshotDialog
          plan={floor}
          areaId={snapshotting ? area.id : null}
          areas={[onFloor(area, crop)]}
          onOpenChange={(o) => !o && setSnapshotting(false)}
          onCreated={(made) =>
            void nav({ to: "/floorplans/$id", params: { id: made.id } })
          }
        />
      )}
    </div>
  )
}
