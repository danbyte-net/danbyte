import { useEffect, useMemo, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { ApiError, api } from "@/lib/api"
import type {
  FloorPlan,
  FloorPlanDrawing,
  FloorPlanDrawingPlacement,
  FloorPlanDrawingSupport,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"

import { placementOf } from "./cad-math"

// The plan's CAD drawing as the editor holds it. Placement changes save the
// moment they are made (PATCH …/drawing/), the way the background image's
// opacity does - the plan's Save button batches tile edits only. A viewer
// without change permission can still hide layers and text: those stay in
// this session and are never sent.

export type PlacementPatch = Partial<FloorPlanDrawingPlacement>

/** Keys a viewer may change locally. */
const VIEWER_KEYS = new Set<keyof FloorPlanDrawingPlacement>([
  "hidden_layers",
  "hide_text",
])

export function drawingKey(planId: string) {
  return ["floor-plan-drawing", planId] as const
}

/** GET /api/floor-plans/drawing-support/ - what uploads the server takes. */
export function useDrawingSupport(enabled = true) {
  return useQuery({
    queryKey: ["floor-plan-drawing-support"],
    queryFn: () =>
      api<FloorPlanDrawingSupport>("/api/floor-plans/drawing-support/"),
    staleTime: 5 * 60_000,
    enabled,
  })
}

/** The file input's accept list: DXF always, DWG only when it is taken. */
export function drawingAccept(support: FloorPlanDrawingSupport | undefined) {
  return support?.dwg ? ".dxf,.dwg" : ".dxf"
}

/** Why a picked file cannot go up, before it is sent; null when it can. */
export function drawingFileProblem(
  file: File,
  support: FloorPlanDrawingSupport | undefined
): string | null {
  const ext = file.name.toLowerCase().split(".").pop()
  if (ext === "dwg") {
    if (!support?.dwg)
      return (
        support?.message ||
        "DWG files need a converter on the server. Save as DXF and upload that."
      )
  } else if (ext !== "dxf") return "Choose a DXF or DWG file."
  if (support && file.size > support.max_upload_bytes)
    return `The file is over the ${Math.round(support.max_upload_bytes / 1048576)} MB limit.`
  return null
}

export function useCadDrawing(plan: FloorPlan | undefined, canEdit: boolean) {
  const qc = useQueryClient()
  const planId = plan?.id ?? ""
  const summary = plan?.drawing ?? null
  const query = useQuery({
    queryKey: drawingKey(planId),
    enabled: !!summary,
    queryFn: () => api<FloorPlanDrawing>(`/api/floor-plans/${planId}/drawing/`),
    // Poll while the worker has it.
    refetchInterval: (q) => (q.state.data?.status === "queued" ? 2000 : false),
  })
  const drawing = summary ? (query.data ?? null) : null

  // When processing ends, the plan's summary (rendered_url) changes too.
  const lastStatus = useRef<string | null>(null)
  useEffect(() => {
    const s = drawing?.status ?? null
    if (lastStatus.current === "queued" && s && s !== "queued")
      qc.invalidateQueries({ queryKey: ["floor-plan", planId] })
    lastStatus.current = s
  }, [drawing?.status, planId, qc])

  // Session overrides over the saved placement; reset with the plan or a
  // new file.
  const [local, setLocal] = useState<PlacementPatch>({})
  useEffect(() => setLocal({}), [planId, drawing?.id, drawing?.processed_at])

  const placement = useMemo(
    () => placementOf(drawing ?? { placement: {} }, local),
    [drawing, local]
  )

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["floor-plan", planId] })
    qc.invalidateQueries({ queryKey: drawingKey(planId) })
    qc.invalidateQueries({ queryKey: ["floor-plans"] })
  }

  const patchMut = useMutation({
    mutationFn: (p: PlacementPatch) =>
      api<FloorPlanDrawing>(`/api/floor-plans/${planId}/drawing/`, {
        method: "PATCH",
        body: JSON.stringify(p),
      }),
    onSuccess: (d, sent) => {
      qc.setQueryData(drawingKey(planId), d)
      // Drop the overrides this save carried, unless changed again since.
      setLocal((cur) => {
        const next = { ...cur }
        for (const k of Object.keys(sent) as (keyof PlacementPatch)[])
          if (cur[k] === sent[k]) delete next[k]
        return next
      })
    },
    onError: (err) => {
      apiErrorToast(err)
      setLocal({})
    },
  })

  /** Change the placement: shown at once, saved for an editor. */
  const change = (p: PlacementPatch) => {
    const allowed = canEdit
      ? p
      : (Object.fromEntries(
          Object.entries(p).filter(([k]) =>
            VIEWER_KEYS.has(k as keyof FloorPlanDrawingPlacement)
          )
        ) as PlacementPatch)
    if (!Object.keys(allowed).length) return
    setLocal((cur) => ({ ...cur, ...allowed }))
    if (canEdit) patchMut.mutate(allowed)
  }

  /** Show a change without saving it - a slider mid-drag. */
  const preview = (p: PlacementPatch) => setLocal((cur) => ({ ...cur, ...p }))

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData()
      fd.append("file", file)
      const d = await api<FloorPlanDrawing>(
        `/api/floor-plans/${planId}/drawing/`,
        { method: "POST", body: fd }
      )
      // One background per plan: the drawing replaces the image.
      if (plan?.background_image) {
        const clear = new FormData()
        clear.append("clear", "1")
        await api<FloorPlan>(`/api/floor-plans/${planId}/background/`, {
          method: "POST",
          body: clear,
        })
      }
      return d
    },
    onSuccess: (d) => {
      qc.setQueryData(drawingKey(planId), d)
      invalidate()
    },
    onError: (err) => apiErrorToast(err),
  })

  const remove = useMutation({
    mutationFn: () =>
      api<void>(`/api/floor-plans/${planId}/drawing/`, { method: "DELETE" }),
    onSuccess: () => {
      qc.removeQueries({ queryKey: drawingKey(planId) })
      invalidate()
    },
    onError: (err) => apiErrorToast(err),
  })

  const reprocess = useMutation({
    mutationFn: () =>
      api<FloorPlanDrawing>(`/api/floor-plans/${planId}/drawing/reprocess/`, {
        method: "POST",
      }),
    onSuccess: (d) => {
      qc.setQueryData(drawingKey(planId), d)
      invalidate()
    },
    onError: (err) => apiErrorToast(err),
  })

  const resetCalibration = useMutation({
    mutationFn: () =>
      api<FloorPlanDrawing>(`/api/floor-plans/${planId}/drawing/calibrate/`, {
        method: "DELETE",
      }),
    onSuccess: (d) => qc.setQueryData(drawingKey(planId), d),
    onError: (err) => apiErrorToast(err),
  })

  /** Fit the grid to the drawing. A drawing that needs more than 512 cells
   * comes back as `{ minCellMm }` for the caller to offer. */
  const fitGrid = useMutation({
    mutationFn: async (
      cellMm?: number
    ): Promise<{ ok: true } | { ok: false; minCellMm: number }> => {
      try {
        const r = await api<{
          floor_plan: FloorPlan
          drawing: FloorPlanDrawing
        }>(`/api/floor-plans/${planId}/drawing/fit-grid/`, {
          method: "POST",
          body: JSON.stringify(cellMm ? { cell_mm: cellMm } : {}),
        })
        qc.setQueryData(["floor-plan", planId], r.floor_plan)
        qc.setQueryData(drawingKey(planId), r.drawing)
        setLocal((cur) => {
          const next = { ...cur }
          delete next.x_mm
          delete next.y_mm
          return next
        })
        qc.invalidateQueries({ queryKey: ["floor-plans"] })
        return { ok: true }
      } catch (err) {
        const body = err instanceof ApiError ? err.body : null
        const min =
          body && typeof body === "object" && "min_cell_mm" in body
            ? Number(body.min_cell_mm)
            : NaN
        if (err instanceof ApiError && err.status === 400 && min > 0)
          return { ok: false, minCellMm: min }
        throw err
      }
    },
    onError: (err) => apiErrorToast(err),
  })

  return {
    summary,
    drawing,
    query,
    placement,
    change,
    preview,
    upload,
    remove,
    reprocess,
    resetCalibration,
    fitGrid,
    saving: patchMut.isPending,
  }
}

export type CadDrawingState = ReturnType<typeof useCadDrawing>
