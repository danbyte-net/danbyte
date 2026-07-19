import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"

/**
 * Fetch the create-form seed for cloning an object.
 *
 * `type` is the API path segment (e.g. "devices", "prefixes", "ips"). Returns
 * the `initial` payload from `GET /api/<type>/<id>/clone/` — the source's
 * carried-over fields with identity/unique fields dropped. `enabled` only when
 * an id is given, so the create form can call it unconditionally.
 */
export function useCloneSeed<T = Record<string, unknown>>(
  type: string,
  id: string | undefined
) {
  return useQuery({
    queryKey: ["clone", type, id],
    queryFn: () => api<{ initial: T }>(`/api/${type}/${id}/clone/`),
    enabled: !!id,
    // Always refetch: the seed reflects the source object's current values.
    staleTime: 0,
  })
}
