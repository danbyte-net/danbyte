import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { Cable as CableIcon, Pencil, Trash2 } from "lucide-react"
import { Link } from "@tanstack/react-router"

import {
  api,
  type ConsolePort,
  type Paginated,
  type TerminationKind,
} from "@/lib/api"
import { PortReserveAction } from "@/components/port-reservation-dialog"
import { hereUrl } from "@/lib/return-url"
import { Button } from "@/components/ui/button"
import { DataTable, selectionColumn } from "@/components/data-table"
import { ComponentBulkBar } from "@/components/component-bulk-bar"
import { CableChip } from "@/components/cells/cable-chip"
import { QueryError } from "@/components/query-error"
import { ConsolePortDialog } from "@/components/console-port-dialog"
import { useRegisterAddActions } from "@/components/device-add-actions"
import { ComponentDeleteDialog } from "@/components/component-delete-dialog"
import { useMe } from "@/lib/use-me"

// Both console tables share a row shape - only the header noun differs.
function consoleCols({
  header,
  kind,
  canEdit,
  canDelete,
  canConnect,
  canReserve,
  onEdit,
  onDelete,
}: {
  header: string
  /** Cable-termination kind of the rows (console_port / console_server_port). */
  kind: TerminationKind
  canEdit: boolean
  canDelete: boolean
  canConnect: boolean
  canReserve: boolean
  onEdit: (p: ConsolePort) => void
  onDelete: (p: ConsolePort) => void
}): ColumnDef<ConsolePort>[] {
  return [
    {
      id: "name",
      header,
      cell: ({ row }) => (
        <span className="font-mono font-medium">{row.original.name}</span>
      ),
    },
    {
      id: "type",
      header: "Type",
      cell: ({ row }) =>
        row.original.type ? (
          <span className="text-xs">{row.original.type_display}</span>
        ) : (
          <span className="text-muted-foreground">-</span>
        ),
    },
    {
      id: "speed",
      header: "Speed",
      cell: ({ row }) =>
        row.original.speed != null ? (
          <span className="num text-xs">{row.original.speed} baud</span>
        ) : (
          <span className="text-muted-foreground">-</span>
        ),
    },
    {
      id: "cable",
      header: "Cable",
      cell: ({ row }) => <CableChip cable={row.original.cable} />,
    },
    {
      id: "description",
      header: "Description",
      cell: ({ row }) =>
        row.original.description ? (
          <span className="text-xs">{row.original.description}</span>
        ) : (
          <span className="text-muted-foreground">-</span>
        ),
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <div className="flex justify-end gap-1">
          {!row.original.cable && (
            <>
              {canConnect && (
                <Button
                  size="icon"
                  variant="ghost"
                  asChild
                  className="h-7 w-7 text-muted-foreground hover:text-primary"
                  title="Connect cable"
                >
                  <Link
                    to="/cables/new"
                    search={{
                      a_kind: kind,
                      a_id: row.original.id,
                      ret: hereUrl(),
                    }}
                  >
                    <CableIcon className="h-3.5 w-3.5" />
                  </Link>
                </Button>
              )}
              <PortReserveAction
                kind={kind}
                portId={row.original.id}
                name={row.original.name}
                reservation={row.original.reservation}
                canReserve={canReserve}
              />
            </>
          )}
          {canEdit && (
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={() => onEdit(row.original)}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          )}
          {canDelete && (
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-destructive hover:text-destructive"
              onClick={() => onDelete(row.original)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      ),
    },
  ]
}

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
      ...consoleCols({
        header: "Console port",
        kind: "console_port",
        canEdit: canEditPort,
        canDelete: canDeletePort,
        canConnect,
        canReserve,
        onEdit: setEditPort,
        onDelete: setDelPort,
      }),
    ],
    [canEditPort, canDeletePort, canConnect, canReserve]
  )
  const serverCols = useMemo(
    () => [
      ...(canEditServer ? [selectionColumn<ConsolePort>()] : []),
      ...consoleCols({
        header: "Console server port",
        kind: "console_server_port",
        canEdit: canEditServer,
        canDelete: canDeleteServer,
        canConnect,
        canReserve,
        onEdit: setEditServer,
        onDelete: setDelServer,
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
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : portRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No console ports. A console port is the device's out-of-band
            management jack - cable it to a console server port.
          </p>
        ) : (
          <DataTable
            data={portRows}
            columns={portCols}
            embedded
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
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : serverRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No console server ports. Console server ports are the terminal
            server side - each one cables out to a device's console port.
          </p>
        ) : (
          <DataTable
            data={serverRows}
            columns={serverCols}
            embedded
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
