import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { useQuery, keepPreviousData } from "@tanstack/react-query"
import { Search } from "lucide-react"

import { api } from "@/lib/api"
import type { CheckListResponse, CheckListRow, CheckStatus } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { SimpleTable } from "@/components/ui/simple-table"
import type { SimpleColumn } from "@/components/ui/simple-table"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { QueryError } from "@/components/query-error"
import { CheckStatusBadge } from "./status-badge"

// Quick-filter tabs (ping-monitor parity). "all" first, then the states an
// operator scans for most.
const TABS: { value: CheckStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "up", label: "Up" },
  { value: "degraded", label: "Degraded" },
  { value: "down", label: "Down" },
  { value: "stale", label: "Stale" },
  { value: "skipped", label: "Skipped" },
  { value: "unknown", label: "Unknown" },
]

const COLUMNS: SimpleColumn<CheckListRow>[] = [
  {
    id: "status",
    header: "Status",
    cell: (r) => <CheckStatusBadge status={r.status} />,
  },
  {
    id: "ip",
    header: "IP address",
    cell: (r) => (
      <Link
        to="/ips/$id"
        params={{ id: r.target_ip.id }}
        className="link font-mono font-medium"
      >
        {r.target_ip.ip_address}
      </Link>
    ),
  },
  { id: "check", header: "Check", flex: true, cell: (r) => r.template.name },
  {
    id: "kind",
    header: "Type",
    cell: (r) => (
      <span className="font-mono text-[11px] text-muted-foreground uppercase">
        {r.kind}
      </span>
    ),
  },
  {
    id: "latency",
    header: "Latency",
    align: "right",
    cell: (r) => (
      <span className="num text-muted-foreground">
        {r.last_latency_ms != null ? `${r.last_latency_ms.toFixed(1)} ms` : "—"}
      </span>
    ),
  },
  {
    id: "last_checked",
    header: "Last checked",
    align: "right",
    cell: (r) => (
      <span className="num text-[11px] text-muted-foreground">
        {r.last_checked ? new Date(r.last_checked).toLocaleString() : "never"}
      </span>
    ),
  },
]

export function ChecksList({
  status,
  onStatusChange,
}: {
  status: CheckStatus | "all"
  onStatusChange: (s: CheckStatus | "all") => void
}) {
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(1)

  const q = useQuery({
    queryKey: ["monitoring-checks", status, search, page],
    queryFn: () =>
      api<CheckListResponse>(
        `/api/monitoring/checks/?status=${status}&search=${encodeURIComponent(
          search
        )}&page=${page}`
      ),
    placeholderData: keepPreviousData,
  })

  const counts = q.data?.status_counts ?? {}
  const rows = q.data?.results ?? []
  const total = q.data?.count ?? 0
  const pageSize = q.data?.page_size ?? 50
  const pages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="space-y-3">
      {/* Filter tabs + search */}
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedTabs
          value={status}
          onValueChange={(s) => {
            setPage(1)
            onStatusChange(s)
          }}
          items={TABS.map((t) => ({ ...t, count: counts[t.value] ?? 0 }))}
        />
        <div className="relative ml-auto">
          <Search className="absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Filter by IP or check…"
            value={search}
            onChange={(e) => {
              setPage(1)
              setSearch(e.target.value)
            }}
            className="h-8 w-64 pl-8 text-xs"
          />
        </div>
      </div>

      {q.isError && <QueryError error={q.error} />}

      <SimpleTable
        columns={COLUMNS}
        data={rows}
        getRowKey={(r) => r.id}
        empty={q.isLoading ? "Loading…" : "No checks match this filter."}
      />

      {/* Footer: count + paging. Same shape as the shared DataTable pager, but
          the rows are paged by the API (status/search are server filters), so
          the page index is ours to drive rather than the table's. */}
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="num">
          {total} check{total === 1 ? "" : "s"}
        </span>
        {pages > 1 && (
          <div className="ml-auto flex items-center gap-2">
            <span className="num">
              Page {page} of {pages}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Prev
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              disabled={page >= pages}
              onClick={() => setPage((p) => Math.min(pages, p + 1))}
            >
              Next
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
