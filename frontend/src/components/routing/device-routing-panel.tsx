import { useQuery, useQueryClient } from "@tanstack/react-query"
import type { ColumnDef } from "@tanstack/react-table"
import { Plus, Pencil, Trash2 } from "lucide-react"
import { useMemo, useState } from "react"

import { Link } from "@tanstack/react-router"

import { api } from "@/lib/api"
import type {
  BGPAddressFamily,
  BGPInstance,
  BGPSession,
  Paginated,
  StaticRoute,
} from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ColorBadge } from "@/components/cells/color-badge"
import { StatusBadge } from "@/components/status-badge"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { DataTable } from "@/components/data-table"
import { QueryError } from "@/components/query-error"
import {
  buildBGPSessionColumns,
  buildStaticRouteColumns,
  sessionNeighbor,
} from "@/components/columns/routing-columns"

import {
  BGPAddressFamilyForm,
  BGPInstanceForm,
  BGPSessionForm,
} from "./bgp-forms"
import { RoutingDeleteDialog } from "./catalog-page"
import { EIGRPSection, ISISSection, OSPFSection } from "./device-igp-section"
import { VTEPSection } from "./device-vtep-section"
import { StaticRouteForm } from "./object-forms"

// A device's Routing tab: what the box routes with - static routes, the
// BGP / OSPF / IS-IS instance cards and the VTEP. Rows are edited in place
// through a dialog, the device pre-set, so the tab is where a router's
// routing is written down.

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
      <BGPSection device={device} />
      <OSPFSection device={device} />
      <ISISSection device={device} />
      <EIGRPSection device={device} />
      <VTEPSection device={device} />
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

// ─── BGP ─────────────────────────────────────────────────────────────────────

type Dialog =
  | { kind: "instance"; item: BGPInstance | null }
  | { kind: "af"; instance: BGPInstance; item: BGPAddressFamily | null }
  | { kind: "session"; instance: BGPInstance; item: BGPSession | null }
  | null

