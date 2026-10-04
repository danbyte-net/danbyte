import { useMemo, useRef } from "react"
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"

import { fetchTopology } from "@/lib/api"
import type { Tunnel } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { EmbeddedMap } from "@/components/topology/embedded-map"
import { ExportMenu } from "@/components/topology/export/export-menu"
import { graphLegend, legendRows } from "@/components/topology/legend"
import type { CanvasHandle } from "@/components/topology/topology-canvas"
import { tunnelDeviceIds, tunnelGraph } from "./tunnel-graph"
import type { TunnelCardData } from "./tunnel-graph"

/**
 * A tunnel's Map tab, drawn as the Topology page's Diagram draws a map
 * (tunnel-graph.ts): each end a card with its role as the pill, a dashed
 * line per hub ↔ spoke or peer ↔ peer with the interface names and
 * outside addresses on it, a hub's spokes as one breakout. Clicking a card
 * opens its device (or VM). Lazy-load this, like the other maps, so React
 * Flow stays out of the page's own bundle.
 */
export function TunnelMap({ tunnel }: { tunnel: Tunnel }) {
  const navigate = useNavigate()
  const { me } = useMe()
  const canvas = useRef<CanvasHandle>(null)
  const ids = useMemo(() => tunnelDeviceIds(tunnel), [tunnel])
  // The devices' cards as the Topology page draws them: role colours and
  // card lines. A viewer who may not see them gets the names.
  const cards = useQuery({
    queryKey: ["tunnel-map-cards", ids],
    queryFn: ({ signal }) =>
      fetchTopology({ devices: ids, include: ["card"] }, { signal }),
    enabled: ids.length > 0,
    retry: false,
    staleTime: 30_000,
  })
  const model = useMemo(
    () => tunnelGraph(tunnel, cards.data),
    [tunnel, cards.data]
  )
  const legend = useMemo(
    () =>
      legendRows({
        viewStyle: "diagram",
        grouped: false,
        colorMode: "none",
        ...graphLegend(model.graph),
      }),
    [model.graph]
  )

  if (tunnel.terminations.length === 0)
    return <EmptyState title="No terminations yet." />

  return (
    <div>
      <div className="mb-2 flex items-center justify-end gap-1.5">
        <ExportMenu
          name={tunnel.name}
          modes
          legend={legend}
          document={(req) =>
            canvas.current?.document({
              ...req,
              meta: {
                title: tunnel.name,
                ...(me.active_tenant ? { tenant: me.active_tenant.name } : {}),
                generated_at: new Date().toISOString(),
                danbyte_url: window.location.href,
              },
              origin: window.location.origin,
            }) ?? null
          }
        />
      </div>
      <div className="h-[440px] overflow-hidden rounded-lg border border-border">
        {cards.isLoading ? (
          <Loading />
        ) : (
          <EmbeddedMap
            ref={canvas}
            graph={model.graph}
            direction={model.direction}
            positions={model.positions}
            onSelectNode={(d) => {
              const vm = (d as TunnelCardData).vm_id
              if (d.device_id)
                navigate({ to: "/devices/$id", params: { id: d.device_id } })
              else if (vm)
                navigate({ to: "/virtual-machines/$id", params: { id: vm } })
            }}
          />
        )}
      </div>
    </div>
  )
}
