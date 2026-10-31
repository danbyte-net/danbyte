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

/** The panel beside the tool rail for the tool in hand: the trays (Cable
 * trays), raised floors and walls (Walls and raised floors), or the tile
 * palette (Tiles). The other tools have none. */
export function PlanRail({
  plan,
  ed,
  trays,
  walls,
  areas,
  tileTypes,
  roles,
  onDeleteRow,
}: {
  /** A wall's, tray's or raised floor's row deleted. */
  onDeleteRow?: (id: string) => void
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
        onDeleteTray={onDeleteRow}
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
        onDeleteArea={onDeleteRow}
        onDeleteWall={onDeleteRow}
      />
    )
  // Layout: the tile palette is the Tiles tool's; the drawing tools and
  // Select work on the plan itself.
  if (ed.tool !== "tiles") return null
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
