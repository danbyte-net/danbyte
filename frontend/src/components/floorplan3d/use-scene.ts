import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"

import type { ScenePayload } from "./world"

/** The 3D room's one-fetch structural payload. Live status is NOT here - the
 * scene keeps consuming the same `["floor-plan-state", id]` poll the 2D canvas
 * uses, so switching views never doubles the polling. */
export function useScene(planId: string) {
  return useQuery({
    queryKey: ["floor-plan-scene", planId],
    queryFn: () => api<ScenePayload>(`/api/floor-plans/${planId}/scene/`),
    staleTime: 30_000,
  })
}
