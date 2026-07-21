import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"

import { api, type TraceGraph } from "@/lib/api"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { linearizeTrace, PathStrip } from "@/components/cable-trace-path"
import { TraceSection } from "@/components/topology/trace-section"

export interface TraceTarget {
  id: string
  name: string
}

/** Quick cable trace for one interface — the flat path strip in a dialog,
 * launched from the interfaces table without leaving the page. */
export function InterfaceTraceDialog({
  target,
  onOpenChange,
}: {
  target: TraceTarget | null
  onOpenChange: (open: boolean) => void
}) {
  const q = useQuery({
    // Same key the interface page's Trace section uses — shared cache.
    queryKey: ["trace", "interface", target?.id],
    queryFn: () => api<TraceGraph>(`/api/interfaces/${target!.id}/trace/`),
    enabled: !!target,
  })
  const steps = q.data ? linearizeTrace(q.data, "") : null

  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            Trace · <span className="font-mono">{target?.name}</span>
          </DialogTitle>
        </DialogHeader>
        {q.isLoading ? (
          <div className="h-16 animate-pulse rounded-md bg-muted/30" />
        ) : steps && steps.filter((s) => s.t === "chip").length >= 2 ? (
          <>
            {q.data && !q.data.complete && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400">
                Incomplete — the run dead-ends before reaching a far port.
              </p>
            )}
            <div className="overflow-x-auto">
              <PathStrip steps={steps} highlightPort={target?.name} />
            </div>
          </>
        ) : target ? (
          // Breakout / looped / otherwise non-linear runs can't be a flat
          // strip — render the full trace graph inline (shares this dialog's
          // trace cache) instead of sending the user off to the interface page.
          <TraceSection
            url={`/api/interfaces/${target.id}/trace/`}
            queryKey={["trace", "interface", target.id]}
          />
        ) : null}
        {target && (
          <Button size="sm" variant="outline" className="w-fit" asChild>
            <Link to="/interfaces/$id" params={{ id: target.id }}>
              Open interface
            </Link>
          </Button>
        )}
      </DialogContent>
    </Dialog>
  )
}
