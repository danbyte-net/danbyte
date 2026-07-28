import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api } from "@/lib/api"
import type { ContactGroup, Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { buildContactGroupColumns } from "@/components/columns/contact-group-columns"
import { ContactGroupDeleteDialog } from "@/components/contact-group-delete-dialog"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/contact-groups/")({
  component: ListPage,
})

function ListPage() {
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<ContactGroup | null>(null)
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("contactgroup", "add")
  const canEdit = canDo("contactgroup", "change")
  const canDelete = canDo("contactgroup", "delete")

  const query = useQuery({
    queryKey: ["contact-groups", q],
    queryFn: () =>
      api<Paginated<ContactGroup>>(
        `/api/contact-groups/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })
  const rows = query.data?.results ?? []
  const handleDelete = useCallback((v: ContactGroup) => setDeleting(v), [])
  const columns = useMemo<ColumnDef<ContactGroup>[]>(
    () =>
      buildContactGroupColumns({
        humanIds,
        selection: true,
        actions: {
          editTo: canEdit ? "/contact-groups/$id/edit" : undefined,
          editParams: (g) => ({ id: g.id }),
          onDelete: canDelete ? handleDelete : undefined,
        },
      }),
    [handleDelete, canEdit, canDelete, humanIds]
  )

  return (
    <ListPageShell
      title="Contact groups"
      count={query.data ? rows.length : undefined}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter…",
      }}
      actions={
        <>
          <TableActions ioType="contactgroup" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/contact-groups/new">Add group</Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      <DataTable
        data={rows}
        columns={columns}
        flexColumn="description"
        tableId="contact-groups"
      />
      <ContactGroupDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
