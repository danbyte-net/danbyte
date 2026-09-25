import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Pencil, Plus, Trash2 } from "lucide-react"
import { useState } from "react"
import type { ReactNode } from "react"

import { api } from "@/lib/api"
import type {
  EIGRPInstance,
  EIGRPInterface,
  ISISInstance,
  ISISInterface,
  OSPFInstance,
  OSPFInterface,
  Paginated,
} from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ColorBadge } from "@/components/cells/color-badge"
import { QueryError } from "@/components/query-error"
import { StatusBadge } from "@/components/status-badge"

import { RoutingDeleteDialog } from "./catalog-page"
import {
  EIGRPInstanceForm,
  EIGRPInterfaceForm,
  ISISInstanceForm,
  ISISInterfaceForm,
  OSPFInstanceForm,
  OSPFInterfaceForm,
} from "./igp-forms"
import {
  ownerDetailKey,
  ownerName,
  ownerNoun,
  ownerParam,
  PortLink,
  portOf,
} from "./owner"
import type { RoutingOwner } from "./owner"

// The OSPF, IS-IS and EIGRP cards on a device's or VM's Routing tab: one card per
// instance, the enrolled interfaces as rows, and dialogs to add or edit
// either - the same shape the BGP cards have.

function IconButtons({
  onEdit,
  onDelete,
  editLabel,
  deleteLabel,
}: {
  onEdit?: () => void
  onDelete?: () => void
  editLabel: string
  deleteLabel: string
}) {
  return (
    <span className="ml-auto flex items-center gap-1">
      {onEdit && (
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={onEdit}
          aria-label={editLabel}
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      )}
      {onDelete && (
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7 text-muted-foreground hover:text-destructive"
          onClick={onDelete}
          aria-label={deleteLabel}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      )}
    </span>
  )
}

function Card({
  title,
  badges,
  onEdit,
  onDelete,
  addLabel,
  onAdd,
  rows,
  empty,
}: {
  title: ReactNode
  badges: ReactNode
  onEdit?: () => void
  onDelete?: () => void
  addLabel: string
  onAdd?: () => void
  rows: ReactNode[]
  empty: string
}) {
  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <span className="font-mono text-sm font-semibold">{title}</span>
        {badges}
        <IconButtons
          onEdit={onEdit}
          onDelete={onDelete}
          editLabel="Edit instance"
          deleteLabel="Delete instance"
        />
      </div>
      <div className="grid gap-2 p-4">
        <div className="flex items-center gap-2">
          <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Interfaces
          </h3>
          {rows.length > 0 && (
            <span className="num text-xs text-muted-foreground">
              {rows.length}
            </span>
          )}
          <span className="ml-auto">
            {onAdd && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                onClick={onAdd}
              >
                <Plus className="h-3.5 w-3.5" /> {addLabel}
              </Button>
            )}
          </span>
        </div>
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">{empty}</p>
        ) : (
          <ul className="divide-y divide-border rounded-md border border-border">
            {rows}
          </ul>
        )}
      </div>
    </div>
  )
}

