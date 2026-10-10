import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"

import {
  api,
  type Paginated,
  type PowerOutlet,
  type PowerPort,
} from "@/lib/api"
import { DataTable, selectionColumn } from "@/components/data-table"
import { ComponentBulkBar } from "@/components/component-bulk-bar"
import { buildPowerPortColumns } from "@/components/columns/power-port-columns"
import { buildPowerOutletColumns } from "@/components/columns/power-outlet-columns"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { PowerPortDialog } from "@/components/power-port-dialog"
import { PowerOutletDialog } from "@/components/power-outlet-dialog"
import { useRegisterAddActions } from "@/components/device-add-actions"
import { ComponentDeleteDialog } from "@/components/component-delete-dialog"
import { useMe } from "@/lib/use-me"

export function DevicePowerPane({ deviceId }: { deviceId: string }) {
  const { canDo } = useMe()
  const canAddPort = canDo("powerport", "add")
  const canEditPort = canDo("powerport", "change")
  const canDeletePort = canDo("powerport", "delete")
  const canAddOutlet = canDo("poweroutlet", "add")
  const canEditOutlet = canDo("poweroutlet", "change")
  const canDeleteOutlet = canDo("poweroutlet", "delete")
  const canConnect = canDo("cable", "add")
  const canReserve = canDo("portreservation", "add")

  const [portOpen, setPortOpen] = useState(false)
  const [editPort, setEditPort] = useState<PowerPort | null>(null)
  const [delPort, setDelPort] = useState<PowerPort | null>(null)

  const [outletOpen, setOutletOpen] = useState(false)
  const [editOutlet, setEditOutlet] = useState<PowerOutlet | null>(null)
  const [delOutlet, setDelOutlet] = useState<PowerOutlet | null>(null)
  const [selPorts, setSelPorts] = useState<PowerPort[]>([])
  const [selOutlets, setSelOutlets] = useState<PowerOutlet[]>([])

  const ports = useQuery({
    queryKey: ["device-power-ports", deviceId],
    queryFn: () =>
      api<Paginated<PowerPort>>(`/api/power-ports/?device=${deviceId}`),
  })
  const outlets = useQuery({
    queryKey: ["device-power-outlets", deviceId],
    queryFn: () =>
      api<Paginated<PowerOutlet>>(`/api/power-outlets/?device=${deviceId}`),
  })

  const portCols = useMemo<ColumnDef<PowerPort>[]>(
    () => [
      selectionColumn<PowerPort>(),
      ...buildPowerPortColumns({
        actions: {
          canEdit: canEditPort,
          canDelete: canDeletePort,
          canConnect,
          canReserve,
          onEdit: setEditPort,
          onDelete: setDelPort,
        },
      }),
    ],
    [canConnect, canReserve, canEditPort, canDeletePort]
  )
  const outletCols = useMemo<ColumnDef<PowerOutlet>[]>(
    () => [
      selectionColumn<PowerOutlet>(),
      ...buildPowerOutletColumns({
        actions: {
          canEdit: canEditOutlet,
          canDelete: canDeleteOutlet,
          canConnect,
          canReserve,
          onEdit: setEditOutlet,
          onDelete: setDelOutlet,
        },
      }),
    ],
    [canConnect, canReserve, canEditOutlet, canDeleteOutlet]
  )

  const portRows = ports.data?.results ?? []
  const outletRows = outlets.data?.results ?? []

  useRegisterAddActions("power", [
    ...(canAddPort
      ? [{ label: "Power port", onClick: () => setPortOpen(true) }]
      : []),
    ...(canAddOutlet
      ? [{ label: "Power outlet", onClick: () => setOutletOpen(true) }]
      : []),
  ])

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h3 className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          Power ports
        </h3>
        {ports.isError ? (
          <QueryError error={ports.error} />
        ) : ports.isLoading ? (
          <Loading />
        ) : portRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No power ports. A power port is the device's inlet (PSU) - cable it
            to a feed, then hang outlets off it on a PDU.
          </p>
        ) : (
          <DataTable
            data={portRows}
            total={ports.data?.count}
            columns={portCols}
            tableId="device-power-ports"
            searchable
            searchPlaceholder="Search ports…"
            onSelectedRowsChange={setSelPorts}
          />
        )}
      </section>

      <section className="space-y-3">
        <h3 className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          Power outlets
        </h3>
        {outlets.isError ? (
          <QueryError error={outlets.error} />
        ) : outlets.isLoading ? (
          <Loading />
        ) : outletRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No power outlets. Outlets are the sockets a PDU offers - each one is
            fed by one of this device's power ports.
          </p>
        ) : (
          <DataTable
            data={outletRows}
            total={outlets.data?.count}
            columns={outletCols}
            tableId="device-power-outlets"
            searchable
            searchPlaceholder="Search ports…"
            onSelectedRowsChange={setSelOutlets}
          />
        )}
      </section>

      <ComponentBulkBar
        endpoint="/api/power-ports/"
        kindLabel="power port"
        selected={selPorts}
        onCleared={() => setSelPorts([])}
        invalidate={[["device-power-ports", deviceId]]}
        fields={[
          {
            key: "type",
            label: "Type",
            kind: "choice",
            choices: "power_port_types",
          },
          { key: "description", label: "Description", kind: "text" },
        ]}
        tags
      />
      <ComponentBulkBar
        endpoint="/api/power-outlets/"
        kindLabel="power outlet"
        selected={selOutlets}
        onCleared={() => setSelOutlets([])}
        invalidate={[["device-power-outlets", deviceId]]}
        fields={[
          {
            key: "type",
            label: "Type",
            kind: "choice",
            choices: "power_outlet_types",
          },
          {
            key: "feed_leg",
            label: "Feed leg",
            kind: "choice",
            choices: "feed_legs",
          },
          { key: "description", label: "Description", kind: "text" },
        ]}
        tags
      />

      <PowerPortDialog
        deviceId={deviceId}
        port={editPort}
        open={portOpen || !!editPort}
        onOpenChange={(o) => {
          if (!o) {
            setPortOpen(false)
            setEditPort(null)
          }
        }}
      />
      <PowerOutletDialog
        deviceId={deviceId}
        outlet={editOutlet}
        open={outletOpen || !!editOutlet}
        onOpenChange={(o) => {
          if (!o) {
            setOutletOpen(false)
            setEditOutlet(null)
          }
        }}
      />

      <ComponentDeleteDialog
        endpoint="power-ports"
        queryKeys={[
          ["device-power-ports", deviceId],
          // Outlets fed by this port lose their feed - refresh both lists.
          ["device-power-outlets", deviceId],
        ]}
        item={delPort}
        warning={
          delPort && delPort.outlet_count > 0
            ? `${delPort.outlet_count} outlet${delPort.outlet_count === 1 ? "" : "s"} fed by this power port will lose their feed.`
            : undefined
        }
        onOpenChange={(o) => !o && setDelPort(null)}
      />
      <ComponentDeleteDialog
        endpoint="power-outlets"
        queryKeys={[
          ["device-power-outlets", deviceId],
          ["device-power-ports", deviceId],
        ]}
        item={delOutlet}
        onOpenChange={(o) => !o && setDelOutlet(null)}
      />
    </div>
  )
}
