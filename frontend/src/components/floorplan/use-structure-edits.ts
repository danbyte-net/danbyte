import { useCallback } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  FloorPlan,
  FloorPlanTray,
  FloorPlanTrayWritePayload,
  FloorPlanWall,
  FloorPlanWallOpening,
  FloorPlanWallWritePayload,
  RaisedFloorArea,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"

import type { PlanEditState } from "./use-plan-edit-state"

/** Structure and Cables mode edits - raised floors, walls (with their doors)
 * and trays. Unlike tiles these save at once, one request per change, and
 * stay outside the undo history. */
export function useStructureEdits({
  id,
  plan,
  walls,
  ed,
}: {
  id: string
  plan: FloorPlan | undefined
  walls: FloorPlanWall[]
  ed: PlanEditState
}) {
  const qc = useQueryClient()
  const {
    areaArmed,
    setAreaArmed,
    setSelectedAreaId,
    setSelectedWallId,
    setDoorArmed,
    setSelectedTrayId,
    setDrawPoints,
    setNamingPoints,
    mode,
  } = ed

  const invalidateAreas = () => {
    qc.invalidateQueries({ queryKey: ["floor-plan-raised-floors", id] })
    qc.invalidateQueries({ queryKey: ["floor-plan-scene", id] })
  }
  const createArea = useMutation({
    mutationFn: (rect: { x: number; y: number; w: number; h: number }) =>
      api<RaisedFloorArea>("/api/floor-plan-raised-floors/", {
        method: "POST",
        body: JSON.stringify({
          floor_plan_id: id,
          x: rect.x,
          y: rect.y,
          width: rect.w,
          height: rect.h,
        }),
      }),
    onSuccess: (a) => {
      invalidateAreas()
      setSelectedAreaId(a.id)
      setAreaArmed(false)
    },
    onError: (e) => apiErrorToast(e),
  })
  const patchArea = useMutation({
    mutationFn: ({
      areaId,
      body,
    }: {
      areaId: string
      body: Partial<RaisedFloorArea>
    }) =>
      api<RaisedFloorArea>(`/api/floor-plan-raised-floors/${areaId}/`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      invalidateAreas()
      // Structure edits persist immediately (tray-style) - without a word,
      // the page's Save-button mental model reads that as "not saved".
      toast.success("Raised floor saved")
    },
    onError: (e) => apiErrorToast(e),
  })
  const deleteArea = useMutation({
    mutationFn: (areaId: string) =>
      api<void>(`/api/floor-plan-raised-floors/${areaId}/`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      invalidateAreas()
      setSelectedAreaId(null)
    },
    onError: (e) => apiErrorToast(e),
  })
  /** Structure mode: a completed drag-rect becomes a raised-floor area. */
  const createAreaAt = useCallback(
    (rect: { x: number; y: number; w: number; h: number }) => {
      if (!areaArmed || !plan) return
      createArea.mutate(rect)
    },
    [areaArmed, plan, id]
  )

  // ── Walls (instant-save, tray-style) ───────────────────────────────────
  const invalidateWalls = () => {
    qc.invalidateQueries({ queryKey: ["floor-plan-walls", id] })
    qc.invalidateQueries({ queryKey: ["floor-plan-scene", id] })
  }
  const createWall = useMutation({
    mutationFn: (payload: FloorPlanWallWritePayload) =>
      api<FloorPlanWall>("/api/floor-plan-walls/", {
        method: "POST",
        body: JSON.stringify({ ...payload, floor_plan_id: id }),
      }),
    onSuccess: (w) => {
      invalidateWalls()
      setSelectedWallId(w.id)
      toast.success("Wall added")
    },
    onError: (e) => apiErrorToast(e),
  })
  const patchWall = useMutation({
    mutationFn: ({
      wallId,
      body,
    }: {
      wallId: string
      body: FloorPlanWallWritePayload
    }) =>
      api<FloorPlanWall>(`/api/floor-plan-walls/${wallId}/`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      invalidateWalls()
      // Same contract as areas: instant-save needs a word, or the page's
      // Save-button mental model reads it as "not saved".
      toast.success("Wall saved")
    },
    onError: (e) => apiErrorToast(e),
  })
  const deleteWall = useMutation({
    mutationFn: (wallId: string) =>
      api<void>(`/api/floor-plan-walls/${wallId}/`, { method: "DELETE" }),
    onSuccess: () => {
      invalidateWalls()
      setSelectedWallId(null)
    },
    onError: (e) => apiErrorToast(e),
  })
  /** "Add door" click: a 900 mm opening centred on the clicked spot, clamped
   * into the segment (the server validates overlap and bounds). */
  const placeDoor = useCallback(
    (wallId: string, seg: number, at: number) => {
      const wall = walls.find((w) => w.id === wallId)
      if (!wall || !plan) return
      const [ax, ay] = wall.points[seg]
      const [bx, by] = wall.points[seg + 1]
      const segLen = Math.hypot(bx - ax, by - ay)
      const w = 900 / plan.cell_mm
      if (segLen < w) {
        toast.error("This wall segment is too short for a door.")
        return
      }
      const from = Math.max(0, Math.min(segLen - w, at - w / 2))
      const opening: FloorPlanWallOpening = {
        seg,
        from: Math.round(from * 100) / 100,
        to: Math.round((from + w) * 100) / 100,
        height_mm: null,
      }
      patchWall.mutate({
        wallId,
        body: { openings: [...wall.openings, opening] },
      })
      setDoorArmed(false)
      setSelectedWallId(wallId)
    },
    [walls, plan, patchWall.mutate]
  )

  // ── Trays (save immediately per op - no bulk/dirty model like tiles) ────
  const invalidateTrays = () => {
    qc.invalidateQueries({ queryKey: ["floor-plan-trays", id] })
    // A cable's route depends on its trays - refresh the routed paths so
    // links don't fall back to point-to-point until a reload.
    qc.invalidateQueries({ queryKey: ["floor-plan-cable-paths", id] })
  }
  const createTray = useMutation({
    mutationFn: (payload: FloorPlanTrayWritePayload) =>
      api<FloorPlanTray>("/api/floor-plan-trays/", {
        method: "POST",
        body: JSON.stringify({ ...payload, floor_plan_id: id }),
      }),
    onSuccess: (tray) => {
      invalidateTrays()
      setSelectedTrayId(tray.id)
      toast.success(`Added ${tray.name}`)
    },
    onError: (err) => apiErrorToast(err),
  })
  const patchTray = useMutation({
    mutationFn: ({
      trayId,
      patch,
    }: {
      trayId: string
      patch: FloorPlanTrayWritePayload
    }) =>
      api<FloorPlanTray>(`/api/floor-plan-trays/${trayId}/`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    onSuccess: invalidateTrays,
    onError: (err) => apiErrorToast(err),
  })
  const deleteTray = useMutation({
    mutationFn: (trayId: string) =>
      api<void>(`/api/floor-plan-trays/${trayId}/`, { method: "DELETE" }),
    onSuccess: () => {
      invalidateTrays()
      setSelectedTrayId(null)
    },
    onError: (err) => apiErrorToast(err),
  })

  const addDrawPoint = useCallback((pt: [number, number]) => {
    setDrawPoints((prev) => {
      const arr = prev ?? []
      // Skip a duplicate of the last vertex (e.g. the extra click a
      // double-click-to-finish produces), so trays don't get zero-length hops.
      const last = arr.length ? arr[arr.length - 1] : null
      if (last && last[0] === pt[0] && last[1] === pt[1]) return arr
      return [...arr, pt]
    })
  }, [])
  // One polyline rig, two products: Cables mode finishes into the tray
  // naming dialog; Structure mode creates the wall at once (label is
  // optional - the inspector opens on it for the rest).
  const finishDraw = useCallback(() => {
    setDrawPoints((prev) => {
      if (prev && prev.length >= 2) {
        if (mode === "structure") createWall.mutate({ points: prev })
        else setNamingPoints(prev)
      }
      return null
    })
  }, [mode, createWall.mutate])

  return {
    patchArea,
    deleteArea,
    createAreaAt,
    patchWall,
    deleteWall,
    placeDoor,
    createTray,
    patchTray,
    deleteTray,
    addDrawPoint,
    finishDraw,
  }
}

export type StructureEdits = ReturnType<typeof useStructureEdits>
