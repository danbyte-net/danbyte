import { useCallback, useRef } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"

import { api, type ColumnPref, type ColumnPrefData } from "@/lib/api"

const prefKey = (tableId: string) => ["col-pref", tableId] as const

export interface TablePreference {
  /** Saved column order (manageable columns only). Empty = no saved order. */
  order: string[]
  /** Saved hidden column ids. */
  hidden: string[]
  /** Admin lock — when true the layout can't be changed by the user. */
  isForced: boolean
  /** Whether the user has their own saved row (enables Reset). */
  hasUserRow: boolean
  source: ColumnPref["source"]
  /** True once the initial fetch has resolved (or there's no tableId). */
  loaded: boolean
  /** Persist a new layout. No-op while forced. Debounced PUT. */
  setLayout: (next: Partial<ColumnPrefData>) => void
  /** Drop the user's row so the tenant default / discovery takes over. */
  reset: () => void
}

const INERT: TablePreference = {
  order: [],
  hidden: [],
  isForced: false,
  hasUserRow: false,
  source: "none",
  loaded: true,
  setLayout: () => {},
  reset: () => {},
}

// Per-table column-layout preference, backed by /api/prefs/columns/<id>/.
// Returns an inert object when `tableId` is undefined so <DataTable> behaves
// exactly as before for tables that haven't opted in.
export function useTablePreference(tableId?: string): TablePreference {
  const qc = useQueryClient()
  const enabled = !!tableId
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const q = useQuery({
    queryKey: tableId ? prefKey(tableId) : ["col-pref", "__none__"],
    queryFn: () => api<ColumnPref>(`/api/prefs/columns/${tableId}/`),
    enabled,
    staleTime: 5 * 60_000,
  })

  const order = q.data?.data?.order ?? []
  const hidden = q.data?.data?.hidden ?? []
  const isForced = q.data?.is_forced ?? false

  const setLayout = useCallback(
    (next: Partial<ColumnPrefData>) => {
      if (!tableId) return
      const key = prefKey(tableId)
      const current = qc.getQueryData<ColumnPref>(key)
      if (current?.is_forced) return // locked — ignore writes
      const merged: ColumnPrefData = {
        order: next.order ?? current?.data?.order ?? [],
        hidden: next.hidden ?? current?.data?.hidden ?? [],
      }
      // Optimistic: reflect the change immediately, then debounce the PUT so
      // a flurry of toggles/reorders collapses into one request.
      qc.setQueryData<ColumnPref>(key, {
        source: "user",
        is_forced: false,
        data: merged,
      })
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        api(`/api/prefs/columns/${tableId}/`, {
          method: "PUT",
          body: JSON.stringify(merged),
        }).catch(() => {
          // On failure (e.g. a freshly-applied admin lock → 409) reconcile
          // with the server's truth.
          qc.invalidateQueries({ queryKey: key })
        })
      }, 350)
    },
    [tableId, qc]
  )

  const reset = useCallback(() => {
    if (!tableId) return
    const key = prefKey(tableId)
    if (timer.current) clearTimeout(timer.current)
    api(`/api/prefs/columns/${tableId}/`, { method: "DELETE" })
      .catch(() => {})
      .finally(() => qc.invalidateQueries({ queryKey: key }))
  }, [tableId, qc])

  if (!enabled) return INERT

  return {
    order,
    hidden,
    isForced,
    hasUserRow: q.data?.source === "user",
    source: q.data?.source ?? "none",
    loaded: q.isSuccess,
    setLayout,
    reset,
  }
}

// ─── Admin: publish / clear the tenant-wide default ──────────────────────
// Plain helpers the Admin settings page drives via useMutation.

export function putTableDefault(
  tableId: string,
  body: ColumnPrefData & { forced: boolean }
) {
  return api(`/api/prefs/columns/${tableId}/default/`, {
    method: "PUT",
    body: JSON.stringify(body),
  })
}

export function deleteTableDefault(tableId: string) {
  return api(`/api/prefs/columns/${tableId}/default/`, { method: "DELETE" })
}
