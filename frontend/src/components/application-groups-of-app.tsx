import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"

import { apiAll } from "@/lib/api-all"
import type { ApplicationGroup } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { DataTable } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { buildApplicationGroupColumns } from "@/components/columns/application-group-columns"

/** The application groups an application is a member of (#436) - the
 * Groups tab of the application page. */
export function ApplicationGroupsOfApp({
  applicationId,
}: {
  applicationId: string
}) {
  const { humanIds } = useMe()
  const q = useQuery({
    queryKey: ["application-groups", "application", applicationId],
    queryFn: () =>
      apiAll<ApplicationGroup>(
        `/api/application-groups/?application=${applicationId}`
      ),
  })
  const columns = useMemo(
    () => buildApplicationGroupColumns<ApplicationGroup>({ humanIds }),
    [humanIds]
  )
  if (q.isLoading) return <Loading />
  if (q.isError) return <QueryError error={q.error} />
  const rows = q.data?.results ?? []
  if (rows.length === 0) return <EmptyState title="In no application group." />
  return (
    <DataTable
      data={rows}
      columns={columns}
      flexColumn="description"
      tableId="application-groups-of-app"
      embedded
    />
  )
}
