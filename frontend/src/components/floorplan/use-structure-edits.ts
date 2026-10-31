import { useCallback } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  FloorPlan,
  FloorPlanTray,
  FloorPlanTrayWritePayload,
  FloorPlanWallOpening,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"

import { viaQuery } from "./snapshot"
import {
  areaOutline,
  doorFromDrag,
  fitOpenings,
  flipDoor,
  joinRuns,
  rectsOverlap,
  splitRun,
  structureLists,
  wallsAround,
} from "./structure"
import type {
  RaisedRow,
  RunRow,
  StructShape,
  TrayRow,
  WallRow,
} from "./structure"
import type { Pt } from "./shapes"
import { floorPlanContentsKey } from "./use-floor-plan-data"
import type { PlanEditState } from "./use-plan-edit-state"
import { isTemp, tempId } from "./use-tile-edits"

/** Where the thickness a wall was last given is kept, in this browser. */
const THICKNESS_KEY = "floorplan:wall-thickness"

/** The thickness the next new wall gets: the one last set on a wall here,
 * else none (the standard 100 mm). */
export function lastWallThickness(): number | null {
  try {
    const v = Number(window.localStorage.getItem(THICKNESS_KEY))
    return Number.isFinite(v) && v >= 20 && v <= 2000 ? v : null
  } catch {
    return null
  }
}

export function rememberWallThickness(mm: number | null) {
  try {
    if (mm == null) window.localStorage.removeItem(THICKNESS_KEY)
    else window.localStorage.setItem(THICKNESS_KEY, String(mm))
  } catch {
    // Storage blocked: the next wall takes the standard thickness.
  }
}

const now = () => new Date().toISOString()

/** A new wall in the draft, from its points. */
export function newWall(points: Pt[], extra: Partial<WallRow> = {}): WallRow {
  return {
    part: "wall",
    id: tempId(),
    label: "",
    points,
    height_mm: null,
    thickness_mm: lastWallThickness(),
    color: "",
    openings: [],
    created_at: now(),
    updated_at: "",
    ...extra,
  }
}

/** Structure edits - raised floors, walls (with their doors) and trays - on
 * the editor's draft, like tiles: each one an undo step, all written by
 * Save. A tray's cables are the exception: they are written at once. */
