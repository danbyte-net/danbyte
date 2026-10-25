import { useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"

import { apiAll } from "@/lib/api-all"
import type { SupportContract } from "@/lib/api"
import { buildSupportContractColumns } from "@/components/columns/support-contract-columns"
import { DataTable } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { useMe } from "@/lib/use-me"

/** One manufacturer's support contracts. The page calls it for the tab count
 * too; both share the query key, so it is fetched once. It takes the API's
 * default page, as the Support contracts list does, rather than a smaller
 * cap that hid the rest under a tab count naming them all (#439). */
export function useManufacturerContracts(
  manufacturerId: string,
  enabled = true
) {
  return useQuery({
    queryKey: ["support-contracts", "manufacturer", manufacturerId],
    queryFn: () =>
      apiAll<SupportContract>(
        `/api/support-contracts/?${new URLSearchParams({
          manufacturer: manufacturerId,
        }).toString()}`
      ),
    enabled,
  })
}

/** The Support contracts table, embedded on a manufacturer's page. */
export function EmbeddedSupportContractTable({
  manufacturerId,
}: {
  manufacturerId: string
}) {
  const { canDo, humanIds } = useMe()
  // Cost is commercial data: the API leaves it out without view_cost.
  const canSeeCost = canDo("supportcontract", "view_cost")
  const q = useManufacturerContracts(manufacturerId)

  const columns = useMemo<ColumnDef<SupportContract>[]>(
    () =>
      buildSupportContractColumns({
        humanIds,
        omit: canSeeCost
          ? ["manufacturer", "description"]
          : ["manufacturer", "description", "cost"],
      }),
    [canSeeCost, humanIds]
  )

  if (q.isError) return <QueryError error={q.error} />
  if (q.isLoading) return <Loading />
  const rows = q.data?.results ?? []
  if (rows.length === 0)
    return <EmptyState title="No support contracts with this manufacturer." />

  return (
    <DataTable
      data={rows}
      // Past even that page, the table says it holds the first rows only.
      total={q.data?.count}
      columns={columns}
      flexColumn="contract_number"
      tableId="embedded-support-contracts"
    />
  )
}
