import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import { useCallback, useMemo, useState } from "react"

import type { RBACGroup } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { buildGroupColumns } from "@/components/columns/group-columns"
import { GroupDeleteDialog } from "@/components/group-delete-dialog"
import { SafeBulkDeleteBar } from "@/components/safe-bulk-delete-bar"
import { useMe } from "@/lib/use-me"
import { useUrlSearch } from "@/lib/url-filters"

export const Route = createFileRoute("/groups/")({ component: GroupsPage })

function GroupsPage() {
  const [q, setQ] = useUrlSearch()
  const [deleting, setDeleting] = useState<RBACGroup | null>(null)
  const [selected, setSelected] = useState<RBACGroup[]>([])
  const { canDo } = useMe()
  const canAdd = canDo("group", "add")
  const canEdit = canDo("group", "change")
  const canDelete = canDo("group", "delete")

  const query = useQuery({
    queryKey: ["groups"],
    queryFn: () => apiAll<RBACGroup>("/api/groups/"),
  })

  const allRows = query.data?.results ?? []
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return allRows
    return allRows.filter(
      (g) =>
        g.name.toLowerCase().includes(needle) ||
        g.description.toLowerCase().includes(needle)
    )
  }, [allRows, q])

  const handleDelete = useCallback((g: RBACGroup) => setDeleting(g), [])
  const columns = useMemo(
    () =>
      buildGroupColumns({
        // Groups have no bulk edit: the one bulk action is Delete.
        selection: canDelete,
        actions: {
          editTo: "/groups/$id/edit",
          editParams: (g) => ({ id: String(g.id) }),
          canEdit: () => canEdit,
          onDelete: handleDelete,
          canDelete: (g) => canDelete && !g.built_in,
        },
      }),
    [handleDelete, canEdit, canDelete]
  )

  return (
    <ListPageShell
      title="Groups"
      count={query.data ? rows.length : undefined}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter groups…",
      }}
      actions={
        <>
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/groups/new">Add group</Link>
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
        tableId="groups"
        onSelectedRowsChange={canDelete ? setSelected : undefined}
        selectedRows={canDelete ? selected : undefined}
      />
      <SafeBulkDeleteBar
        selected={selected.map((g) => ({ id: String(g.id) }))}
        endpoint="/api/groups/"
        noun={["group", "groups"]}
        invalidate={[["groups"], ["object-permissions"]]}
        onCleared={() => setSelected([])}
      />
      <GroupDeleteDialog
        group={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
