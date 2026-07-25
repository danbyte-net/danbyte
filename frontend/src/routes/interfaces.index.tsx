import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { Cable as CableIcon } from "lucide-react"
import { useCallback, useMemo, useState } from "react"

import { api, type Interface, type Paginated } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { buildInterfaceColumns } from "@/components/columns/interface-columns"
import { cableTint } from "@/components/cable-status-control"
import {
  FilterRail,
  FacetGroup,
  toggleInSet,
  type FacetOption,
} from "@/components/filter-rail"
import { ListPageShell } from "@/components/list-page-shell"
import { InterfaceDeleteDialog } from "@/components/interface-delete-dialog"
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
      buildInterfaceColumns<Interface>({
        selection: true,
        include: [
          "device",
          "name",
          "enabled",
          "speed",
          "mtu",
          "vlan",
          "cables",
          "tags",
          "description",
        ],
        // Only this table lets you flip a cable's status inline; the per-device
        // tables keep that control in their actions column.
        cableControl: { canEdit: canChangeCable },
        actions: {
          editTo: "/interfaces/$id/edit",
          editParams: (i) => ({ id: i.id }),
          canEdit: () => canEdit,
          onDelete: handleDelete,
          canDelete: () => canDelete,
          extra: (i) =>
            canAddCable && !i.cable ? (
              <Button
                size="sm"
                variant="ghost"
                asChild
                className="h-7 px-1.5"
                title="Connect a cable to this port"
              >
                <Link
                  to="/cables/new"
                  search={{ a_kind: "interface", a_id: i.id }}
                >
                  <CableIcon className="h-3.5 w-3.5" />
                </Link>
              </Button>
            ) : null,
        },
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
        flexColumn="description"
        rowStyle={(r) => cableTint(r.cable?.status)}
      />
      <InterfaceDeleteDialog
        iface={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
