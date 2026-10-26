import { useQuery } from "@tanstack/react-query"

import { ApiError, api } from "@/lib/api"
import type { PrtgConnection, PrtgSensorSummary } from "@/lib/api"
import { TimeCell } from "@/components/cells/time-ago"
import {
  SourceItemsList,
  StateTip,
} from "@/components/monitoring/monitoring-bar"
import type { SourceItem } from "@/components/monitoring/monitoring-bar"
import {
  StatePill,
  mixedStateLabel,
} from "@/components/monitoring/mixed-status-badge"
import type { MixedState } from "@/components/monitoring/mixed-status-badge"
import { useStatusLabels } from "@/components/monitoring/status-palette"
import { usePrtgSensors } from "./sensor-table"

/** What a summary is narrowed to - all of the tenant's sensors, one
 * connection's, or one device's or VM's. */
export type PrtgSensorScope =
  | { connection: string }
  | { device: string }
  | { virtual_machine: string }
  | Record<string, never>

export function scopeQuery(scope: PrtgSensorScope): string {
  return Object.entries(scope)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&")
}

/** The per-state counts behind a strip, in one request. A 404 (the
 * integration is off) reads as nothing to show. */
export function usePrtgSensorSummary(scope: PrtgSensorScope, enabled = true) {
  const qs = scopeQuery(scope)
  return useQuery({
    queryKey: ["prtg-sensor-summary", qs],
    queryFn: async () => {
      try {
        return await api<PrtgSensorSummary>(
          `/api/prtg/sensors/summary/${qs ? `?${qs}` : ""}`
        )
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null
        throw e
      }
    },
    enabled,
    staleTime: 60_000,
    refetchInterval: 2 * 60_000,
  })
}

/** Worst first: what an operator reads first. */
const ORDER = ["down", "degraded", "unknown", "up", "paused"] as const

/**
 * The /prtg Overview's sensors: one 32px row per state with sensors in it,
 * the shared pill and the count - the pill is the word, the number is the
 * only other thing on the row. A row opens the tab that lists it (Alarms for
 * down and degraded, Sensors for the rest); a problem row's hover lists its
 * sensors, worst and newest first, ten at most - the Alarms tab's own read.
 */
export function PrtgSensorBreakdown({
  connection,
  summary,
  readAt,
  onOpen,
}: {
  connection: PrtgConnection
  summary: PrtgSensorSummary
  readAt?: string | null
  onOpen: (tab: "alarms" | "sensors") => void
}) {
  const labels = useStatusLabels()
  const problems = summary.down + summary.degraded > 0
  const alarms = usePrtgSensors(connection, "alarms", problems)
  const rows = ORDER.filter((k) => summary[k] > 0)
  const itemsOf = (k: MixedState): SourceItem[] =>
    (alarms.data?.results ?? [])
      .filter((s) => !s.paused && s.state === k)
      .map((s) => ({
        key: s.id,
        name: s.name,
        address: s.device?.name ?? s.virtual_machine?.name,
        status: k,
        note: s.message || undefined,
        since: s.last_down_at,
      }))
  return (
    <section
      className="flex flex-col rounded-lg border border-border bg-card"
      data-testid="prtg-sensor-breakdown"
    >
      <div className="flex h-10 items-center gap-2 border-b border-border px-3">
        <h2 className="text-[11px] font-semibold tracking-wide uppercase">
          Sensors
        </h2>
        <span className="num text-xs text-muted-foreground">
          {summary.total}
        </span>
        {readAt && (
          <span className="ml-auto inline-flex items-center gap-1 text-[11px] whitespace-nowrap text-muted-foreground">
            read <TimeCell iso={readAt} />
          </span>
        )}
      </div>
      {rows.length === 0 ? (
        <p className="px-3 py-2 text-[13px] text-muted-foreground">
          No sensors.
        </p>
      ) : (
        <div className="flex flex-col divide-y divide-border/60">
          {rows.map((k) => {
            const tab = k === "down" || k === "degraded" ? "alarms" : "sensors"
            const row = (
              <button
                type="button"
                onClick={() => onOpen(tab)}
                className="flex h-8 w-full items-center gap-3 px-3 text-left text-[13px] hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
                data-state={k}
                aria-label={`${summary[k]} ${mixedStateLabel(k, labels)}`}
              >
                <StatePill state={k} />
                <span className="num ml-auto font-medium">{summary[k]}</span>
              </button>
            )
            if (tab !== "alarms") return <div key={k}>{row}</div>
            return (
              <div key={k} className="flex [&>span]:w-full">
                <StateTip
                  content={
                    <SourceItemsList
                      items={itemsOf(k)}
                      total={summary[k]}
                      heading={`${summary[k]} ${mixedStateLabel(k, labels)}`}
                    />
                  }
                >
                  {row}
                </StateTip>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
