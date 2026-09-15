import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { Plus } from "lucide-react"
import { useMemo, useState } from "react"

import { api } from "@/lib/api"
import type { Paginated, StaticRoute } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { DataTable } from "@/components/data-table"
import { QueryError } from "@/components/query-error"
import { buildStaticRouteColumns } from "@/components/columns/routing-columns"

import { RoutingDeleteDialog } from "./catalog-page"
import { StaticRouteForm } from "./object-forms"

// A device's Routing tab: what the box routes with. Static routes today;
// the BGP / OSPF / IS-IS instance cards and the VTEP land beside them as
// each protocol arrives. Rows are edited in place through a dialog, the
// device pre-set, so the tab is where a router's routing is written down.

function Section({
  title,
  count,
  action,
  children,
}: {
  title: string
  count?: number
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="grid gap-2">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        {count != null && count > 0 && (
          <span className="num text-xs text-muted-foreground">{count}</span>
        )}
        <span className="ml-auto">{action}</span>
      </div>
      {children}
    </section>
  )
}

export function DeviceRoutingPanel({
  device,
}: {
  device: { id: string; name: string }
}) {
  const { canDo, humanIds } = useMe()
  const qc = useQueryClient()
  const [editing, setEditing] = useState<StaticRoute | null>(null)
  const [adding, setAdding] = useState(false)
  const [deleting, setDeleting] = useState<StaticRoute | null>(null)

  const routes = useQuery({
    queryKey: ["static-routes", "device", device.id],
    queryFn: () =>
      api<Paginated<StaticRoute>>(
        `/api/routing/static-routes/?device=${device.id}&page_size=500`
      ),
  })
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["static-routes"] })
    qc.invalidateQueries({ queryKey: ["device", device.id] })
  }
  const canEdit = canDo("staticroute", "change")
  const canDelete = canDo("staticroute", "delete")
  const columns = useMemo<ColumnDef<StaticRoute, unknown>[]>(
    () =>
      buildStaticRouteColumns({
        humanIds,
        omit: ["device"],
        actions: {
          onEdit: setEditing,
          canEdit: () => canEdit,
          onDelete: setDeleting,
          canDelete: () => canDelete,
        },
      }),
    [humanIds, canEdit, canDelete]
  )
  const rows = routes.data?.results ?? []

  return (
    <div className="grid gap-8">
      <Section
        title="Static routes"
        count={rows.length}
        action={
          canDo("staticroute", "add") && (
            <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
              <Plus className="h-3.5 w-3.5" /> Add static route
            </Button>
          )
        }
      >
        {routes.isError && <QueryError error={routes.error} />}
        {routes.isLoading && (
          <p className="text-sm text-muted-foreground">Loading…</p>
        )}
        {routes.data && rows.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No static routes on this device.
          </p>
        )}
        {rows.length > 0 && (
          <DataTable
            data={rows}
            columns={columns}
            flexColumn="description"
            tableId="device-static-routes"
          />
        )}
      </Section>

      <Dialog
        open={adding || !!editing}
        onOpenChange={(o) => {
          if (!o) {
            setAdding(false)
            setEditing(null)
          }
        }}
      >
        <DialogContent size="2xl" className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editing
                ? `Edit ${editing.prefix}`
                : `Add static route on ${device.name}`}
            </DialogTitle>
          </DialogHeader>
          {(adding || editing) && (
            <StaticRouteForm
              item={editing}
              device={device}
              onSaved={() => {
                refresh()
                setAdding(false)
                setEditing(null)
              }}
              onCancel={() => {
                setAdding(false)
                setEditing(null)
              }}
            />
          )}
        </DialogContent>
      </Dialog>
      <RoutingDeleteDialog
        item={deleting}
        endpoint="/api/routing/static-routes/"
        queryKey="static-routes"
        label={(r) => r.prefix}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={refresh}
      />
    </div>
  )
}
