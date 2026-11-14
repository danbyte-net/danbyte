import type { ReactNode } from "react"
import { Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  ChevronDown,
  Network,
  Route as RouteIcon,
  Waypoints,
} from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

/** One place to look a cable up: the topology, the floor plan or the site
 * map. `solo` labels it when it is the only one. */
interface Place {
  key: string
  label: string
  solo: string
  icon: ReactNode
  render: (body: ReactNode) => ReactNode
}

/**
 * "Show on" for a cable's page (#507): the places that show this cable, as
 * one control - a plain button when there is one, a menu when there are
 * more, nothing when there are none.
 *
 * - **Topology** - the run's devices (and panels) on the topology map.
 * - **Floor plan** - the plan that shows the cable, its A↔B route
 *   highlighted and the view fitted to it.
 * - **Site map** - the geographic map with the cable drawn along its
 *   assigned routes.
 */
export function CableShowOn({
  cableId,
  topology,
}: {
  cableId: string
  /** The run's devices, comma-joined, when there are two or more. */
  topology?: { devices: string; panels: boolean } | null
}) {
  const plan = useQuery({
    queryKey: ["cable-floor-plan", cableId],
    queryFn: () =>
      api<{ plan_id: string | null }>(`/api/cables/${cableId}/floor-plan/`),
  })
  const routes = useQuery({
    queryKey: ["cable-routes", "of-cable", cableId],
    queryFn: () =>
      api<{ count: number }>(`/api/cable-routes/?cable=${cableId}&page_size=1`),
  })
  const planId = plan.data?.plan_id
  const places: Place[] = []
  if (topology)
    places.push({
      key: "topology",
      label: "Topology",
      solo: "Topology",
      icon: <Network className="h-3.5 w-3.5" />,
      render: (body) => (
        <Link
          to="/topology/map"
          search={{
            devices: topology.devices,
            ...(topology.panels ? { panels: true } : {}),
          }}
        >
          {body}
        </Link>
      ),
    })
  if (planId)
    places.push({
      key: "plan",
      label: "Floor plan",
      solo: "Trace on map",
      icon: <Waypoints className="h-3.5 w-3.5" />,
      render: (body) => (
        <Link
          to="/floorplans/$id"
          params={{ id: planId }}
          search={{ trace: cableId }}
        >
          {body}
        </Link>
      ),
    })
  if (routes.data?.count)
    places.push({
      key: "site-map",
      label: "Site map",
      solo: "Show on site map",
      icon: <Waypoints className="h-3.5 w-3.5" />,
      render: (body) => (
        <Link to="/site-map" search={{ trace: cableId }}>
          {body}
        </Link>
      ),
    })
  if (places.length === 0) return null
  if (places.length === 1) {
    const [p] = places
    return (
      <Button variant="outline" size="sm" asChild>
        {p.render(
          <>
            {p.icon} {p.solo}
          </>
        )}
      </Button>
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <Waypoints className="h-3.5 w-3.5" /> Show on
          <ChevronDown className="h-3 w-3 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto">
        {places.map((p) => (
          <DropdownMenuItem key={p.key} asChild>
            {p.render(
              <>
                {p.icon} {p.label}
              </>
            )}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * "Auto-route" - asks the server to compute the best tray path for this cable
 * on its floor plan, assign those trays, and estimate the length (run +
 * vertical drops + slack; an already-recorded length is kept). Renders nothing
 * when the cable's ends aren't on any plan or the user can't edit cables.
 */
export function AutoRouteButton({ cableId }: { cableId: string }) {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const q = useQuery({
    queryKey: ["cable-floor-plan", cableId],
    queryFn: () =>
      api<{ plan_id: string | null }>(`/api/cables/${cableId}/floor-plan/`),
  })
  const planId = q.data?.plan_id
  const route = useMutation({
    mutationFn: () =>
      api<{
        reachable: boolean
        detail?: string
        tray_names: string[]
        length_m: number
        length_set: boolean
      }>(`/api/cables/${cableId}/auto-route/`, {
        method: "POST",
        body: JSON.stringify({ floor_plan: planId }),
      }),
    onSuccess: (r) => {
      if (!r.reachable) {
        toast.info(r.detail ?? "No tray path connects the two ends.")
        return
      }
      qc.invalidateQueries({ queryKey: ["cable", cableId] })
      qc.invalidateQueries({ queryKey: ["cable-floor-plan", cableId] })
      qc.invalidateQueries({ queryKey: ["floor-plan-cable-paths"] })
      toast.success(
        `Routed via ${r.tray_names.join(" → ")} · est. ${r.length_m} m` +
          (r.length_set ? "" : " (recorded length kept)")
      )
    },
    onError: (err) => apiErrorToast(err),
  })
  if (!planId || !canDo("cable", "change")) return null
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={route.isPending}
      title="Compute the best tray path, assign the trays, estimate the length"
      onClick={() => route.mutate()}
    >
      <RouteIcon className="h-3.5 w-3.5" />
      {route.isPending ? "Routing…" : "Auto-route"}
    </Button>
  )
}
