import { useEffect, useMemo, useRef } from "react"
import { useNavigate } from "@tanstack/react-router"

import type { FloorPlan, FloorPlanTile } from "@/lib/api"
import { useTheme } from "@/components/theme-provider"

import { useCadCalibration } from "./cad-calibrate"
import { useCadSource } from "./cad-layer"
import { cableStubs } from "./cable-draw"
import { CELL } from "./floor-canvas"
import type { FloorCanvasApi } from "./floor-canvas"
import { visibleShapes, visibleTiles } from "./hidden"
import { PlanCanvas } from "./plan-canvas"
import { asPhotos } from "./placement"
import { raisedOutline } from "./raised-floor-shape"
import { shapeBounds } from "./shapes"
import type { PlanShape } from "./shapes"
import { structureLists } from "./structure"
import type { StructShape } from "./structure"
import { tileOpen } from "./tile-open"
import { DEFAULT_POPOVER_FIELDS, useTilePopover } from "./tile-popover"
import { useCableRoutes } from "./use-cable-routes"
import { useCadDrawing } from "./use-cad-drawing"
import { useFloorPlanData } from "./use-floor-plan-data"
import { usePlanCapacity, popoverShowsPorts } from "./use-plan-capacity"
import { usePlanEditState } from "./use-plan-edit-state"
import { usePlanMutations } from "./use-plan-mutations"
import { usePlanViewPrefs } from "./use-plan-view-prefs"
import { useShapeEdits } from "./use-shape-edits"
import { useStructureEdits } from "./use-structure-edits"
import { useTileEdits } from "./use-tile-edits"

/** A box in cell units. */
export interface CellBox {
  x: number
  y: number
  w: number
  h: number
}

/** What a read-only view frames: the whole grid when the plan shows a
 * background (a picture or a drawing spans the grid), else the box round
 * what is drawn on it - tiles, areas, labels, walls, trays and raised
 * floors - and the grid again for an empty plan. */
export function planContentBox(
  plan: Pick<
    FloorPlan,
    | "grid_width"
    | "grid_height"
    | "cell_mm"
    | "background_image"
    | "background_shown"
    | "drawing"
  >,
  tiles: readonly Pick<FloorPlanTile, "x" | "y" | "width" | "height">[],
  shapes: readonly PlanShape[],
  structure: readonly StructShape[]
): CellBox {
  const grid = { x: 0, y: 0, w: plan.grid_width, h: plan.grid_height }
  const backdrop =
    (!!plan.background_image || !!plan.drawing) &&
    plan.background_shown !== false
  if (backdrop) return grid
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const add = (x0: number, y0: number, x1: number, y1: number) => {
    if (![x0, y0, x1, y1].every(Number.isFinite)) return
    minX = Math.min(minX, x0)
    minY = Math.min(minY, y0)
    maxX = Math.max(maxX, x1)
    maxY = Math.max(maxY, y1)
  }
  const addPoints = (pts: readonly (readonly [number, number])[]) => {
    for (const [x, y] of pts) add(x, y, x, y)
  }
  for (const t of tiles) add(t.x, t.y, t.x + t.width, t.y + t.height)
  for (const s of shapes) {
    const b = shapeBounds(s, plan.cell_mm)
    add(b.minX, b.minY, b.maxX, b.maxY)
  }
  for (const r of structure) {
    if (r.part === "raised_floor") addPoints(raisedOutline(r))
    else addPoints(r.points)
  }
  if (!Number.isFinite(minX)) return grid
  // A cell of room round the content, and never thinner than a cell.
  return {
    x: minX - 1,
    y: minY - 1,
    w: Math.max(1, maxX - minX) + 2,
    h: Math.max(1, maxY - minY) + 2,
  }
}

/** A floor plan drawn read-only, as its page draws it for a viewer: the
 * same data hooks and query keys, the plan's saved Display settings, its
 * walls, areas, labels, trays and cable routes, through the page's own
 * `PlanCanvas` - with nothing editable and no side panels. Framed on its
 * content on load and whenever its box changes size (the dashboard). */