function Section({
  title,
  count,
  action,
  children,
}: {
  title: string
  count?: number
  action?: ReactNode
  children: ReactNode
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

const onOff = (v: boolean | null, fallback: boolean) =>
  (v ?? fallback) ? "passive" : null

// ─── OSPF ────────────────────────────────────────────────────────────────────

type OSPFDialog =
  | { kind: "instance"; item: OSPFInstance | null }
  | { kind: "iface"; instance: OSPFInstance; item: OSPFInterface | null }
  | null

export function OSPFSection({ owner }: { owner: RoutingOwner }) {
  const { canDo } = useMe()
  const qc = useQueryClient()
  const [dialog, setDialog] = useState<OSPFDialog>(null)
  const [deleting, setDeleting] = useState<
    | { kind: "instance"; item: OSPFInstance }
    | { kind: "iface"; item: OSPFInterface }
    | null
  >(null)
  const q = useQuery({
    queryKey: ["ospf-instances", owner.kind, owner.id],
    queryFn: () =>
      api<Paginated<OSPFInstance>>(
        `/api/routing/ospf-instances/?${ownerParam(owner)}`
      ),
  })
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["ospf-instances"] })
    qc.invalidateQueries({ queryKey: ownerDetailKey(owner) })
  }
  const close = () => setDialog(null)
  const rows = q.data?.results ?? []
  return (
    <Section
      title="OSPF"
      count={rows.length}
      action={
        canDo("ospfinstance", "add") && (
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
      {q.isError && <QueryError error={q.error} />}
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.data && rows.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No OSPF on this {ownerNoun(owner)}.
        </p>
      )}
      {rows.map((inst) => (
        <Card
          key={inst.id}
          title={`OSPF${inst.version === 3 ? "v3" : ""} ${inst.process_id}`.trim()}
          badges={
            <>
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
              {inst.passive_by_default && (
                <Badge variant="secondary">passive by default</Badge>
              )}
              {inst.redistributions.length > 0 && (
                <span className="text-xs text-muted-foreground">
                  redistribute{" "}
                  {inst.redistributions.map((r) => r.source).join(", ")}
                </span>
              )}
            </>
          }
          onEdit={
            canDo("ospfinstance", "change")
              ? () => setDialog({ kind: "instance", item: inst })
              : undefined
          }
          onDelete={
            canDo("ospfinstance", "delete")
              ? () => setDeleting({ kind: "instance", item: inst })
              : undefined
          }
          addLabel="Enrol interface"
          onAdd={
            canDo("ospfinterface", "add")
              ? () => setDialog({ kind: "iface", instance: inst, item: null })
              : undefined
          }
          empty="No interfaces enrolled."
          rows={inst.interfaces.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center gap-3 px-3 py-1.5 text-xs"
            >
              <PortLink
                iface={row.interface}
                vmIface={row.vm_interface}
                className="link font-mono font-medium"
              />
              <Link
                to="/ospf-areas/$id"
                params={{ id: row.area.id }}
                className="link"
              >
                area {row.area.area_id}
              </Link>
              {row.cost != null && (
                <span className="text-muted-foreground">
                  cost <span className="num">{row.cost}</span>
                </span>
              )}
              {row.network_type && (
                <span className="text-muted-foreground">
                  {row.network_type}
                </span>
              )}
              {onOff(row.passive, inst.passive_by_default) && (
                <Badge variant="secondary">passive</Badge>
              )}
              {row.bfd && (
                <Badge variant="secondary">
                  bfd{row.bfd_profile ? ` · ${row.bfd_profile.name}` : ""}
                </Badge>
              )}
              {row.authentication !== "none" && (
                <span className="text-muted-foreground">
                  {row.authentication} · {row.keychain?.name}
                </span>
              )}
              <IconButtons
                editLabel="Edit interface"
                deleteLabel="Remove interface"
                onEdit={
                  canDo("ospfinterface", "change")
                    ? () =>
                        setDialog({ kind: "iface", instance: inst, item: row })
                    : undefined
                }
                onDelete={
                  canDo("ospfinterface", "delete")
                    ? () => setDeleting({ kind: "iface", item: row })
                    : undefined
                }
              />
            </li>
          ))}
        />
      ))}
      <Dialog open={dialog !== null} onOpenChange={(o) => !o && close()}>
        <DialogContent size="2xl" className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {dialog?.kind === "instance"
                ? dialog.item
                  ? `Edit OSPF ${dialog.item.process_id}`
                  : `Add OSPF instance on ${owner.name}`
                : dialog?.kind === "iface"
                  ? dialog.item
                    ? `Edit ${portOf(dialog.item)?.name ?? "interface"}`
                    : `Enrol an interface in OSPF ${dialog.instance.process_id}`
                  : ""}
            </DialogTitle>
          </DialogHeader>
          {dialog?.kind === "instance" && (
            <OSPFInstanceForm
              item={dialog.item}
              owner={owner}
              onSaved={() => {
                refresh()
                close()
              }}
              onCancel={close}
            />
          )}
          {dialog?.kind === "iface" && (
            <OSPFInterfaceForm
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
        endpoint="/api/routing/ospf-instances/"
        queryKey="ospf-instances"
        label={(i) => `OSPF ${i.process_id} on ${ownerName(i)}`}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={refresh}
      />
      <RoutingDeleteDialog
        item={deleting?.kind === "iface" ? deleting.item : null}
        endpoint="/api/routing/ospf-interfaces/"
        queryKey="ospf-instances"
        label={(i) => portOf(i)?.name ?? "interface"}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={refresh}
      />
    </Section>
  )
}

