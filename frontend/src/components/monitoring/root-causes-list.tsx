import { useEffect, useMemo, useState } from "react"
import { keepPreviousData, useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { RootCausesResponse } from "@/lib/api"
import { DataTable } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { buildRootCauseColumns } from "@/components/columns/root-cause-columns"

type View = "open" | "resolved"

/** The Alerts page's Root causes tab (#450): one row per down device that
 * explains the alerts behind it. */
export function RootCausesList({
  view,
  onView,
}: {
  view: View
  onView: (v: View) => void
}) {
  const [draft, setDraft] = useState("")
  const [search, setSearch] = useState("")
  useEffect(() => {
    const t = setTimeout(() => setSearch(draft.trim()), 300)
    return () => clearTimeout(t)
  }, [draft])

  const q = useQuery({
    queryKey: ["root-causes", view, search],
    queryFn: () => {
      const p = new URLSearchParams({ status: view })
      if (search) p.set("q", search)
      return api<RootCausesResponse>(`/api/monitoring/root-causes/?${p}`)
    },
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  })
  const columns = useMemo(() => buildRootCauseColumns(), [])
  const rows = q.data?.results ?? []
  const counts = q.data?.counts ?? {}

  return (
    <ListPageShell
      title="Root causes"
      count={q.data ? rows.length : undefined}
      search={{
        value: draft,
        onChange: setDraft,
        placeholder: "Root device…",
      }}
      actions={
        <SegmentedTabs<View>
          value={view}
          onValueChange={onView}
          items={[
            { value: "open", label: "Open", count: counts.open },
            { value: "resolved", label: "Resolved", count: counts.resolved },
          ]}
        />
      }
      query={q}
    >
      <DataTable
        tableId="root-causes"
        data={rows}
        columns={columns}
        flexColumn="device"
      />
    </ListPageShell>
  )
}
