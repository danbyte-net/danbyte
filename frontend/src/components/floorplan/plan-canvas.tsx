import type { ReactNode, RefObject } from "react"
import { PanelRight, Waypoints } from "lucide-react"

import type {
  FloorPlan,
  FloorPlanCablePath,
  FloorPlanLiveState,
  FloorplanPopoverConfig,
  FloorPlanTile,
  FloorPlanTray,
  FloorPlanWall,
  RaisedFloorArea,
} from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

import { CadLayer } from "./cad-layer"
import type { CadSource } from "./cad-layer"
import type { CadTheme } from "./cad-colour"
import { CadPanel } from "./cad-panel"
import { CalibrateBar, CalibrateMarks } from "./cad-calibrate"
import type { CadCalibration } from "./cad-calibrate"
import { CabinetPanel } from "./cabinet-panel"
import type { CableRoute } from "./cable-draw"
import { CablePopover, useCablePopover } from "./cable-popover"
import { CanvasHints } from "./canvas-hints"
import { FloorCanvas, tileIsZone } from "./floor-canvas"
import type {
  FloorCanvasApi,
  FloorCanvasProps,
  PaletteEntry,
} from "./floor-canvas"
import { LinkedObjectLink } from "./linked-object-link"
import { isLiveView, viewBackgroundFrame } from "./snapshot"
import { SelectionBar } from "./selection-bar"
import { TilePopover } from "./tile-popover"
import type { useTilePopover } from "./tile-popover"
import type { CadDrawingState } from "./use-cad-drawing"
import type { PlanCapacity } from "./use-plan-capacity"
import type { PlanShape } from "./shapes"
import type { PlanEditState } from "./use-plan-edit-state"
import type { ShapeEdits } from "./use-shape-edits"
import type { PlanViewPrefs } from "./use-plan-view-prefs"
import type { StructureEdits } from "./use-structure-edits"
import type { TileEdits } from "./use-tile-edits"

/** Arms the canvas's drag-rect painter while drawing a raised-floor area -
 * the ghost rect reuses the palette machinery, nothing else reads this. */
const AREA_PSEUDO_ENTRY = {
  key: "structure:raised-floor",
  kind: "tile_type",
  id: "raised-floor",
  name: "Raised floor",
  color: "#71717a",
  icon: "",
  defaultWidth: 4,
  defaultHeight: 3,
  isZone: false,
  hasFov: false,
} as const satisfies PaletteEntry

/** The 2D plan: the canvas with its layers wired to the editor, and what
 * floats over it - the drawing's panel and badges, the bulk bar, the
 * drawing hints, the tile popover and a cabinet's panel. */
