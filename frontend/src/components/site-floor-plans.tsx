import { Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { useMemo } from "react"

import type { FloorPlanStack } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { useMe } from "@/lib/use-me"
import { buildFloorPlanStackColumns } from "@/components/columns/floor-plan-stack-columns"
import { DataTable } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { Button } from "@/components/ui/button"

/** A site's floor plans: its site-wide ones (Location reads "Whole site")
 * and those of its locations. */
export function SiteFloorPlans({ siteId }: { siteId: string }) {
  const { canDo } = useMe()
  const q = useQuery({
    queryKey: ["floor-plan-stacks", { site: siteId }],
    queryFn: () =>
      apiAll<FloorPlanStack>(`/api/floor-plan-stacks/?site=${siteId}`),
  })
  const columns = useMemo(
    () => buildFloorPlanStackColumns({ omit: ["site"] }),
    []
  )
  const add = canDo("floorplan", "add") && (
    <Button size="sm" variant="outline" asChild>
      <Link to="/floorplans/new" search={{ site: siteId }}>
        Add floor plan
      </Link>
    </Button>
  )

  if (q.isLoading) return <Loading />
  if (q.isError) return <QueryError error={q.error} />
  const rows = q.data?.results ?? []
  if (rows.length === 0)
    return (
      <EmptyState title="No floor plans yet.">
        {add && <div className="mt-3">{add}</div>}
      </EmptyState>
    )
  return (
    <div className="grid gap-3">
      {add && <div className="flex justify-end">{add}</div>}
      <DataTable
        data={rows}
        total={q.data?.count}
        columns={columns}
        tableId="embedded-floor-plan-stacks"
        flexColumn="description"
        embedded
        searchable
        searchPlaceholder="Search floor plans…"
      />
    </div>
  )
}
