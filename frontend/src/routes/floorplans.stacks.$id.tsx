import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { useEffect, useState } from "react"

import { api } from "@/lib/api"
import type { FloorPlanStack } from "@/lib/api"
import { entryFloor } from "@/lib/floor-plan-stacks"
import { usePageTitle } from "@/lib/page-title"
import { useMe } from "@/lib/use-me"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { Button } from "@/components/ui/button"
import { AddFloorDialog } from "@/components/floorplan/floor-dialogs"
import { floorPlanStackKey } from "@/components/floorplan/use-floor-plan-data"

export const Route = createFileRoute("/floorplans/stacks/$id")({
  component: FloorPlanStackPage,
})

/** A floor plan's own link (search, change log): opens the floor last viewed
 * in it in this browser, or its first floor. */
function FloorPlanStackPage() {
  const { id } = Route.useParams()
  const nav = useNavigate()
  const { canDo } = useMe()
  const [adding, setAdding] = useState(false)
  const query = useQuery({
    queryKey: floorPlanStackKey(id),
    queryFn: () => api<FloorPlanStack>(`/api/floor-plan-stacks/${id}/`),
  })
  const stack = query.data
  usePageTitle(stack?.name ?? null)
  const floor = stack ? entryFloor(stack) : null
  useEffect(() => {
    if (floor)
      void nav({ to: "/floorplans/$id", params: { id: floor }, replace: true })
  }, [floor, nav])

  if (query.isError) return <QueryError error={query.error} />
  if (!stack || floor) return <Loading />
  return (
    <div className="mx-auto w-full max-w-lg p-6">
      <h1 className="mb-4 text-base font-semibold">{stack.name}</h1>
      <EmptyState title="No floors yet.">
        {canDo("floorplan", "add") ? (
          <Button size="sm" className="mt-3" onClick={() => setAdding(true)}>
            Add floor
          </Button>
        ) : (
          <Link to="/floorplans" className="link">
            Floor plans
          </Link>
        )}
      </EmptyState>
      <AddFloorDialog
        open={adding}
        onOpenChange={setAdding}
        stack={stack}
        onAdded={(p) => nav({ to: "/floorplans/$id", params: { id: p.id } })}
      />
    </div>
  )
}
