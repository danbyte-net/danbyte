import { useQuery } from "@tanstack/react-query"

import { api, type TraceGraph } from "@/lib/api"
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
} from "@/components/cable-trace-path"
import { Loading } from "@/components/loading"
import { OpenLink } from "@/components/open-link"
import { TraceSection } from "@/components/topology/trace-section"

export interface TraceTarget {
  id: string
  name: string
}

/** Quick cable trace for one interface - the flat path strip in a dialog,
 * launched from the interfaces table without leaving the page. */
export function InterfaceTraceDialog({
  target,
  onOpenChange,
}: {
  target: TraceTarget | null
  onOpenChange: (open: boolean) => void
}) {
  const q = useQuery({
    // Same key the interface page's Trace section uses - shared cache.
    queryKey: ["trace", "interface", target?.id],
    queryFn: () => api<TraceGraph>(`/api/interfaces/${target!.id}/trace/`),
    enabled: !!target,
  })
  const steps = q.data ? linearizeTrace(q.data, "") : null
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
              Trace · <span className="font-mono">{target?.name}</span>
            </span>
            {/* The trace map below carries its own badge. */}
            {strip && !q.data?.complete && <IncompleteBadge />}
          </DialogTitle>
        </DialogHeader>
        {q.isLoading ? (
          <Loading />
        ) : strip ? (
          <div className="overflow-x-auto">
            <PathStrip steps={strip} highlightPort={target?.name} />
          </div>
        ) : target ? (
          // Breakout / looped / otherwise non-linear runs can't be a flat
          // strip - render the full trace graph inline (shares this dialog's
          // trace cache) instead of sending the user off to the interface page.
          <TraceSection
            url={`/api/interfaces/${target.id}/trace/`}
            queryKey={["trace", "interface", target.id]}
          />
        ) : null}
        {target && (
          <DialogFooter>
            <OpenLink to="/interfaces/$id" params={{ id: target.id }}>
              Open interface
            </OpenLink>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
