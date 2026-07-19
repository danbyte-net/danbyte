import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Waypoints } from "lucide-react"

import { api, type DevicePathRun } from "@/lib/api"
import { QueryError } from "@/components/query-error"
import { PathStrip, type PathStep } from "@/components/cable-trace-path"

// The end-to-end cabled runs of a device, one flat strip each (panels crossed
// front⇄rear). Shared by the device page's topology widget and the site map's
// device inspector. `onTraceCables` lets the host highlight a run's cables on
// whatever canvas it owns (floor plan or site map).
export function DevicePathsList({
  deviceId,
  onTraceCables,
  max = 5,
  emptyText = "Nothing cabled yet — connect a port and its run shows up here.",
}: {
  deviceId: string
  onTraceCables?: (cableIds: string[]) => void
  max?: number
  emptyText?: string
}) {
  const [showAll, setShowAll] = useState(false)
  const paths = useQuery({
    queryKey: ["device-paths", deviceId],
    queryFn: () =>
      api<{ runs: DevicePathRun[] }>(`/api/devices/${deviceId}/paths/`),
  })
  const runs = paths.data?.runs ?? []

  if (paths.isError)
    return (
      <div className="p-2">
        <QueryError error={paths.error} />
      </div>
    )
  if (paths.isLoading)
    return <div className="h-16 w-full animate-pulse rounded bg-muted/30" />
  if (runs.length === 0)
    return <p className="px-1 text-[12px] text-muted-foreground">{emptyText}</p>

  return (
    <div className="divide-y divide-border">
      {(showAll ? runs : runs.slice(0, max)).map((run, i) => (
        <PathRow
          key={`${run.origin.name}:${i}`}
          run={run}
          onTraceCables={onTraceCables}
        />
      ))}
      {runs.length > max && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="w-full px-1 py-1.5 text-left text-[11px] text-muted-foreground hover:text-foreground"
        >
          {showAll ? "Show fewer" : `Show all ${runs.length} runs`}
        </button>
      )}
    </div>
  )
}

/** Every cable id across all of a device's runs — for a one-shot "trace
 * everything" action. */
export function runCableIds(runs: DevicePathRun[]): string[] {
  const ids = new Set<string>()
  for (const run of runs)
    for (const s of run.steps)
      if (s.t === "seg" && s.cable_id) ids.add(s.cable_id)
  return [...ids]
}

export function PathRow({
  run,
  onTraceCables,
}: {
  run: DevicePathRun
  onTraceCables?: (cableIds: string[]) => void
}) {
  const ids = useMemo(
    () =>
      run.steps
        .filter((s): s is Extract<typeof s, { t: "seg" }> => s.t === "seg")
        .map((s) => s.cable_id)
        .filter((id): id is string => !!id),
    [run.steps]
  )
  const steps = useMemo<PathStep[]>(
    () =>
      run.steps.map((s) =>
        s.t === "chip"
          ? {
              t: "chip",
              chip: {
                deviceId: s.device_id,
                device: s.device,
                origin: s.origin,
                ports: s.ports.map((p) => ({
                  name: p.name,
                  interfaceId: p.interface_id ?? undefined,
                })),
              },
            }
          : {
              t: "seg",
              seg: {
                cableId: s.cable_id,
                label: s.label,
                tag: s.cable_label ?? undefined,
                color: s.color ?? undefined,
                self: false,
                fiber: s.fiber,
                fiberCount: s.fiber_count,
                strand: s.strand,
                strandColor: s.strand_color,
              },
            }
      ),
    [run.steps]
  )
  const hasLeading = (onTraceCables && ids.length > 0) || !run.complete
  return (
    <div className="px-1 py-1">
      <PathStrip
        steps={steps}
        onTraceCable={
          onTraceCables ? (cableId) => onTraceCables([cableId]) : undefined
        }
        leading={
          hasLeading ? (
            <div className="mr-2 flex shrink-0 items-center gap-1.5">
              {onTraceCables && ids.length > 0 && (
                <button
                  type="button"
                  title="Trace this whole run"
                  onClick={() => onTraceCables(ids)}
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                >
                  <Waypoints className="h-3.5 w-3.5" />
                </button>
              )}
              {!run.complete && (
                <span className="shrink-0 text-[9px] text-amber-600 dark:text-amber-400">
                  incomplete
                </span>
              )}
            </div>
          ) : undefined
        }
      />
    </div>
  )
}
