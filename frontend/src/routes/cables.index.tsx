import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { ArrowLeftRight, ChevronDown, Waypoints } from "lucide-react"
import { useCallback, useMemo, useState } from "react"

import { api } from "@/lib/api"
import type { Cable, Paginated, Status, Termination } from "@/lib/api"
import { StatusBadge } from "@/components/status-badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { DataTable, selectionColumn } from "@/components/data-table"
import { useTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { tagsColumn } from "@/components/cells/tag-list"
import { timeAgoColumn } from "@/components/cells/time-ago"
import { numidColumn } from "@/components/cells/numid"
import { CableDeleteDialog } from "@/components/cable-delete-dialog"
import { CableTraceDialog } from "@/components/cable-trace-dialog"
import { cableTint } from "@/components/cable-status-control"
import type { CableTraceTarget } from "@/components/cable-trace-dialog"
import { RowActions } from "@/components/row-actions"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"

export const Route = createFileRoute("/cables/")({ component: CablesPage })

// Inline status control: click the badge to switch a cable between its
// available statuses (Connected / Planned / Decommissioning) without opening
// the edit form. Falls back to a plain badge when the user can't edit.
function CableStatusCell({
  cable,
  canEdit,
}: {
  cable: Cable
  canEdit: boolean
}) {
  const qc = useQueryClient()
  const statuses = useQuery({
    queryKey: ["statuses", "cable"],
    queryFn: () =>
      api<Paginated<Status>>("/api/statuses/?available_to=cable&picker=1"),
    enabled: canEdit,
    staleTime: 5 * 60_000,
  })
  const setStatus = useMutation({
    mutationFn: (statusId: string) =>
      api<Cable>(`/api/cables/${cable.id}/`, {
        method: "PATCH",
        body: JSON.stringify({ status_id: statusId }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cables"] }),
    onError: (e: unknown) => apiErrorToast(e, "Could not change status"),
  })
  if (!canEdit) return <StatusBadge status={cable.status} />
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1 rounded-md hover:bg-muted/60"
          onClick={(e) => e.stopPropagation()}
          title="Change cable status"
        >
          <StatusBadge status={cable.status} />
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        {(statuses.data?.results ?? []).map((s) => (
          <DropdownMenuItem
            key={s.id}
            disabled={setStatus.isPending || s.id === cable.status?.id}
            onSelect={() => setStatus.mutate(s.id)}
          >
            <span
              className="mr-2 h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: s.color }}
            />
            {s.name}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function termSummary(terms: Termination[]): string {
  if (!terms.length) return "—"
  return terms.map((t) => `${t.device.name}:${t.name}`).join(", ")
}

function CablesPage() {
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<Cable | null>(null)
  const [tracing, setTracing] = useState<CableTraceTarget | null>(null)

  const { canDo, humanIds } = useMe()
  const canAdd = canDo("cable", "add")
  const canEdit = canDo("cable", "change")
  const canDelete = canDo("cable", "delete")

  const query = useQuery({
    queryKey: ["cables", q],
    queryFn: () =>
      api<Paginated<Cable>>(
        `/api/cables/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })
  const rows = query.data?.results ?? []

  const handleDelete = useCallback((c: Cable) => setDeleting(c), [])
  const handleTrace = useCallback(
    (c: Cable) =>
      setTracing({ id: c.id, label: c.label || `Cable #${c.numid}` }),
    []
  )
  const columns = useMemo<ColumnDef<Cable>[]>(
    () =>
      buildColumns({
        onDelete: handleDelete,
        onTrace: handleTrace,
        canEdit,
        canDelete,
        humanIds,
      }),
    [handleDelete, handleTrace, canEdit, canDelete, humanIds]
  )
  const { rail, filteredRows } = useTableFilters(columns, rows)

  return (
    <ListPageShell
      title="Cables"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by device, port…",
      }}
      actions={
        <>
          <TableActions ioType="cable" />
          {canAdd && (
            <Button size="sm" asChild>
              <Link to="/cables/new">Add cable</Link>
            </Button>
          )}
        </>
      }
      query={query}
    >
      <DataTable
        data={filteredRows}
        columns={columns}
        flexColumn="description"
        tableId="cables"
        rowStyle={(c) => cableTint(c.status)}
      />
      <CableDeleteDialog
        cable={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
      <CableTraceDialog
        target={tracing}
        onOpenChange={(o) => !o && setTracing(null)}
      />
    </ListPageShell>
  )
}

function buildColumns({
  onDelete,
  onTrace,
  canEdit,
  canDelete,
  humanIds,
}: {
  onDelete: (c: Cable) => void
  onTrace: (c: Cable) => void
  canEdit: boolean
  canDelete: boolean
  humanIds: boolean
}): ColumnDef<Cable>[] {
  return [
    selectionColumn<Cable>(),
    ...(humanIds ? [numidColumn<Cable>({ get: (r) => r.numid })] : []),
    {
      id: "label",
      accessorKey: "label",
      header: "Label",
      cell: ({ row }) =>
        row.original.label ? (
          <Link
            to="/cables/$id"
            params={{ id: row.original.id }}
            className="text-xs font-medium hover:underline"
          >
            {row.original.label}
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "a",
      header: "A side",
      enableSorting: false,
      cell: ({ row }) => (
        <Link
          to="/cables/$id"
          params={{ id: row.original.id }}
          className="font-mono text-xs hover:underline"
        >
          {termSummary(row.original.a_terminations)}
        </Link>
      ),
    },
    {
      id: "link",
      header: "",
      enableSorting: false,
      cell: () => (
        <ArrowLeftRight className="h-3.5 w-3.5 text-muted-foreground" />
      ),
    },
    {
      id: "b",
      header: "B side",
      enableSorting: false,
      cell: ({ row }) => (
        <Link
          to="/cables/$id"
          params={{ id: row.original.id }}
          className="font-mono text-xs hover:underline"
        >
          {termSummary(row.original.b_terminations)}
        </Link>
      ),
    },
    {
      id: "type",
      accessorKey: "type",
      header: "Type",
      cell: ({ row }) =>
        row.original.type ? (
          <span className="text-xs">{row.original.type_display}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
      meta: {
        facet: {
          kind: "enum",
          label: "Type",
          get: (r: Cable) => r.type || "__none__",
          formatValue: (v, sample) => ({
            label: v === "__none__" ? "—" : sample.type_display || v,
          }),
        },
      },
    },
    {
      id: "status",
      accessorFn: (r) => r.status?.name ?? "",
      header: "Status",
      cell: ({ row }) => (
        <CableStatusCell cable={row.original} canEdit={canEdit} />
      ),
      meta: {
        facet: {
          kind: "enum",
          label: "Status",
          get: (r: Cable) => r.status?.id ?? "__none__",
          formatValue: (_v, r) => ({
            label: r.status?.name ?? "No status",
            color: r.status?.color,
          }),
        },
      },
    },
    {
      id: "description",
      accessorKey: "description",
      header: "Description",
      cell: ({ row }) => (
        <span className="line-clamp-1 block text-muted-foreground">
          {row.original.description || "—"}
        </span>
      ),
    },
    tagsColumn<Cable>({ getTags: (r) => r.tags }),
    timeAgoColumn<Cable>({
      id: "updated",
      header: "Updated",
      get: (r) => r.updated_at,
      align: "right",
    }),
    {
      id: "actions",
      enableHiding: false,
      cell: ({ row }) => (
        <div className="flex items-center justify-end gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-7"
            title="Trace this run"
            aria-label={`Trace ${row.original.label || "cable"}`}
            onClick={() => onTrace(row.original)}
          >
            <Waypoints className="h-3.5 w-3.5" />
          </Button>
          <RowActions
            editTo={canEdit ? "/cables/$id/edit" : undefined}
            editParams={{ id: row.original.id }}
            onDelete={canDelete ? () => onDelete(row.original) : undefined}
          />
        </div>
      ),
    },
  ]
}
