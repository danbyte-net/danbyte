import { createFileRoute, Link } from "@tanstack/react-router"
import { TableActions } from "@/components/table-actions"
import { type ColumnDef } from "@tanstack/react-table"
import { Cable as CableIcon } from "lucide-react"
import { useCallback, useMemo, useState } from "react"

import { type Interface } from "@/lib/api"
import { useServerList } from "@/lib/server-list"
import { Button } from "@/components/ui/button"
import { DataTable } from "@/components/data-table"
import { buildInterfaceColumns } from "@/components/columns/interface-columns"
import { portTint } from "@/components/cable-status-control"
import {
  MarkConnectedToggle,
  PortReserveAction,
} from "@/components/port-reservation-dialog"
import { ListPageShell } from "@/components/list-page-shell"
import { InterfaceDeleteDialog } from "@/components/interface-delete-dialog"
import { useInterfaceDriftMap } from "@/components/monitoring/device-drift-badge"
import { usePlannedChangeMap } from "@/components/planning/planned-change-badge"
import { wireFacetColumns } from "@/components/table-filters"
import type { ServerFacetExtra } from "@/components/table-filters"
import { useMe } from "@/lib/use-me"
import { hereUrl } from "@/lib/return-url"
import { useUrlSearch } from "@/lib/url-filters"

export const Route = createFileRoute("/interfaces/")({
  component: InterfacesPage,
})

/** The rail: Device and Tags from their columns, Status (keyed by id, `none`
 * for Active - the links the list has always used) from the server alone,
 * as the list shows no Status column. */
const INTERFACE_FACETS = ["device", "status", "tags"]
const STATUS_FACET: ServerFacetExtra[] = [
  { id: "status", label: "Status", kind: "enum" },
]
const COLUMNS = [
  "device",
  "name",
  "enabled",
  "speed",
  "mtu",
  "vlan",
  "cables",
  "tags",
  "description",
] as const

function InterfacesPage() {
  const [q, setQ] = useUrlSearch()
  const [deleting, setDeleting] = useState<Interface | null>(null)

  const { canDo } = useMe()
  const canAddCable = canDo("cable", "add")
  const canChangeCable = canDo("cable", "change")
  const canReserve = canDo("portreservation", "add")
  const canAdd = canDo("interface", "add")
  const canEdit = canDo("interface", "change")
  const canDelete = canDo("interface", "delete")

  // One page at a time from the server (#482): 41,600 interfaces used to be
  // ten sequential requests before the first row showed.
  const facetColumns = useMemo(
    () => buildInterfaceColumns<Interface>({ include: [...COLUMNS] }),
    []
  )
  const list = useServerList<Interface>({
    endpoint: "/api/interfaces/",
    queryKey: "interfaces",
    columns: facetColumns,
    facets: INTERFACE_FACETS,
    extraFacets: STATUS_FACET,
  })
  const { query, rows, selectedValues, toggleValue } = list

  const handleDelete = useCallback((i: Interface) => setDeleting(i), [])
  // Fleet-wide SNMP drift for every port on the page, in ONE request - the
  // devices list marks drifted devices, and interfaces are what drift actually
  // references (MAC / admin-status / speed / VLAN, stale ports, discovered IPs).
  const drift = useInterfaceDriftMap()
  const planned = usePlannedChangeMap()
  const columns = useMemo<ColumnDef<Interface>[]>(
    () =>
      wireFacetColumns(
        buildInterfaceColumns<Interface>({
          selection: true,
          drift,
          planned,
          include: [...COLUMNS],
          // Only this table lets you flip a cable's status inline; the
          // per-device tables keep that control in their actions column.
          cableControl: { canEdit: canChangeCable },
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
        selectedValues,
        toggleValue
      ),
    [
      handleDelete,
      canEdit,
      canDelete,
      canAddCable,
      canChangeCable,
      canReserve,
      drift,
      planned,
      selectedValues,
      toggleValue,
    ]
  )

  return (
    <ListPageShell
      title="Interfaces"
      count={query.data ? list.total : undefined}
      rail={list.rail}
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
        {...list.tableProps}
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
