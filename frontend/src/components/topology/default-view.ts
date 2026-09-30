import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useRouterState } from "@tanstack/react-router"
import { useEffect } from "react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useUrlPatch } from "@/lib/use-url-state"
import { isBare, settleDefault } from "./view-overrides"

/** The tenant's default view: the saved view a bare `/topology` opens for
 * everyone; `id: null` is No view. */
export interface DefaultView {
  id: string | null
}

const DEFAULT_VIEW_URL = "/api/topology-views/default/"
/** Under `topology-views`, so whatever refreshes the views list (a delete
 * above all) refreshes the default too. */
export const DEFAULT_VIEW_KEY = ["topology-views", "default"]

/**
 * Opens the tenant's default view on a bare `/topology`. The address is
 * replaced, never pushed: Back leaves the page rather than returning to
 * the bare address, and a deep link that gets `view=none` added loads no
 * map twice. `enabled` is whether the user may read topology views; a
 * default they can't read (or any error) is No view.
 *
 * - `resolving`: a bare address that is about to become the default's -
 *   nothing should be fetched or loaded for it yet.
 * - `noView`: how the page writes No view. `none` once there is a default
 *   (or it is still being asked for), so the bare address that means "the
 *   default" is never it.
 */
export function useDefaultView(
  search: Record<string, unknown>,
  enabled: boolean
) {
  const q = useQuery({
    queryKey: DEFAULT_VIEW_KEY,
    queryFn: () => api<DefaultView>(DEFAULT_VIEW_URL),
    enabled,
    // A failed read must not hold the map up: it is No view at once.
    retry: false,
    // Asked when the page opens, not when the window regains focus or the
    // network comes back: a default set elsewhere must not pull an open
    // map from under you.
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
  const pending = enabled && q.isPending
  const defaultId = q.data?.id ?? null
  const patch = useUrlPatch()
  const view = pending ? undefined : settleDefault(search, defaultId)?.view
  // Keyed on the location too: should the router's own commit of the page's
  // first address land after this replace, the address is bare again and is
  // settled again. Once settled it names a view, so this can't repeat.
  const at = useRouterState({ select: (s) => s.location.state.__TSR_key })
  useEffect(() => {
    if (view) patch({ view }, { replace: true, ignoreBlocker: true })
  }, [view, at])
  return {
    defaultId,
    resolving: isBare(search) && (pending || defaultId !== null),
    noView: pending || defaultId ? "none" : undefined,
  }
}

/** Set (an id) or clear (null) the tenant's default view. */
export function useSetDefaultView(nameOf: (id: string) => string | undefined) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string | null) =>
      api<DefaultView>(DEFAULT_VIEW_URL, {
        method: "PUT",
        body: JSON.stringify({ id }),
      }),
    onSuccess: (r) => {
      qc.setQueryData(DEFAULT_VIEW_KEY, r)
      const name = r.id ? nameOf(r.id) : undefined
      toast.success(
        !r.id ? "Default cleared" : name ? `Default: “${name}”` : "Default set"
      )
    },
    onError: (err) => apiErrorToast(err),
  })
}
