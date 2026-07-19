import { useState } from "react"
import { Link } from "@tanstack/react-router"
import { useQuery, keepPreviousData } from "@tanstack/react-query"
import { Search } from "lucide-react"

import { api, type CheckListResponse, type CheckStatus } from "@/lib/api"
import { Input } from "@/components/ui/input"
import { QueryError } from "@/components/query-error"
import { CheckStatusBadge } from "./status-badge"

// Quick-filter tabs (ping-monitor parity). "all" first, then the states an
// operator scans for most.
const TABS: { key: CheckStatus | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "up", label: "Up" },
  { key: "degraded", label: "Degraded" },
  { key: "down", label: "Down" },
  { key: "stale", label: "Stale" },
  { key: "skipped", label: "Skipped" },
  { key: "unknown", label: "Unknown" },
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
        <div className="flex flex-wrap items-center gap-1">
          {TABS.map((t) => {
            const active = status === t.key
            const n = counts[t.key] ?? 0
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => {
                  setPage(1)
                  onStatusChange(t.key)
                }}
                className={`inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[13px] font-medium transition-colors ${
                  active
                    ? "bg-foreground text-background"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                {t.label}
                <span
                  className={`num text-[11px] ${
                    active ? "text-background/70" : "text-muted-foreground/70"
                  }`}
                >
                  {n}
                </span>
              </button>
            )
          })}
        </div>
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

      <div className="overflow-hidden rounded-lg border border-border bg-card">
        <table className="w-full text-left text-[13px]">
          <thead className="bg-muted/40 text-[10px] tracking-[0.06em] text-muted-foreground uppercase">
            <tr>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">IP address</th>
              <th className="px-3 py-2 font-medium">Check</th>
              <th className="px-3 py-2 font-medium">Type</th>
              <th className="px-3 py-2 text-right font-medium">Latency</th>
              <th className="px-3 py-2 text-right font-medium">Last checked</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-muted/40">
                <td className="px-3 py-1.5">
                  <CheckStatusBadge status={r.status} />
                </td>
                <td className="px-3 py-1.5">
                  <Link
                    to="/ips/$id"
                    params={{ id: r.target_ip.id }}
                    className="font-mono font-medium hover:underline"
                  >
                    {r.target_ip.ip_address}
                  </Link>
                </td>
                <td className="px-3 py-1.5">{r.template.name}</td>
                <td className="px-3 py-1.5">
                  <span className="font-mono text-[11px] text-muted-foreground uppercase">
                    {r.kind}
                  </span>
                </td>
                <td className="num px-3 py-1.5 text-right text-muted-foreground">
                  {r.last_latency_ms != null
                    ? `${r.last_latency_ms.toFixed(1)} ms`
                    : "—"}
                </td>
                <td className="num px-3 py-1.5 text-right text-[11px] text-muted-foreground">
                  {r.last_checked
                    ? new Date(r.last_checked).toLocaleString()
                    : "never"}
                </td>
              </tr>
            ))}
            {q.data && rows.length === 0 && (
              <tr>
                <td
                  colSpan={6}
                  className="px-3 py-10 text-center text-sm text-muted-foreground"
                >
                  No checks match this filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Footer: count + paging */}
      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
        <span>
          {total} check{total === 1 ? "" : "s"}
        </span>
        {pages > 1 && (
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="rounded px-2 py-1 hover:bg-muted disabled:opacity-40"
            >
              Prev
            </button>
            <span className="num">
              {page} / {pages}
            </span>
            <button
              type="button"
              disabled={page >= pages}
              onClick={() => setPage((p) => Math.min(pages, p + 1))}
              className="rounded px-2 py-1 hover:bg-muted disabled:opacity-40"
            >
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
