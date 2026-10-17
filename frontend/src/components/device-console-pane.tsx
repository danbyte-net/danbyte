import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"

import { api, type ConsolePort, type Paginated } from "@/lib/api"
import { DataTable, selectionColumn } from "@/components/data-table"
import { ComponentBulkBar } from "@/components/component-bulk-bar"
import { buildConsolePortColumns } from "@/components/columns/console-port-columns"
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { ConsolePortDialog } from "@/components/console-port-dialog"
import { useRegisterAddActions } from "@/components/device-add-actions"
import { ComponentDeleteDialog } from "@/components/component-delete-dialog"
import { useMe } from "@/lib/use-me"

export function DeviceConsolePane({ deviceId }: { deviceId: string }) {
  const { canDo } = useMe()
  const canAddPort = canDo("consoleport", "add")
  const canEditPort = canDo("consoleport", "change")
  const canDeletePort = canDo("consoleport", "delete")
  const canAddServer = canDo("consoleserverport", "add")
  const canEditServer = canDo("consoleserverport", "change")
  const canDeleteServer = canDo("consoleserverport", "delete")
  const canConnect = canDo("cable", "add")
  const canReserve = canDo("portreservation", "add")

  const [portOpen, setPortOpen] = useState(false)
  const [editPort, setEditPort] = useState<ConsolePort | null>(null)
  const [delPort, setDelPort] = useState<ConsolePort | null>(null)

  const [serverOpen, setServerOpen] = useState(false)
  const [editServer, setEditServer] = useState<ConsolePort | null>(null)
  const [delServer, setDelServer] = useState<ConsolePort | null>(null)
  const [selPorts, setSelPorts] = useState<ConsolePort[]>([])
  const [selServers, setSelServers] = useState<ConsolePort[]>([])

  const ports = useQuery({
    queryKey: ["device-console-ports", deviceId],
    queryFn: () =>
      api<Paginated<ConsolePort>>(`/api/console-ports/?device=${deviceId}`),
  })
  const serverPorts = useQuery({
    queryKey: ["device-console-server-ports", deviceId],
    queryFn: () =>
      api<Paginated<ConsolePort>>(
        `/api/console-server-ports/?device=${deviceId}`
      ),
  })

  const portCols = useMemo(
    () => [
      ...(canEditPort ? [selectionColumn<ConsolePort>()] : []),
      ...buildConsolePortColumns({
        header: "Console port",
        kind: "console_port",
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
    [canEditPort, canDeletePort, canConnect, canReserve]
  )
  const serverCols = useMemo(
    () => [
      ...(canEditServer ? [selectionColumn<ConsolePort>()] : []),
      ...buildConsolePortColumns({
        header: "Console server port",
        kind: "console_server_port",
        actions: {
          canEdit: canEditServer,
          canDelete: canDeleteServer,
          canConnect,
          canReserve,
          onEdit: setEditServer,
          onDelete: setDelServer,
        },
      }),
    ],
    [canEditServer, canDeleteServer, canConnect, canReserve]
  )

  const portRows = ports.data?.results ?? []
  const serverRows = serverPorts.data?.results ?? []

  useRegisterAddActions("console", [
    ...(canAddPort
      ? [{ label: "Console port", onClick: () => setPortOpen(true) }]
      : []),
    ...(canAddServer
      ? [
          {
            label: "Console server port",
            onClick: () => setServerOpen(true),
          },
        ]
      : []),
  ])

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h3 className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          Console ports
        </h3>
        {ports.isError ? (
          <QueryError error={ports.error} />
        ) : ports.isLoading ? (
          <Loading />
        ) : portRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No console ports. A console port is the device's out-of-band
            management jack - cable it to a console server port.
          </p>
        ) : (
          <DataTable
            data={portRows}
            total={ports.data?.count}
            columns={portCols}
            tableId="device-console-ports"
            searchable
            searchPlaceholder="Search ports…"
            onSelectedRowsChange={setSelPorts}
          />
        )}
      </section>

      <ComponentBulkBar
        endpoint="/api/console-ports/"
        kindLabel="console port"
        selected={selPorts}
        onCleared={() => setSelPorts([])}
        invalidate={[["device-console-ports", deviceId]]}
        fields={[
          {
            key: "type",
            label: "Type",
            kind: "choice",
            choices: "console_port_types",
          },
          { key: "description", label: "Description", kind: "text" },
        ]}
        tags
        canDelete={canDeletePort}
      />

      <section className="space-y-3">
        <h3 className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          Console server ports
        </h3>
        {serverPorts.isError ? (
          <QueryError error={serverPorts.error} />
        ) : serverPorts.isLoading ? (
          <Loading />
        ) : serverRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No console server ports. Console server ports are the terminal
            server side - each one cables out to a device's console port.
          </p>
        ) : (
          <DataTable
            data={serverRows}
            total={serverPorts.data?.count}
            columns={serverCols}
            tableId="device-console-server-ports"
            searchable
            searchPlaceholder="Search ports…"
            onSelectedRowsChange={setSelServers}
          />
        )}
      </section>

      <ComponentBulkBar
        endpoint="/api/console-server-ports/"
        kindLabel="console server port"
        selected={selServers}
        onCleared={() => setSelServers([])}
        invalidate={[["device-console-server-ports", deviceId]]}
        fields={[
          {
            key: "type",
            label: "Type",
            kind: "choice",
            choices: "console_port_types",
          },
          { key: "speed", label: "Speed (baud)", kind: "int" },
          { key: "description", label: "Description", kind: "text" },
        ]}
        tags
        canDelete={canDeleteServer}
      />

      <ConsolePortDialog
        kind="port"
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
      <ConsolePortDialog
        kind="server-port"
        deviceId={deviceId}
        port={editServer}
        open={serverOpen || !!editServer}
        onOpenChange={(o) => {
          if (!o) {
            setServerOpen(false)
            setEditServer(null)
          }
        }}
      />

      <ComponentDeleteDialog
        endpoint="console-ports"
        queryKeys={[["device-console-ports", deviceId]]}
        item={delPort}
        onOpenChange={(o) => !o && setDelPort(null)}
      />
      <ComponentDeleteDialog
        endpoint="console-server-ports"
        queryKeys={[["device-console-server-ports", deviceId]]}
        item={delServer}
        onOpenChange={(o) => !o && setDelServer(null)}
      />
    </div>
  )
}
