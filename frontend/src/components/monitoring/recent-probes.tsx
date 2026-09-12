import { useState } from "react"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import { useDateFormat } from "@/lib/datetime"
import { Button } from "@/components/ui/button"
import { SimpleTable } from "@/components/ui/simple-table"
import type { SimpleColumn } from "@/components/ui/simple-table"
import { CheckStatusBadge } from "./status-badge"
import type { CheckStatus } from "@/lib/api"

export interface Probe {
  status: string
  latency_ms: number | null
  at: string
}

interface ProbesResp {
  probes: Probe[]
  kept_seconds: number
  fast: boolean
  interval_ms?: number
}

const SHOW = 60

/**
 * The last minutes of a fast check's raw probes, newest first. They are
 * not database rows - the lane folds them into one result per recording
 * window - but while somebody watches the address the lane keeps a short
 * ring of them, and the live socket appends each new one here as it lands
 * (see `useLiveMonitoring`, which writes to this query's cache).
 */
export function RecentProbes({
  ipId,
  templateId,
  className,
}: {
  ipId: string
  templateId: string
  className?: string
}) {
  const { formatTime } = useDateFormat()
  const [all, setAll] = useState(false)
  const q = useQuery({
    queryKey: ["ip-probes", ipId, templateId],
    queryFn: () =>
      api<ProbesResp>(
        `/api/monitoring/ips/${ipId}/probes/?template=${templateId}`
      ),
    staleTime: 5 * 60_000,
  })
  if (!q.data?.fast) return null
  const probes = q.data.probes
  const shown = all ? probes : probes.slice(0, SHOW)
  const columns: SimpleColumn<Probe>[] = [
    {
      id: "at",
      header: "When",
      cell: (p) => (
        <span className="num text-xs text-muted-foreground">
          {formatTime(p.at)}
          <span className="opacity-60">
            .{String(new Date(p.at).getMilliseconds()).padStart(3, "0")}
          </span>
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      cell: (p) => <CheckStatusBadge status={p.status as CheckStatus} />,
    },
    {
      id: "latency",
      header: "Latency",
      align: "right",
      flex: true,
      cell: (p) => (
        <span className="num text-muted-foreground">
          {p.latency_ms != null ? `${p.latency_ms.toFixed(2)} ms` : "-"}
        </span>
      ),
    },
  ]
  return (
    <div className={className}>
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          Recent probes
        </span>
        <span className="text-[11px] text-muted-foreground">
          last {Math.round(q.data.kept_seconds / 60)} min while this tab is open
          · {probes.length}
        </span>
        {probes.length > SHOW && (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-6 px-2 text-xs"
            onClick={() => setAll((v) => !v)}
          >
            {all ? `Newest ${SHOW}` : `All ${probes.length}`}
          </Button>
        )}
      </div>
      <SimpleTable
        columns={columns}
        data={shown}
        getRowKey={(p) => p.at}
        empty="No probes yet - they arrive as the lane runs them."
      />
    </div>
  )
}
