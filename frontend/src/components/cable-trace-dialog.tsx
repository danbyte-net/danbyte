import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"

import { api } from "@/lib/api"
import type { TraceGraph } from "@/lib/api"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { linearizeTrace, PathStrip } from "@/components/cable-trace-path"

export interface CableTraceTarget {
  id: string
  label: string
}

/** The end-to-end run for one cable, as the flat path strip in a dialog —
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
    queryFn: () => api<TraceGraph>(`/api/cables/${target!.id}/trace/`),
    enabled: !!target,
  })
  const steps = q.data ? linearizeTrace(q.data, target?.id ?? "") : null

  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            Trace · <span className="font-mono">{target?.label}</span>
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
              <PathStrip steps={steps} />
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            This run branches (breakout) or can't be drawn flat — the cable page
            has the full trace graph.
          </p>
        )}
        {target && (
          <Button size="sm" variant="outline" className="w-fit" asChild>
            <Link to="/cables/$id" params={{ id: target.id }}>
              Open cable
            </Link>
          </Button>
        )}
      </DialogContent>
    </Dialog>
  )
}
