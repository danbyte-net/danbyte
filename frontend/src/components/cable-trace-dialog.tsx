import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type { TraceGraph } from "@/lib/api"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  IncompleteBadge,
  linearizeTrace,
  PathStrip,
  traceUrl,
} from "@/components/cable-trace-path"
import { Loading } from "@/components/loading"
import { OpenLink } from "@/components/open-link"
import { TraceSection } from "@/components/topology/trace-section"

export interface CableTraceTarget {
  id: string
  label: string
}

/** The end-to-end run for one cable, as the flat path strip in a dialog -
 * launched from the cables table and the device Hardware tab without leaving
 * the page. Shares the trace cache with the cable page's Trace tab. */
export function CableTraceDialog({
  target,
  onOpenChange,
}: {
  target: CableTraceTarget | null
  onOpenChange: (open: boolean) => void
}) {
  const q = useQuery({
    queryKey: ["trace", "cable", target?.id],
    queryFn: () => api<TraceGraph>(traceUrl("cable", target!.id)),
    enabled: !!target,
  })
  const steps = q.data ? linearizeTrace(q.data, target?.id ?? "") : null
  // A run with two ends or more draws as the flat strip; anything else
  // (breakouts, loops) as the trace map.
  const strip =
    steps && steps.filter((s) => s.t === "chip").length >= 2 ? steps : null

  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent size="2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span>
              Trace · <span className="font-mono">{target?.label}</span>
            </span>
            {/* The trace map below carries its own badge. */}
            {strip && !q.data?.complete && <IncompleteBadge />}
          </DialogTitle>
        </DialogHeader>
        {q.isLoading ? (
          <Loading />
        ) : strip ? (
          <div className="overflow-x-auto">
            <PathStrip steps={strip} />
          </div>
        ) : target ? (
          // Breakout / looped / otherwise non-linear runs can't be a flat
          // strip - render the full trace graph inline (shares this dialog's
          // trace cache) instead of sending the user off to the cable page.
          <TraceSection
            url={traceUrl("cable", target.id)}
            queryKey={["trace", "cable", target.id]}
            name={`Trace · ${target.label}`}
          />
        ) : null}
        {target && (
          <DialogFooter>
            <OpenLink to="/cables/$id" params={{ id: target.id }}>
              Open cable
            </OpenLink>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
