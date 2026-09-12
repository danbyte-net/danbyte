import { useQuery } from "@tanstack/react-query"

import { api, type CheckResultRow } from "@/lib/api"
import { CheckStatusBadge } from "./status-badge"
import { SourceBadge } from "./source-badge"

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

  return (
    <table className="w-full text-left text-xs">
      <thead className="text-[10px] tracking-[0.06em] text-muted-foreground uppercase">
        <tr>
          <th className="py-1 pr-3 font-medium">When</th>
          <th className="py-1 pr-3 font-medium">Status</th>
          <th className="py-1 pr-3 font-medium">Source</th>
          <th className="py-1 pr-3 font-medium">Latency</th>
          <th className="py-1 font-medium">Detail</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-border">
        {rows.map((r) => (
          <tr key={r.id}>
            <td className="py-1 pr-3 whitespace-nowrap text-muted-foreground">
              {new Date(r.timestamp).toLocaleString()}
            </td>
            <td className="py-1 pr-3">
              <CheckStatusBadge status={r.status} />
            </td>
            <td className="py-1 pr-3">
              <SourceBadge source={r.source} engine={r.engine} />
            </td>
            <td className="num py-1 pr-3 text-muted-foreground">
              {r.latency_ms != null ? `${r.latency_ms.toFixed(1)} ms` : "-"}
            </td>
            <td className="py-1 font-mono text-[11px] text-muted-foreground">
              {detailSummary(r.detail)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** One line for a result's or a change's detail - the error if there was
 * one, else the few fields worth a glance. An external system's payload
 * reads as its host and its first problem, never as raw JSON. */
export function detailSummary(detail: Record<string, unknown>): string {
  if (!detail || Object.keys(detail).length === 0) return "-"
  if (typeof detail.error === "string") return detail.error
  const parts: string[] = []
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
