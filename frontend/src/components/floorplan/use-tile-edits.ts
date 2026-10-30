import { useCallback } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  FloorPlan,
  FloorPlanTile,
  FloorPlanTilesBulkPayload,
  FloorPlanTileWritePayload,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"

import { resizedRect } from "./cabinet-tile"
import { findCollision, tileIsZone } from "./floor-canvas"
import { moveSelection, rotateSelection } from "./selection"
import { floorPlanContentsKey } from "./use-floor-plan-data"
import type { EditTile, PlanEditState } from "./use-plan-edit-state"

let tempCounter = 0
const tempId = () => `new-${++tempCounter}`
export const isTemp = (id: string) => id.startsWith("new-")

/** Every tile edit the Layout mode makes - on the local draft, which Save
 * writes in one bulk transaction. */
export function useTileEdits({
  id,
  plan,
  ed,
}: {
  id: string
  plan: FloorPlan | undefined
  ed: PlanEditState
}) {
  const qc = useQueryClient()
  const {
    draft,
    tiles,
    dirtyIds,
    deletedIds,
    setTiles,
    setDirtyIds,
    setDeletedIds,
    multiSel,
    setMultiSel,
    setSelectedId,
    armed,
  } = ed

  const changeTile = useCallback(
    (tileId: string, patch: Partial<FloorPlanTile>) => {
      setTiles((prev) =>
        prev.map((t) => (t.id === tileId ? { ...t, ...patch } : t))
      )
      setDirtyIds((prev) =>
        prev.has(tileId) ? prev : new Set(prev).add(tileId)
      )
    },
    []
  )

  // Geometry edits (canvas drags, nudges, resizes) refuse to stack tiles -
  // the candidate rect must be free of other non-zone tiles. Zones are
  // background and may overlap anything.
  const changeTileGuarded = useCallback(
    (tileId: string, patch: Partial<FloorPlanTile>) => {
      const touchesGeometry =
        "x" in patch || "y" in patch || "width" in patch || "height" in patch
      if (touchesGeometry) {
        const tile = tiles.find((t) => t.id === tileId)
        if (tile && !tileIsZone(tile)) {
          const rect = {
            x: patch.x ?? tile.x,
            y: patch.y ?? tile.y,
            width: patch.width ?? tile.width,
            height: patch.height ?? tile.height,
          }
          if (findCollision(tiles, rect, tileId)) return
        }
      }
      changeTile(tileId, patch)
    },
    [tiles, changeTile]
  )

  // The multi-selection as one piece (selection.ts): moved by whole cells,
  // or turned a quarter about its middle - all of it or none of it, inside
  // the grid and never onto a tile outside it. One undo step either way.
  const applyPatches = useCallback(
    (patches: Map<string, Partial<FloorPlanTile>>) => {
      for (const [tid, patch] of patches) changeTile(tid, patch)
    },
    [changeTile]
  )
  const moveSelectionBy = useCallback(
    (dx: number, dy: number): boolean => {
      if (!plan || (!dx && !dy)) return false
      const patches = moveSelection(tiles, multiSel, dx, dy, plan)
      if (!patches) return false
      applyPatches(patches)
      return true
    },
    [plan, tiles, multiSel, applyPatches]
  )
  const rotateSelectionTurn = useCallback(() => {
    if (!plan) return
    const patches = rotateSelection(tiles, multiSel, plan)
    if (!patches) {
      toast.error("No room to turn the selection - a neighbour is in the way.")
      return
    }
    applyPatches(patches)
  }, [plan, tiles, multiSel, applyPatches])

  const createAt = useCallback(
    (rect: { x: number; y: number; w: number; h: number }) => {
      if (!armed || !plan) return
      // A plain click paints a 1×1 rect - use the palette entry's default
      // footprint there; an actual drag wins.
      const w =
        rect.w === 1 && rect.h === 1
          ? Math.min(armed.defaultWidth, plan.grid_width - rect.x)
          : rect.w
      const h =
        rect.w === 1 && rect.h === 1
          ? Math.min(armed.defaultHeight, plan.grid_height - rect.y)
          : rect.h
      const candidate = {
        x: rect.x,
        y: rect.y,
        width: Math.max(1, w),
        height: Math.max(1, h),
      }
      // Zones may cover anything; normal tiles never stack.
      if (!armed.isZone && findCollision(tiles, candidate)) {
        toast.error("Tiles can't stack - that spot is taken.")
        return
      }
      const now = new Date().toISOString()
      const tile: EditTile = {
        id: tempId(),
        ...candidate,
        tile_type:
          armed.kind === "tile_type"
            ? {
                id: armed.id,
                name: armed.name,
                slug: "",
                color: armed.color,
                icon: armed.icon,
                default_width: armed.defaultWidth,
                default_height: armed.defaultHeight,
                is_zone: armed.isZone,
                has_fov: armed.hasFov,
              }
            : null,
        role_type:
          armed.kind === "role"
            ? {
                id: armed.id,
                name: armed.name,
                slug: "",
                color: armed.color,
                is_patch_panel: false,
                has_fov: armed.hasFov,
              }
            : null,
        orientation: 0,
        label: "",
        color: "",
        status: "",
        link_kind: "",
        linked: null,
        // Camera types start with a visible cone so the controls make sense.
        fov_deg: armed.hasFov ? 90 : null,
        fov_distance: armed.hasFov ? 3 : null,
        fov_direction: armed.hasFov ? 0 : null,
        fov_anchor: "",
        fov_ptz: false,
        created_at: now,
        updated_at: now,
      }
      setTiles((prev) => [...prev, tile])
      setDirtyIds((prev) => new Set(prev).add(tile.id))
      setSelectedId(tile.id)
    },
    [armed, plan, tiles]
  )

  const deleteTile = useCallback((tileId: string) => {
    setTiles((prev) => prev.filter((t) => t.id !== tileId))
    setDirtyIds((prev) => {
      const next = new Set(prev)
      next.delete(tileId)
      return next
    })
    if (!isTemp(tileId)) setDeletedIds((prev) => new Set(prev).add(tileId))
    setSelectedId((cur) => (cur === tileId ? null : cur))
  }, [])

  // Set an absolute facing (orientation). A quarter-turn (90/270 delta) swaps
  // the grid footprint - same invariant the relative rotate keeps.
  const setTileFacing = useCallback(
    (tile: EditTile, orientation: EditTile["orientation"]) => {
      if (!plan || orientation === tile.orientation) return
      const quarter = (orientation - tile.orientation + 360) % 180 !== 0
      const width = quarter ? tile.height : tile.width
      const height = quarter ? tile.width : tile.height
      const rect = {
        width,
        height,
        x: Math.min(tile.x, Math.max(0, plan.grid_width - width)),
        y: Math.min(tile.y, Math.max(0, plan.grid_height - height)),
      }
      if (quarter && !tileIsZone(tile) && findCollision(tiles, rect, tile.id)) {
        toast.error("No room to rotate - a neighbour is in the way.")
        return
      }
      changeTile(tile.id, { orientation, ...rect })
    },
    [changeTile, plan, tiles]
  )

  const rotateTile = useCallback(
    (tile: EditTile) =>
      setTileFacing(
        tile,
        ((tile.orientation + 90) % 360) as EditTile["orientation"]
      ),
    [setTileFacing]
  )

  // Size a tile to what it links to (a cabinet's footprint) - on its own
  // corner, inside the grid, and never onto a neighbour.
  const fitTile = useCallback(
    (tile: EditTile, size: { width: number; height: number }) => {
      if (!plan) return
      const rect = resizedRect(tile, size, plan)
      if (!tileIsZone(tile) && findCollision(tiles, rect, tile.id)) {
        toast.error("No room to fit it - a neighbour is in the way.")
        return
      }
      changeTile(tile.id, rect)
    },
    [changeTile, plan, tiles]
  )

  // ── Save (explicit, one bulk transaction) ──────────────────────────────
  const save = useMutation({
    mutationFn: async () => {
      const body = (t: EditTile): FloorPlanTileWritePayload => ({
        x: t.x,
        y: t.y,
        width: t.width,
        height: t.height,
        tile_type_id: t.tile_type?.id ?? null,
        role_type_id: t.role_type?.id ?? null,
        orientation: t.orientation,
        label: t.label,
        color: t.color,
        status: t.status,
        link_kind: t.linked ? t.linked.kind : "",
        link_id: t.linked?.id ?? "",
        fov_deg: t.fov_deg,
        fov_distance: t.fov_distance,
        fov_direction: t.fov_direction,
        fov_anchor: t.fov_anchor,
        fov_ptz: t.fov_ptz,
      })
      const payload: FloorPlanTilesBulkPayload = {
        create: tiles.filter((t) => isTemp(t.id)).map(body),
        update: tiles
          .filter((t) => !isTemp(t.id) && dirtyIds.has(t.id))
          .map((t) => ({ id: t.id, ...body(t) })),
        delete: [...deletedIds],
      }
      return api<FloorPlanTile[]>(`/api/floor-plans/${id}/tiles/bulk/`, {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (fresh) => {
      // New tiles have their real ids now: the history starts again.
      draft.load(fresh)
      setMultiSel(new Set())
      setSelectedId(null)
      // The plan's contents - the dashboard widget reads them too.
      qc.invalidateQueries({ queryKey: floorPlanContentsKey(id) })
      qc.invalidateQueries({ queryKey: ["floor-plan", id] })
      qc.invalidateQueries({ queryKey: ["floor-plans"] })
      // Tile moves change cable endpoints - refresh the routed paths too.
      qc.invalidateQueries({ queryKey: ["floor-plan-cable-paths", id] })
      // A tile linked to another rack changes which racks the plan holds.
      qc.invalidateQueries({ queryKey: ["floor-plan-racks", id] })
      toast.success("Floor plan saved")
    },
    onError: (err) => apiErrorToast(err),
  })

  return {
    changeTile,
    changeTileGuarded,
    moveSelectionBy,
    rotateSelectionTurn,
    createAt,
    deleteTile,
    setTileFacing,
    rotateTile,
    fitTile,
    save,
  }
}

export type TileEdits = ReturnType<typeof useTileEdits>
