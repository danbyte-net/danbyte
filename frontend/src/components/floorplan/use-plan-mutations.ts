import { useMutation, useQueryClient } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { FloorPlan } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"

/** Writes to the plan itself: its fields and view state (PATCH), and the
 * background image (multipart). */
export function usePlanMutations(id: string) {
  const qc = useQueryClient()

  // ── Background image upload / opacity ──────────────────────────────────
  const uploadBackground = useMutation({
    mutationFn: async (file: File | null) => {
      const fd = new FormData()
      if (file) fd.append("background_image", file)
      else fd.append("clear", "1")
      return api<FloorPlan>(`/api/floor-plans/${id}/background/`, {
        method: "POST",
        body: fd,
      })
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["floor-plan", id] }),
    onError: (err) => apiErrorToast(err),
  })

  const patchPlan = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      api<FloorPlan>(`/api/floor-plans/${id}/`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["floor-plan", id] }),
    onError: (err) => apiErrorToast(err),
  })

  return { uploadBackground, patchPlan }
}
