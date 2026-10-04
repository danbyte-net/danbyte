import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api } from "@/lib/api"
import type { CabinetType, Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { buildCabinetTypeColumns } from "@/components/columns/cabinet-type-columns"
import { CabinetTypeDeleteDialog } from "@/components/cabinet-type-delete-dialog"
import { EmptyState } from "@/components/empty-state"
import { ListPageShell } from "@/components/list-page-shell"
import { TableActions } from "@/components/table-actions"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/cabinet-types/")({
  component: CabinetTypesPage,
})

function CabinetTypesPage() {
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<CabinetType | null>(null)
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("cabinettype", "add")
  const canEdit = canDo("cabinettype", "change")
  const canDelete = canDo("cabinettype", "delete")

  const query = useQuery({
    queryKey: ["cabinet-types", q],
    queryFn: () =>
      api<Paginated<CabinetType>>(
        `/api/cabinet-types/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })
  const rows = query.data?.results ?? []

  const handleDelete = useCallback((t: CabinetType) => setDeleting(t), [])
  const columns = useMemo<ColumnDef<CabinetType>[]>(
    () =>
      buildCabinetTypeColumns({
        selection: true,
        humanIds,
        actions: {
          editTo: "/cabinet-types/$id/edit",
          editParams: (t) => ({ id: t.id }),
          canEdit: () => canEdit,
          onDelete: handleDelete,
          canDelete: () => canDelete,
        },
      }),
    [handleDelete, canEdit, canDelete, humanIds]
  )

  return (
    <ListPageShell
      title="Cabinet types"
      count={query.data ? rows.length : undefined}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by name, manufacturer…",
      }}
      actions={
        <>
          <TableActions ioType="cabinettype" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/cabinet-types/new">Add cabinet type</Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      {rows.length === 0 && !q ? (
        <EmptyState title="No cabinet types yet." />
      ) : (
        <DataTable
          data={rows}
          total={query.data?.count}
          columns={columns}
          flexColumn="description"
          tableId="cabinet-types"
        />
      )}
      <CabinetTypeDeleteDialog
        cabinetType={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
