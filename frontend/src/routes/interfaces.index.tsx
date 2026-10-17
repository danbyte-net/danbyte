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
import { portTint } from "@/components/cable-status-control"
import {
  MarkConnectedToggle,
  PortReserveAction,
} from "@/components/port-reservation-dialog"
import {
  FilterRail,
  FacetGroup,
  tagFacetOptions,
  type FacetOption,
} from "@/components/filter-rail"
import { ListPageShell } from "@/components/list-page-shell"
import { InterfaceDeleteDialog } from "@/components/interface-delete-dialog"
import { useInterfaceDriftMap } from "@/components/monitoring/device-drift-badge"
import { usePlannedChangeMap } from "@/components/planning/planned-change-badge"
import { useMe } from "@/lib/use-me"
import { hereUrl } from "@/lib/return-url"
import { useUrlSearch, toggled, useKnown, useUrlSet } from "@/lib/url-filters"

const statusKey = (i: Interface) => i.status?.id ?? "none"

export const Route = createFileRoute("/interfaces/")({
  component: InterfacesPage,
})

function InterfacesPage() {
  const [q, setQ] = useUrlSearch()
  const [deviceFilterRaw, setDeviceFilter] = useUrlSet("device")
  const [statusFilterRaw, setStatusFilter] = useUrlSet("status")
  const [tagFilterRaw, setTagFilter] = useUrlSet("tag")
  const [deleting, setDeleting] = useState<Interface | null>(null)

  const { canDo } = useMe()
  const canAddCable = canDo("cable", "add")
  const canChangeCable = canDo("cable", "change")
  const canDeleteCable = canDo("cable", "delete")
  const canReserve = canDo("portreservation", "add")
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

  // Status facet counts null as Active - that's how it reads everywhere.
  // Keyed by status id (`none` for no status), so the URL holds ids.
  const statusFacets = useMemo(() => {
    const c: Record<string, FacetOption> = {}
    for (const i of allRows) {
      const key = statusKey(i)
      if (!c[key])
        c[key] = {
          value: key,
          label: i.status?.name ?? "Active",
          count: 0,
          color: i.status?.color || undefined,
          textColor: i.status?.text_color || undefined,
        }
      c[key].count++
    }
    return Object.values(c).sort((a, b) => b.count - a.count)
  }, [allRows])

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
  const tagFacets = useMemo(
    () => tagFacetOptions(allRows, (i) => i.tags),
    [allRows]
  )
  // A value no row carries (a stale link) is ignored.
  const deviceFilter = useKnown(deviceFilterRaw, facets)
  const statusFilter = useKnown(statusFilterRaw, statusFacets)
  const tagFilter = useKnown(tagFilterRaw, tagFacets)
  const rows = useMemo(
    () =>
      allRows.filter(
        (i) =>
          (deviceFilter.size === 0 || deviceFilter.has(i.device.id)) &&
          (statusFilter.size === 0 || statusFilter.has(statusKey(i))) &&
          (tagFilter.size === 0 || i.tags.some((t) => tagFilter.has(t.slug)))
      ),
    [allRows, deviceFilter, statusFilter, tagFilter]
  )

  const handleDelete = useCallback((i: Interface) => setDeleting(i), [])
  // Fleet-wide SNMP drift for every port on the page, in ONE request - the
  // devices list marks drifted devices, and interfaces are what drift actually
  // references (MAC / admin-status / speed / VLAN, stale ports, discovered IPs).
  const drift = useInterfaceDriftMap()
  const planned = usePlannedChangeMap()
  const columns = useMemo<ColumnDef<Interface>[]>(
    () =>
      buildInterfaceColumns<Interface>({
        selection: true,
        drift,
        planned,
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
        tagFilter: {
          activeSlugs: tagFilter,
          onToggle: (v) => setTagFilter((s) => toggled(s, v)),
        },
        actions: {
          editTo: "/interfaces/$id/edit",
          editParams: (i) => ({ id: i.id }),
          canEdit: () => canEdit,
          onDelete: handleDelete,
          canDelete: () => canDelete,
          extra: (i) =>
            !i.cable && !i.virtual ? (
              <>
                {canAddCable && (
                  <Button
                    size="sm"
                    variant="ghost"
                    asChild
                    className="h-7 px-1.5 text-muted-foreground hover:text-primary"
                    title="Connect cable"
                  >
                    <Link
                      to="/cables/new"
                      search={{
                        a_kind: "interface",
                        a_id: i.id,
                        ret: hereUrl(),
                      }}
                    >
                      <CableIcon className="h-3.5 w-3.5" />
                    </Link>
                  </Button>
                )}
                {!i.mark_connected && (
                  <PortReserveAction
                    kind="interface"
                    portId={i.id}
                    name={i.name}
                    reservation={i.reservation}
                    canReserve={canReserve}
                  />
                )}
                {!i.reservation && (
                  <MarkConnectedToggle
                    endpoint="/api/interfaces/"
                    portId={i.id}
                    name={i.name}
                    marked={i.mark_connected}
                    canEdit={canEdit}
                  />
                )}
              </>
            ) : null,
        },
      }),
    [
      handleDelete,
      canEdit,
      canDelete,
      canAddCable,
      canChangeCable,
      canDeleteCable,
      canReserve,
      drift,
      tagFilter,
      setTagFilter,
    ]
  )

  const rail = (
    <FilterRail>
      <FacetGroup
        label="Device"
        options={facets}
        selected={deviceFilter}
        onToggle={(v) => setDeviceFilter((s) => toggled(s, v))}
      />
      <FacetGroup
        label="Status"
        options={statusFacets}
        selected={statusFilter}
        onToggle={(v) => setStatusFilter((s) => toggled(s, v))}
      />
      <FacetGroup
        label="Tags"
        options={tagFacets}
        selected={tagFilter}
        onToggle={(v) => setTagFilter((s) => toggled(s, v))}
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
      page={query.data}
    >
      <DataTable
        data={rows}
        columns={columns}
        tableId="interfaces"
        flexColumn="description"
        rowStyle={(r) => portTint(r)}
      />
      <InterfaceDeleteDialog
        iface={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </ListPageShell>
  )
}
