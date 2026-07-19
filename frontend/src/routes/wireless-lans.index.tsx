import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { useCallback, useMemo, useState } from "react"

import { api, type WirelessLAN, type Paginated } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader } from "@/components/data-table"
import { tagsColumn } from "@/components/cells/tag-list"
import { numidColumn } from "@/components/cells/numid"
import { useTableFilters } from "@/components/table-filters"
import { ListPageShell } from "@/components/list-page-shell"
import { RowActions } from "@/components/row-actions"
import { WirelessLANDeleteDialog } from "@/components/wireless-lan-delete-dialog"
import { StatusBadge } from "@/components/status-badge"

export const Route = createFileRoute("/wireless-lans/")({
  component: WirelessLANsPage,
})

function WirelessLANsPage() {
  const { humanIds } = useMe()
  const [q, setQ] = useState("")
  const [deleting, setDeleting] = useState<WirelessLAN | null>(null)

  const query = useQuery({
    queryKey: ["wireless-lans", q],
    queryFn: () =>
      api<Paginated<WirelessLAN>>(
        `/api/wireless-lans/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })

  const rows = query.data?.results ?? []
  const onDelete = useCallback((w: WirelessLAN) => setDeleting(w), [])
  const columns = useMemo<ColumnDef<WirelessLAN>[]>(
    () => [
      ...(humanIds ? [numidColumn<WirelessLAN>({ get: (r) => r.numid })] : []),
      {
        id: "ssid",
        accessorKey: "ssid",
        header: ({ column }) => <SortHeader column={column} label="SSID" />,
        cell: ({ row }) => (
          <Link
            to="/wireless-lans/$id/edit"
            params={{ id: row.original.id }}
            className="font-medium hover:underline"
          >
            {row.original.ssid}
          </Link>
        ),
      },
      {
        id: "group",
        accessorFn: (w) => w.group?.name ?? "",
        header: "Group",
        cell: ({ row }) => (
          <span className="text-xs">{row.original.group?.name ?? "—"}</span>
        ),
        meta: {
          facet: {
            kind: "enum",
            label: "Group",
            get: (r: WirelessLAN) => r.group?.id ?? "__none__",
            formatValue: (_v, sample) => ({
              label: sample.group?.name ?? "No group",
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
            get: (r: WirelessLAN) => r.status?.id ?? "__none__",
            formatValue: (_v, r) => ({
              label: r.status?.name ?? "No status",
              color: r.status?.color,
            }),
          },
        },
      },
      {
        id: "vlan",
        accessorFn: (w) => w.vlan?.vlan_id ?? "",
        header: "VLAN",
        cell: ({ row }) =>
          row.original.vlan ? (
            <span className="text-xs">
              <span className="font-mono">{row.original.vlan.vlan_id}</span>{" "}
              <span className="text-muted-foreground">
                {row.original.vlan.name}
              </span>
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
        meta: {
          facet: {
            kind: "enum",
            label: "VLAN",
            get: (r: WirelessLAN) => r.vlan?.id ?? "__none__",
            formatValue: (_v, sample) => ({
              label: sample.vlan?.name ?? "—",
            }),
          },
        },
      },
      {
        id: "auth",
        accessorKey: "auth_type",
        header: "Auth",
        cell: ({ row }) =>
          row.original.auth_type ? (
            <span className="text-xs">
              {row.original.auth_type_display}
              {row.original.auth_cipher && (
                <span className="text-muted-foreground">
                  {" "}
                  · {row.original.auth_cipher.toUpperCase()}
                </span>
              )}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
        meta: {
          facet: {
            kind: "enum",
            label: "Auth",
            get: (r: WirelessLAN) => r.auth_type,
            formatValue: (v) => ({ label: v || "—" }),
          },
        },
      },
      tagsColumn<WirelessLAN>({ getTags: (r) => r.tags }),
      {
        id: "actions",
        enableHiding: false,
        cell: ({ row }) => (
          <RowActions
            editTo="/wireless-lans/$id/edit"
            editParams={{ id: row.original.id }}
            onDelete={() => onDelete(row.original)}
          />
        ),
      },
    ],
    [onDelete, humanIds]
  )

  const { rail, filteredRows } = useTableFilters(columns, rows)

  return (
    <ListPageShell
      title="Wireless LANs"
      count={query.data ? filteredRows.length : undefined}
      rail={rail}
      search={{ value: q, onChange: setQ, placeholder: "Filter by SSID…" }}
      actions={
        <>
          <TableActions ioType="wirelesslan" />
          <Button size="sm" asChild>
            <Link to="/wireless-lans/new">Add wireless LAN</Link>
          </Button>
        </>
      }
      query={query}
    >
      <DataTable
        data={filteredRows}
        columns={columns}
        flexColumn="ssid"
        tableId="wireless-lans"
      />
      <WirelessLANDeleteDialog
        item={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
