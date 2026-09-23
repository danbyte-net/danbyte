import { useMemo } from "react"
import { useSearch } from "@tanstack/react-router"
import { keepPreviousData, useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { LatencyOffender, LatencyPageResponse } from "@/lib/api"
import { useUrlPatch } from "@/lib/use-url-state"
import { DataTable } from "@/components/data-table"
import { QueryError } from "@/components/query-error"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { Section } from "@/components/ui/section"
import { checkColumns } from "@/components/columns/check-columns"
import { fmtMs } from "./availability"
import { FRAME_TABS, frameQuery } from "./explore-view"
import { RollupLatencyChart } from "./rollup-charts"

const COLUMNS = [
  "status",
  "ip",
  "device",
  "check",
  "p95",
  "baseline",
  "ratio",
  "spikes",
]

/**
 * `/monitoring?view=latency` - one check kind at a time: its percentiles
 * over the window, then the checks furthest from their own normal and the
 * ones spiking most. Never an average across kinds.
 */
export function LatencyView() {
  const search = useSearch({ strict: false })
  const patch = useUrlPatch()
  const kind = typeof search.kind === "string" ? search.kind : ""
  const days = FRAME_TABS.some((f) => f.value === search.days)
    ? String(search.days)
    : "7"
  const q = useQuery({
    queryKey: ["monitoring-latency", kind, days],
    queryFn: () =>
      api<LatencyPageResponse>(
        `/api/monitoring/latency/?${frameQuery(days)}${kind ? `&kind=${kind}` : ""}`
      ),
    placeholderData: keepPreviousData,
  })
  const columns = useMemo(
    () =>
      checkColumns(null, { label: "", offenders: true }).filter((c) =>
        COLUMNS.includes(c.id!)
      ),
    []
  )
  if (q.isError) return <QueryError error={q.error} />
  const d = q.data
  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        {d && d.kinds.length > 0 && (
          <SegmentedTabs
            value={d.kind ?? ""}
            onValueChange={(v) => patch({ kind: v })}
            items={d.kinds.map((k) => ({
              value: k.kind,
              label: (
                <span className="inline-flex items-baseline gap-1.5">
                  <span className="font-mono text-[11px] uppercase">
                    {k.kind}
                  </span>
                  <span className="num text-[11px] text-muted-foreground">
                    {fmtMs(k.p95)}
                  </span>
                </span>
              ),
            }))}
          />
        )}
        <SegmentedTabs
          className="ml-auto"
          value={days}
          onValueChange={(v) => patch({ days: v })}
          items={FRAME_TABS}
        />
      </div>
      {!d ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : d.kinds.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No latency recorded in this window.
        </p>
      ) : (
        <>
          <Section title="Percentiles">
            <RollupLatencyChart series={d.series} daily={d.window.daily} />
          </Section>
          <Offenders
            title="Furthest from baseline"
            rows={d.slowest}
            columns={columns}
          />
          <Offenders title="Most spikes" rows={d.spikiest} columns={columns} />
        </>
      )}
    </div>
  )
}

function Offenders({
  title,
  rows,
  columns,
}: {
  title: string
  rows: LatencyOffender[]
  columns: ReturnType<typeof checkColumns>
}) {
  return (
    <Section title={title}>
      <DataTable
        columns={columns}
        data={rows}
        embedded
        enableExport={false}
        flexColumn="check"
      />
    </Section>
  )
}
