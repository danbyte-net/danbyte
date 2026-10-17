import { useEffect, useMemo, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"

import { CabledFilterChips } from "@/components/cabled-filter"
import { CABLE_STATES, cableState, cableStateMatches } from "@/lib/cable-state"
import type { CableState } from "@/lib/cable-state"
import { api } from "@/lib/api"
import type { FrontPort, Paginated, RearPort } from "@/lib/api"
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
import { Loading } from "@/components/loading"
import { QueryError } from "@/components/query-error"
import { RearPortForm } from "@/components/rear-port-form"
import { FrontPortForm } from "@/components/front-port-form"
import { PortDeleteDialog } from "@/components/port-delete-dialog"
import { portTint } from "@/components/cable-status-control"
import { useRegisterAddActions } from "@/components/device-add-actions"
import { buildRearPortColumns } from "@/components/columns/rear-port-columns"
import { buildFrontPortColumns } from "@/components/columns/front-port-columns"
import { useMe } from "@/lib/use-me"

/** The cabled-state chips' filter, seeded from the URL (the utilization card's
 * drill-down) and counted over one port type's rows. */
function useCabledFilter<T extends Parameters<typeof cableState>[0]>(
  rows: T[],
  initial?: CableState | null
) {
  const [cabled, setCabled] = useState<CableState | null>(initial ?? null)
  useEffect(() => setCabled(initial ?? null), [initial])
  const counts = useMemo(() => {
    const c: Partial<Record<CableState, number>> = {}
    for (const s of CABLE_STATES)
      c[s] = rows.filter((r) => cableStateMatches(cableState(r), s)).length
    return c
  }, [rows])
  const filtered = useMemo(
    () =>
      rows.filter((r) => !cabled || cableStateMatches(cableState(r), cabled)),
    [rows, cabled]
  )
  return { cabled, setCabled, counts, filtered }
}

/** Rear ports - the back of a patch panel, a tab of their own (#345). */
export function DeviceRearPortsPane({
  deviceId,
  initialCabled,
}: {
  deviceId: string
  /** Seed for the cabled-state chips (the utilization card drill-down). */
  initialCabled?: CableState | null
}) {
  const { canDo } = useMe()
  const canAdd = canDo("rearport", "add")
  const canEdit = canDo("rearport", "change")
  const canDelete = canDo("rearport", "delete")
  const canEditCable = canDo("cable", "change")
  const canConnect = canDo("cable", "add")
  const canReserve = canDo("portreservation", "add")
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<RearPort | null>(null)
  const [deleting, setDeleting] = useState<RearPort | null>(null)
  const [selected, setSelected] = useState<RearPort[]>([])
  const [tracing, setTracing] = useState<CableTraceTarget | null>(null)

  const q = useQuery({
    queryKey: ["device-rear-ports", deviceId],
    queryFn: () =>
      api<Paginated<RearPort>>(`/api/rear-ports/?device=${deviceId}`),
  })
  const all = useMemo(() => q.data?.results ?? [], [q.data])
  const { cabled, setCabled, counts, filtered } = useCabledFilter(
    all,
    initialCabled
  )

  const columns = useMemo<ColumnDef<RearPort>[]>(
    () => [
      selectionColumn<RearPort>(),
      ...buildRearPortColumns({
        actions: {
          canEdit,
          canDelete,
          canEditCable,
          canConnect,
          canReserve,
          onEdit: setEditing,
          onDelete: setDeleting,
          onTrace: setTracing,
        },
      }),
    ],
    [canEdit, canDelete, canEditCable, canConnect, canReserve]
  )

  useRegisterAddActions(
    "rear-ports",
    canAdd ? [{ label: "Rear port", onClick: () => setOpen(true) }] : []
  )

  const close = () => {
    setOpen(false)
    setEditing(null)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {q.isError ? (
        <QueryError error={q.error} />
      ) : q.isLoading ? (
        <Loading />
      ) : all.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No rear ports. Rear ports are the back of a patch panel - add one,
          then map front ports to its strands.
        </p>
      ) : (
        <>
          <CabledFilterChips
            value={cabled}
            onChange={setCabled}
            counts={counts}
          />
          <DataTable
            data={filtered}
            total={q.data?.count}
            columns={columns}
            flexColumn="description"
            rowStyle={(r) => portTint(r)}
            onSelectedRowsChange={setSelected}
            selectedRows={selected}
            tableId="device-rear-ports"
            stickyHeader
            searchable
            searchPlaceholder="Search ports…"
          />
        </>
      )}

      <Dialog open={open || !!editing} onOpenChange={(o) => !o && close()}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>
              {editing ? "Edit rear port" : "Add rear port"}
            </DialogTitle>
          </DialogHeader>
          <RearPortForm
            port={editing ?? undefined}
            deviceId={deviceId}
            onSaved={close}
            onCancel={close}
          />
        </DialogContent>
      </Dialog>
      <ComponentBulkBar
        endpoint="/api/rear-ports/"
        kindLabel="rear port"
        selected={selected}
        onCleared={() => setSelected([])}
        invalidate={[["device-rear-ports", deviceId]]}
        fields={[
          { key: "mark_connected", label: "Mark connected", kind: "bool" },
          // Free text, matching RearPortForm - RearPort.type carries no model
          // choices, so a closed list would block values the single-port form
          // accepts.
          { key: "type", label: "Type", kind: "text", hint: "e.g. lc" },
          { key: "positions", label: "Positions", kind: "int" },
          { key: "description", label: "Description", kind: "text" },
        ]}
        tags
      />
      <PortDeleteDialog
        kind="rear"
        port={deleting}
        deviceId={deviceId}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
      <CableTraceDialog
        target={tracing}
        onOpenChange={(o) => !o && setTracing(null)}
      />
    </div>
  )
}