export function PlanView({ id }: { id: string }) {
  const nav = useNavigate()
  const { theme } = useTheme()
  const data = useFloorPlanData(id, { catalogs: false })
  const { plan, liveState, popoverCfg, cablePaths, trays } = data
  const ed = usePlanEditState(
    id,
    data.serverTiles,
    data.serverShapes,
    data.serverStructure
  )
  const { patchPlan } = usePlanMutations(id)
  // A viewer's prefs: the plan's saved state; nothing written back.
  const prefs = usePlanViewPrefs({ id, plan, canEdit: false, patchPlan })
  const edits = useTileEdits({ id, plan, ed })
  const structure = useStructureEdits({ id, plan, ed })
  const shapeEdits = useShapeEdits({ plan, ed })
  const { walls, raised: areas } = useMemo(
    () => structureLists(ed.structure),
    [ed.structure]
  )

  const shownTiles = useMemo(
    () => visibleTiles(ed.tiles, prefs.hidden),
    [ed.tiles, prefs.hidden]
  )
  const drawnTiles = useMemo(
    () => (prefs.showPhotos ? asPhotos(shownTiles) : shownTiles),
    [shownTiles, prefs.showPhotos]
  )
  const shownShapes = useMemo(
    () => visibleShapes(ed.shapes, prefs.hidden),
    [ed.shapes, prefs.hidden]
  )
  const cableRoutes = useCableRoutes(
    cablePaths,
    trays,
    shownTiles,
    plan?.ceiling_mm,
    areas
  )
  const stubs = useMemo(
    () =>
      plan
        ? cableStubs(cablePaths, cableRoutes, shownTiles, [
            plan.grid_width / 2,
            plan.grid_height / 2,
          ])
        : [],
    [plan, cablePaths, cableRoutes, shownTiles]
  )

  const popover = useTilePopover()
  const popoverFields = useMemo(() => {
    const cfg = popoverCfg.data
    if (!cfg) return DEFAULT_POPOVER_FIELDS
    const slug = popover.target?.tile.tile_type?.slug
    return (slug && cfg.tile_overrides[slug]) || cfg.fields
  }, [popoverCfg.data, popover.target])
  const capacity = usePlanCapacity({
    planId: id,
    tiles: shownTiles,
    live: liveState.data ?? null,
    colorBy: prefs.colorBy,
    wantPorts: popoverShowsPorts(popoverCfg.data),
  })
  const cad = useCadDrawing(plan, false)
  const cadSource = useCadSource(id, cad.drawing, cad.placement)
  const cadPxPerMm = CELL / (plan?.cell_mm || 600)
  const calibration = useCadCalibration(
    id,
    cad.drawing,
    cad.placement,
    cadPxPerMm
  )
  const canvasApi = useRef<FloorCanvasApi | null>(null)
  const exportRef = useRef<HTMLDivElement>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  // Frame the content once it has landed, and again on every resize - a
  // dashboard cell is measured after first paint and changes with the grid.
  const box = useMemo(
    () =>
      plan ? planContentBox(plan, shownTiles, shownShapes, ed.structure) : null,
    [plan, shownTiles, shownShapes, ed.structure]
  )
  const boxKey = box ? `${box.x},${box.y},${box.w},${box.h}` : ""
  const boxNow = useRef(box)
  boxNow.current = box
  useEffect(() => {
    const el = boxRef.current
    if (!el || !boxKey) return
    const fit = () => {
      const b = boxNow.current
      if (b) canvasApi.current?.fitBox?.(b)
    }
    const frame = requestAnimationFrame(fit)
    if (typeof ResizeObserver === "undefined")
      return () => cancelAnimationFrame(frame)
    const ro = new ResizeObserver(() => fit())
    ro.observe(el)
    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
    }
  }, [boxKey])

  if (!plan) return null

  // A nested plan opens; a rack, device or cabinet opens on its plan's page
  // (its detail panel lives there); anything else pins its popover.
  const openTile = (tile: FloorPlanTile) => {
    const how = tileOpen(tile)
    if (how.kind === "plan") {
      void nav({ to: "/floorplans/$id", params: { id: how.id } })
      return
    }
    if (how.kind === "panel") {
      void nav({
        to: "/floorplans/$id",
        params: { id: plan.id },
        search: { tile: tile.id },
      })
      return
    }
    popover.pinTile(tile, canvasApi.current?.tilePoint?.(tile) ?? undefined)
  }

  return (
    <div ref={boxRef} className="relative h-full w-full">
      <PlanCanvas
        plan={plan}
        shownTiles={drawnTiles}
        shownShapes={shownShapes}
        shapeEdits={shapeEdits}
        canEdit={false}
        onOpenShape={(s) => {
          if (s.opens)
            void nav({ to: "/floorplans/$id", params: { id: s.opens.id } })
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
        cableRoutes={cableRoutes}
        cableStubs={stubs}
        onOpenCable={(cid) => ed.setHighlightCableIds(cid ? [cid] : [])}
        tileTypes={[]}
        roles={[]}
        popover={popover}
        popoverFields={popoverFields}
        capacity={capacity}
        racksOpen={false}
        colorLegend={null}
        canvasApi={canvasApi}
        exportRef={exportRef}
        cad={cad}
        cadSource={cadSource}
        cadPxPerMm={cadPxPerMm}
        calibration={calibration}
        theme={theme}
        openTile={openTile}
      />
    </div>
  )
}
