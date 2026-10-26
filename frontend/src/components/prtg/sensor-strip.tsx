import { useQuery } from "@tanstack/react-query"

import { ApiError, api } from "@/lib/api"
import type { PrtgSensorSummary } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import {
  statusLabel,
  useStatusLabels,
} from "@/components/monitoring/status-palette"
import { cn } from "@/lib/utils"

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

const ORDER = [
  { key: "down", variant: "destructive" },
  { key: "degraded", variant: "warning" },
  { key: "up", variant: "success" },
  { key: "unknown", variant: "secondary" },
  { key: "paused", variant: "outline" },
] as const

/**
 * PRTG's sensor overview strip, in Danbyte's badges: one squarish `Badge`
 * per state with its count, worst first, named by the tenant's status labels.
 * States with no sensors are left out; `all` keeps them, muted.
 */
export function PrtgStateStrip({
  summary,
  all = false,
  className,
}: {
  summary: Pick<
    PrtgSensorSummary,
    "down" | "degraded" | "up" | "unknown" | "paused"
  >
  all?: boolean
  className?: string
}) {
  const labels = useStatusLabels()
  const shown = ORDER.filter((o) => all || summary[o.key] > 0)
  if (shown.length === 0)
    return (
      <span className={cn("text-xs text-muted-foreground", className)}>
        No sensors
      </span>
    )
  return (
    <span
      className={cn("inline-flex flex-wrap items-center gap-1.5", className)}
      data-testid="prtg-state-strip"
    >
      {shown.map((o) => (
        <Badge
          key={o.key}
          variant={summary[o.key] > 0 ? o.variant : "outline"}
          className={cn("num", summary[o.key] === 0 && "text-muted-foreground")}
          data-state={o.key}
        >
          {summary[o.key]}{" "}
          {o.key === "paused" ? "paused" : statusLabel(o.key, labels)}
        </Badge>
      ))}
    </span>
  )
}
