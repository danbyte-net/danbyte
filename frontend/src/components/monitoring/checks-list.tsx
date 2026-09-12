import { useEffect, useMemo, useState } from "react"
import { useSearch } from "@tanstack/react-router"
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"
import type { SortingState } from "@tanstack/react-table"
import { X } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { CheckListResponse, CheckListRow, CheckStatus } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useUrlPatch } from "@/lib/use-url-state"
import { Button } from "@/components/ui/button"
import { DataTable, selectionColumn } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { Switch } from "@/components/ui/switch"
import type { FilterSnapshot } from "@/components/table-filters"
import {
  CHECK_ORDERING,
  checkColumns,
} from "@/components/columns/check-columns"
import type { CheckColumnId } from "@/components/columns/check-columns"
import { MonitoringRail, RAIL_KEYS, railActiveCount } from "./monitoring-rail"
import type { RailFilters } from "./monitoring-rail"

// Quick-filter tabs: "all" first, then the states an operator scans for
// most. One click sets the whole status filter; the rail's Status facet
// combines several.
const TABS: { value: CheckStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "up", label: "Up" },
  { value: "degraded", label: "Degraded" },
  { value: "down", label: "Down" },
  { value: "stale", label: "Stale" },
  { value: "skipped", label: "Skipped" },
  { value: "unknown", label: "Unknown" },
]

const PAGE = 50
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v !== "" ? v : undefined

/** `ordering` param ↔ the table's sort state, so a `SortHeader` click asks
 * the server for a different order. */
function orderingToSorting(ordering: string): SortingState {
  const desc = ordering.startsWith("-")
  const key = desc ? ordering.slice(1) : ordering
  const id = (Object.keys(CHECK_ORDERING) as CheckColumnId[]).find(
    (c) => CHECK_ORDERING[c] === key
  )
  return id ? [{ id, desc }] : []
}
function sortingToOrdering(s: SortingState): string | undefined {
  const first = s.at(0)
  if (!first) return undefined
  const key = CHECK_ORDERING[first.id as CheckColumnId]
  if (!key) return undefined
  return `${first.desc ? "-" : ""}${key}`
}

/**
 * `/monitoring?view=checks` - every check in the tenant on the same rail the
 * History view has, with server paging and sorting. The status quick-tabs
 * and the dashboard donut both write `?status=`; the rail widens it to a
 * list. `?strip=7` draws each row's last seven days to scale.
 */
