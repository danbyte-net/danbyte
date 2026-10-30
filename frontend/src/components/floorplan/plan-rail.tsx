import type {
  DeviceRole,
  FloorPlan,
  FloorPlanTray,
  FloorPlanWall,
  FloorTileTypeOption,
  RaisedFloorArea,
} from "@/lib/api"

import { StructureRail } from "./structure-panels"
import { TilePalette } from "./tile-palette"
import { TrayRail } from "./tray-panels"
import type { PlanEditState } from "./use-plan-edit-state"

/** The editor's left rail for the mode in hand: the trays (Cables), raised
 * floors and walls (Structure), or the tile palette (Layout). */
export function PlanRail({
  plan,
  ed,
  trays,
  walls,
  areas,
  tileTypes,
  roles,
}: {
  plan: FloorPlan
  ed: PlanEditState
  trays: FloorPlanTray[]
  walls: FloorPlanWall[]
  areas: RaisedFloorArea[]
  tileTypes: FloorTileTypeOption[] | undefined
  roles: DeviceRole[] | undefined
}) {
  const {
    mode,
    selectedTrayId,
    setSelectedTrayId,
    drawPoints,
    setDrawPoints,
    trayEditMode,
    setTrayEditMode,
    areaArmed,
    setAreaArmed,
    selectedAreaId,
    setSelectedAreaId,
    selectedWallId,
    setSelectedWallId,
    setDoorArmed,
    paletteTab,
    setPaletteTab,
    armed,
    setArmed,
  } = ed
  if (mode === "cable")
    return (
      <TrayRail
        trays={trays}
        selectedTrayId={selectedTrayId}
        drawing={drawPoints !== null}
        editMode={trayEditMode}
        onToggleEdit={() => setTrayEditMode((v) => !v)}
        onSelectTray={setSelectedTrayId}
        onStartDraw={() => {
          setSelectedTrayId(null)
          setTrayEditMode(false)
          setDrawPoints([])
        }}
        onCancelDraw={() => setDrawPoints(null)}
      />
    )
  if (mode === "structure")
    return (
      <StructureRail
        areas={areas}
        selectedAreaId={selectedAreaId}
        drawing={areaArmed}
        onSelectArea={(aid) => {
          setSelectedAreaId(aid)
          if (aid) setSelectedWallId(null)
        }}
        onStartDraw={() => {
          setSelectedAreaId(null)
          setSelectedWallId(null)
          setDrawPoints(null)
          setDoorArmed(false)
          setAreaArmed(true)
        }}
        onCancelDraw={() => setAreaArmed(false)}
        walls={walls}
        selectedWallId={selectedWallId}
        wallDrawing={drawPoints !== null}
        onSelectWall={(wid) => {
          setSelectedWallId(wid)
          if (wid) setSelectedAreaId(null)
        }}
        onStartWallDraw={() => {
          setSelectedWallId(null)
          setSelectedAreaId(null)
          setAreaArmed(false)
          setDoorArmed(false)
          setDrawPoints([])
        }}
        onCancelWallDraw={() => setDrawPoints(null)}
      />
    )
  return (
    <TilePalette
      planId={plan.id}
      tileTypes={tileTypes}
      roles={roles}
      paletteTab={paletteTab}
      setPaletteTab={setPaletteTab}
      armed={armed}
      setArmed={setArmed}
    />
  )
}
