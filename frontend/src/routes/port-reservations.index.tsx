import { useMemo, useState } from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { Trash2 } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { Paginated, PortReservation } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader } from "@/components/data-table"
import { ListPageShell } from "@/components/list-page-shell"
import { TimeCell } from "@/components/cells/time-ago"
import { useTableFilters } from "@/components/table-filters"
import { useMe } from "@/lib/use-me"

// Direct holds on single uncabled ports - the planning half of cabling that
// doesn't know its far end yet. Rows disappear on their own when a cable
// lands on the port (the backend releases the hold).

export const Route = createFileRoute("/port-reservations/")({
  component: PortReservationsPage,
})

const KIND_LABEL: Record<string, string> = {
  interface: "Interface",
  front_port: "Front port",
  rear_port: "Rear port",
  console_port: "Console port",
  console_server_port: "Console server port",
  power_port: "Power port",
  power_outlet: "Power outlet",
  power_feed: "Power feed",
  aux_port: "Aux port",
}

function PortReservationsPage() {
  const qc = useQueryClient()
  const { canDo } = useMe()
  const canRelease = canDo("portreservation", "delete")
  const [search, setSearch] = useState("")

  const q = useQuery({
    queryKey: ["port-reservations"],
    queryFn: () =>
      api<Paginated<PortReservation>>("/api/port-reservations/?page_size=500"),
  })

  const release = useMutation({
    mutationFn: (id: string) =>
      api(`/api/port-reservations/${id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Reservation released")
      qc.invalidateQueries({ queryKey: ["port-reservations"] })
    },
    onError: (e) => apiErrorToast(e, "Could not release the reservation"),
  })

  const all = useMemo(() => q.data?.results ?? [], [q.data])
  const searched = useMemo(() => {
    const s = search.trim().toLowerCase()
    if (!s) return all
    return all.filter((r) =>
      [r.port.name, r.port.device.name, r.claimed_by, r.note]
        .join(" ")
        .toLowerCase()
        .includes(s)
    )
  }, [all, search])

  const columns = useMemo<ColumnDef<PortReservation>[]>(
    () => [
      {
        id: "port",
        accessorFn: (r) => `${r.port.device.name}:${r.port.name}`,
        header: ({ column }) => <SortHeader column={column} label="Port" />,
        cell: ({ row }) => (
          <span className="font-mono text-xs">
            <Link
              to="/devices/$id"
              params={{ id: row.original.port.device.id }}
              className="link"
            >
              {row.original.port.device.name}
            </Link>
            <span className="text-muted-foreground">:</span>
            {row.original.port.kind === "interface" ? (
              <Link
                to="/interfaces/$id"
                params={{ id: row.original.port.id }}
                className="link"
              >
                {row.original.port.name}
              </Link>
            ) : (
              row.original.port.name
            )}
          </span>
        ),
      },
      {
        id: "kind",
        accessorFn: (r) => KIND_LABEL[r.port.kind] ?? r.port.kind,
        header: "Kind",
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {KIND_LABEL[row.original.port.kind] ?? row.original.port.kind}
          </span>
        ),
      },
      {
        id: "site",
        accessorFn: (r) => r.site?.name ?? "",
        header: ({ column }) => <SortHeader column={column} label="Site" />,
        cell: ({ row }) =>
          row.original.site ? (
            <Link
              to="/sites/$id"
              params={{ id: row.original.site.id }}
              className="link text-xs"
            >
              {row.original.site.name}
            </Link>
          ) : (
            <span className="text-muted-foreground">-</span>
          ),
      },
      {
        id: "claimed_by",
        accessorFn: (r) => r.claimed_by,
        header: ({ column }) => (
          <SortHeader column={column} label="Reserved by" />
        ),
        cell: ({ row }) =>
          row.original.claimed_by || (
            <span className="text-muted-foreground">-</span>
          ),
      },
      {
        id: "note",
        accessorKey: "note",
        header: "Note",
        cell: ({ row }) =>
          row.original.note ? (
            <span className="text-xs">{row.original.note}</span>
          ) : (
            <span className="text-muted-foreground">-</span>
          ),
      },
      {
        id: "created",
        accessorKey: "created_at",
        header: ({ column }) => <SortHeader column={column} label="Since" />,
        cell: ({ row }) => <TimeCell iso={row.original.created_at} />,
      },
      ...(canRelease
        ? [
            {
              id: "actions",
              header: "",
              cell: ({ row }) => (
                <div className="flex justify-end">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-destructive hover:text-destructive"
                    title="Release reservation"
                    aria-label={`Release ${row.original.port.name}`}
                    disabled={release.isPending}
                    onClick={() => release.mutate(row.original.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ),
            } satisfies ColumnDef<PortReservation>,
          ]
        : []),
    ],
    [canRelease, release]
  )

  const { rail, filteredRows, snapshot, restore, activeCount } =
    useTableFilters(columns, searched)

  return (
    <ListPageShell
      title="Port reservations"
      count={q.data ? filteredRows.length : undefined}
      rail={rail}
      savedViews={{
        objectType: "portreservation",
        filters: { snapshot, restore, activeCount },
      }}
      search={{
        value: search,
        onChange: setSearch,
        placeholder: "Filter reservations…",
      }}
      query={q}
    >
      <DataTable
        data={filteredRows}
        columns={columns}
        flexColumn="note"
        tableId="port-reservations"
        exportName="port-reservations"
        exportTitle="Port reservations"
      />
    </ListPageShell>
  )
}
