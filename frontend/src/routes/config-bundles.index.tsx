import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { useMemo, useState } from "react"

import { api } from "@/lib/api"
import type { ConfigBundle, Paginated } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { TableActions } from "@/components/table-actions"
import { buildConfigBundleColumns } from "@/components/columns/config-bundle-columns"
import { ConfigBundleDeleteDialog } from "@/components/config-bundle-delete-dialog"

export const Route = createFileRoute("/config-bundles/")({
  component: ConfigBundlesPage,
})

function ConfigBundlesPage() {
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("configbundle", "add")
  const canEdit = canDo("configbundle", "change")
  const canDelete = canDo("configbundle", "delete")
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<ConfigBundle | null>(null)

  const query = useQuery({
    queryKey: ["config-bundles", q],
    queryFn: () =>
      api<Paginated<ConfigBundle>>(
        `/api/config-bundles/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const rows = query.data?.results ?? []
  const columns = useMemo(
    () =>
      buildConfigBundleColumns({
        humanIds,
        actions: {
          editTo: "/config-bundles/$id/edit",
          editParams: (b) => ({ id: b.id }),
          canEdit: () => canEdit,
          onDelete: setDeleting,
          canDelete: () => canDelete,
        },
      }),
    [humanIds, canEdit, canDelete]
  )

  return (
    <ListPageShell
      title="Config bundles"
      count={query.data ? rows.length : undefined}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter bundles…",
      }}
      actions={
        <>
          <TableActions ioType="configbundle" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/config-bundles/new">Add bundle</Link>
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
        flexColumn="description"
      />
      <ConfigBundleDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
