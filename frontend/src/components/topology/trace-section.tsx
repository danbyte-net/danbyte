import { lazy, Suspense, useMemo, useRef, useState } from "react"
import { useQuery } from "@tanstack/react-query"

import { api, type TraceGraph } from "@/lib/api"
import { IncompleteBadge } from "@/components/cable-trace-path"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { useMe } from "@/lib/use-me"
import { useUrlEnum } from "@/lib/use-url-state"
import { ExportMenu } from "./export/export-menu"
import { graphLegend, legendRows } from "./legend"
import type { CanvasHandle } from "./topology-canvas"

const AXES = ["LR", "TB"] as const

const EmbeddedMap = lazy(() =>
  import("./embedded-map").then((m) => ({ default: m.EmbeddedMap }))
)

// The end-to-end cable trace for an interface or cable, drawn as the
// Diagram draws the Topology page (embedded-map.tsx): the traced devices as
// Detailed cards, a patch panel as a dashed card with a nub on each front
// and rear port the run uses, the run itself thick in the accent colour.
// Lazy so React Flow never hits the SSR bundle. Renders nothing useful when
// the object isn't cabled.
export function TraceSection({
  url,
  queryKey,
  focusNodeId,
  urlKey,
  name = "Trace",
}: {
  /** The trace (`traceUrl`), with the map's card lines and addresses. */
  url: string
  queryKey: unknown[]
  focusNodeId?: string
  /** Put the axis on the page URL under this param, so a trace can be linked
   * the way it is being read. Omitted inside a dialog: a dialog must not
   * rewrite the address of the page behind it. */
  urlKey?: string
  /** The exported files' title and name. */
  name?: string
}) {
  const q = useQuery({ queryKey, queryFn: () => api<TraceGraph>(url) })
  const local = useState<"LR" | "TB">("LR")
  const linked = useUrlEnum<"LR" | "TB">(urlKey ?? "dir", "LR", AXES)
  const [direction, setDirection] = urlKey ? linked : local
  const graph = q.data?.device_graph
  // Two devices or more make a map; one is an uncabled port.
  const drawn = (graph?.nodes.length ?? 0) > 1
  const canvas = useRef<CanvasHandle>(null)
  const { me } = useMe()
  const legend = useMemo(
    () =>
      graph
        ? legendRows({
            viewStyle: "diagram",
            grouped: false,
            colorMode: "cable",
            ...graphLegend(graph),
          })
        : [],
    [graph]
  )

  return (
    <div>
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
          Trace
        </h2>
        {q.data && !q.data.complete && <IncompleteBadge />}
        {drawn && (
          <div className="ml-auto flex items-center gap-1.5">
            <SegmentedTabs<"LR" | "TB">
              value={direction}
              onValueChange={setDirection}
              items={[
                { value: "LR", label: "Left to right" },
                { value: "TB", label: "Top to bottom" },
              ]}
            />
            <ExportMenu
              name={name}
              modes
              legend={legend}
              document={(req) =>
                canvas.current?.document({
                  ...req,
                  meta: {
                    title: name,
                    ...(me.active_tenant
                      ? { tenant: me.active_tenant.name }
                      : {}),
                    generated_at: new Date().toISOString(),
                    danbyte_url: window.location.href,
                  },
                  origin: window.location.origin,
                }) ?? null
              }
            />
          </div>
        )}
      </div>
      {q.isLoading && <Loading />}
      {q.isError && <QueryError error={q.error} />}
      {q.data && !drawn && <EmptyState title="Not cabled." />}
      {graph && drawn && (
        <div className="h-[440px] overflow-hidden rounded-lg border border-border">
          <Suspense fallback={<Loading />}>
            <EmbeddedMap
              ref={canvas}
              graph={graph}
              focusNodeId={focusNodeId}
              direction={direction}
            />
          </Suspense>
        </div>
      )}
    </div>
  )
}
