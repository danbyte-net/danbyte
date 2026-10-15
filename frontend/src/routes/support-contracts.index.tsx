import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api } from "@/lib/api"
import type { Paginated, SupportContract } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { useTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { SafeBulkDeleteBar } from "@/components/safe-bulk-delete-bar"
import { TableActions } from "@/components/table-actions"
import { useMe } from "@/lib/use-me"
import { SupportContractDeleteDialog } from "@/components/support-contract-delete-dialog"
import { buildSupportContractColumns } from "@/components/columns/support-contract-columns"

export const Route = createFileRoute("/support-contracts/")({
  component: SupportContractsPage,
})

function SupportContractsPage() {
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("supportcontract", "add")
  const canEdit = canDo("supportcontract", "change")
  const canDelete = canDo("supportcontract", "delete")
  // Cost is commercial data: the API leaves it out without view_cost.
  const canSeeCost = canDo("supportcontract", "view_cost")
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<SupportContract | null>(null)
  const [selectedRows, setSelectedRows] = useState<SupportContract[]>([])

  const query = useQuery({
    queryKey: ["support-contracts", q],
    queryFn: () =>
      api<Paginated<SupportContract>>(
        `/api/support-contracts/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })
  const rows = query.data?.results ?? []
  const onDelete = useCallback((c: SupportContract) => setDeleting(c), [])

  const columns = useMemo<ColumnDef<SupportContract>[]>(
    () =>
      buildSupportContractColumns({
        humanIds,
        selection: canDelete,
        omit: canSeeCost ? ["description"] : ["description", "cost"],
        actions: {
          editTo: "/support-contracts/$id/edit",
          editParams: (c) => ({ id: c.id }),
          canEdit: (c) => c.permissions?.change ?? canEdit,
          onDelete,
          canDelete: (c) => c.permissions?.delete ?? canDelete,
        },
      }),
    [onDelete, canEdit, canDelete, canSeeCost, humanIds]
  )
  const {
    rail,
    filteredRows,
    snapshot,
    restore,
    activeCount,
    columns: wiredColumns,
  } = useTableFilters(columns, rows)

  return (
    <ListPageShell
      title="Support contracts"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      savedViews={{
        objectType: "supportcontract",
        filters: { snapshot, restore, activeCount },
      }}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by number, reseller…",
      }}
      actions={
        <>
          <TableActions ioType="supportcontract" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/support-contracts/new">Add contract</Link>
            </Button>
          )}
        </>
      }
      query={query}
      page={query.data}
    >
      <DataTable
        data={filteredRows}
        columns={wiredColumns}
        onSelectedRowsChange={setSelectedRows}
        selectedRows={selectedRows}
        flexColumn="contract_number"
        tableId="support-contracts"
      />
      <SupportContractDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
      <SafeBulkDeleteBar
        selected={selectedRows}
        endpoint="/api/support-contracts/"
        noun={["contract", "contracts"]}
        invalidate={[["support-contracts"]]}
        onCleared={() => setSelectedRows([])}
      />
    </ListPageShell>
  )
}
