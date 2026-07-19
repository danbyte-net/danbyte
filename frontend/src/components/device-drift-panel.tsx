import { useQuery } from "@tanstack/react-query"

import { api, ApiError } from "@/lib/api"
import type {
  DeviceConfigSnapshot,
  DeviceConfigState,
  DriftStatus,
  Paginated,
} from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Section } from "@/components/ui/section"
import { SimpleTable } from "@/components/ui/simple-table"
import type { SimpleColumn } from "@/components/ui/simple-table"
import { TimeCell } from "@/components/cells/time-ago"

const STATUS: Record<
  DriftStatus,
  {
    label: string
    variant: "success" | "warning" | "destructive" | "secondary"
  }
> = {
  in_sync: { label: "In sync", variant: "success" },
  drift: { label: "Drift", variant: "warning" },
  error: { label: "Error", variant: "destructive" },
  unknown: { label: "Unknown", variant: "secondary" },
}

// One unified-diff line, tinted by its +/- prefix.
function DiffLine({ line }: { line: string }) {
  const add = line.startsWith("+") && !line.startsWith("+++")
  const del = line.startsWith("-") && !line.startsWith("---")
  const hunk = line.startsWith("@@")
  return (
    <div
      className={
        add
          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : del
            ? "bg-red-500/10 text-red-700 dark:text-red-300"
            : hunk
              ? "text-sky-600 dark:text-sky-400"
              : "text-muted-foreground"
      }
    >
      {line || " "}
    </div>
  )
}

// Reads the device's latest reported config drift (the runner POSTs actual
// config back to /api/devices/<id>/config-state/). Read-only — Danbyte never
// pulls from the device itself.
export function DeviceDriftPanel({ deviceId }: { deviceId: string }) {
  const q = useQuery({
    queryKey: ["device-config-state", deviceId],
    queryFn: async () => {
      try {
        return await api<DeviceConfigState>(
          `/api/devices/${deviceId}/config-state/`
        )
      } catch (err) {
        // 404 = nothing reported yet → render the empty state, not an error.
        if (err instanceof ApiError && err.status === 404) return null
        throw err
      }
    },
    refetchInterval: 30_000,
  })

  return (
    <Section
      title="Config drift"
      badge={
        q.data ? (
          <Badge
            variant={STATUS[q.data.status].variant}
            className="text-[10px]"
          >
            {STATUS[q.data.status].label}
          </Badge>
        ) : undefined
      }
      description="intended vs. actual, as reported by the runner"
      actions={
        q.data?.source ? (
          <span className="text-[11px] text-muted-foreground">
            via {q.data.source}
          </span>
        ) : undefined
      }
    >
      <div className="space-y-3 rounded-lg border border-border p-4">
        {q.isLoading && (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
        {!q.isLoading && q.data === null && (
          <p className="text-sm text-muted-foreground">
            No config state reported yet. Have your runner POST the device's
            actual config to{" "}
            <span className="font-mono text-[12px]">
              /api/devices/{deviceId}/config-state/
            </span>{" "}
            after a render/compare, and drift shows up here.
          </p>
        )}
        {q.data && (
          <>
            <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
              <span>Last reported</span>
              {q.data.reported_at ? (
                <TimeCell iso={q.data.reported_at} />
              ) : (
                <span>—</span>
              )}
              {q.data.template_name && (
                <span>· template {q.data.template_name}</span>
              )}
            </div>
            {q.data.status === "drift" ? (
              <pre className="max-h-96 overflow-auto rounded-md bg-muted/40 p-3 font-mono text-[12px] leading-relaxed">
                {q.data.diff.split("\n").map((line, i) => (
                  <DiffLine key={i} line={line} />
                ))}
              </pre>
            ) : q.data.status === "in_sync" ? (
              <p className="text-sm text-emerald-700 dark:text-emerald-300">
                Actual config matches the intended config.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                Not enough information to compare (intended or actual config was
                empty).
              </p>
            )}
            <DriftHistory deviceId={deviceId} />
          </>
        )}
      </div>
    </Section>
  )
}

const HISTORY_COLUMNS: SimpleColumn<DeviceConfigSnapshot>[] = [
  {
    id: "status",
    header: "Status",
    cell: (e) => (
      <Badge variant={STATUS[e.status].variant}>{STATUS[e.status].label}</Badge>
    ),
  },
  {
    id: "source",
    header: "Source",
    flex: true,
    cell: (e) => (
      <span className="text-muted-foreground">{e.source || "—"}</span>
    ),
  },
  {
    id: "when",
    header: "When",
    align: "right",
    cell: (e) => <TimeCell iso={e.created_at} align="right" />,
  },
]

// Recent drift transitions (drifted, resolved, …), newest first.
function DriftHistory({ deviceId }: { deviceId: string }) {
  const q = useQuery({
    queryKey: ["device-config-history", deviceId],
    queryFn: () =>
      api<Paginated<DeviceConfigSnapshot>>(
        `/api/config-snapshots/?device=${deviceId}`
      ),
    refetchInterval: 30_000,
  })
  const events = (q.data?.results ?? []).slice(0, 8)
  if (events.length <= 1) return null
  return (
    <div>
      <div className="mb-1 text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
        History
      </div>
      <SimpleTable
        columns={HISTORY_COLUMNS}
        data={events}
        getRowKey={(e) => e.id}
      />
    </div>
  )
}
