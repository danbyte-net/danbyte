import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { Cable as CableIcon } from "lucide-react"
import { useCallback, useMemo, useState } from "react"

import { api, type Interface, type Paginated } from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DataTable, SortHeader, selectionColumn } from "@/components/data-table"
import {
  cableTint,
  CableStatusControl,
} from "@/components/cable-status-control"
import { tagsColumn } from "@/components/cells/tag-list"
import {
  FilterRail,
  FacetGroup,
  toggleInSet,
  type FacetOption,
} from "@/components/filter-rail"
import { ListPageShell } from "@/components/list-page-shell"
import { InterfaceDeleteDialog } from "@/components/interface-delete-dialog"
import { RowActions } from "@/components/row-actions"
import { useMe } from "@/lib/use-me"

export const Route = createFileRoute("/interfaces/")({
  component: InterfacesPage,
})

function InterfacesPage() {
  const [q, setQ] = useState("")
  const [deviceFilter, setDeviceFilter] = useState<Set<string>>(new Set())
  const [deleting, setDeleting] = useState<Interface | null>(null)

  const { canDo } = useMe()
  const canAddCable = canDo("cable", "add")
  const canChangeCable = canDo("cable", "change")
  const canAdd = canDo("interface", "add")
  const canEdit = canDo("interface", "change")
  const canDelete = canDo("interface", "delete")

  const query = useQuery({
    queryKey: ["interfaces", q],
    queryFn: () =>
      api<Paginated<Interface>>(
        `/api/interfaces/?${new URLSearchParams({ search: q }).toString()}`
      ),
  })
  const allRows = query.data?.results ?? []

  const rows = useMemo(
    () =>
      allRows.filter(
        (i) => deviceFilter.size === 0 || deviceFilter.has(i.device.id)
      ),
    [allRows, deviceFilter]
  )

  const facets = useMemo(() => {
    const c: Record<string, { name: string; count: number }> = {}
    for (const i of allRows) {
      if (!c[i.device.id]) c[i.device.id] = { name: i.device.name, count: 0 }
      c[i.device.id].count++
    }
    return Object.entries(c)
      .sort(([, a], [, b]) => b.count - a.count)
      .map<FacetOption>(([id, v]) => ({
        value: id,
        label: v.name,
        count: v.count,
      }))
  }, [allRows])

  const handleDelete = useCallback((i: Interface) => setDeleting(i), [])
  const columns = useMemo<ColumnDef<Interface>[]>(
    () =>
      buildColumns({
        onDelete: handleDelete,
        canEdit,
        canDelete,
        canAddCable,
        canChangeCable,
      }),
    [handleDelete, canEdit, canDelete, canAddCable, canChangeCable]
  )

  const rail = (
    <FilterRail>
      <FacetGroup
        label="Device"
        options={facets}
        selected={deviceFilter}
        onToggle={(v) => toggleInSet(deviceFilter, v, setDeviceFilter)}
      />
    </FilterRail>
  )

  return (
    <ListPageShell
      title="Interfaces"
      count={query.data ? rows.length : undefined}
      rail={rail}
      search={{
        value: q,
        onChange: setQ,
        placeholder: "Filter by name, device…",
      }}
      actions={
        <>
          <TableActions ioType="interface" />
          {canAdd && (
            <>
              <Button size="sm" variant="outline" asChild>
                <Link to="/interfaces/bulk" search={{}}>
                  Bulk add
                </Link>
              </Button>
              <Button size="sm" asChild>
                <Link to="/interfaces/new" search={{}}>
                  Add interface
                </Link>
              </Button>
            </>
          )}
        </>
      }
      query={query}
    >
      <DataTable
        data={rows}
        columns={columns}
        tableId="interfaces"
        rowStyle={(r) => cableTint(r.cable?.status)}
      />
      <InterfaceDeleteDialog
        iface={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}

function buildColumns({
  onDelete,
  canEdit,
  canDelete,
  canAddCable,
  canChangeCable,
}: {
  onDelete: (i: Interface) => void
  canEdit: boolean
  canDelete: boolean
  canAddCable: boolean
  canChangeCable: boolean
}): ColumnDef<Interface>[] {
  return [
    selectionColumn<Interface>(),
    {
      id: "device",
      accessorFn: (r) => r.device.name,
      header: ({ column }) => <SortHeader column={column} label="Device" />,
      cell: ({ row }) => (
        <Link
          to="/devices/$id"
          params={{ id: row.original.device.id }}
          className="font-mono text-xs hover:underline"
        >
          {row.original.device.name}
        </Link>
      ),
    },
    {
      id: "name",
      accessorKey: "name",
      header: ({ column }) => <SortHeader column={column} label="Interface" />,
      cell: ({ row }) => (
        <Link
          to="/interfaces/$id"
          params={{ id: row.original.id }}
          className="font-mono font-medium hover:underline"
        >
          {row.original.name}
        </Link>
      ),
    },
    {
      id: "enabled",
      accessorKey: "enabled",
      header: "Enabled",
      cell: ({ row }) =>
        row.original.enabled ? (
          <Badge variant="success">Enabled</Badge>
        ) : (
          <Badge variant="secondary">Disabled</Badge>
        ),
    },
    {
      id: "speed",
      accessorKey: "speed",
      header: "Speed",
      cell: ({ row }) =>
        row.original.speed ? (
          <span className="text-xs">{row.original.speed}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "mtu",
      accessorKey: "mtu",
      header: "MTU",
      cell: ({ row }) =>
        row.original.mtu != null ? (
          <span className="num text-xs">{row.original.mtu}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "vlan",
      header: "VLAN",
      cell: ({ row }) => {
        const v = row.original.vlan
        return v ? (
          <span className="font-mono text-xs">
            {v.vlan_id} · {v.name}
          </span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )
      },
    },
    {
      id: "cables",
      accessorKey: "cable_count",
      header: "Cable",
      cell: ({ row }) =>
        row.original.cable ? (
          <CableStatusControl
            cableId={row.original.cable.id}
            status={row.original.cable.status}
            canEdit={canChangeCable}
          />
        ) : (
          <span className="num text-xs text-muted-foreground">
            {row.original.cable_count || "—"}
          </span>
        ),
    },
    tagsColumn<Interface>({
      getTags: (r) => r.tags,
      activeSlugs: new Set<string>(),
      onToggle: () => {},
    }),
    {
      id: "actions",
      enableHiding: false,
      cell: ({ row }) => (
        <RowActions
          editTo={canEdit ? "/interfaces/$id/edit" : undefined}
          editParams={{ id: row.original.id }}
          onDelete={canDelete ? () => onDelete(row.original) : undefined}
          extra={
            canAddCable && !row.original.cable ? (
              <Button
                size="sm"
                variant="ghost"
                asChild
                className="h-7 px-1.5"
                title="Connect a cable to this port"
              >
                <Link
                  to="/cables/new"
                  search={{ a_kind: "interface", a_id: row.original.id }}
                >
                  <CableIcon className="h-3.5 w-3.5" />
                </Link>
              </Button>
            ) : null
          }
        />
      ),
    },
  ]
}
