import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { ColorBadge } from "@/components/cells/color-badge"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type Circuit, type Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader } from "@/components/data-table"
import { tagsColumn } from "@/components/cells/tag-list"
import { useTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { MiniMap } from "@/components/site-map/mini-map"
import { useState as useStripState } from "react"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { numidColumn } from "@/components/cells/numid"
import { RowActions } from "@/components/row-actions"
import { useMe } from "@/lib/use-me"
import { CircuitDeleteDialog } from "@/components/circuit-delete-dialog"
import { StatusBadge } from "@/components/status-badge"

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
    () => [
      ...(humanIds ? [numidColumn<Circuit>({ get: (r) => r.numid })] : []),
      {
        id: "cid",
        accessorKey: "cid",
        header: ({ column }) => (
          <SortHeader column={column} label="Circuit ID" />
        ),
        cell: ({ row }) => (
          <Link
            to="/circuits/$id"
            params={{ id: row.original.id }}
            className="font-mono text-xs font-medium hover:underline"
          >
            {row.original.cid}
          </Link>
        ),
      },
      {
        id: "provider",
        accessorFn: (c) => c.provider?.name ?? "",
        header: "Provider",
        cell: ({ row }) => (
          <span className="text-xs">{row.original.provider?.name ?? "—"}</span>
        ),
        meta: {
          facet: {
            kind: "enum",
            label: "Provider",
            get: (r: Circuit) => r.provider?.id ?? "__none__",
            formatValue: (_v, s) => ({ label: s.provider?.name ?? "None" }),
          },
        },
      },
      {
        id: "type",
        accessorFn: (c) => c.type?.name ?? "",
        header: "Type",
        cell: ({ row }) =>
          row.original.type ? (
            <ColorBadge
              name={row.original.type.name}
              color={row.original.type.color || undefined}
            />
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
        meta: {
          facet: {
            kind: "enum",
            label: "Type",
            get: (r: Circuit) => r.type?.id ?? "__none__",
            formatValue: (_v, s) => ({
              label: s.type?.name ?? "None",
              color: s.type?.color,
            }),
          },
        },
      },
      {
        id: "status",
        accessorFn: (r) => r.status?.name ?? "",
        header: "Status",
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
        meta: {
          facet: {
            kind: "enum",
            label: "Status",
            get: (r: Circuit) => r.status?.id ?? "__none__",
            formatValue: (_v, r) => ({
              label: r.status?.name ?? "No status",
              color: r.status?.color,
            }),
          },
        },
      },
      {
        id: "endpoints",
        header: "A → Z",
        cell: ({ row }) => {
          const ends = new Map(
            row.original.terminations.map((t) => [
              t.term_side,
              t.site?.name ?? t.provider_network?.name,
            ])
          )
          const a = ends.get("A")
          const z = ends.get("Z")
          if (!a && !z) return <span className="text-muted-foreground">—</span>
          return (
            <span className="text-xs">
              {a ?? "—"} <span className="text-muted-foreground">→</span>{" "}
              {z ?? "—"}
            </span>
          )
        },
      },
      {
        id: "commit",
        accessorKey: "commit_rate_kbps",
        header: ({ column }) => <SortHeader column={column} label="Commit" />,
        cell: ({ row }) =>
          row.original.commit_rate_kbps != null ? (
            <span className="num text-xs">
              {(row.original.commit_rate_kbps / 1000).toLocaleString()} Mbps
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      tagsColumn<Circuit>({ getTags: (r) => r.tags }),
      timeAgoColumn<Circuit>({
        id: "updated",
        header: "Updated",
        get: (r) => r.updated_at,
        align: "right",
      }),
      {
        id: "actions",
        enableHiding: false,
        cell: ({ row }) => (
          <RowActions
            editTo={canEdit ? "/circuits/$id/edit" : undefined}
            editParams={{ id: row.original.id }}
            onDelete={canDelete ? () => onDelete(row.original) : undefined}
          />
        ),
      },
    ],
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
