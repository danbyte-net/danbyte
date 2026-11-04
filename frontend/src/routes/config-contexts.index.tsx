import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { useCallback, useMemo, useState } from "react"

import type { ConfigContext } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { TableActions } from "@/components/table-actions"
import { buildConfigContextColumns } from "@/components/columns/config-context-columns"
import { ConfigContextDeleteDialog } from "@/components/config-context-delete-dialog"
import { SafeBulkEditBar } from "@/components/safe-bulk-edit-bar"
import { useUrlSearch } from "@/lib/url-filters"

export const Route = createFileRoute("/config-contexts/")({
  component: ConfigContextsPage,
})

function ConfigContextsPage() {
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("configcontext", "add")
  const canEdit = canDo("configcontext", "change")
  const canDelete = canDo("configcontext", "delete")
  const selectable = canEdit || canDelete
  const [q, setQ] = useUrlSearch()
  const [deleting, setDeleting] = useState<ConfigContext | null>(null)
  const [selected, setSelected] = useState<ConfigContext[]>([])

  const query = useQuery({
    queryKey: ["config-contexts", q],
    queryFn: () =>
      apiAll<ConfigContext>(
        `/api/config-contexts/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const rows = query.data?.results ?? []
  const onDelete = useCallback((c: ConfigContext) => setDeleting(c), [])
  const columns = useMemo(
    () =>
      buildConfigContextColumns({
        humanIds,
        selection: selectable,
        actions: {
          editTo: "/config-contexts/$id/edit",
          editParams: (c) => ({ id: c.id }),
          canEdit: () => canEdit,
          onDelete,
          canDelete: () => canDelete,
        },
      }),
    [onDelete, humanIds, canEdit, canDelete, selectable]
  )

  return (
    <ListPageShell
      title="Config contexts"
      count={query.data ? rows.length : undefined}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter contexts…",
      }}
      actions={
        <>
          <TableActions ioType="configcontext" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/config-contexts/new">Add context</Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      <DataTable
        data={rows}
        total={query.data?.count}
        columns={columns}
        flexColumn="criteria"
        tableId="config-contexts"
        onSelectedRowsChange={selectable ? setSelected : undefined}
        selectedRows={selectable ? selected : undefined}
      />
      <SafeBulkEditBar
        selected={selected}
        endpoint="/api/config-contexts/"
        noun={["context", "contexts"]}
        invalidate={[["config-contexts"]]}
        onCleared={() => setSelected([])}
        canEdit={canEdit}
        canDelete={canDelete}
        ioType="configcontext"
      />
      <ConfigContextDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