// ─── IS-IS ───────────────────────────────────────────────────────────────────

type ISISDialog =
  | { kind: "instance"; item: ISISInstance | null }
  | { kind: "iface"; instance: ISISInstance; item: ISISInterface | null }
  | null

export function ISISSection({ owner }: { owner: RoutingOwner }) {
  const { canDo } = useMe()
  const qc = useQueryClient()
  const [dialog, setDialog] = useState<ISISDialog>(null)
  const [deleting, setDeleting] = useState<
    | { kind: "instance"; item: ISISInstance }
    | { kind: "iface"; item: ISISInterface }
    | null
  >(null)
  const q = useQuery({
    queryKey: ["isis-instances", owner.kind, owner.id],
    queryFn: () =>
      api<Paginated<ISISInstance>>(
        `/api/routing/isis-instances/?${ownerParam(owner)}`
      ),
  })
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["isis-instances"] })
    qc.invalidateQueries({ queryKey: ownerDetailKey(owner) })
  }
  const close = () => setDialog(null)
  const rows = q.data?.results ?? []
  return (
    <Section
      title="IS-IS"
      count={rows.length}
      action={
        canDo("isisinstance", "add") && (
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
      {q.isError && <QueryError error={q.error} />}
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.data && rows.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No IS-IS on this {ownerNoun(owner)}.
        </p>
      )}
      {rows.map((inst) => (
        <Card
          key={inst.id}
          title={`IS-IS ${inst.process}`.trim()}
          badges={
            <>
              {inst.vrf ? (
                <ColorBadge name={inst.vrf.name} color={inst.vrf.color} />
              ) : (
                <Badge variant="outline">global</Badge>
              )}
              <StatusBadge status={inst.status} />
              <span className="font-mono text-xs text-muted-foreground">
                net {inst.net}
              </span>
              {inst.router_id && (
                <span className="font-mono text-xs text-muted-foreground">
                  router-id {inst.router_id}
                </span>
              )}
              <Badge variant="secondary">level {inst.level}</Badge>
              <span className="text-xs text-muted-foreground">
                metric {inst.metric_style}
              </span>
              {inst.authentication !== "none" && (
                <span className="text-xs text-muted-foreground">
                  {inst.authentication} · {inst.keychain?.name}
                </span>
              )}
            </>
          }
          onEdit={
            canDo("isisinstance", "change")
              ? () => setDialog({ kind: "instance", item: inst })
              : undefined
          }
          onDelete={
            canDo("isisinstance", "delete")
              ? () => setDeleting({ kind: "instance", item: inst })
              : undefined
          }
          addLabel="Enrol interface"
          onAdd={
            canDo("isisinterface", "add")
              ? () => setDialog({ kind: "iface", instance: inst, item: null })
              : undefined
          }
          empty="No interfaces enrolled."
          rows={inst.interfaces.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center gap-3 px-3 py-1.5 text-xs"
            >
              <PortLink
                iface={row.interface}
                vmIface={row.vm_interface}
                className="link font-mono font-medium"
              />
              <span className="font-mono text-muted-foreground">
                {row.families.join(" ")}
              </span>
              <Badge variant="secondary">L{row.level || inst.level}</Badge>
              {row.metric != null && (
                <span className="text-muted-foreground">
                  metric <span className="num">{row.metric}</span>
                </span>
              )}
              {row.network_type && (
                <span className="text-muted-foreground">
                  {row.network_type}
                </span>
              )}
              {row.passive && <Badge variant="secondary">passive</Badge>}
              {row.bfd && (
                <Badge variant="secondary">
                  bfd{row.bfd_profile ? ` · ${row.bfd_profile.name}` : ""}
                </Badge>
              )}
              <IconButtons
                editLabel="Edit interface"
                deleteLabel="Remove interface"
                onEdit={
                  canDo("isisinterface", "change")
                    ? () =>
                        setDialog({ kind: "iface", instance: inst, item: row })
                    : undefined
                }
                onDelete={
                  canDo("isisinterface", "delete")
                    ? () => setDeleting({ kind: "iface", item: row })
                    : undefined
                }
              />
            </li>
          ))}
        />
      ))}
      <Dialog open={dialog !== null} onOpenChange={(o) => !o && close()}>
        <DialogContent size="2xl" className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {dialog?.kind === "instance"
                ? dialog.item
                  ? `Edit IS-IS ${dialog.item.process}`
                  : `Add IS-IS instance on ${owner.name}`
                : dialog?.kind === "iface"
                  ? dialog.item
                    ? `Edit ${portOf(dialog.item)?.name ?? "interface"}`
                    : `Enrol an interface in IS-IS ${dialog.instance.process}`
                  : ""}
            </DialogTitle>
          </DialogHeader>
          {dialog?.kind === "instance" && (
            <ISISInstanceForm
              item={dialog.item}
              owner={owner}
              onSaved={() => {
                refresh()
                close()
              }}
              onCancel={close}
            />
          )}
          {dialog?.kind === "iface" && (
            <ISISInterfaceForm
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
        endpoint="/api/routing/isis-instances/"
        queryKey="isis-instances"
        label={(i) => `IS-IS ${i.process} on ${ownerName(i)}`}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={refresh}
      />
      <RoutingDeleteDialog
        item={deleting?.kind === "iface" ? deleting.item : null}
        endpoint="/api/routing/isis-interfaces/"
        queryKey="isis-instances"
        label={(i) => portOf(i)?.name ?? "interface"}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={refresh}
      />
    </Section>
  )
}

