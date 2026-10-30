import { useNavigate } from "@tanstack/react-router"
import { toPng } from "html-to-image"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import type {
  FloorPlanCablePath,
  FloorPlanConflict,
  FloorPlanCrop,
  FloorPlanPlaceable,
  FloorPlanTile,
} from "@/lib/api"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { DrawingExportMenu } from "@/components/drawing-export-menu"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { HiddenChip } from "@/components/hidden-chip"
import { hiddenCount } from "@/components/hidden-objects"
import { useTheme } from "@/components/theme-provider"
import { rememberFloor } from "@/lib/floor-plan-stacks"
import { usePageTitle } from "@/lib/page-title"
import { useMe } from "@/lib/use-me"

import { AreaPanel } from "./area-panel"
import { BackgroundControls } from "./background-controls"
import { useCadCalibration } from "./cad-calibrate"
import { useCadFloorImage, useCadSource } from "./cad-layer"
import { ColorByLegend, colorByLegendEntries } from "./color-by-legend"
import { CELL, cableRoutePoints } from "./floor-canvas"
import type { FloorCanvasApi } from "./floor-canvas"
import {
  readFloorHidden,
  visibleShapes,
  visibleTiles as pickVisibleTiles,
} from "./hidden"
import { ObjectsSidebar } from "./objects-sidebar"
import { PlanCanvas } from "./plan-canvas"
import { PlanDialogs } from "./plan-dialogs"
import { PlanHeader } from "./plan-header"
import { PlanInspector } from "./plan-inspector"
import { PlanRail } from "./plan-rail"
import { PlanScene3D } from "./plan-scene-3d"
import { planSvg } from "./plan-svg"
import { PlanToolbar } from "./plan-toolbar"
import { PlacePicker, UnplacedList } from "./place-picker"
import { asPhotos, nearScope, placedOnFloor, roomPrompts } from "./placement"
import type { NearScope } from "./placement"
import {
  AssignRoomsDialog,
  ConflictDialog,
  PlanEmptyState,
  RoomPrompt,
  SelectionToolbar,
  useSetRooms,
} from "./placement-panels"
import type { RoomPromptState } from "./placement-panels"
import type { Pt } from "./shapes"
import { RackTablePanel } from "./rack-table-panel"
import { shapeBounds } from "./shapes"
import { SnapAllDialog } from "./snap-all-dialog"
import { edgeIds, isLiveView } from "./snapshot"
import { SnapshotDialog } from "./snapshot-dialogs"
import { DEFAULT_POPOVER_FIELDS, useTilePopover } from "./tile-popover"
import { ToolRail } from "./tool-rail"
import { useCadDrawing } from "./use-cad-drawing"
import { useEditMode } from "./use-edit-mode"
import { useEditorKeys } from "./use-editor-keys"
import { useFloorPlanData } from "./use-floor-plan-data"
import { useLeaveGuard } from "./use-leave-guard"
import { popoverShowsPorts, usePlanCapacity } from "./use-plan-capacity"
import { TOOL_MODE, usePlanEditState } from "./use-plan-edit-state"
import type { EditorTool } from "./use-plan-edit-state"
import { usePlanMutations } from "./use-plan-mutations"
import { usePlanViewPrefs } from "./use-plan-view-prefs"
import { useShapeEdits } from "./use-shape-edits"
import { useStructureEdits } from "./use-structure-edits"
import { useTileEdits } from "./use-tile-edits"

/** The floor-plan page's search params (validated by the route). */
export interface FloorPlanSearch {
  /** A cable's route highlighted and fitted on arrival. */
  trace?: string
  /** "3d" opens straight into the 3D room. */
  viz?: "3d"
  /** A tile selected and zoomed onto on arrival ("Show on floor plan"). */
  tile?: string
}

/** The floor-plan editor: header, bar, mode rail, the 2D canvas or the 3D
 * room, the inspector or Objects panel, the rack table, and the dialogs. */
