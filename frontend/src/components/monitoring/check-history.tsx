import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { CheckResultRow } from "@/lib/api"
import { TimeCell } from "@/components/cells/time-ago"
import { SimpleTable } from "@/components/ui/simple-table"
import type { SimpleColumn } from "@/components/ui/simple-table"
import { CheckStatusBadge } from "./status-badge"
import { SourceBadge, SourceHeader } from "./source-badge"

interface HistoryResp {
  count: number
  results: CheckResultRow[]
}

// Recent raw results for one check on one IP. Shown when a check row is
// expanded, so the operator can see exactly what happened and when.
export function CheckHistory({
  ipId,
  templateId,
}: {
  ipId: string
  templateId: string
}) {
  const q = useQuery({
    queryKey: ["ip-history", ipId, templateId],
    queryFn: () =>
      api<HistoryResp>(
        `/api/monitoring/ips/${ipId}/history/?template=${templateId}&limit=50`
      ),
  })

  if (q.isLoading)
    return <p className="text-xs text-muted-foreground">Loading history…</p>
  const rows = q.data?.results ?? []
  if (rows.length === 0)
    return (
      <p className="text-xs text-muted-foreground">
        No results recorded yet - run the check or wait for the scheduler.
      </p>
    )

  return <SimpleTable columns={COLUMNS} data={rows} getRowKey={(r) => r.id} />
}

// The shared table primitive, like every other embedded list - a raw
// <table> here was the one place on the tab that drew its own rows.
const COLUMNS: SimpleColumn<CheckResultRow>[] = [
  {
    id: "when",
    header: "When",
    cell: (r) => <TimeCell iso={r.timestamp} />,
  },
  {
    id: "status",
    header: "Status",
    cell: (r) => <CheckStatusBadge status={r.status} />,
  },
  {
    id: "source",
    header: <SourceHeader />,
    cell: (r) => <SourceBadge source={r.source} engine={r.engine} />,
  },
  {
    id: "latency",
    header: "Latency",
    align: "right",
    cell: (r) => (
      <span className="num text-muted-foreground">
        {r.latency_ms != null ? `${r.latency_ms.toFixed(1)} ms` : "-"}
      </span>
    ),
  },
  {
    id: "detail",
    header: "Detail",
    flex: true,
    cell: (r) => (
      <span className="block truncate text-muted-foreground">
        {detailSummary(r.detail)}
      </span>
    ),
  },
]

/** One line for a result's or a change's detail - the error if there was
 * one, else the few fields worth a glance. An external system's payload
 * reads as its host and its first problem, never as raw JSON. */
export function detailSummary(detail: Record<string, unknown>): string {
  if (!detail || Object.keys(detail).length === 0) return "-"
  if (typeof detail.error === "string") return detail.error
  const parts: string[] = []
  // A fast-lane aggregate: the window, not one probe.
  const agg = detail.agg
  if (agg && typeof agg === "object") {
    const a = agg as Record<string, unknown>
    const bits = [`${String(a.samples)} probes`]
    if (a.loss_pct != null && Number(a.loss_pct) > 0)
      bits.push(`loss ${String(a.loss_pct)}%`)
    if (a.min_ms != null && a.max_ms != null)
      bits.push(`${String(a.min_ms)}-${String(a.max_ms)} ms`)
    return bits.join(" · ")
  }
  const problems: unknown[] = Array.isArray(detail.problems)
    ? detail.problems
    : []
  const first = problems.at(0)
  if (isNamed(first)) {
    parts.push(
      problems.length > 1 ? `${first.name} +${problems.length - 1}` : first.name
    )
  }
  const avail = detail.availability
  if (avail && typeof avail === "object") {
    const down = Object.entries(avail as Record<string, unknown>)
      .filter(([, v]) => isDown(v))
      .map(([k]) => k.toUpperCase())
    if (down.length) parts.push(`${down.join(", ")} unreachable`)
  }
  if (typeof detail.zabbix_host === "string" && parts.length === 0)
    parts.push(`host ${detail.zabbix_host}`)
  if (detail.port != null) parts.push(`port ${detail.port}`)
  if (detail.banner != null)
    parts.push(`banner: ${String(detail.banner).slice(0, 40)}`)
  if (detail.packet_loss != null)
    parts.push(`loss ${(Number(detail.packet_loss) * 100).toFixed(0)}%`)
  if (detail.status_code != null) parts.push(`HTTP ${detail.status_code}`)
  if (parts.length) return parts.join(" · ")
  // Nothing recognised: the scalar fields, as words, rather than JSON.
  return Object.entries(detail)
    .filter(([, v]) => v == null || typeof v !== "object")
    .slice(0, 4)
    .map(([k, v]) => `${k} ${String(v)}`)
    .join(" · ")
}

function isNamed(v: unknown): v is { name: string } {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as { name?: unknown }).name === "string"
  )
}

function isDown(v: unknown): boolean {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { state?: unknown }).state === "down"
  )
}