export function PlanCanvas({
  plan,
  shownTiles,
  shownShapes,
  shapeEdits,
  onOpenShape,
  canEdit,
  ed,
  edits,
  structure,
  prefs,
  liveState,
  trays,
  walls,
  areas,
  cablePaths,
  cableRoutes,
  tileTypes,
  roles,
  popover,
  popoverFields,
  capacity,
  racksOpen,
  colorLegend,
  canvasApi,
  exportRef,
  cad,
  cadSource,
  cadPxPerMm,
  calibration,
  theme,
  openTile,
  onDropRows,
  selectionToolbar,
  overlays,
  onSnapshotRect,
  lockedIds,
}: {
  /** Edit, the Snapshot tool in hand: the dragged rectangle. */
  onSnapshotRect?: FloorCanvasProps["onSnapshotRect"]
  /** A live view's rows crossing its edge: shown, not editable here. */
  lockedIds?: ReadonlySet<string>
  /** Edit: rows dragged from the Place picker or the unplaced list. */
  onDropRows?: FloorCanvasProps["onDropRows"]
  /** Edit: floats above the selection. */
  selectionToolbar?: ReactNode
  /** Drawn over the canvas: the room prompt, the empty floor's guidance. */
  overlays?: ReactNode
  plan: FloorPlan
  shownTiles: FloorPlanTile[]
  /** The areas and labels on show. */
  shownShapes: PlanShape[]
  shapeEdits: ShapeEdits
  /** Viewing: an area or label clicked. */
  onOpenShape: (shape: PlanShape) => void
  canEdit: boolean
  ed: PlanEditState
  edits: TileEdits
  structure: StructureEdits
  prefs: PlanViewPrefs
  liveState: FloorPlanLiveState | null
  trays: FloorPlanTray[]
  walls: FloorPlanWall[]
  areas: RaisedFloorArea[]
  cablePaths: FloorPlanCablePath[]
  /** Each cable's route (use-cable-routes.ts). */
  cableRoutes: ReadonlyMap<string, CableRoute>
  tileTypes: Parameters<typeof SelectionBar>[0]["tileTypes"]
  roles: Parameters<typeof SelectionBar>[0]["roles"]
  popover: ReturnType<typeof useTilePopover>
  popoverFields: FloorplanPopoverConfig["fields"]
  capacity: PlanCapacity
  racksOpen: boolean
  colorLegend: ReactNode
  canvasApi: RefObject<FloorCanvasApi | null>
  exportRef: RefObject<HTMLDivElement | null>
  cad: CadDrawingState
  cadSource: CadSource
  cadPxPerMm: number
  calibration: CadCalibration
  theme: CadTheme
  openTile: (tile: FloorPlanTile) => void
}) {
  const {
    tiles,
    selectedId,
    setSelectedId,
    armed,
    areaArmed,
    selectedAreaId,
    setSelectedAreaId,
    selectedWallId,
    setSelectedWallId,
    doorArmed,
    multiSel,
    setMultiSel,
    showGrid,
    drawingOpen,
    setDrawingOpen,
    cabinetTileId,
    setCabinetTileId,
    setDeepTile,
    highlightCableIds,
    setHighlightCableIds,
    trayEditMode,
    setTrayEditMode,
    mode,
    selectedTrayId,
    setSelectedTrayId,
    drawPoints,
    draft,
    tool,
    selectedShapeId,
  } = ed
  const {
    changeTile,
    changeTileGuarded,
    moveSelectionBy,
    rotateSelectionTurn,
    createAt,
    deleteTile,
    setTileFacing,
  } = edits
  const {
    patchArea,
    createAreaAt,
    patchWall,
    placeDoor,
    patchTray,
    addDrawPoint,
    finishDraw,
  } = structure
  const {
    colorBy,
    labelFit,
    showFov,
    showZoneLabels,
    showPhotoOutlines,
    showTrays,
    showCableLinks,
    cableColorBy,
    showCableLabels,
    bundleCables,
    setViewPref,
  } = prefs
  // The cable popover: a hover previews a run, a click pins it.
  const cablePopover = useCablePopover()

  // The panel follows its tile - its label as edited, and gone with the
  // tile, its cabinet link or its eye.
  const cabinetPanelTile =
    shownTiles.find(
      (t) => t.id === cabinetTileId && t.linked?.kind === "cabinet"
    ) ?? null

  return (
    <>
      <FloorCanvas
        plan={plan}
        tiles={shownTiles}
        selectedId={selectedId}
        editable={canEdit}
        showGrid={showGrid}
        armed={
          mode === "structure" ? (areaArmed ? AREA_PSEUDO_ENTRY : null) : armed
        }
        onSelect={(id) => {
          setSelectedId(id)
          // A plain click always collapses the multi-selection - it
          // means "work with THIS one now".
          setMultiSel((prev) => (prev.size ? new Set() : prev))
          // Clicking a tile pins its popover (the pointer is already over
          // it, so the hook has the anchor point); clicking the background
          // dismisses.
          if (!id || !popover.pinCurrent()) popover.close()
        }}
        multiSelectedIds={multiSel}
        onToggleSelect={(tid) => {
          setMultiSel((prev) => {
            // The tile selected by a plain click is the first of
            // the selection a Shift- or Ctrl/⌘-click grows.
            const next = new Set(
              prev.size === 0 && selectedId && selectedId !== tid
                ? [selectedId]
                : prev
            )
            if (next.has(tid)) next.delete(tid)
            else next.add(tid)
            // Exactly one tile selected → open the full inspector
            // (Linked object, facing, label…); the bulk bar alone
            // is a dead end for per-tile work like linking.
            setSelectedId(next.size === 1 ? [...next][0] : null)
            return next
          })
        }}
        onMarquee={(rect) => {
          // Non-zone tiles intersecting the sweep join the selection.
          const hit = shownTiles.filter(
            (t) =>
              !tileIsZone(t) &&
              t.x < rect.x + rect.w &&
              rect.x < t.x + t.width &&
              t.y < rect.y + rect.h &&
              rect.y < t.y + t.height
          )
          if (hit.length) {
            setSelectedId(null)
            setMultiSel(new Set(hit.map((t) => t.id)))
          }
        }}
        onHoverTile={popover.onHover}
        onChangeTile={changeTileGuarded}
        onMoveSelection={moveSelectionBy}
        onGestureStart={draft.beginGesture}
        onGestureEnd={draft.endGesture}
        onCreateRect={mode === "structure" ? createAreaAt : createAt}
        raisedFloors={areas}
        selectedAreaId={selectedAreaId}
        onSelectArea={setSelectedAreaId}
        onAreaRectChange={(areaId, rect) =>
          patchArea.mutate({ areaId, body: rect })
        }
        walls={walls}
        selectedWallId={selectedWallId}
        onSelectWall={setSelectedWallId}
        onMoveWall={(wallId, points) =>
          patchWall.mutate({ wallId, body: { points } })
        }
        doorArmed={doorArmed}
        onPlaceDoor={placeDoor}
        onOpenTile={openTile}
        // A click on a device or rack pins its popover (Trace there, or a
        // double-click, opens the deep view); without a hover to pin - a
        // touch - it opens straight away. Other tiles open on a click.
        onClickTile={(tile) => {
          const k = tile.linked?.kind
          if ((k === "device" || k === "rack") && popover.pinCurrent()) return
          openTile(tile)
        }}
        exportRef={exportRef}
        liveState={liveState}
        colorBy={colorBy}
        rackFigures={capacity.figures}
        highlightTileIds={capacity.highlightTileIds}
        dimTileIds={racksOpen ? capacity.dimTileIds : undefined}
        // Inside the export area, so the PNG carries the key.
        overlay={colorLegend}
        labelFit={labelFit}
        showFov={showFov}
        showZoneLabels={showZoneLabels}
        photoOutlines={showPhotoOutlines}
        mode={mode}
        trays={trays}
        showTrays={showTrays}
        selectedTrayId={selectedTrayId}
        onSelectTray={setSelectedTrayId}
        drawPoints={drawPoints ?? undefined}
        onAddDrawPoint={addDrawPoint}
        onFinishDraw={finishDraw}
        onMoveTray={(trayId, points) =>
          patchTray.mutate({ trayId, patch: { points } })
        }
        trayEditMode={trayEditMode}
        cablePaths={cablePaths}
        showCableLinks={showCableLinks}
        highlightCableIds={highlightCableIds}
        onSelectCable={(cid) => {
          setHighlightCableIds(cid ? [cid] : [])
          if (!cid || !cablePopover.pinCurrent()) cablePopover.close()
        }}
        cableRoutes={cableRoutes}
        cableColorBy={cableColorBy}
        showCableLabels={showCableLabels}
        bundleCables={bundleCables}
        onHoverCable={cablePopover.onHover}
        onHighlightCables={(ids) => {
          setHighlightCableIds(ids)
          if (ids.length && !showCableLinks)
            setViewPref("show_cable_links", true)
        }}
        apiRef={canvasApi}
        underlay={
          cad.drawing?.status === "ready" && (
            <CadLayer
              drawing={cad.drawing}
              source={cadSource}
              placement={cad.placement}
              pxPerMm={cadPxPerMm}
              theme={theme}
            />
          )
        }
        worldOverlay={
          calibration.active &&
          cad.drawing && (
            <CalibrateMarks
              drawing={cad.drawing}
              placement={cad.placement}
              pxPerMm={cadPxPerMm}
              points={calibration.points}
            />
          )
        }
        onPickPoint={calibration.active ? calibration.pick : undefined}
        shapes={shownShapes}
        selectedShapeId={selectedShapeId}
        shapeTool={
          canEdit && (tool === "rect" || tool === "polygon" || tool === "label")
            ? tool
            : null
        }
        onSelectShape={shapeEdits.select}
        onChangeShape={shapeEdits.changeShape}
        onCreateArea={shapeEdits.createArea}
        onCreateLabel={shapeEdits.createLabel}
        onDeleteShape={shapeEdits.deleteShape}
        onRestackShape={shapeEdits.restack}
        onOpenShape={onOpenShape}
        onDropRows={onDropRows}
        selectionToolbar={selectionToolbar}
        onSnapshotRect={onSnapshotRect}
        lockedIds={lockedIds}
        clipToGrid={isLiveView(plan)}
        backgroundFrame={viewBackgroundFrame(plan)}
      />
      {overlays}
      {cad.drawing?.status === "ready" &&
        (cadSource.mode === "image" || cadSource.error) && (
          <div className="pointer-events-none absolute top-3 left-3 z-10">
            <Badge variant={cadSource.error ? "destructive" : "secondary"}>
              {cadSource.error
                ? cadSource.error
                : cadSource.loading
                  ? "Rendering…"
                  : "Layers flattened"}
            </Badge>
          </div>
        )}
      {calibration.active && <CalibrateBar cal={calibration} />}
      {drawingOpen && plan.drawing && (
        <CadPanel
          cad={cad}
          plan={plan}
          canEdit={canEdit && !isLiveView(plan)}
          onCalibrate={calibration.start}
          onClose={() => setDrawingOpen(false)}
        />
      )}
      {canEdit && mode === "layout" && multiSel.size > 0 && (
        <SelectionBar
          multiSel={multiSel}
          setMultiSel={setMultiSel}
          tiles={tiles}
          tileTypes={tileTypes}
          roles={roles}
          setTileFacing={setTileFacing}
          rotateSelectionTurn={rotateSelectionTurn}
          changeTile={changeTile}
          deleteTile={deleteTile}
        />
      )}
      <CanvasHints
        mode={mode}
        drawPoints={drawPoints}
        doorArmed={doorArmed}
        trayEditMode={trayEditMode}
        setTrayEditMode={setTrayEditMode}
      />
      {/* Replaces the SVG <title> the browser used to draw: anchored to the
          tile, styled, links out, and pinnable so it can actually be read. */}
      <TilePopover
        target={popover.target}
        live={
          popover.target ? liveState?.tiles[popover.target.tile.id] : undefined
        }
        planRack={
          popover.target?.tile.linked?.kind === "rack" &&
          popover.target.tile.linked.id
            ? capacity.rackById.get(popover.target.tile.linked.id)
            : undefined
        }
        fields={popoverFields}
        onOpenChange={(open) => !open && popover.close()}
        renderLinked={(tile) =>
          tile.linked ? <LinkedObjectLink linked={tile.linked} /> : null
        }
        renderActions={(tile) =>
          !tile.linked?.hidden &&
          (tile.linked?.kind === "rack" ||
            tile.linked?.kind === "cabinet" ||
            tile.linked?.kind === "device") ? (
            <Button
              variant="outline"
              size="sm"
              className="mt-3 w-full"
              onClick={() => {
                popover.close()
                openTile(tile)
              }}
            >
              {tile.linked.kind === "device" ? (
                <Waypoints className="h-3.5 w-3.5" />
              ) : (
                <PanelRight className="h-3.5 w-3.5" />
              )}
              {tile.linked.kind === "device" ? "Trace" : "Contents & trace"}
            </Button>
          ) : null
        }
      />
      <CablePopover
        target={showCableLinks ? cablePopover.target : null}
        cablePaths={cablePaths}
        routes={cableRoutes}
        trays={trays}
        cellMm={plan.cell_mm}
        onOpenChange={(open) => !open && cablePopover.close()}
      />
      {cabinetPanelTile && (
        <CabinetPanel
          key={cabinetPanelTile.id}
          tile={cabinetPanelTile}
          live={liveState?.tiles[cabinetPanelTile.id]}
          onClose={() => setCabinetTileId(null)}
          // A device's paths open in the deep view, as a racked
          // device's do; the panel waits underneath.
          onTraceDevice={(d) =>
            setDeepTile({
              ...cabinetPanelTile,
              linked: {
                kind: "device",
                id: d.id,
                name: d.name,
                route: `/devices/${d.id}`,
              },
            })
          }
        />
      )}
    </>
  )
}
