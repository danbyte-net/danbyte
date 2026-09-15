import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Pencil, Plus, Trash2 } from "lucide-react"
import { useState } from "react"
import type { ReactNode } from "react"

import { api } from "@/lib/api"
import type { Paginated, VTEP, VTEPMembership } from "@/lib/api"
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
import { VlanBadge } from "@/components/cells/vlan-badge"
import { QueryError } from "@/components/query-error"
import { StatusBadge } from "@/components/status-badge"

import { RoutingDeleteDialog } from "./catalog-page"
import { VTEPForm, VTEPMembershipForm } from "./overlay-forms"

// The VTEP card on a device's Routing tab: the tunnel endpoint's identity
// in the header, the VNIs it carries as rows with the VLAN each resolves
// to - the same card shape the protocol instances have.

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

function Section({
  title,
  action,
  children,
}: {
  title: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="grid gap-2">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <span className="ml-auto">{action}</span>
      </div>
      {children}
    </section>
  )
}

type VTEPDialog =
  | { kind: "vtep"; item: VTEP | null }
  | { kind: "vni"; vtep: VTEP; item: VTEPMembership | null }
  | null

export function VTEPSection({
  device,
}: {
  device: { id: string; name: string }
}) {
  const { canDo } = useMe()
  const qc = useQueryClient()
  const [dialog, setDialog] = useState<VTEPDialog>(null)
  const [deleting, setDeleting] = useState<
    { kind: "vtep"; item: VTEP } | { kind: "vni"; item: VTEPMembership } | null
  >(null)
  const q = useQuery({
    queryKey: ["vteps", "device", device.id],
    queryFn: () =>
      api<Paginated<VTEP>>(`/api/routing/vteps/?device=${device.id}`),
  })
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["vteps"] })
    qc.invalidateQueries({ queryKey: ["embedded-vteps"] })
    qc.invalidateQueries({ queryKey: ["device", device.id] })
  }
  const close = () => setDialog(null)
  const vtep = q.data?.results[0] ?? null
  const vnis = vtep
    ? [...vtep.memberships].sort(
        (a, b) => (a.l2vpn.identifier ?? 0) - (b.l2vpn.identifier ?? 0)
      )
    : []
  return (
    <Section
      title="VTEP"
      action={
        q.data &&
        !vtep &&
        canDo("vtep", "add") && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setDialog({ kind: "vtep", item: null })}
          >
            <Plus className="h-3.5 w-3.5" /> Add VTEP
          </Button>
        )
      }
    >
      {q.isError && <QueryError error={q.error} />}
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.data && !vtep && (
        <p className="text-sm text-muted-foreground">
          No VXLAN tunnel endpoint on this device.
        </p>
      )}
      {vtep && (
        <div className="rounded-lg border border-border bg-card">
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
            <span className="font-mono text-sm font-semibold">
              {vtep.source_interface?.name ?? "VTEP"}
            </span>
            {vtep.source_ip && (
              <Link
                to="/ips/$id"
                params={{ id: vtep.source_ip.id }}
                className="link font-mono text-xs"
              >
                {vtep.source_ip.ip_address}
              </Link>
            )}
            {vtep.anycast_ip && (
              <span className="font-mono text-xs text-muted-foreground">
                anycast {vtep.anycast_ip.ip_address}
              </span>
            )}
            {vtep.anycast_gateway_mac && (
              <span className="font-mono text-xs text-muted-foreground">
                gw {vtep.anycast_gateway_mac}
              </span>
            )}
            {vtep.arp_suppression && (
              <Badge variant="secondary">arp-suppress</Badge>
            )}
            <StatusBadge status={vtep.status} />
            <IconButtons
              editLabel="Edit VTEP"
              deleteLabel="Delete VTEP"
              onEdit={
                canDo("vtep", "change")
                  ? () => setDialog({ kind: "vtep", item: vtep })
                  : undefined
              }
              onDelete={
                canDo("vtep", "delete")
                  ? () => setDeleting({ kind: "vtep", item: vtep })
                  : undefined
              }
            />
          </div>
          <div className="grid gap-2 p-4">
            <div className="flex items-center gap-2">
              <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                VNIs
              </h3>
              {vnis.length > 0 && (
                <span className="num text-xs text-muted-foreground">
                  {vnis.length}
                </span>
              )}
              <span className="ml-auto">
                {canDo("vtepmembership", "add") && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs"
                    onClick={() => setDialog({ kind: "vni", vtep, item: null })}
                  >
                    <Plus className="h-3.5 w-3.5" /> Add VNI
                  </Button>
                )}
              </span>
            </div>
            {vnis.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No VNIs on this VTEP.
              </p>
            ) : (
              <ul className="divide-y divide-border rounded-md border border-border">
                {vnis.map((m) => (
                  <li
                    key={m.id}
                    className="flex flex-wrap items-center gap-3 px-3 py-1.5 text-xs"
                  >
                    <span className="num font-mono font-medium">
                      {m.l2vpn.identifier ?? "-"}
                    </span>
                    <Link
                      to="/l2vpns/$id"
                      params={{ id: m.l2vpn.id }}
                      className="link"
                    >
                      {m.l2vpn.name}
                    </Link>
                    {m.l2vpn.vrf ? (
                      <>
                        <Badge variant="outline">L3</Badge>
                        <ColorBadge
                          name={m.l2vpn.vrf.name}
                          color={m.l2vpn.vrf.color}
                        />
                      </>
                    ) : (
                      <Badge variant="outline">L2</Badge>
                    )}
                    {m.resolved_vlan ? (
                      <VlanBadge
                        vlan={m.resolved_vlan}
                        className="font-mono text-[11px]"
                      />
                    ) : (
                      <span className="text-muted-foreground">no VLAN</span>
                    )}
                    {m.vlan && (
                      <span className="text-muted-foreground">own VLAN</span>
                    )}
                    {m.rd && (
                      <span className="font-mono text-muted-foreground">
                        rd {m.rd}
                      </span>
                    )}
                    {m.ingress_replication ? (
                      <Badge variant="secondary">ingress-replication</Badge>
                    ) : m.mcast_group ? (
                      <span className="font-mono text-muted-foreground">
                        {m.mcast_group}
                      </span>
                    ) : null}
                    <IconButtons
                      editLabel="Edit VNI"
                      deleteLabel="Remove VNI"
                      onEdit={
                        canDo("vtepmembership", "change")
                          ? () => setDialog({ kind: "vni", vtep, item: m })
                          : undefined
                      }
                      onDelete={
                        canDo("vtepmembership", "delete")
                          ? () => setDeleting({ kind: "vni", item: m })
                          : undefined
                      }
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
      <Dialog open={dialog !== null} onOpenChange={(o) => !o && close()}>
        <DialogContent size="2xl" className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {dialog?.kind === "vtep"
                ? dialog.item
                  ? `Edit the VTEP on ${device.name}`
                  : `Add a VTEP on ${device.name}`
                : dialog?.kind === "vni"
                  ? dialog.item
                    ? `Edit VNI ${dialog.item.l2vpn.identifier ?? dialog.item.l2vpn.name}`
                    : `Add a VNI on ${device.name}`
                  : ""}
            </DialogTitle>
          </DialogHeader>
          {dialog?.kind === "vtep" && (
            <VTEPForm
              item={dialog.item}
              device={device}
              onSaved={() => {
                refresh()
                close()
              }}
              onCancel={close}
            />
          )}
          {dialog?.kind === "vni" && (
            <VTEPMembershipForm
              item={dialog.item}
              vtep={dialog.vtep}
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
        item={deleting?.kind === "vtep" ? deleting.item : null}
        endpoint="/api/routing/vteps/"
        queryKey="vteps"
        label={(v) => `the VTEP on ${v.device.name}`}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={refresh}
      />
      <RoutingDeleteDialog
        item={deleting?.kind === "vni" ? deleting.item : null}
        endpoint="/api/routing/vtep-memberships/"
        queryKey="vteps"
        label={(m) => `VNI ${m.l2vpn.identifier ?? m.l2vpn.name}`}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={refresh}
      />
    </Section>
  )
}
