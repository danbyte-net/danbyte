import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"

import { apiAll } from "@/lib/api-all"
import type {
  Application,
  ApplicationFlow,
  FlowProtocol,
  InstalledSoftware,
  Status,
} from "@/lib/api"

import { flowsGraph, treeGraph, withPositions } from "./model"
import type { AppMapGraph, AppMapView } from "./model"

// What the Application map fetches and draws (#163): the applications and
// their installs for the Tree, the flows for Flows - each list walked
// whole (`apiAll`) - and the graph of the view, with the cards moved by
// hand where they were left.

export interface AppMapFilters {
  /** Applications picked; empty = all. */
  applications: readonly string[]
  /** Flows: a status id, or "". */
  status: string
  /** Flows: a protocol, or "". */
  protocol: FlowProtocol | ""
  /** A host: `device:<id>` or `vm:<id>`, or "". The Tree keeps the
   * applications installed on it; Flows the flows touching it. */
  host: string
  /** Tree: the hosts drawn under their applications. */
  hosts: boolean
}

export const NO_FILTERS: AppMapFilters = {
  applications: [],
  status: "",
  protocol: "",
  host: "",
  hosts: true,
}

/** How many filters are in force in a view (Hosts is a display choice;
 * the Tree has no status or protocol). */
export function activeFilters(f: AppMapFilters, view: AppMapView): number {
  const flows = view === "flows"
  return (
    (f.applications.length ? 1 : 0) +
    (flows && f.status ? 1 : 0) +
    (flows && f.protocol ? 1 : 0) +
    (f.host ? 1 : 0)
  )
}

/** The flows list query: the server filters what it can. One application
 * goes to the server too; several are kept here. */
export function flowsPath(f: AppMapFilters): string {
  const p = new URLSearchParams()
  if (f.applications.length === 1) p.set("application", f.applications[0])
  if (f.status) p.set("status", f.status)
  if (f.protocol) p.set("protocol", f.protocol)
  const [kind, id] = f.host.split(":")
  if (id && kind === "device") p.set("device", id)
  if (id && kind === "vm") p.set("vm", id)
  const qs = p.toString()
  return `/api/application-flows/${qs ? `?${qs}` : ""}`
}

export function useAppMap({
  view,
  filters,
  positions,
}: {
  view: AppMapView
  filters: AppMapFilters
  positions?: Readonly<Record<string, readonly [number, number]>>
}) {
  const tree = view === "tree"
  const apps = useQuery({
    queryKey: ["applications", "map"],
    queryFn: () => apiAll<Application>("/api/applications/"),
  })
  // Every install: a single application's tree needs its whole
  // subtree's, and the host filter offers every host with one.
  const installs = useQuery({
    queryKey: ["installed-software", "map"],
    queryFn: () => apiAll<InstalledSoftware>("/api/installed-software/"),
  })
  const path = flowsPath(filters)
  const flows = useQuery({
    queryKey: ["application-flows", "map", path],
    queryFn: () => apiAll<ApplicationFlow>(path),
    enabled: !tree,
  })
  const statuses = useQuery({
    queryKey: ["statuses", "applicationflow"],
    queryFn: () =>
      apiAll<Status>("/api/statuses/?available_to=applicationflow&picker=1"),
    staleTime: 5 * 60_000,
  })

  const picked = filters.applications
  const shownFlows = useMemo(() => {
    const rows = flows.data?.results ?? []
    if (picked.length < 2) return rows
    const keep = new Set(picked)
    return rows.filter((f) => keep.has(f.application.id))
  }, [flows.data, picked])

  const base: AppMapGraph | null = useMemo(() => {
    if (tree) {
      if (!apps.data || !installs.data) return null
      return treeGraph(apps.data.results, installs.data.results, {
        applications: picked,
        host: filters.host || undefined,
        hosts: filters.hosts,
      })
    }
    if (!flows.data) return null
    return flowsGraph(shownFlows)
  }, [
    tree,
    apps.data,
    installs.data,
    flows.data,
    shownFlows,
    picked,
    filters.host,
    filters.hosts,
  ])
  const graph = useMemo(
    () => (base ? withPositions(base, positions) : null),
    [base, positions]
  )

  const pending = tree ? [apps, installs] : [flows]
  const failed = pending.find((q) => q.isError) ?? null
  return {
    graph,
    /** The layout before any card was moved: what a drag is measured
     * against. */
    base,
    loading: pending.some((q) => q.isLoading),
    error: failed?.error ?? null,
    applications: apps.data?.results ?? [],
    installs: installs.data?.results ?? [],
    flows: shownFlows,
    statuses: statuses.data?.results ?? [],
  }
}

/** The cards whose centre is not where the layout put them: what is kept
 * of a drag. */
export function movedFrom(
  base: AppMapGraph,
  centres: Record<string, [number, number]>
): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {}
  for (const n of base.nodes) {
    if (!Object.hasOwn(centres, n.id)) continue
    const c = centres[n.id]
    if (
      Math.abs(c[0] - n.position.x) > 0.5 ||
      Math.abs(c[1] - n.position.y) > 0.5
    )
      out[n.id] = c
  }
  return out
}