// ─── EIGRP ───────────────────────────────────────────────────────────────────

type EIGRPDialog =
  | { kind: "instance"; item: EIGRPInstance | null }
  | { kind: "iface"; instance: EIGRPInstance; item: EIGRPInterface | null }
  | null

export function EIGRPSection({ owner }: { owner: RoutingOwner }) {
  const { canDo } = useMe()
  const qc = useQueryClient()
  const [dialog, setDialog] = useState<EIGRPDialog>(null)
  const [deleting, setDeleting] = useState<
    | { kind: "instance"; item: EIGRPInstance }
    | { kind: "iface"; item: EIGRPInterface }
    | null
  >(null)
  const q = useQuery({
    queryKey: ["eigrp-instances", owner.kind, owner.id],
    queryFn: () =>
      api<Paginated<EIGRPInstance>>(
        `/api/routing/eigrp-instances/?${ownerParam(owner)}`
      ),
  })
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["eigrp-instances"] })
    qc.invalidateQueries({ queryKey: ownerDetailKey(owner) })
  }
  const close = () => setDialog(null)
  const rows = q.data?.results ?? []
  const title = (inst: EIGRPInstance) =>
    inst.name ? `EIGRP ${inst.name} · AS ${inst.asn}` : `EIGRP ${inst.asn}`
  return (
    <Section
      title="EIGRP"
      count={rows.length}
      action={
        canDo("eigrpinstance", "add") && (
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
      {q.isError && <QueryError error={q.error} />}
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.data && rows.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No EIGRP on this {ownerNoun(owner)}.
        </p>
      )}
      {rows.map((inst) => (
        <Card
          key={inst.id}
          title={title(inst)}
          badges={
            <>
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
              {inst.k_values && (
                <span className="font-mono text-xs text-muted-foreground">
                  k {inst.k_values}
                </span>
              )}
              {inst.stub && <Badge variant="secondary">stub</Badge>}
              {inst.passive_by_default && (
                <Badge variant="secondary">passive by default</Badge>
              )}
              {inst.redistributions.length > 0 && (
                <span className="text-xs text-muted-foreground">
                  redistribute{" "}
                  {inst.redistributions.map((r) => r.source).join(", ")}
                </span>
              )}
            </>
          }
          onEdit={
            canDo("eigrpinstance", "change")
              ? () => setDialog({ kind: "instance", item: inst })
              : undefined
          }
          onDelete={
            canDo("eigrpinstance", "delete")
              ? () => setDeleting({ kind: "instance", item: inst })
              : undefined
          }
          addLabel="Enrol interface"
          onAdd={
            canDo("eigrpinterface", "add")
              ? () => setDialog({ kind: "iface", instance: inst, item: null })
              : undefined
          }
          empty="No interfaces enrolled."
          rows={inst.interfaces.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center gap-3 px-3 py-1.5 text-xs"
            >
              <PortLink
                iface={row.interface}
                vmIface={row.vm_interface}
                className="link font-mono font-medium"
              />
              {row.summary_addresses.length > 0 && (
                <span className="font-mono text-muted-foreground">
                  summary {row.summary_addresses.join(", ")}
                </span>
              )}
              {row.bandwidth_percent != null && (
                <span className="text-muted-foreground">
                  bandwidth <span className="num">{row.bandwidth_percent}</span>
                  %
                </span>
              )}
              {onOff(row.passive, inst.passive_by_default) && (
                <Badge variant="secondary">passive</Badge>
              )}
              {row.split_horizon === false && (
                <Badge variant="secondary">no split-horizon</Badge>
              )}
              {row.bfd && (
                <Badge variant="secondary">
                  bfd{row.bfd_profile ? ` · ${row.bfd_profile.name}` : ""}
                </Badge>
              )}
              {row.authentication !== "none" && (
                <span className="text-muted-foreground">
                  {row.authentication} · {row.keychain?.name}
                </span>
              )}
              <IconButtons
                editLabel="Edit interface"
                deleteLabel="Remove interface"
                onEdit={
                  canDo("eigrpinterface", "change")
                    ? () =>
                        setDialog({ kind: "iface", instance: inst, item: row })
                    : undefined
                }
                onDelete={
                  canDo("eigrpinterface", "delete")
                    ? () => setDeleting({ kind: "iface", item: row })
                    : undefined
                }
              />
            </li>
          ))}
        />
      ))}
      <Dialog open={dialog !== null} onOpenChange={(o) => !o && close()}>
        <DialogContent size="2xl" className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {dialog?.kind === "instance"
                ? dialog.item
                  ? `Edit ${title(dialog.item)}`
                  : `Add EIGRP instance on ${owner.name}`
                : dialog?.kind === "iface"
                  ? dialog.item
                    ? `Edit ${portOf(dialog.item)?.name ?? "interface"}`
                    : `Enrol an interface in ${title(dialog.instance)}`
                  : ""}
            </DialogTitle>
          </DialogHeader>
          {dialog?.kind === "instance" && (
            <EIGRPInstanceForm
              item={dialog.item}
              owner={owner}
              onSaved={() => {
                refresh()
                close()
              }}
              onCancel={close}
            />
          )}
          {dialog?.kind === "iface" && (
            <EIGRPInterfaceForm
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
        endpoint="/api/routing/eigrp-instances/"
        queryKey="eigrp-instances"
        label={(i) => `${title(i)} on ${ownerName(i)}`}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={refresh}
      />
      <RoutingDeleteDialog
        item={deleting?.kind === "iface" ? deleting.item : null}
        endpoint="/api/routing/eigrp-interfaces/"
        queryKey="eigrp-instances"
        label={(i) => portOf(i)?.name ?? "interface"}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={refresh}
      />
    </Section>
  )
}
