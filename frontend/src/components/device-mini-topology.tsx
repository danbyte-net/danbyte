import { lazy, Suspense, useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Link, useNavigate } from "@tanstack/react-router"
import { Maximize2 } from "lucide-react"

import { api } from "@/lib/api"
import type {
  DevicePathRun,
  GhostEdgeData,
  TopoEdge,
  TopoNode,
  TopologyGraph,
} from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { SegmentedTabs } from "@/components/segmented-tabs"
import { QueryError } from "@/components/query-error"
import { MaterializeCableDialog } from "@/components/topology/materialize-cable-dialog"
import { DevicePathsList } from "@/components/device-paths-list"

const TopologyCanvas = lazy(() =>
  import("@/components/topology/topology-canvas").then((m) => ({
    default: m.TopologyCanvas,
  }))
)

// Topology widget for the device detail page. Default view is **Paths** —
// one flat end-to-end strip per cabled port (the cable page's design),
// panels crossed front ⇄ rear. **Map** keeps the React Flow neighbourhood
// with LLDP ghosts; "Full map" jumps to /topology focused here.
export function DeviceMiniTopology({
  deviceId,
  onTraceCables,
}: {
  deviceId: string
  /** Floor-plan deep-view: trace a whole run, or one cable, on the plan. */
  onTraceCables?: (cableIds: string[]) => void
}) {
  const [view, setView] = useState<"paths" | "map">("paths")
  const [ghost, setGhost] = useState<GhostEdgeData | null>(null)
  const navigate = useNavigate()

  const paths = useQuery({
    queryKey: ["device-paths", deviceId],
    queryFn: () =>
      api<{ runs: DevicePathRun[] }>(`/api/devices/${deviceId}/paths/`),
  })
  const q = useQuery({
    queryKey: ["device-topology", deviceId],
    queryFn: () => api<TopologyGraph>(`/api/devices/${deviceId}/map/`),
    enabled: view === "map",
  })
  const ghosts = useQuery({
    queryKey: ["device-topology-ghosts", deviceId],
    queryFn: () =>
      api<{ nodes: TopoNode[]; edges: TopoEdge[] }>(
        `/api/monitoring/topology/ghosts/?device=${deviceId}`
      ),
  })

  // Merge the cabling map with the LLDP ghost graph (dedup nodes by id).
  const graph = useMemo<TopologyGraph | undefined>(() => {
    if (!q.data) return undefined
    const nodes = [...q.data.nodes]
    const have = new Set(nodes.map((n) => n.id))
    for (const n of ghosts.data?.nodes ?? []) {
      if (!have.has(n.id)) {
        nodes.push(n)
        have.add(n.id)
      }
    }
    const present = new Set(nodes.map((n) => n.id))
    const ghostEdges = (ghosts.data?.edges ?? []).filter(
      (e) => present.has(e.source) && present.has(e.target)
    )
    return { ...q.data, nodes, edges: [...q.data.edges, ...ghostEdges] }
  }, [q.data, ghosts.data])

  const runs = paths.data?.runs ?? []
  const ghostCount = ghosts.data?.edges.length ?? 0

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Topology</h2>
          {paths.data && (
            <Badge variant="secondary">
              {runs.length} run{runs.length === 1 ? "" : "s"}
            </Badge>
          )}
          {ghostCount > 0 && (
            <Badge variant="warning">
              {ghostCount} LLDP link{ghostCount === 1 ? "" : "s"}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <SegmentedTabs
            value={view}
            onValueChange={(v) => setView(v)}
            items={[
              { value: "paths", label: "Paths" },
              { value: "map", label: "Map" },
            ]}
          />
          <Button size="sm" variant="ghost" asChild className="h-7">
            <Link to="/topology" search={{ device: deviceId }}>
              <Maximize2 className="h-3.5 w-3.5" /> Full map
            </Link>
          </Button>
        </div>
      </div>

      {view === "paths" ? (
        <div className="max-h-80 overflow-auto rounded-b-lg px-3 py-2">
          <DevicePathsList deviceId={deviceId} onTraceCables={onTraceCables} />
        </div>
      ) : (
        <div className="h-72 overflow-hidden rounded-b-lg">
          {q.isError ? (
            <div className="p-4">
              <QueryError error={q.error} />
            </div>
          ) : q.isLoading || !graph ? (
            <div className="h-full w-full animate-pulse bg-muted/30" />
          ) : graph.nodes.length <= 1 ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
              Nothing cabled or seen via LLDP yet — cable up its interfaces, or
              poll it over SNMP to discover neighbours.
            </div>
          ) : (
            <Suspense
              fallback={
                <div className="h-full w-full animate-pulse bg-muted/30" />
              }
            >
              <TopologyCanvas
                graph={graph}
                focusNodeId={`dev:${deviceId}`}
                originId={`dev:${deviceId}`}
                onGhostEdge={setGhost}
                onSelectNode={(d) => {
                  if (d.device_id && d.device_id !== deviceId)
                    navigate({
                      to: "/devices/$id",
                      params: { id: d.device_id },
                    })
                }}
                onSelectEdge={(d) => {
                  if (d.cable_id)
                    navigate({ to: "/cables/$id", params: { id: d.cable_id } })
                }}
              />
            </Suspense>
          )}
        </div>
      )}
      <MaterializeCableDialog ghost={ghost} onClose={() => setGhost(null)} />
    </div>
  )
}
