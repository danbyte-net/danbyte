import { useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import type { ColumnDef } from "@tanstack/react-table"
import { Pencil, Trash2, Waypoints } from "lucide-react"

import { api } from "@/lib/api"
import type { FrontPort, Paginated, RearPort } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { CableTraceDialog } from "@/components/cable-trace-dialog"
import type { CableTraceTarget } from "@/components/cable-trace-dialog"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { DataTable, selectionColumn } from "@/components/data-table"
import { ComponentBulkBar } from "@/components/component-bulk-bar"
import { TagList } from "@/components/cells/tag-list"
import { QueryError } from "@/components/query-error"
import { RearPortForm } from "@/components/rear-port-form"
import { FrontPortForm } from "@/components/front-port-form"
import { PortDeleteDialog } from "@/components/port-delete-dialog"
import {
  cableTint,
  CableStatusControl,
} from "@/components/cable-status-control"
import { useRegisterAddActions } from "@/components/device-add-actions"
import { useMe } from "@/lib/use-me"

// CableMini chip — the one place a cable color is allowed to show (it's the
// physical cable). Plain "—" when the port isn't cabled.
function CableCell({ cable }: { cable: RearPort["cable"] }) {
  if (!cable) return <span className="text-muted-foreground">—</span>
  return (
    <Link
      to="/cables/$id"
      params={{ id: cable.id }}
      className="inline-flex items-center gap-1.5 hover:underline"
    >
      <span
        className="h-2.5 w-2.5 rounded-sm border border-border"
        style={cable.color ? { backgroundColor: cable.color } : undefined}
      />
      <span className="font-mono text-xs">{cable.type || "cable"}</span>
    </Link>
  )
}

export function DevicePortsPane({ deviceId }: { deviceId: string }) {
  const { canDo } = useMe()
  const canAddRear = canDo("rearport", "add")
  const canEditRear = canDo("rearport", "change")
  const canDeleteRear = canDo("rearport", "delete")
  const canAddFront = canDo("frontport", "add")
  const canEditFront = canDo("frontport", "change")
  const canDeleteFront = canDo("frontport", "delete")
  const canEditCable = canDo("cable", "change")
  const [rearOpen, setRearOpen] = useState(false)
  const [editRear, setEditRear] = useState<RearPort | null>(null)
  const [delRear, setDelRear] = useState<RearPort | null>(null)

  const [frontOpen, setFrontOpen] = useState(false)
  const [editFront, setEditFront] = useState<FrontPort | null>(null)
  const [selRear, setSelRear] = useState<RearPort[]>([])
  const [selFront, setSelFront] = useState<FrontPort[]>([])
  const [delFront, setDelFront] = useState<FrontPort | null>(null)
  const [tracing, setTracing] = useState<CableTraceTarget | null>(null)

  const rear = useQuery({
    queryKey: ["device-rear-ports", deviceId],
    queryFn: () =>
      api<Paginated<RearPort>>(`/api/rear-ports/?device=${deviceId}`),
  })
  const front = useQuery({
    queryKey: ["device-front-ports", deviceId],
    queryFn: () =>
      api<Paginated<FrontPort>>(`/api/front-ports/?device=${deviceId}`),
  })

  const rearCols = useMemo<ColumnDef<RearPort>[]>(
    () => [
      selectionColumn<RearPort>(),
      {
        id: "name",
        header: "Rear port",
        cell: ({ row }) => (
          <span className="font-mono font-medium">{row.original.name}</span>
        ),
      },
      {
        id: "positions",
        header: "Positions",
        cell: ({ row }) => (
          <span className="num text-xs">{row.original.positions}</span>
        ),
      },
      {
        id: "type",
        header: "Type",
        cell: ({ row }) =>
          row.original.type ? (
            <span className="font-mono text-xs">{row.original.type}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "fronts",
        header: "Front ports",
        cell: ({ row }) => (
          <span className="num text-xs">{row.original.front_port_count}</span>
        ),
      },
      {
        id: "cable",
        header: "Cable",
        cell: ({ row }) => <CableCell cable={row.original.cable} />,
      },
      {
        id: "tags",
        header: "Tags",
        cell: ({ row }) =>
          row.original.tags.length ? (
            <TagList tags={row.original.tags} />
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => (
          <div className="flex justify-end gap-1">
            {row.original.cable && (
              <CableStatusControl
                cableId={row.original.cable.id}
                status={row.original.cable.status}
                canEdit={canEditCable}
              />
            )}
            {row.original.cable && (
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                title="Trace this run"
                aria-label={`Trace ${row.original.name}`}
                onClick={() =>
                  setTracing({
                    id: row.original.cable!.id,
                    label: row.original.name,
                  })
                }
              >
                <Waypoints className="h-3.5 w-3.5" />
              </Button>
            )}
            {canEditRear && (
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                onClick={() => setEditRear(row.original)}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            )}
            {canDeleteRear && (
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 text-destructive hover:text-destructive"
                onClick={() => setDelRear(row.original)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        ),
      },
    ],
    [canEditRear, canDeleteRear, canEditCable]
  )

  const frontCols = useMemo<ColumnDef<FrontPort>[]>(
    () => [
      selectionColumn<FrontPort>(),
      {
        id: "name",
        header: "Front port",
        cell: ({ row }) => (
          <span className="font-mono font-medium">{row.original.name}</span>
        ),
      },
      {
        id: "maps",
        header: "Maps to",
        cell: ({ row }) => (
          <span className="font-mono text-xs">
            {row.original.rear_port.name}
            <span className="text-muted-foreground">
              {" "}
              · strand {row.original.rear_port_position}
            </span>
          </span>
        ),
      },
      {
        id: "type",
        header: "Type",
        cell: ({ row }) =>
          row.original.type ? (
            <span className="font-mono text-xs">{row.original.type}</span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "cable",
        header: "Cable",
        cell: ({ row }) => <CableCell cable={row.original.cable} />,
      },
      {
        id: "tags",
        header: "Tags",
        cell: ({ row }) =>
          row.original.tags.length ? (
            <TagList tags={row.original.tags} />
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => (
          <div className="flex justify-end gap-1">
            {row.original.cable && (
              <CableStatusControl
                cableId={row.original.cable.id}
                status={row.original.cable.status}
                canEdit={canEditCable}
              />
            )}
            {row.original.cable && (
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                title="Trace this run"
                aria-label={`Trace ${row.original.name}`}
                onClick={() =>
                  setTracing({
                    id: row.original.cable!.id,
                    label: row.original.name,
                  })
                }
              >
                <Waypoints className="h-3.5 w-3.5" />
              </Button>
            )}
            {canEditFront && (
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7"
                onClick={() => setEditFront(row.original)}
              >
                <Pencil className="h-3.5 w-3.5" />
              </Button>
            )}
            {canDeleteFront && (
              <Button
                size="icon"
                variant="ghost"
                className="h-7 w-7 text-destructive hover:text-destructive"
                onClick={() => setDelFront(row.original)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        ),
      },
    ],
    [canEditFront, canDeleteFront, canEditCable]
  )

  const rearRows = rear.data?.results ?? []
  const frontRows = front.data?.results ?? []

  useRegisterAddActions("ports", [
    ...(canAddRear
      ? [{ label: "Rear port", onClick: () => setRearOpen(true) }]
      : []),
    ...(canAddFront
      ? [{ label: "Front port", onClick: () => setFrontOpen(true) }]
      : []),
  ])

  return (
    <div className="space-y-8">
      <section className="space-y-3">
        <h3 className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          Rear ports
        </h3>
        {rear.isError ? (
          <QueryError error={rear.error} />
        ) : rear.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : rearRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No rear ports. Rear ports are the back of a patch panel — add one,
            then map front ports to its strands.
          </p>
        ) : (
          <DataTable
            data={rearRows}
            columns={rearCols}
            rowStyle={(r) => cableTint(r.cable?.status)}
            onSelectedRowsChange={setSelRear}
            embedded
          />
        )}
      </section>

      <section className="space-y-3">
        <h3 className="text-[10px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          Front ports
        </h3>
        {front.isError ? (
          <QueryError error={front.error} />
        ) : front.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : frontRows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No front ports. A front port is a panel's front jack mapped to a
            rear-port strand — a cable trace passes through it.
          </p>
        ) : (
          <DataTable
            data={frontRows}
            columns={frontCols}
            rowStyle={(r) => cableTint(r.cable?.status)}
            onSelectedRowsChange={setSelFront}
            embedded
          />
        )}
      </section>

      {/* Rear port add / edit */}
      <Dialog
        open={rearOpen || !!editRear}
        onOpenChange={(o) => {
          if (!o) {
            setRearOpen(false)
            setEditRear(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editRear ? "Edit rear port" : "Add rear port"}
            </DialogTitle>
          </DialogHeader>
          <RearPortForm
            port={editRear ?? undefined}
            deviceId={deviceId}
            onSaved={() => {
              setRearOpen(false)
              setEditRear(null)
            }}
            onCancel={() => {
              setRearOpen(false)
              setEditRear(null)
            }}
          />
        </DialogContent>
      </Dialog>

      {/* Front port add / edit */}
      <Dialog
        open={frontOpen || !!editFront}
        onOpenChange={(o) => {
          if (!o) {
            setFrontOpen(false)
            setEditFront(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editFront ? "Edit front port" : "Add front port"}
            </DialogTitle>
          </DialogHeader>
          <FrontPortForm
            port={editFront ?? undefined}
            deviceId={deviceId}
            onSaved={() => {
              setFrontOpen(false)
              setEditFront(null)
            }}
            onCancel={() => {
              setFrontOpen(false)
              setEditFront(null)
            }}
          />
        </DialogContent>
      </Dialog>

      <ComponentBulkBar
        endpoint="/api/rear-ports/"
        kindLabel="rear port"
        selected={selRear}
        onCleared={() => setSelRear([])}
        invalidate={[["device-rear-ports", deviceId]]}
        fields={[
          // Free text, matching RearPortForm — RearPort.type carries no model
          // choices, so a closed list would block values the single-port form
          // accepts.
          { key: "type", label: "Type", kind: "text", hint: "e.g. lc" },
          { key: "positions", label: "Positions", kind: "int" },
          { key: "description", label: "Description", kind: "text" },
        ]}
        tags
      />
      <ComponentBulkBar
        endpoint="/api/front-ports/"
        kindLabel="front port"
        selected={selFront}
        onCleared={() => setSelFront([])}
        invalidate={[["device-front-ports", deviceId]]}
        fields={[
          {
            key: "type",
            label: "Type",
            kind: "choice",
            choices: "front_port_types",
          },
          { key: "description", label: "Description", kind: "text" },
        ]}
        tags
      />
      <PortDeleteDialog
        kind="rear"
        port={delRear}
        deviceId={deviceId}
        onOpenChange={(o) => !o && setDelRear(null)}
      />
      <PortDeleteDialog
        kind="front"
        port={delFront}
        deviceId={deviceId}
        onOpenChange={(o) => !o && setDelFront(null)}
      />
      <CableTraceDialog
        target={tracing}
        onOpenChange={(o) => !o && setTracing(null)}
      />
    </div>
  )
}