function BGPSection({ device }: { device: { id: string; name: string } }) {
  const { canDo, humanIds } = useMe()
  const qc = useQueryClient()
  const [dialog, setDialog] = useState<Dialog>(null)
  const [deleting, setDeleting] = useState<
    | { kind: "instance"; item: BGPInstance }
    | { kind: "af"; item: BGPAddressFamily }
    | { kind: "session"; item: BGPSession }
    | null
  >(null)

  const instances = useQuery({
    queryKey: ["bgp-instances", "device", device.id],
    queryFn: () =>
      api<Paginated<BGPInstance>>(
        `/api/routing/bgp-instances/?device=${device.id}`
      ),
  })
  const sessions = useQuery({
    queryKey: ["bgp-sessions", "device", device.id],
    queryFn: () =>
      api<Paginated<BGPSession>>(
        `/api/routing/bgp-sessions/?device=${device.id}&page_size=500`
      ),
  })
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["bgp-instances"] })
    qc.invalidateQueries({ queryKey: ["bgp-sessions"] })
    qc.invalidateQueries({ queryKey: ["device", device.id] })
  }
  const canEditS = canDo("bgpsession", "change")
  const canDeleteS = canDo("bgpsession", "delete")
  const sessionColumns = useMemo<ColumnDef<BGPSession, unknown>[]>(
    () =>
      buildBGPSessionColumns({
        humanIds,
        omit: ["device", "vrf", "local_asn"],
        actions: {
          onEdit: (row) =>
            setDialog({
              kind: "session",
              instance: (instances.data?.results ?? []).find(
                (i) => i.id === row.instance.id
              )!,
              item: row,
            }),
          canEdit: () => canEditS,
          onDelete: (row) => setDeleting({ kind: "session", item: row }),
          canDelete: () => canDeleteS,
        },
      }),
    [humanIds, canEditS, canDeleteS, instances.data]
  )
  const rows = instances.data?.results ?? []
  const close = () => setDialog(null)

  return (
    <Section
      title="BGP"
      count={rows.length}
      action={
        canDo("bgpinstance", "add") && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setDialog({ kind: "instance", item: null })}
          >
            <Plus className="h-3.5 w-3.5" /> Add instance
          </Button>
        )
      }
    >
      {instances.isError && <QueryError error={instances.error} />}
      {instances.isLoading && (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
      {instances.data && rows.length === 0 && (
        <p className="text-sm text-muted-foreground">No BGP on this device.</p>
      )}
      {rows.map((inst) => {
        const mine = (sessions.data?.results ?? []).filter(
          (s) => s.instance.id === inst.id
        )
        return (
          <div
            key={inst.id}
            className="rounded-lg border border-border bg-card"
          >
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
              <span className="font-mono text-sm font-semibold">
                AS{inst.asn.asn}
              </span>
              {inst.vrf ? (
                <ColorBadge name={inst.vrf.name} color={inst.vrf.color} />
              ) : (
                <Badge variant="outline">global</Badge>
              )}
              <StatusBadge status={inst.status} />
              {inst.router_id && (
                <span className="font-mono text-xs text-muted-foreground">
                  router-id {inst.router_id}
                </span>
              )}
              {inst.address_families.length > 0 && (
                <span className="flex flex-wrap gap-1">
                  {inst.address_families.map((af) => (
                    <Badge
                      key={af.id}
                      variant="secondary"
                      className="font-mono"
                    >
                      {af.afi_safi}
                    </Badge>
                  ))}
                </span>
              )}
              <span className="ml-auto flex items-center gap-1">
                {canDo("bgpinstance", "change") && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    onClick={() => setDialog({ kind: "instance", item: inst })}
                    aria-label="Edit instance"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                )}
                {canDo("bgpinstance", "delete") && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    onClick={() =>
                      setDeleting({ kind: "instance", item: inst })
                    }
                    aria-label="Delete instance"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </span>
            </div>
            <div className="grid gap-4 p-4">
              <div className="grid gap-2">
                <div className="flex items-center gap-2">
                  <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                    Address families
                  </h3>
                  <span className="ml-auto">
                    {canDo("bgpaddressfamily", "add") && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs"
                        onClick={() =>
                          setDialog({ kind: "af", instance: inst, item: null })
                        }
                      >
                        <Plus className="h-3.5 w-3.5" /> Add
                      </Button>
                    )}
                  </span>
                </div>
                {inst.address_families.length === 0 ? (
                  <p className="text-xs text-muted-foreground">None yet.</p>
                ) : (
                  <ul className="divide-y divide-border rounded-md border border-border">
                    {inst.address_families.map((af) => (
                      <li
                        key={af.id}
                        className="flex flex-wrap items-center gap-3 px-3 py-1.5 text-xs"
                      >
                        <span className="font-mono font-medium">
                          {af.afi_safi}
                        </span>
                        {af.networks.length > 0 && (
                          <span className="font-mono text-muted-foreground">
                            {af.networks.join(" ")}
                          </span>
                        )}
                        {af.maximum_paths != null && (
                          <span className="text-muted-foreground">
                            maximum-paths{" "}
                            <span className="num">{af.maximum_paths}</span>
                          </span>
                        )}
                        {af.import_policy && (
                          <span className="text-muted-foreground">
                            in{" "}
                            <Link
                              to="/routing-policies/$id"
                              params={{ id: af.import_policy.id }}
                              className="link font-mono"
                            >
                              {af.import_policy.name}
                            </Link>
                          </span>
                        )}
                        {af.export_policy && (
                          <span className="text-muted-foreground">
                            out{" "}
                            <Link
                              to="/routing-policies/$id"
                              params={{ id: af.export_policy.id }}
                              className="link font-mono"
                            >
                              {af.export_policy.name}
                            </Link>
                          </span>
                        )}
                        {af.redistributions.length > 0 && (
                          <span className="text-muted-foreground">
                            redistribute{" "}
                            {af.redistributions.map((r) => r.source).join(", ")}
                          </span>
                        )}
                        <span className="ml-auto flex items-center gap-1">
                          {canDo("bgpaddressfamily", "change") && (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7"
                              onClick={() =>
                                setDialog({
                                  kind: "af",
                                  instance: inst,
                                  item: af,
                                })
                              }
                              aria-label="Edit address family"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          {canDo("bgpaddressfamily", "delete") && (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7 text-muted-foreground hover:text-destructive"
                              onClick={() =>
                                setDeleting({ kind: "af", item: af })
                              }
                              aria-label="Delete address family"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="grid gap-2">
                <div className="flex items-center gap-2">
                  <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                    Sessions
                  </h3>
                  {mine.length > 0 && (
                    <span className="num text-xs text-muted-foreground">
                      {mine.length}
                    </span>
                  )}
                  <span className="ml-auto">
                    {canDo("bgpsession", "add") && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs"
                        onClick={() =>
                          setDialog({
                            kind: "session",
                            instance: inst,
                            item: null,
                          })
                        }
                      >
                        <Plus className="h-3.5 w-3.5" /> Add session
                      </Button>
                    )}
                  </span>
                </div>
                {mine.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No neighbours yet.
                  </p>
                ) : (
                  <DataTable
                    data={mine}
                    columns={sessionColumns}
                    flexColumn="description"
                    tableId="device-bgp-sessions"
                  />
                )}
              </div>
            </div>
          </div>
        )
      })}

      <Dialog open={dialog !== null} onOpenChange={(o) => !o && close()}>
        <DialogContent size="2xl" className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {dialog?.kind === "instance"
                ? dialog.item
                  ? `Edit AS${dialog.item.asn.asn}`
                  : `Add BGP instance on ${device.name}`
                : dialog?.kind === "af"
                  ? dialog.item
                    ? `Edit ${dialog.item.afi_safi}`
                    : `Add address family to AS${dialog.instance.asn.asn}`
                  : dialog?.kind === "session"
                    ? dialog.item
                      ? `Edit ${sessionNeighbor(dialog.item)}`
                      : `Add session to AS${dialog.instance.asn.asn}`
                    : ""}
            </DialogTitle>
          </DialogHeader>
          {dialog?.kind === "instance" && (
            <BGPInstanceForm
              item={dialog.item}
              device={device}
              onSaved={() => {
                refresh()
                close()
              }}
              onCancel={close}
            />
          )}
          {dialog?.kind === "af" && (
            <BGPAddressFamilyForm
              item={dialog.item}
              instance={dialog.instance}
              onSaved={() => {
                refresh()
                close()
              }}
              onCancel={close}
            />
          )}
          {dialog?.kind === "session" && (
            <BGPSessionForm
              item={dialog.item}
              instance={dialog.instance}
              onSaved={() => {
                refresh()
                close()
              }}
              onCancel={close}
            />
          )}
        </DialogContent>
      </Dialog>
      <RoutingDeleteDialog
        item={deleting?.kind === "instance" ? deleting.item : null}
        endpoint="/api/routing/bgp-instances/"
        queryKey="bgp-instances"
        label={(i) => `AS${i.asn.asn} on ${i.device.name}`}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={refresh}
      />
      <RoutingDeleteDialog
        item={deleting?.kind === "af" ? deleting.item : null}
        endpoint="/api/routing/bgp-address-families/"
        queryKey="bgp-instances"
        label={(a) => a.afi_safi}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={refresh}
      />
      <RoutingDeleteDialog
        item={deleting?.kind === "session" ? deleting.item : null}
        endpoint="/api/routing/bgp-sessions/"
        queryKey="bgp-sessions"
        label={(x) => sessionNeighbor(x)}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={refresh}
      />
    </Section>
  )
}