export function ChecksList({
  flappingOnly = false,
}: {
  /** The Flapping view: the same list pinned to `flapping=1`, rows
   * selectable, a bulk *Confirm not flapping* on the selection. */
  flappingOnly?: boolean
}) {
  const search = useSearch({ strict: false })
  const patch = useUrlPatch()
  const qc = useQueryClient()
  const [selected, setSelected] = useState<CheckListRow[]>([])

  const rail: RailFilters = Object.fromEntries(
    RAIL_KEYS.map((k) => [k, str(search[k])])
  )
  const status = str(search.status) ?? "all"
  const q = str(search.q) ?? ""
  const page = Number(str(search.page) ?? "1") || 1
  const ordering = str(search.ordering) ?? "-last_checked"
  const strip = str(search.strip) === "1"
  const flapping = flappingOnly ? "1" : str(search.flapping)

  const [draft, setDraft] = useState(q)
  useEffect(() => setDraft(q), [q])
  useEffect(() => {
    if (draft === q) return
    const t = setTimeout(
      () =>
        patch({ q: draft || undefined, page: undefined }, { replace: true }),
      300
    )
    return () => clearTimeout(t)
  }, [draft])

  const params = useMemo(() => {
    const p = new URLSearchParams()
    for (const k of RAIL_KEYS) {
      const v = rail[k]
      if (v && k !== "status") p.set(k, v)
    }
    if (status !== "all") p.set("status", status)
    if (q) p.set("search", q)
    p.set("ordering", ordering)
    p.set("page", String(page))
    p.set("page_size", String(PAGE))
    if (strip) p.set("strip", "7")
    if (flapping) p.set("flapping", flapping)
    return p.toString()
  }, [rail, status, q, ordering, page, strip, flapping])

  const query = useQuery({
    queryKey: ["monitoring-checks", params],
    queryFn: () => api<CheckListResponse>(`/api/monitoring/checks/?${params}`),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  })
  const data = query.data
  const counts = data?.status_counts ?? {}
  const rows = data?.results ?? []
  const total = data?.count ?? 0
  const pages = Math.max(1, Math.ceil(total / PAGE))

  const columns = useMemo(() => {
    const cols = checkColumns(
      strip && data?.since && data.until
        ? { since: data.since, until: data.until }
        : null
    )
    return flappingOnly ? [selectionColumn<CheckListRow>(), ...cols] : cols
  }, [strip, data?.since, data?.until, flappingOnly])

  const confirmCalm = useMutation({
    mutationFn: (stateIds: string[]) =>
      api<{ cleared: number }>("/api/monitoring/flapping/clear/", {
        method: "POST",
        body: JSON.stringify({ state_ids: stateIds }),
      }),
    onSuccess: (d) => {
      toast.success(
        d.cleared === 1
          ? "Confirmed not flapping"
          : `Confirmed ${d.cleared} checks`
      )
      setSelected([])
      qc.invalidateQueries({ queryKey: ["monitoring-checks"] })
      qc.invalidateQueries({ queryKey: ["monitoring-flapping"] })
      qc.invalidateQueries({ queryKey: ["monitoring-stats"] })
    },
    onError: (err) => apiErrorToast(err),
  })

  const snapshot = (): FilterSnapshot => {
    const out: FilterSnapshot = {}
    for (const k of RAIL_KEYS) if (rail[k] && k !== "status") out[k] = rail[k]!
    if (status !== "all") out.status = status
    if (strip) out.strip = "1"
    return out
  }
  const restore = (snap: FilterSnapshot | null | undefined) => {
    const next: Record<string, string | undefined> = { page: undefined }
    for (const k of [...RAIL_KEYS, "strip"]) next[k] = undefined
    next.status = "all"
    for (const [k, v] of Object.entries(snap ?? {}))
      if (typeof v === "string") next[k] = v
      else if (Array.isArray(v)) next[k] = v.join(",")
    patch(next)
  }

  const railFilters: RailFilters = {
    ...rail,
    status: status === "all" ? undefined : status,
    flapping: flappingOnly ? undefined : flapping,
  }

  return (
    <ListPageShell
      title={flappingOnly ? "Flapping" : "Checks"}
      count={data ? total : undefined}
      rail={
        <MonitoringRail
          facets={data?.facets ?? {}}
          filters={railFilters}
          onChange={(p) =>
            patch({
              ...p,
              // The rail writes the same param the tabs do; an empty facet
              // is "all" in the URL, which the route's default already is.
              ...("status" in p ? { status: p.status ?? "all" } : {}),
            })
          }
          statusKey="status"
          showFlapping={!flappingOnly}
        />
      }
      search={{
        value: draft,
        onChange: setDraft,
        placeholder: "Address, DNS name, device, check…",
      }}
      savedViews={{
        objectType: flappingOnly ? "monitoring-flapping" : "monitoring-check",
        filters: {
          snapshot,
          restore,
          activeCount: railActiveCount(railFilters) + (strip ? 1 : 0),
        },
      }}
      actions={
        <>
          <SegmentedTabs
            value={TABS.some((t) => t.value === status) ? status : "all"}
            onValueChange={(s) =>
              patch({ status: s === "all" ? "all" : s, page: undefined })
            }
            items={TABS.map((t) => ({ ...t, count: counts[t.value] ?? 0 }))}
          />
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Switch
              checked={strip}
              onCheckedChange={(v) => patch({ strip: v ? "1" : undefined })}
              aria-label="Show seven days of status per row"
            />
            7 days
          </label>
        </>
      }
      query={query}
    >
      <DataTable<CheckListRow>
        columns={columns}
        data={rows}
        tableId="monitoring-checks"
        exportName="monitoring-checks"
        exportTitle="Checks"
        flexColumn="check"
        onSelectedRowsChange={flappingOnly ? setSelected : undefined}
        exportAll={async () => {
          const out: CheckListRow[] = []
          for (let p = 1; p <= 25; p++) {
            const all = new URLSearchParams(params)
            all.set("page", String(p))
            all.set("page_size", "200")
            all.delete("strip")
            const r = await api<CheckListResponse>(
              `/api/monitoring/checks/?${all}`
            )
            out.push(...r.results)
            if (out.length >= r.count) break
          }
          return out
        }}
        serverPagination={{
          page,
          pageCount: pages,
          totalRows: total,
          onPageChange: (p) => patch({ page: p === 1 ? undefined : String(p) }),
        }}
        serverSorting={{
          sorting: orderingToSorting(ordering),
          onSortingChange: (s) =>
            patch({
              ordering: sortingToOrdering(s) ?? undefined,
              page: undefined,
            }),
        }}
      />
      {flappingOnly && selected.length > 0 && (
        <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center">
          <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border bg-popover px-2 py-1.5 text-popover-foreground shadow-lg">
            <span className="pl-2 text-xs font-medium text-foreground">
              {selected.length} selected
            </span>
            <span className="h-4 w-px bg-border" />
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              disabled={confirmCalm.isPending}
              onClick={() => confirmCalm.mutate(selected.map((r) => r.id))}
            >
              {confirmCalm.isPending ? "Confirming…" : "Confirm not flapping"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 w-7 p-0"
              onClick={() => setSelected([])}
              aria-label="Clear selection"
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        </div>
      )}
    </ListPageShell>
  )
}