export function useStructureEdits({
  id,
  plan,
  ed,
  onVersion,
}: {
  id: string
  plan: FloorPlan | undefined
  ed: PlanEditState
  /** A row was written outside the draft: the version its edits are now
   * based on. */
  onVersion?: (rowId: string, version: string) => void
}) {
  const qc = useQueryClient()
  const via = viaQuery(plan)
  const {
    structure,
    setStructure,
    setDirtyIds,
    setDeletedIds,
    areaArmed,
    setAreaArmed,
    setSelectedAreaId,
    setSelectedWallId,
    setDoorArmed,
    setSelectedDoor,
    setSelectedTrayId,
    setStructSel,
    setDrawPoints,
    setNamingPoints,
    mode,
  } = ed
  const grid = plan
    ? { w: plan.grid_width, h: plan.grid_height }
    : { w: 0, h: 0 }

  const markDirty = useCallback(
    (ids: string[]) =>
      setDirtyIds((prev) => {
        if (ids.every((x) => prev.has(x))) return prev
        const next = new Set(prev)
        for (const x of ids) next.add(x)
        return next
      }),
    [setDirtyIds]
  )

  /** Rows changed, made and removed together - one undo step. */
  const commit = useCallback(
    ({
      update = [],
      create = [],
      remove = [],
    }: {
      update?: StructShape[]
      create?: StructShape[]
      remove?: string[]
    }) => {
      const byId = new Map(update.map((r) => [r.id, r]))
      const gone = new Set(remove)
      setStructure((prev) => [
        ...prev.filter((r) => !gone.has(r.id)).map((r) => byId.get(r.id) ?? r),
        ...create,
      ])
      markDirty([...update, ...create].map((r) => r.id))
      if (gone.size) {
        const rows = structure.filter((r) => gone.has(r.id))
        setDirtyIds((prev) => {
          const next = new Set(prev)
          for (const x of gone) next.delete(x)
          return next
        })
        const saved = rows.filter((r) => !isTemp(r.id))
        if (saved.length)
          setDeletedIds((prev) => {
            const next = new Set(prev)
            for (const r of saved) next.add(`${r.part}:${r.id}`)
            return next
          })
      }
    },
    [structure, setStructure, markDirty, setDirtyIds, setDeletedIds]
  )

  const find = useCallback(
    (rowId: string) => structure.find((r) => r.id === rowId),
    [structure]
  )
  /** One row patched. */
  const change = useCallback(
    (rowId: string, patch: Partial<StructShape>) => {
      const row = find(rowId)
      if (!row) return
      commit({ update: [{ ...row, ...patch } as StructShape] })
    },
    [find, commit]
  )
  const remove = useCallback(
    (rowId: string) => commit({ remove: [rowId] }),
    [commit]
  )

  // ── Raised floors ──────────────────────────────────────────────────────
  const raisedFits = (
    rowId: string | null,
    rect: { x: number; y: number; width: number; height: number }
  ) =>
    !structureLists(structure).raised.some(
      (r) => r.id !== rowId && rectsOverlap(r, rect)
    )
  const patchArea = (areaId: string, body: Partial<RaisedRow>) => {
    const row = find(areaId)
    if (row?.part !== "raised_floor") return
    const next = { ...row, ...body }
    if (!raisedFits(areaId, next)) {
      toast.error("Raised floors must not overlap.")
      return
    }
    change(areaId, body)
  }
  const deleteArea = (areaId: string) => {
    remove(areaId)
    setSelectedAreaId(null)
  }
  /** Structure mode: a completed drag-rect becomes a raised-floor area. */
  const createAreaAt = (rect: {
    x: number
    y: number
    w: number
    h: number
  }) => {
    if (!areaArmed || !plan) return
    const row: RaisedRow = {
      part: "raised_floor",
      id: tempId(),
      x: rect.x,
      y: rect.y,
      width: rect.w,
      height: rect.h,
      plenum_mm: 300,
      label: "",
      color: "",
      created_at: now(),
      updated_at: "",
    }
    if (!raisedFits(null, row)) {
      toast.error("Raised floors must not overlap.")
      return
    }
    commit({ create: [row] })
    setSelectedAreaId(row.id)
    setAreaArmed(false)
  }

  // ── Walls and doors ────────────────────────────────────────────────────
  const wallOf = (wallId: string): WallRow | null => {
    const w = find(wallId)
    return w?.part === "wall" ? w : null
  }
  const patchWall = (wallId: string, body: Partial<WallRow>) => {
    const w = wallOf(wallId)
    if (!w) return
    // Points moved under the doors: each stays inside its segment.
    const openings =
      body.points && !body.openings
        ? fitOpenings(body.points, w.openings)
        : body.openings
    if ("thickness_mm" in body) rememberWallThickness(body.thickness_mm ?? null)
    change(wallId, openings ? { ...body, openings } : body)
  }
  const deleteWall = (wallId: string) => {
    remove(wallId)
    setSelectedWallId(null)
    setSelectedDoor(null)
  }
  const createWall = (points: Pt[]) => {
    const w = newWall(points)
    commit({ create: [w] })
    setSelectedWallId(w.id)
    return w
  }
  /** A door dragged (or clicked) along segment `seg` from `t0` to `t1`
   * cells. */
  const addDoor = (wallId: string, seg: number, t0: number, t1: number) => {
    const w = wallOf(wallId)
    if (!w || !plan) return
    const span = doorFromDrag(w.points, w.openings, seg, t0, t1, plan.cell_mm)
    if (!span) {
      toast.error("No room for a door there.")
      return
    }
    const door: FloorPlanWallOpening = {
      seg,
      ...span,
      height_mm: null,
      hinge: "start",
      side: "left",
    }
    const openings = [...w.openings, door].sort(
      (a, b) => a.seg - b.seg || a.from - b.from
    )
    change(wallId, { openings })
    setDoorArmed(false)
    setSelectedWallId(wallId)
    setSelectedDoor({ wallId, index: openings.indexOf(door) })
  }
  /** "Add door here": a door of the standard width at `at` cells. */
  const placeDoor = (wallId: string, seg: number, at: number) =>
    addDoor(wallId, seg, at, at)
  const changeDoor = (
    wallId: string,
    index: number,
    door: FloorPlanWallOpening
  ) => {
    const w = wallOf(wallId)
    if (!w || !w.openings[index]) return
    change(wallId, {
      openings: w.openings.map((o, i) => (i === index ? door : o)),
    })
  }
  const flipDoorAt = (wallId: string, index: number) => {
    const o = wallOf(wallId)?.openings[index]
    if (o) changeDoor(wallId, index, flipDoor(o))
  }
  const deleteDoor = (wallId: string, index: number) => {
    const w = wallOf(wallId)
    if (!w) return
    change(wallId, { openings: w.openings.filter((_, i) => i !== index) })
    setSelectedDoor(null)
  }

  /** Walls round areas (rectangles at any turn, polygons): one per unbroken
   * stretch of outline, joined at the corners, leaving out what a wall
   * already runs along - one undo step. */
  const wallsAroundAreas = (areaIds: string[]) => {
    if (!plan) return
    const outlines = ed.shapes
      .filter((s) => s.kind === "area" && areaIds.includes(s.id))
      .map((s) => areaOutline(s as Extract<typeof s, { kind: "area" }>))
    const runs = wallsAround(outlines, structureLists(structure).walls, grid)
    if (!runs.length) {
      toast.info("Walls already run all the way round.")
      return
    }
    const made = runs.map((points) => newWall(points))
    commit({ create: made })
    setSelectedWallId(made[0].id)
    toast.success(
      made.length === 1 ? "Added a wall" : `Added ${made.length} walls`
    )
  }

  // ── Trays ─────────────────────────────────────────────────────────────
  const createTray = (payload: FloorPlanTrayWritePayload) => {
    const row: TrayRow = {
      part: "tray",
      id: tempId(),
      name: payload.name ?? "",
      kind: payload.kind ?? "",
      color: payload.color ?? "",
      points: payload.points ?? [],
      level: payload.level ?? "overhead",
      elevation_mm: payload.elevation_mm ?? null,
      capacity: payload.capacity ?? null,
      description: payload.description ?? "",
      cables: [],
      hidden_cable_count: 0,
      created_at: now(),
      updated_at: "",
    }
    commit({ create: [row] })
    setSelectedTrayId(row.id)
  }
  const patchTray = (trayId: string, patch: FloorPlanTrayWritePayload) => {
    const { cable_ids: cableIds, ...rest } = patch
    if (cableIds) {
      patchCables.mutate({ trayId, cableIds })
      return
    }
    change(trayId, rest)
  }
  const deleteTray = (trayId: string) => {
    remove(trayId)
    setSelectedTrayId(null)
  }
  // A tray's cables are written at once: the cable side keeps its own
  // rules (who may change which cable), and a route reads them.
  const patchCables = useMutation({
    mutationFn: ({
      trayId,
      cableIds,
    }: {
      trayId: string
      cableIds: string[]
    }) =>
      api<FloorPlanTray>(`/api/floor-plan-trays/${trayId}/${via}`, {
        method: "PATCH",
        body: JSON.stringify({ cable_ids: cableIds }),
      }),
    onSuccess: (tray) => {
      onVersion?.(tray.id, tray.updated_at)
      qc.invalidateQueries({ queryKey: floorPlanContentsKey(id) })
      qc.invalidateQueries({ queryKey: ["floor-plan-cable-paths", id] })
    },
    onError: (err) => apiErrorToast(err),
  })

  // ── Runs: split and join ──────────────────────────────────────────────
  /** A wall or tray cut in two at `t` cells along segment `seg`. */
  const splitAt = (rowId: string, seg: number, t: number) => {
    const row = find(rowId)
    if (!row || row.part === "raised_floor") return
    const parts = splitRun(
      row.points,
      row.part === "wall" ? row.openings : [],
      seg,
      t,
      grid
    )
    if (!parts) {
      toast.error(
        row.part === "wall"
          ? "Split a wall between its doors, not at an end."
          : "Split a tray between its ends."
      )
      return
    }
    const first = { ...row, points: parts.a.points }
    const second = {
      ...row,
      id: tempId(),
      updated_at: "",
      points: parts.b.points,
    }
    if (first.part === "wall" && second.part === "wall") {
      first.openings = parts.a.openings
      second.openings = parts.b.openings
    }
    if (second.part === "tray") second.name = `${second.name} 2`.trim()
    commit({ update: [first], create: [second] })
  }
  /** Two walls (or two trays) that touch end to end made one. */
  const join = (aId: string, bId: string) => {
    const a = find(aId)
    const b = find(bId)
    if (!a || !b || a.part !== b.part || a.part === "raised_floor") return
    const ra = a
    const rb = b as RunRow
    const joined = joinRuns(
      { points: ra.points, openings: ra.part === "wall" ? ra.openings : [] },
      { points: rb.points, openings: rb.part === "wall" ? rb.openings : [] }
    )
    if (!joined) {
      toast.error("Only runs that meet end to end join.")
      return
    }
    const merged = { ...ra, points: joined.points }
    if (merged.part === "wall") merged.openings = joined.openings
    if (merged.part === "tray" && rb.part === "tray") {
      const ids = new Set(merged.cables.map((c) => c.id))
      merged.cables = [
        ...merged.cables,
        ...rb.cables.filter((c) => !ids.has(c.id)),
      ]
    }
    commit({ update: [merged], remove: [rb.id] })
    setStructSel(new Set())
    if (merged.part === "wall") setSelectedWallId(merged.id)
    else setSelectedTrayId(merged.id)
  }

  /** A bend put into a wall or tray at `t` cells along segment `seg`. */
  const addBend = (rowId: string, seg: number, t: number) => {
    const row = find(rowId)
    if (!row || row.part === "raised_floor") return
    const parts = splitRun(
      row.points,
      row.part === "wall" ? row.openings : [],
      seg,
      t,
      grid
    )
    if (!parts) return
    const joined = joinRuns(parts.a, parts.b)
    if (!joined) return
    change(rowId, {
      points: joined.points,
      ...(row.part === "wall" ? { openings: joined.openings } : {}),
    })
  }
  /** Point `index` of a wall or tray taken out (a run keeps two); the
   * segments either side become one, their doors on it. */
  const removePoint = (rowId: string, index: number) => {
    const row = find(rowId)
    if (!row || row.part === "raised_floor" || row.points.length <= 2) return
    const points = row.points.filter((_, i) => i !== index)
    if (row.part === "tray") {
      change(rowId, { points })
      return
    }
    const before =
      index > 0
        ? Math.hypot(
            row.points[index][0] - row.points[index - 1][0],
            row.points[index][1] - row.points[index - 1][1]
          )
        : 0
    const openings = row.openings.flatMap((o) => {
      if (index === 0) return o.seg === 0 ? [] : [{ ...o, seg: o.seg - 1 }]
      if (index === row.points.length - 1) return o.seg === index - 1 ? [] : [o]
      if (o.seg < index) return [o]
      if (o.seg === index)
        return [
          { ...o, seg: index - 1, from: o.from + before, to: o.to + before },
        ]
      return [{ ...o, seg: o.seg - 1 }]
    })
    change(rowId, { points, openings: fitOpenings(points, openings) })
  }
  /** A wall, tray or raised floor deleted. */
  const deleteRow = (rowId: string) => {
    const row = find(rowId)
    if (!row) return
    if (row.part === "wall") deleteWall(rowId)
    else if (row.part === "tray") deleteTray(rowId)
    else deleteArea(rowId)
  }

  // ── Drawing a wall or a tray ──────────────────────────────────────────
  const addDrawPoint = useCallback((pt: [number, number]) => {
    setDrawPoints((prev) => {
      const arr = prev ?? []
      // Skip a duplicate of the last vertex (e.g. the extra click a
      // double-click-to-finish produces), so runs don't get zero-length hops.
      const last = arr.length ? arr[arr.length - 1] : null
      if (last && last[0] === pt[0] && last[1] === pt[1]) return arr
      return [...arr, pt]
    })
  }, [])
  // One polyline rig, two products: Cables mode finishes into the tray
  // naming dialog; Structure mode makes the wall at once (its inspector
  // opens on it for the rest).
  const finishDraw = () => {
    const pts = ed.drawPoints
    setDrawPoints(null)
    if (!pts || pts.length < 2) return
    if (mode === "structure") createWall(pts)
    else setNamingPoints(pts)
  }

  return {
    commit,
    change,
    patchArea,
    deleteArea,
    createAreaAt,
    patchWall,
    deleteWall,
    createWall,
    addDoor,
    placeDoor,
    changeDoor,
    flipDoor: flipDoorAt,
    deleteDoor,
    wallsAroundAreas,
    createTray,
    patchTray,
    deleteTray,
    splitAt,
    join,
    addBend,
    removePoint,
    deleteRow,
    addDrawPoint,
    finishDraw,
  }
}

export type StructureEdits = ReturnType<typeof useStructureEdits>
