import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type Circuit, type Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { useTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { MiniMap } from "@/components/site-map/mini-map"
import { useState as useStripState } from "react"
import { useMe } from "@/lib/use-me"
import { CircuitDeleteDialog } from "@/components/circuit-delete-dialog"
import { buildCircuitColumns } from "@/components/columns/circuit-columns"

export const Route = createFileRoute("/circuits/")({ component: CircuitsPage })

function CircuitsPage() {
  const { canDo, humanIds } = useMe()
  const canAdd = canDo("circuit", "add")
  const canEdit = canDo("circuit", "change")
  const canDelete = canDo("circuit", "delete")
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<Circuit | null>(null)

  const query = useQuery({
    queryKey: ["circuits", q],
    queryFn: () =>
      api<Paginated<Circuit>>(
        `/api/circuits/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const rows = query.data?.results ?? []
  const onDelete = useCallback((c: Circuit) => setDeleting(c), [])
  const columns = useMemo<ColumnDef<Circuit>[]>(
    () =>
      buildCircuitColumns({
        humanIds,
        omit: ["description"],
        actions: {
          editTo: "/circuits/$id/edit",
          editParams: (c) => ({ id: c.id }),
          canEdit: () => canEdit,
          onDelete,
          canDelete: () => canDelete,
        },
      }),
    [onDelete, canEdit, canDelete, humanIds]
  )
  const { rail, filteredRows } = useTableFilters(columns, rows)

  return (
    <ListPageShell
      title="Circuits"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by circuit ID…",
      }}
      actions={
        <>
          <TableActions ioType="circuit" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/circuits/new">Add circuit</Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      <CircuitsMapStrip />
      <DataTable
        data={filteredRows}
        columns={columns}
        flexColumn="endpoints"
        tableId="circuits"
      />
      <CircuitDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}

function CircuitsMapStrip() {
  const [open, setOpen] = useStripState(
    () => localStorage.getItem("circuits:map") !== "closed"
  )
  return (
    <div className="mb-2">
      <button
        className="text-[11px] tracking-[0.08em] text-muted-foreground uppercase hover:text-foreground"
        onClick={() =>
          setOpen((v) => {
            localStorage.setItem("circuits:map", v ? "closed" : "open")
            return !v
          })
        }
      >
        {open ? "▾" : "▸"} Map
      </button>
      {open && (
        <div className="mt-1 h-44 overflow-hidden rounded-lg border border-border">
          <MiniMap className="h-full w-full" />
        </div>
      )}
    </div>
  )
}