export function FloorPlanEditor({
  id,
  search,
}: {
  id: string
  search: FloorPlanSearch
}) {
  const nav = useNavigate()
  const { canDo, humanIds } = useMe()
  const { theme } = useTheme()
  const canEdit = canDo("floorplan", "change")
  // View by default; Edit (E) for those who may change the plan.
  const { editing, setEdit } = useEditMode(canEdit)

  const data = useFloorPlanData(id)
  const { planQuery, plan, tileTypes, roles, liveState, popoverCfg } = data
  const { trays, areas, walls, cablePaths } = data
  usePageTitle(
    plan ? (plan.stack ? `${plan.stack.name} · ${plan.name}` : plan.name) : null
  )
  // The floor plan reopens on this floor in this browser.
  const stackId = plan?.stack?.id
  useEffect(() => {
    if (stackId) rememberFloor(stackId, id)
  }, [stackId, id])
  const { trace: traceParam, viz: vizParam, tile: tileParam } = search
  const view3d = vizParam === "3d"

  const ed = usePlanEditState(id, data.serverTiles, data.serverShapes)
  const { tiles, isDirty, selectedId, setSelectedId } = ed
  // An area opened while viewing (its room in the map panel).
  const [openArea, setOpenArea] = useState<string | null>(null)
  const [snapOpen, setSnapOpen] = useState(false)
  // The Snapshot tool's rectangle, while its dialog is open.
  const [snapshotCrop, setSnapshotCrop] = useState<FloorPlanCrop | null>(null)
  // A live view: the source's objects, its edge ones locked here.
  const liveView = isLiveView(plan)
  const lockedIds = useMemo(
    () => edgeIds(data.contentsQuery.data),
    [data.contentsQuery.data]
  )
  const [leaveEditOpen, setLeaveEditOpen] = useState(false)
  // Placing: the picker with the room near the pointer when it opened, the
  // bulk room assignment, and the "Set room to X?" prompt after a drop.
  const [placeOpen, setPlaceOpen] = useState(false)
  const [near, setNear] = useState<NearScope | null>(null)
  const [assignOpen, setAssignOpen] = useState(false)
  const [roomPrompt, setRoomPrompt] = useState<RoomPromptState | null>(null)
  const setRooms = useSetRooms(id)
  // Tile popover: hover-preview (delayed) + click-to-pin.
  const popover = useTilePopover()
  // Resolve the row list for the tile in hand: a tile type with its own list
  // wins, otherwise it INHERITS the global one (absence = inherit, so the two
  // can never drift apart).
  const popoverFields = useMemo(() => {
    const cfg = popoverCfg.data
    if (!cfg) return DEFAULT_POPOVER_FIELDS
    const slug = popover.target?.tile.tile_type?.slug
    return (slug && cfg.tile_overrides[slug]) || cfg.fields
  }, [popoverCfg.data, popover.target])
  const canvasApi = useRef<FloorCanvasApi | null>(null)
  const exportRef = useRef<HTMLDivElement>(null)

  const leaveGuard = useLeaveGuard(isDirty, ed.isDirtyRef)
  const { uploadBackground, patchPlan } = usePlanMutations(id)
  const prefs = usePlanViewPrefs({ id, plan, canEdit, patchPlan })
  const { hidden, setHiddenPref, colorBy, showRacks, showObjects } = prefs
  const edits = useTileEdits({ id, plan, ed })
  const structure = useStructureEdits({ id, plan, walls, ed })
  const shapeEdits = useShapeEdits({ plan, ed })

  const shownTiles = useMemo(
    () => pickVisibleTiles(tiles, hidden),
    [tiles, hidden]
  )
  // Display > Photos: each tile with a photo drawn as it, its own saved
  // `display` untouched (the edits keep reading `tiles`).
  const drawnTiles = useMemo(
    () => (prefs.showPhotos ? asPhotos(shownTiles) : shownTiles),
    [shownTiles, prefs.showPhotos]
  )
  const shownShapes = useMemo(
    () => visibleShapes(ed.shapes, hidden),
    [ed.shapes, hidden]
  )

  /** Pick a tool: its canvas mode, nothing selected or half drawn. */
  const selectTool = useCallback(
    (tool: EditorTool) => {
      ed.setTool(tool)
      ed.setMode(TOOL_MODE[tool])
      setSelectedId(null)
      ed.setSelectedShapeId(null)
      ed.setSelectedTrayId(null)
      ed.setArmed(null)
      ed.setDrawPoints(null)
      ed.setSelectedAreaId(null)
      ed.setAreaArmed(false)
      ed.setMultiSel(new Set())
      // Leaving the trays must exit tray-edit - otherwise Layout stays
      // frozen (tiles unselectable, cables hidden).
      ed.setTrayEditMode(false)
    },
    [ed]
  )
  /** View or Edit. Leaving Edit with unsaved edits asks first. */
  const changeEditing = useCallback(
    (on: boolean) => {
      if (!on && isDirty) {
        setLeaveEditOpen(true)
        return
      }
      if (!on) selectTool("select")
      setOpenArea(null)
      setEdit(on)
    },
    [isDirty, selectTool, setEdit]
  )
  const toggleFree = () => {
    if (!plan) return
    if (plan.layout_mode === "free") setSnapOpen(true)
    else
      patchPlan.mutate(
        { layout_mode: "free" },
        { onSuccess: () => toast.success("Free placement on") }
      )
  }
  const hiddenTileIds = useMemo(
    () =>
      new Set(tiles.filter((t) => !shownTiles.includes(t)).map((t) => t.id)),
    [tiles, shownTiles]
  )
  // A tile that just went off the plan cannot stay selected - the keyboard
  // nudge and delete act on the selection, and nobody should edit what they
  // cannot see.
  useEffect(() => {
    if (selectedId && hiddenTileIds.has(selectedId)) setSelectedId(null)
  }, [selectedId, hiddenTileIds])

  const capacity = usePlanCapacity({
    planId: id,
    tiles: shownTiles,
    live: liveState.data ?? null,
    colorBy,
    wantPorts: popoverShowsPorts(popoverCfg.data),
  })
  // The plan's CAD drawing: placement saved as it changes (an editor) or
  // kept on screen (a viewer's layer choices), drawn under the grid.
  // A view's drawing is its source's: layer choices stay on screen.
  const cad = useCadDrawing(plan, canEdit && !liveView)
  const cadSource = useCadSource(id, cad.drawing, cad.placement)
  const cadPxPerMm = CELL / (plan?.cell_mm || 600)
  const calibration = useCadCalibration(
    id,
    cad.drawing,
    cad.placement,
    cadPxPerMm
  )
  const cadFloorUrl = useCadFloorImage(
    cad.drawing,
    cadSource,
    cad.placement,
    view3d && cad.drawing?.status === "ready"
  )
  const racksOpen = colorBy !== "type" && showRacks && capacity.hasRacks
  // The table takes the plan's lower part: fit the plan to the room left
  // when it opens or closes - unless the page arrived focused on a tile or
  // a trace, which keeps its framing.
  useEffect(() => {
    if (tileParam || traceParam) return
    const frame = requestAnimationFrame(() => canvasApi.current?.fit())
    return () => cancelAnimationFrame(frame)
  }, [racksOpen, tileParam, traceParam])

  // ?trace=<cableId> → highlight that cable + fit the view to its route, so a
  // "trace on map" link from a cable/rack lands on the run without any clicks.
  // ?tile=<id> → select it and zoom in on it, once the tiles have landed.
  const focusedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!tileParam || focusedRef.current === tileParam) return
    const tile = tiles.find((t) => t.id === tileParam)
    if (!tile) return
    focusedRef.current = tileParam
    setSelectedId(tile.id)
    requestAnimationFrame(() => canvasApi.current?.focusTile(tile, 2.5))
  }, [tileParam, tiles])

  const tracedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!traceParam || tracedRef.current === traceParam) return
    const cp = cablePaths.find((c) => c.id === traceParam)
    if (!cp) return // paths not loaded yet - the effect re-runs when they land
    tracedRef.current = traceParam
    prefs.setShowLinksLocal(true)
    ed.setHighlightCableIds([traceParam])
    const route = cableRoutePoints(cp, trays, tiles)
    if (route.length >= 2)
      requestAnimationFrame(() => canvasApi.current?.focusPoints(route))
  }, [traceParam, cablePaths, trays, tiles])

  /** Place rows at a cell point: linked tiles, no type needed. A drop into
   * another room's area asks "Set room to X?" - never sets it itself. */
  const placeAt = useCallback(
    (rows: FloorPlanPlaceable[], at: Pt, move = false) => {
      if (ed.mode !== "layout") selectTool("select")
      const placed = edits.placeRows(rows, at, { move })
      setPlaceOpen(false)
      setRoomPrompt(roomPrompts(placed, ed.shapes)[0] ?? null)
    },
    [ed, edits, selectTool]
  )
  const placeAtCentre = useCallback(
    (rows: FloorPlanPlaceable[]) => {
      if (!plan) return
      const at = canvasApi.current?.centerCell?.() ?? [
        plan.grid_width / 2,
        plan.grid_height / 2,
      ]
      placeAt(rows, at)
    },
    [plan, placeAt]
  )
  // The objects on this floor as the editor holds it - the unsaved draft
  // included - for the picker's "On this floor" and the Not placed list.
  const onFloor = useMemo(() => placedOnFloor(tiles), [tiles])
  const openPlace = useCallback(() => {
    const api = canvasApi.current
    setNear(
      nearScope(
        ed.shapes,
        api?.pointerCell?.() ?? null,
        api?.centerCell?.() ?? null
      )
    )
    setPlaceOpen(true)
  }, [ed.shapes])
  const applyRoom = (prompt: RoomPromptState) =>
    setRooms.mutate(prompt, {
      onSuccess: () => {
        setRoomPrompt(null)
        // The placed tiles show the room they now name.
        const ids = new Set(prompt.objects.map((o) => o.id))
        ed.setTiles((prev) =>
          prev.map((t) =>
            t.linked && ids.has(t.linked.id)
              ? { ...t, linked: { ...t.linked, room: prompt.room } }
              : t
          )
        )
      },
    })
  const conflictName = (c: FloorPlanConflict) => {
    const local =
      c.kind === "tile"
        ? tiles.find((t) => t.id === c.id)
        : ed.shapes.find((sh) => sh.id === c.id)
    const row = (local ?? c.current) as unknown as Record<
      string,
      unknown
    > | null
    if (!row) return c.kind
    const linked = row.linked as { name?: string } | null | undefined
    return (
      (row.label as string) ||
      linked?.name ||
      (row.text as string) ||
      ((row.room as { name?: string } | null)?.name ?? "") ||
      c.kind
    )
  }

  const { stepHistory } = useEditorKeys({
    // P in View, for those who may edit: into Edit, then the picker.
    onPlaceKey: openPlace,
    canEdit: editing,
    canToggleEdit: canEdit,
    onToggleEdit: changeEditing,
    selectTool,
    shapeEdits,
    canvasApi,
    view3d,
    traceParam,
    tracedRef,
    plan,
    ed,
    edits,
    structure,
    prefs,
    hiddenTileIds,
    closePopover: popover.close,
  })

  const exportPng = async () => {
    if (!exportRef.current || !plan) return
    const url = await toPng(exportRef.current, {
      backgroundColor: theme === "dark" ? "#09090b" : "#ffffff",
      pixelRatio: 2,
    })
    const a = document.createElement("a")
    a.href = url
    a.download = `${plan.name}.png`
    a.click()
  }

  const openTile = (tile: FloorPlanTile) => {
    if (tile.linked?.kind === "floorplan") {
      nav({ to: "/floorplans/$id", params: { id: tile.linked.id } })
      return
    }
    // Rack/device tiles open the contents + end-to-end trace sheet (from
    // the popover's Trace or a double-click - a click pins the popover).
    if (tile.linked?.kind === "rack" || tile.linked?.kind === "device") {
      popover.close()
      ed.setDeepTile(tile)
      return
    }
    // A cabinet tile opens its panel over the canvas - in place of the
    // popover a click pinned on the way.
    if (tile.linked?.kind === "cabinet") {
      popover.close()
      ed.setCabinetTileId(tile.id)
      return
    }
    setSelectedId(tile.id)
  }

  // From a device's paths in the deep-view: close the sheet and highlight one
  // cable, or a whole run (all its cables), on the plan - no Cables mode.
  const traceCablesOnMap = useCallback(
    (cableIds: string[]) => {
      ed.setDeepTile(null)
      ed.setCabinetTileId(null)
      prefs.setShowLinksLocal(true)
      ed.setHighlightCableIds(cableIds)
      const pts = cableIds
        .map((cid) => cablePaths.find((c) => c.id === cid))
        .filter((cp): cp is FloorPlanCablePath => !!cp)
        .flatMap((cp) => cableRoutePoints(cp, trays, shownTiles))
      if (pts.length >= 2)
        requestAnimationFrame(() => canvasApi.current?.focusPoints(pts))
      else if (cableIds.length)
        toast.info("That run isn't routed through a tray on this plan yet.")
    },
    [cablePaths, trays, shownTiles]
  )

  if (planQuery.isLoading) return <Loading />
  if (planQuery.isError) return <QueryError error={planQuery.error} />
  if (!plan) return null

  // The key to the Color by, in the corner of the 2D plan - inside its
  // export area - and of the 3D room.
  const colorLegend = colorBy !== "type" && capacity.hasRacks && (
    <div className="pointer-events-none absolute bottom-3 left-3 z-10">
      <ColorByLegend
        colorBy={colorBy}
        figures={capacity.legend.figures}
        alarm={capacity.legend.alarm}
      />
    </div>
  )

  // The background image's controls: a popover off the header on a wide
  // screen, a dialog from More on a narrow one.
  const backgroundControls = (
    <BackgroundControls
      plan={plan}
      cad={cad}
      uploadBackground={uploadBackground}
      patchPlan={patchPlan}
      onImageOverDrawing={ed.setPendingImage}
    />
  )

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {/* ── Header: which plan, which floor, which mode ──────────────── */}
      <PlanHeader
        plan={plan}
        stack={data.stack.data}
        isDirty={isDirty}
        canEdit={canEdit}
        canAdd={canDo("floorplan", "add")}
        view3d={view3d}
        editing={editing}
        onEditingChange={changeEditing}
      />

      {/* ── Second bar: find and view on the left, the panel, display and
          file actions on the right. */}
      <PlanToolbar
        plan={plan}
        mode={ed.mode}
        view3d={view3d}
        canEdit={editing}
        tiles={shownTiles}
        search={ed.search}
        onSearchChange={ed.setSearch}
        onPickTile={(tile) => {
          setSelectedId(tile.id)
          canvasApi.current?.focusTile(tile)
        }}
        onFit={() => canvasApi.current?.fit()}
        showGrid={ed.showGrid}
        onShowGridChange={ed.setShowGrid}
        prefs={prefs}
        hasRacks={capacity.hasRacks}
        drawingOpen={ed.drawingOpen}
        onToggleDrawing={() => ed.setDrawingOpen((o) => !o)}
        backgroundControls={liveView ? undefined : backgroundControls}
        exportMenu={
          <DrawingExportMenu
            name={plan.name}
            build={async () => ({
              svg: planSvg({
                plan,
                tiles: shownTiles,
                walls,
                trays,
                areas,
                shapes: shownShapes,
                colorBy,
                figures: capacity.figures,
                liveState: liveState.data ?? null,
                showZoneLabels: prefs.showZoneLabels,
                showTrays: prefs.showTrays,
              }),
              missing: 0,
            })}
            pdfUrl={`/api/floor-plans/${plan.id}/export/pdf/`}
            paperKey="floorplan:export"
            defaultPaper={{ size: "a3", orientation: "landscape" }}
            snapshot={view3d ? undefined : exportPng}
            svg={false}
            pdfExtra={() => ({
              legend: capacity.hasRacks
                ? colorByLegendEntries(
                    colorBy,
                    capacity.legend.figures,
                    capacity.legend.alarm
                  )
                : null,
            })}
          />
        }
        onOpenSettings={() => ed.setSettingsOpen(true)}
        onOpenBackground={() => ed.setBackgroundOpen(true)}
        canUndo={ed.draft.canUndo}
        canRedo={ed.draft.canRedo}
        onUndo={() => stepHistory("undo")}
        onRedo={() => stepHistory("redo")}
        isDirty={isDirty}
        saving={edits.save.isPending}
        onSave={() => edits.save.mutate()}
        placeSlot={
          editing && !view3d ? (
            <PlacePicker
              plan={plan}
              onFloor={onFloor}
              open={placeOpen}
              onOpenChange={(o) => (o ? openPlace() : setPlaceOpen(false))}
              near={near}
              onPlace={placeAtCentre}
              onShow={(tileId) => {
                const tile = tiles.find((t) => t.id === tileId)
                if (!tile) return
                if (ed.mode !== "layout") selectTool("select")
                setSelectedId(tile.id)
                canvasApi.current?.focusTile(tile)
              }}
              onAssignRooms={() => setAssignOpen(true)}
            />
          ) : undefined
        }
      />

      {/* ── Body: palette rail · canvas · inspector ─────────────────── */}
      <div className="flex min-h-0 flex-1">
        {editing && !view3d && (
          <ToolRail
            tool={ed.tool}
            onToolChange={selectTool}
            free={plan.layout_mode === "free"}
            onToggleFree={toggleFree}
            canToggleFree={!liveView}
          />
        )}
        {editing && !view3d && (
          <PlanRail
            plan={plan}
            ed={ed}
            trays={trays}
            walls={walls}
            areas={areas}
            tileTypes={tileTypes.data?.results}
            roles={roles.data?.results}
          />
        )}

        <div className="relative min-w-0 flex-1">
          {data.contentsQuery.isError && (
            <div className="p-4">
              <QueryError error={data.contentsQuery.error} />
            </div>
          )}
          {view3d && (
            <PlanScene3D
              plan={plan}
              liveState={liveState.data ?? null}
              hiddenTileIds={hiddenTileIds}
              traceCableId={traceParam ?? null}
              prefs={prefs}
              capacity={capacity}
              rackFocus={ed.rackFocus3d}
              cad={cad}
              cadFloorUrl={cadFloorUrl}
              colorLegend={colorLegend}
              areas={shownShapes}
              showHint={ed.show3dHint}
              onDismissHint={() => ed.setShow3dHint(false)}
            />
          )}
          {!view3d && (
            <PlanCanvas
              plan={plan}
              shownTiles={drawnTiles}
              shownShapes={shownShapes}
              shapeEdits={shapeEdits}
              canEdit={editing}
              onOpenShape={(s) => {
                if (s.kind === "area") setOpenArea(s.id)
              }}
              ed={ed}
              edits={edits}
              structure={structure}
              prefs={prefs}
              liveState={liveState.data ?? null}
              trays={trays}
              walls={walls}
              areas={areas}
              cablePaths={cablePaths}
              tileTypes={tileTypes.data?.results ?? []}
              roles={roles.data?.results ?? []}
              popover={popover}
              popoverFields={popoverFields}
              capacity={capacity}
              racksOpen={racksOpen}
              colorLegend={colorLegend}
              canvasApi={canvasApi}
              exportRef={exportRef}
              cad={cad}
              cadSource={cadSource}
              cadPxPerMm={cadPxPerMm}
              calibration={calibration}
              theme={theme}
              openTile={openTile}
              onDropRows={
                editing ? (rows, at) => placeAt(rows, at, true) : undefined
              }
              onSnapshotRect={
                editing && ed.tool === "snapshot"
                  ? (r) => setSnapshotCrop(r)
                  : undefined
              }
              lockedIds={liveView ? lockedIds : undefined}
              selectionToolbar={
                editing ? (
                  <SelectionToolbar
                    plan={plan}
                    tile={
                      selectedId
                        ? (tiles.find((t) => t.id === selectedId) ?? null)
                        : null
                    }
                    shape={
                      ed.shapes.find((sh) => sh.id === ed.selectedShapeId) ??
                      null
                    }
                    shapes={ed.shapes}
                    onTileDisplay={edits.setTileDisplay}
                    onRestackTile={edits.restackTile}
                    onDeleteTile={edits.deleteTile}
                    onSetRoom={applyRoom}
                    onChangeShape={shapeEdits.changeShape}
                    onRestackShape={shapeEdits.restack}
                    onDeleteShape={shapeEdits.deleteShape}
                  />
                ) : undefined
              }
              overlays={
                editing ? (
                  <>
                    {roomPrompt && (
                      <RoomPrompt
                        prompt={roomPrompt}
                        busy={setRooms.isPending}
                        onSet={() => applyRoom(roomPrompt)}
                        onDismiss={() => setRoomPrompt(null)}
                      />
                    )}
                    {data.contentsQuery.isSuccess &&
                      tiles.length === 0 &&
                      ed.shapes.length === 0 &&
                      ed.tool === "select" && (
                        <PlanEmptyState
                          onDrawRoom={() => selectTool("rect")}
                          onPlace={openPlace}
                        />
                      )}
                  </>
                ) : undefined
              }
            />
          )}
          {!editing &&
            !view3d &&
            (() => {
              const a = ed.shapes.find((s) => s.id === openArea)
              return a?.kind === "area" ? (
                <AreaPanel area={a} onClose={() => setOpenArea(null)} />
              ) : null
            })()}
        </div>

        {editing && !view3d && (
          <PlanInspector
            plan={plan}
            ed={ed}
            edits={edits}
            structure={structure}
            prefs={prefs}
            shapeEdits={shapeEdits}
            trays={trays}
            walls={walls}
            areas={areas}
            tileTypes={tileTypes.data?.results ?? []}
            roles={roles.data?.results ?? []}
            openTile={openTile}
          />
        )}
        {/* Outermost right aside, so it coexists with whichever inspector is
            open rather than fighting it for the gutter. */}
        {!showObjects && (
          <HiddenChip
            count={hiddenCount(hidden)}
            onShowAll={() => setHiddenPref(readFloorHidden(undefined))}
          />
        )}
        {showObjects && (
          <ObjectsSidebar
            tiles={tiles}
            liveState={liveState.data ?? null}
            selectedId={selectedId}
            onPick={(tile) => {
              if (hiddenTileIds.has(tile.id)) return
              setSelectedId(tile.id)
              canvasApi.current?.focusTile(tile)
            }}
            hidden={hidden}
            onHiddenChange={setHiddenPref}
            // While the rack table is open it lists the racks.
            omitRacks={racksOpen}
            unplaced={
              editing && !view3d ? (
                <UnplacedList
                  planId={id}
                  onFloor={onFloor}
                  onPlace={placeAtCentre}
                />
              ) : undefined
            }
            shapes={ed.shapes}
            selectedShapeId={editing ? ed.selectedShapeId : openArea}
            onPickShape={(s) => {
              const off =
                s.kind === "area"
                  ? hidden.areas.includes(s.id)
                  : hidden.labels.includes(s.id)
              if (off) return
              if (editing) {
                if (ed.mode !== "layout") selectTool("select")
                shapeEdits.select(s.id)
              } else if (s.kind === "area") setOpenArea(s.id)
              const b = shapeBounds(s, plan.cell_mm)
              canvasApi.current?.focusPoints([
                [b.minX, b.minY],
                [b.maxX, b.maxY],
              ])
            }}
          />
        )}
      </div>

      {/* The plan's racks while it is coloured by them: under the plan,
          the width of the page, its height dragged from its top edge. */}
      {racksOpen && (
        <RackTablePanel
          racks={capacity.rows}
          loading={capacity.query.isLoading}
          error={capacity.query.error}
          humanIds={humanIds}
          onHover={(r) => capacity.setPointRackId(r?.id ?? null)}
          onFocus={(r) => {
            const tile = shownTiles.find((t) => t.id === r.tileIds[0])
            if (!tile) return
            if (view3d) {
              ed.setRackFocus3d((cur) => ({
                tileId: tile.id,
                n: (cur?.n ?? 0) + 1,
              }))
              return
            }
            setSelectedId(tile.id)
            canvasApi.current?.focusTile(tile, 2)
          }}
          onMatchChange={capacity.setMatch}
          onClose={() => prefs.setViewPref("show_racks", false)}
        />
      )}

      <PlanDialogs
        plan={plan}
        ed={ed}
        cad={cad}
        uploadBackground={uploadBackground}
        createTray={structure.createTray}
        traceCablesOnMap={traceCablesOnMap}
        backgroundControls={backgroundControls}
        leaveGuard={leaveGuard}
      />
      <AssignRoomsDialog
        planId={id}
        open={assignOpen}
        onOpenChange={setAssignOpen}
      />
      <ConflictDialog
        conflicts={edits.conflicts}
        nameOf={conflictName}
        saving={edits.save.isPending}
        onResolve={edits.resolveConflicts}
        onCancel={edits.dismissConflicts}
      />
      <SnapshotDialog
        plan={plan}
        crop={snapshotCrop}
        onOpenChange={(o) => !o && setSnapshotCrop(null)}
        onCreated={(made) => {
          selectTool("select")
          void nav({ to: "/floorplans/$id", params: { id: made.id } })
        }}
      />
      <SnapAllDialog
        planId={plan.id}
        open={snapOpen}
        onOpenChange={setSnapOpen}
        isDirty={isDirty}
      />
      <ConfirmDialog
        open={leaveEditOpen}
        onOpenChange={setLeaveEditOpen}
        title="Leave Edit?"
        description="This plan has unsaved changes. Leaving Edit discards them."
        confirmLabel="Discard"
        destructive
        onConfirm={() => {
          ed.draft.load(data.serverTiles ?? [], data.serverShapes ?? [])
          setLeaveEditOpen(false)
          selectTool("select")
          setEdit(false)
        }}
      />
    </div>
  )
}
