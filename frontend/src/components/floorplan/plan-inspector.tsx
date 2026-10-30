import type {
  DeviceRole,
  FloorPlan,
  FloorPlanTile,
  FloorPlanTray,
  FloorPlanWall,
  FloorTileTypeOption,
  RaisedFloorArea,
} from "@/lib/api"

import { AreaInspector, WallInspector } from "./structure-panels"
import { TileInspector } from "./tile-inspector"
import { TrayInspector } from "./tray-panels"
import type { PlanEditState } from "./use-plan-edit-state"
import type { PlanViewPrefs } from "./use-plan-view-prefs"
import type { StructureEdits } from "./use-structure-edits"
import type { TileEdits } from "./use-tile-edits"

/** The editor's right panel for what is selected in the mode in hand: a
 * tile (Layout), a tray (Cables), a wall or a raised floor (Structure). */
export function PlanInspector({
  plan,
  ed,
  edits,
  structure,
  prefs,
  trays,
  walls,
  areas,
  tileTypes,
  roles,
  openTile,
}: {
  plan: FloorPlan
  ed: PlanEditState
  edits: TileEdits
  structure: StructureEdits
  prefs: PlanViewPrefs
  trays: FloorPlanTray[]
  walls: FloorPlanWall[]
  areas: RaisedFloorArea[]
  tileTypes: FloorTileTypeOption[]
  roles: DeviceRole[]
  openTile: (tile: FloorPlanTile) => void
}) {
  const {
    mode,
    tiles,
    selectedId,
    selectedTrayId,
    selectedWallId,
    selectedAreaId,
    highlightCableIds,
    setHighlightCableIds,
    trayEditMode,
    setTrayEditMode,
    doorArmed,
    setDoorArmed,
  } = ed
  const { changeTile, rotateTile, setTileFacing, fitTile, deleteTile } = edits
  const {
    patchTray,
    deleteTray,
    patchWall,
    deleteWall,
    patchArea,
    deleteArea,
  } = structure
  const { showCableLinks, setViewPref } = prefs

  const selected = tiles.find((t) => t.id === selectedId) ?? null
  const selectedTray = trays.find((t) => t.id === selectedTrayId) ?? null

  if (mode === "layout")
    return (
      selected && (
        <TileInspector
          key={selected.id}
          tile={selected}
          planId={plan.id}
          siteId={plan.site.id}
          cellMm={plan.cell_mm}
          tileTypes={tileTypes}
          roles={roles}
          onChange={(patch) => changeTile(selected.id, patch)}
          onRotate={() => rotateTile(selected)}
          onSetFacing={(o) => setTileFacing(selected, o)}
          onFit={(size) => fitTile(selected, size)}
          onDelete={() => deleteTile(selected.id)}
          onOpenContents={
            selected.linked?.kind === "rack" ||
            selected.linked?.kind === "cabinet" ||
            selected.linked?.kind === "device"
              ? () => openTile(selected)
              : undefined
          }
        />
      )
    )
  if (mode === "cable")
    return (
      selectedTray && (
        <TrayInspector
          key={selectedTray.id}
          highlightCableId={highlightCableIds[0] ?? null}
          tray={selectedTray}
          editing={trayEditMode}
          onEditShape={() => setTrayEditMode((v) => !v)}
          onHighlightCable={(cableId) => {
            setHighlightCableIds(cableId ? [cableId] : [])
            if (cableId && !showCableLinks)
              setViewPref("show_cable_links", true)
          }}
          onPatch={(patch) =>
            patchTray.mutate({ trayId: selectedTray.id, patch })
          }
          onDelete={() => deleteTray.mutate(selectedTray.id)}
        />
      )
    )
  const wall = walls.find((w) => w.id === selectedWallId)
  if (wall)
    return (
      <WallInspector
        key={wall.id}
        wall={wall}
        cellMM={plan.cell_mm}
        ceilingMM={plan.ceiling_mm}
        doorArmed={doorArmed}
        onArmDoor={() => setDoorArmed((v) => !v)}
        onPatch={(body) => patchWall.mutate({ wallId: wall.id, body })}
        onDelete={() => deleteWall.mutate(wall.id)}
      />
    )
  const area = areas.find((a) => a.id === selectedAreaId)
  if (!area) return null
  return (
    <AreaInspector
      key={area.id}
      area={area}
      onPatch={(body) => patchArea.mutate({ areaId: area.id, body })}
      onDelete={() => deleteArea.mutate(area.id)}
    />
  )
}
