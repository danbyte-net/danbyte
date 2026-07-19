import { lazy, Suspense, useState } from "react"
import { useQuery } from "@tanstack/react-query"

import { api, type TraceGraph } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { QueryError } from "@/components/query-error"
import { SegmentedTabs } from "@/components/segmented-tabs"

const TopologyCanvas = lazy(() =>
  import("./topology-canvas").then((m) => ({ default: m.TopologyCanvas }))
)

// The end-to-end cable trace for an interface or cable, rendered with the same
// React Flow canvas as the topology map (focused mode). Lazy so RF never hits
// the SSR bundle. Renders nothing useful when the object isn't cabled.
export function TraceSection({
  url,
  queryKey,
  focusNodeId,
}: {
  url: string
  queryKey: unknown[]
  focusNodeId?: string
}) {
  const q = useQuery({ queryKey, queryFn: () => api<TraceGraph>(url) })
  const [direction, setDirection] = useState<"LR" | "TB">("LR")

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
          Trace map
        </h2>
        {q.data && !q.data.complete && (
          <Badge variant="warning">Incomplete</Badge>
        )}
        {q.data && q.data.nodes.length > 1 && (
          <div className="ml-auto">
            <SegmentedTabs<"LR" | "TB">
              value={direction}
              onValueChange={setDirection}
              items={[
                { value: "LR", label: "Side-to-side" },
                { value: "TB", label: "Tree" },
              ]}
            />
          </div>
        )}
      </div>
      {q.isLoading && (
        <div className="h-16 animate-pulse rounded-lg border border-border" />
      )}
      {q.isError && <QueryError error={q.error} />}
      {q.data && (q.data.device_graph?.nodes.length ?? 0) <= 1 && (
        <p className="text-sm text-muted-foreground">
          Not cabled — nothing to trace.
        </p>
      )}
      {q.data && (q.data.device_graph?.nodes.length ?? 0) > 1 && (
        <div className="h-[440px] overflow-hidden rounded-lg border border-border">
          <Suspense
            fallback={
              <div className="h-full w-full animate-pulse bg-muted/30" />
            }
          >
            <TopologyCanvas
              graph={q.data.device_graph!}
              focusNodeId={focusNodeId}
              direction={direction}
            />
          </Suspense>
        </div>
      )}
    </div>
  )
}