/** Front ports - a patch panel's front jacks, a tab of their own (#345). */
export function DeviceFrontPortsPane({
  deviceId,
  initialCabled,
}: {
  deviceId: string
  /** Seed for the cabled-state chips (the utilization card drill-down). */
  initialCabled?: CableState | null
}) {
  const { canDo } = useMe()
  const canAdd = canDo("frontport", "add")
  const canEdit = canDo("frontport", "change")
  const canDelete = canDo("frontport", "delete")
  const canEditCable = canDo("cable", "change")
  const canConnect = canDo("cable", "add")
  const canReserve = canDo("portreservation", "add")
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<FrontPort | null>(null)
  const [deleting, setDeleting] = useState<FrontPort | null>(null)
  const [selected, setSelected] = useState<FrontPort[]>([])
  const [tracing, setTracing] = useState<CableTraceTarget | null>(null)

  const q = useQuery({
    queryKey: ["device-front-ports", deviceId],
    queryFn: () =>
      api<Paginated<FrontPort>>(`/api/front-ports/?device=${deviceId}`),
  })
  const all = useMemo(() => q.data?.results ?? [], [q.data])
  const { cabled, setCabled, counts, filtered } = useCabledFilter(
    all,
    initialCabled
  )

  const columns = useMemo<ColumnDef<FrontPort>[]>(
    () => [
      selectionColumn<FrontPort>(),
      ...buildFrontPortColumns({
        actions: {
          canEdit,
          canDelete,
          canEditCable,
          canConnect,
          canReserve,
          onEdit: setEditing,
          onDelete: setDeleting,
          onTrace: setTracing,
        },
      }),
    ],
    [canEdit, canDelete, canEditCable, canConnect, canReserve]
  )

  useRegisterAddActions(
    "front-ports",
    canAdd ? [{ label: "Front port", onClick: () => setOpen(true) }] : []
  )

  const close = () => {
    setOpen(false)
    setEditing(null)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {q.isError ? (
        <QueryError error={q.error} />
      ) : q.isLoading ? (
        <Loading />
      ) : all.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No front ports. A front port is a panel's front jack mapped to a
          rear-port strand - a cable trace passes through it.
        </p>
      ) : (
        <>
          <CabledFilterChips
            value={cabled}
            onChange={setCabled}
            counts={counts}
          />
          <DataTable
            data={filtered}
            total={q.data?.count}
            columns={columns}
            flexColumn="description"
            rowStyle={(r) => portTint(r)}
            onSelectedRowsChange={setSelected}
            selectedRows={selected}
            tableId="device-front-ports"
            stickyHeader
            searchable
            searchPlaceholder="Search ports…"
          />
        </>
      )}

      <Dialog open={open || !!editing} onOpenChange={(o) => !o && close()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editing ? "Edit front port" : "Add front port"}
            </DialogTitle>
          </DialogHeader>
          <FrontPortForm
            port={editing ?? undefined}
            deviceId={deviceId}
            onSaved={close}
            onCancel={close}
          />
        </DialogContent>
      </Dialog>
      <ComponentBulkBar
        endpoint="/api/front-ports/"
        kindLabel="front port"
        selected={selected}
        onCleared={() => setSelected([])}
        invalidate={[["device-front-ports", deviceId]]}
        fields={[
          { key: "mark_connected", label: "Mark connected", kind: "bool" },
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
        kind="front"
        port={deleting}
        deviceId={deviceId}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
      <CableTraceDialog
        target={tracing}
        onOpenChange={(o) => !o && setTracing(null)}
      />
    </div>
  )
}
