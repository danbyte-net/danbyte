import { createFileRoute, Link } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { apiAll } from "@/lib/api-all"
import type { Room } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { buildRoomColumns } from "@/components/columns/room-columns"
import { RoomDeleteDialog } from "@/components/room-delete-dialog"
import { ListPageShell } from "@/components/list-page-shell"
import { SafeBulkEditBar } from "@/components/safe-bulk-edit-bar"
import { TableActions } from "@/components/table-actions"
import { useUrlTableFilters } from "@/components/table-filters"
import { useMe } from "@/lib/use-me"
import { useUrlSearch } from "@/lib/url-filters"

export const Route = createFileRoute("/rooms/")({ component: RoomsPage })

function RoomsPage() {
  const [q, setQ] = useUrlSearch()
  const [deleting, setDeleting] = useState<Room | null>(null)
  const [selected, setSelected] = useState<Room[]>([])
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("room", "add")
  const canEdit = canDo("room", "change")
  const canDelete = canDo("room", "delete")

  const query = useQuery({
    queryKey: ["rooms", q],
    queryFn: () =>
      apiAll<Room>(
        `/api/rooms/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const handleDelete = useCallback((r: Room) => setDeleting(r), [])
  const selectable = canEdit || canDelete
  const columns = useMemo<ColumnDef<Room>[]>(
    () =>
      buildRoomColumns({
        selection: selectable,
        humanIds,
        actions: {
          editTo: "/rooms/$id/edit",
          editParams: (r) => ({ id: r.id }),
          canEdit: () => canEdit,
          onDelete: handleDelete,
          canDelete: () => canDelete,
        },
      }),
    [handleDelete, selectable, canEdit, canDelete, humanIds]
  )

  const allRows = query.data?.results ?? []
  const {
    rail,
    filteredRows,
    snapshot,
    restore,
    activeCount,
    columns: wiredColumns,
  } = useUrlTableFilters(columns, allRows)

  return (
    <ListPageShell
      title="Rooms"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      savedViews={{
        objectType: "room",
        filters: { snapshot, restore, activeCount },
      }}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by name, code…",
      }}
      actions={
        <>
          <TableActions ioType="room" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/rooms/new">Add room</Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      <DataTable
        data={filteredRows}
        columns={wiredColumns}
        flexColumn="description"
        tableId="rooms"
        onSelectedRowsChange={selectable ? setSelected : undefined}
        selectedRows={selectable ? selected : undefined}
      />
      <SafeBulkEditBar
        selected={selected}
        endpoint="/api/rooms/"
        noun={["room", "rooms"]}
        invalidate={[["rooms"], ["rooms-picker"], ["locations"]]}
        onCleared={() => setSelected([])}
        canEdit={canEdit}
        canDelete={canDelete}
      />
      <RoomDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
