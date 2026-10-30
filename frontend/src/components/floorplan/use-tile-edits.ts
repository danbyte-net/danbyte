import { useCallback, useEffect, useRef, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { ApiError, api } from "@/lib/api"
import type {
  FloorPlan,
  FloorPlanAreaWritePayload,
  FloorPlanBulkPayload,
  FloorPlanBulkResult,
  FloorPlanConflict,
  FloorPlanLabelWritePayload,
  FloorPlanPlaceable,
  FloorPlanTile,
  FloorPlanTileWritePayload,
  FloorTileDisplay,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"

import { resizedRect } from "./cabinet-tile"
import { findCollision, tileIsZone } from "./floor-canvas"
import {
  droppedRect,
  linkedTile,
  placeKey,
  placedOnFloor,
  placementRects,
} from "./placement"
import { moveSelection, rotateSelection } from "./selection"
import { shapesOf } from "./shapes"
import type { PlanShape, Pt } from "./shapes"
import { floorPlanContentsKey } from "./use-floor-plan-data"
import type { EditTile, PlanEditState } from "./use-plan-edit-state"

let tempCounter = 0
export const tempId = () => `new-${++tempCounter}`
export const isTemp = (id: string) => id.startsWith("new-")

/** An area as the bulk endpoint takes it. */
function areaBody(
  a: Extract<PlanShape, { kind: "area" }>
): FloorPlanAreaWritePayload {
  return {
    shape: a.shape,
    x: a.x,
    y: a.y,
    width: a.width,
    height: a.height,
    rotation: a.rotation,
    points: a.points,
    room_id: a.room?.id ?? null,
    location_id: a.location?.id ?? null,
    area_type_id: a.room || a.location ? null : (a.area_type?.id ?? null),
    label: a.label,
    color: a.color,
    fill_opacity: a.fill_opacity,
    border: a.border,
    show_name: a.show_name,
    z: a.z,
    locked: a.locked,
  }
}

/** A label as the bulk endpoint takes it. */
function labelBody(
  l: Extract<PlanShape, { kind: "label" }>
): FloorPlanLabelWritePayload {
  return {
    text: l.text,
    x: l.x,
    y: l.y,
    width: l.width,
    height: l.height,
    rotation: l.rotation,
    font_mm: l.font_mm,
    weight: l.weight,
    align: l.align,
    color: l.color,
    plate: l.plate,
    z: l.z,
    locked: l.locked,
  }
}

/** Every tile edit the Layout mode makes - on the local draft, which Save
 * writes in one bulk transaction with the areas and labels. */
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
  const free = plan?.layout_mode === "free"
  // A save refused as changed elsewhere (409): the rows, until settled.
  const [conflicts, setConflicts] = useState<FloorPlanConflict[] | null>(null)
  const [resave, setResave] = useState(false)
  // Versions taken over from a conflict ("Keep mine"), by row id.
  const rebase = useRef(new Map<string, string>())
  const {
    draft,
    tiles,
    shapes,
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
  // background and may overlap anything. A free plan lets tiles overlap.
  const changeTileGuarded = useCallback(
    (tileId: string, patch: Partial<FloorPlanTile>) => {
      const touchesGeometry =
        (!free && "x" in patch) ||
        "y" in patch ||
        "width" in patch ||
        "height" in patch
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
    [tiles, changeTile, free]
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
      if (!free && !armed.isZone && findCollision(tiles, candidate)) {
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
    [armed, plan, tiles, free]
  )

  /** Place devices, racks or cabinets at `at` (cells) - linked tiles with
   * no type, one step. An object already on the floor (saved or in the
   * draft) is never placed twice: one dropped alone (`move`) moves its
   * tile to the drop, otherwise it is selected; among several it is
   * skipped. Answers the tiles placed or moved. */
  const placeRows = useCallback(
    (
      rows: FloorPlanPlaceable[],
      at: Pt,
      { move = false }: { move?: boolean } = {}
    ): EditTile[] => {
      if (!plan || !rows.length) return []
      const onFloor = placedOnFloor(tiles)
      const seen = new Set<string>()
      const fresh: FloorPlanPlaceable[] = []
      const there: string[] = []
      for (const row of rows) {
        const key = placeKey(row.kind, row.id)
        if (seen.has(key)) continue
        seen.add(key)
        const tileId = onFloor.get(key)
        if (tileId) there.push(tileId)
        else fresh.push(row)
      }
      if (!fresh.length) {
        if (there.length === 1) {
          const tile = tiles.find((t) => t.id === there[0])
          const to = tile && move ? droppedRect(tile, at, plan, tiles) : null
          if (tile && to) changeTile(tile.id, to)
          else if (tile && move) toast.error("No room there.")
          setMultiSel(new Set())
          setSelectedId(there[0])
          return tile && to ? [{ ...tile, ...to }] : []
        }
        toast.info(`${there.length} already on this floor`)
        setSelectedId(null)
        setMultiSel(new Set(there))
        return []
      }
      if (there.length)
        toast.info(`${there.length} already on this floor, skipped`)
      const topZ = tiles.reduce((m, t) => Math.max(m, t.z ?? 0), 0)
      const placed = placementRects(fresh, at, plan, tiles).map((p, i) =>
        linkedTile(
          p.row,
          { x: p.x, y: p.y, width: p.width, height: p.height },
          tempId(),
          p.display,
          free ? topZ + 1 + i : 0
        )
      )
      if (placed.length < fresh.length)
        toast.error("No room left on the plan for all of them.")
      if (!placed.length) return []
      setTiles((prev) => [...prev, ...placed])
      setDirtyIds((prev) => {
        const next = new Set(prev)
        for (const t of placed) next.add(t.id)
        return next
      })
      setMultiSel(new Set(placed.length > 1 ? placed.map((t) => t.id) : []))
      setSelectedId(placed.length === 1 ? placed[0].id : null)
      return placed
    },
    [plan, tiles, free, changeTile]
  )

  /** Bring a free tile in front of every other (+1) or behind them (-1). */
  const restackTile = useCallback(
    (tileId: string, dir: 1 | -1) => {
      const zs = tiles.filter((t) => t.id !== tileId).map((t) => t.z ?? 0)
      const z = dir > 0 ? Math.max(0, ...zs) + 1 : Math.min(0, ...zs) - 1
      changeTile(tileId, { z })
    },
    [tiles, changeTile]
  )

  /** Show a device or rack as its photo or as its box. A free tile turned
   * to its photo takes the photo's proportions. */
  const setTileDisplay = useCallback(
    (tile: EditTile, display: FloorTileDisplay) => {
      const patch: Partial<FloorPlanTile> = { display }
      const aspect = tile.photo?.aspect
      if (display === "photo" && free && aspect)
        patch.height = Math.round(tile.width * aspect * 1000) / 1000
      changeTile(tile.id, patch)
    },
    [changeTile, free]
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
      if (
        quarter &&
        !free &&
        !tileIsZone(tile) &&
        findCollision(tiles, rect, tile.id)
      ) {
        toast.error("No room to rotate - a neighbour is in the way.")
        return
      }
      changeTile(tile.id, { orientation, ...rect })
    },
    [changeTile, plan, tiles, free]
  )

  const rotateTile = useCallback(
    (tile: EditTile) => setTileFacing(tile, (tile.orientation + 90) % 360),
    [setTileFacing]
  )

  // Size a tile to what it links to (a cabinet's footprint) - on its own
  // corner, inside the grid, and never onto a neighbour.
  const fitTile = useCallback(
    (tile: EditTile, size: { width: number; height: number }) => {
      if (!plan) return
      const rect = resizedRect(tile, size, plan)
      if (!free && !tileIsZone(tile) && findCollision(tiles, rect, tile.id)) {
        toast.error("No room to fit it - a neighbour is in the way.")
        return
      }
      changeTile(tile.id, rect)
    },
    [changeTile, plan, tiles, free]
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
        display: t.display ?? "icon",
        z: t.z ?? 0,
      })
      // The version each edit is based on: the row as loaded, or as taken
      // over in a conflict ("Keep mine").
      const base = new Map<string, string>()
      for (const r of [...draft.origin.tiles, ...draft.origin.shapes])
        base.set(r.id, r.updated_at)
      for (const [rid, v] of rebase.current) base.set(rid, v)
      const v = (rid: string) => {
        const version = base.get(rid)
        return version ? { version } : {}
      }
      const del = (rid: string) => {
        const version = base.get(rid)
        return version ? { id: rid, version } : rid
      }
      const areas = shapes.filter((s) => s.kind === "area")
      const labels = shapes.filter((s) => s.kind === "label")
      // Deleted ids are one set: a shape's carries its kind (`area:<id>`,
      // `label:<id>`), a tile's is bare.
      const gone = [...deletedIds]
      const goneOf = (kind: string) =>
        gone
          .filter((g) => g.startsWith(`${kind}:`))
          .map((g) => g.slice(kind.length + 1))
      const payload: FloorPlanBulkPayload = {
        tiles: {
          create: tiles.filter((t) => isTemp(t.id)).map(body),
          update: tiles
            .filter((t) => !isTemp(t.id) && dirtyIds.has(t.id))
            .map((t) => ({ id: t.id, ...v(t.id), ...body(t) })),
          delete: gone.filter((g) => !g.includes(":")).map(del),
        },
        areas: {
          create: areas.filter((a) => isTemp(a.id)).map(areaBody),
          update: areas
            .filter((a) => !isTemp(a.id) && dirtyIds.has(a.id))
            .map((a) => ({ id: a.id, ...v(a.id), ...areaBody(a) })),
          delete: goneOf("area").map(del),
        },
        labels: {
          create: labels.filter((l) => isTemp(l.id)).map(labelBody),
          update: labels
            .filter((l) => !isTemp(l.id) && dirtyIds.has(l.id))
            .map((l) => ({ id: l.id, ...v(l.id), ...labelBody(l) })),
          delete: goneOf("label").map(del),
        },
      }
      return api<FloorPlanBulkResult>(`/api/floor-plans/${id}/bulk/`, {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (fresh) => {
      // New rows have their real ids now: the history starts again.
      rebase.current.clear()
      setConflicts(null)
      draft.load(fresh.tiles, shapesOf(fresh.areas, fresh.labels))
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
    onError: (err) => {
      // Changed elsewhere since the plan was opened: nothing was written;
      // the conflict dialog asks, row by row, whose version stays.
      const body = err instanceof ApiError ? err.body : null
      if (
        err instanceof ApiError &&
        err.status === 409 &&
        body &&
        typeof body === "object" &&
        "conflicts" in body
      ) {
        setConflicts((body as { conflicts: FloorPlanConflict[] }).conflicts)
        return
      }
      apiErrorToast(err)
    },
  })

  /** Settle a 409: per row, "mine" keeps the edit (based on the row as it
   * is now - a row deleted elsewhere is made again) and "theirs" takes the
   * row as it is now (a row deleted elsewhere goes). Then saves again. */
  const resolveConflicts = useCallback(
    (choice: Record<string, "mine" | "theirs">) => {
      const list = conflicts ?? []
      const theirs = list.filter((c) => choice[c.id] === "theirs")
      const mine = list.filter((c) => choice[c.id] !== "theirs")
      const remade = new Map<string, string>()
      for (const c of mine) {
        if (c.current) rebase.current.set(c.id, c.current.updated_at)
        else remade.set(c.id, tempId())
      }
      const takeTile = (t: EditTile) => {
        const c = theirs.find((x) => x.id === t.id && x.kind === "tile")
        if (c) return c.current ? [c.current as EditTile] : []
        const nid = remade.get(t.id)
        return [nid ? { ...t, id: nid } : t]
      }
      const takeShape = (sh: PlanShape) => {
        const c = theirs.find((x) => x.id === sh.id && x.kind === sh.kind)
        if (c)
          return c.current
            ? [{ ...(c.current as object), kind: sh.kind } as PlanShape]
            : []
        const nid = remade.get(sh.id)
        return [nid ? { ...sh, id: nid } : sh]
      }
      // A row deleted here but changed there comes back when theirs stays.
      const back = <T extends { id: string }>(prev: T[], kinds: string[]) =>
        theirs
          .filter(
            (c) =>
              c.current &&
              kinds.includes(c.kind) &&
              !prev.some((r) => r.id === c.id)
          )
          .map((c) =>
            c.kind === "tile"
              ? (c.current as unknown as T)
              : ({ ...(c.current as object), kind: c.kind } as unknown as T)
          )
      setTiles((prev) => [...prev.flatMap(takeTile), ...back(prev, ["tile"])])
      ed.setShapes((prev) => [
        ...prev.flatMap(takeShape),
        ...back(prev, ["area", "label"]),
      ])
      setDirtyIds((prev) => {
        const next = new Set(prev)
        for (const c of theirs) next.delete(c.id)
        for (const [old, nid] of remade) {
          next.delete(old)
          next.add(nid)
        }
        return next
      })
      setDeletedIds((prev) => {
        const next = new Set(prev)
        for (const c of theirs) {
          next.delete(c.id)
          next.delete(`${c.kind}:${c.id}`)
        }
        return next
      })
      setConflicts(null)
      setResave(true)
    },
    [conflicts]
  )
  // Saved again once the draft holds the choices.
  useEffect(() => {
    if (!resave) return
    setResave(false)
    save.mutate()
  }, [resave])

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
    placeRows,
    restackTile,
    setTileDisplay,
    save,
    conflicts,
    resolveConflicts,
    dismissConflicts: () => setConflicts(null),
  }
}

export type TileEdits = ReturnType<typeof useTileEdits>
