import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Pencil, Plus, Trash2 } from "lucide-react"
import { useState } from "react"

import { api } from "@/lib/api"
import type { LDPInstance, Paginated } from "@/lib/api"
import { useMe } from "@/lib/use-me"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { KvCard, dash } from "@/components/kv-card"
import type { KvRow } from "@/components/kv-card"
import { QueryError } from "@/components/query-error"
import { StatusBadge } from "@/components/status-badge"

import { RoutingDeleteDialog } from "./catalog-page"
import { LDPInstanceForm } from "./overlay-forms"

// The LDP card on a device's Routing tab: `mpls ldp` as the box writes it -
// router id, transport address, which routes get labels, the ports it
// speaks on. One per device, so the section is the instance or an Add.

const ALLOCATION_LABEL: Record<string, string> = {
  "host-routes": "Host routes only",
  all: "All routes",
}

export function LDPSection({
  device,
}: {
  device: { id: string; name: string }
}) {
  const { canDo } = useMe()
  const qc = useQueryClient()
  const [editing, setEditing] = useState<LDPInstance | null | false>(false)
  const [deleting, setDeleting] = useState<LDPInstance | null>(null)
  const q = useQuery({
    queryKey: ["ldp-instances", "device", device.id],
    queryFn: () =>
      api<Paginated<LDPInstance>>(
        `/api/routing/ldp-instances/?device=${device.id}`
      ),
  })
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["ldp-instances"] })
    qc.invalidateQueries({ queryKey: ["device", device.id] })
  }
  const close = () => setEditing(false)
  const ldp = q.data?.results[0] ?? null

  const rows: KvRow[] = ldp
    ? [
        {
          label: "Router ID",
          value: ldp.router_id ? (
            <span className="font-mono">{ldp.router_id}</span>
          ) : (
            dash
          ),
        },
        {
          label: "Transport address",
          value: ldp.transport_address ? (
            <span className="font-mono">{ldp.transport_address}</span>
          ) : (
            <span className="text-muted-foreground">Router ID</span>
          ),
        },
        {
          label: "Label allocation",
          value: ALLOCATION_LABEL[ldp.label_allocation] ?? ldp.label_allocation,
        },
        {
          label: "Interfaces",
          value:
            ldp.interfaces.length === 0 ? (
              dash
            ) : (
              <span className="flex flex-wrap gap-1">
                {ldp.interfaces.map((i) => (
                  <Badge key={i.id} variant="secondary" className="font-mono">
                    {i.name}
                  </Badge>
                ))}
              </span>
            ),
        },
        {
          label: "BFD",
          value: ldp.bfd ? (
            <span>
              On
              {ldp.bfd_profile && (
                <span className="font-mono text-muted-foreground">
                  {" "}
                  · {ldp.bfd_profile.name}
                </span>
              )}
            </span>
          ) : (
            "Off"
          ),
        },
        {
          label: "Status",
          value: ldp.status ? <StatusBadge status={ldp.status} /> : dash,
        },
        ...(ldp.description
          ? [{ label: "Description", value: ldp.description }]
          : []),
      ]
    : []

  return (
    <section className="grid gap-2">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold">LDP</h2>
        <span className="ml-auto flex items-center gap-1">
          {q.data && !ldp && canDo("ldpinstance", "add") && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEditing(null)}
            >
              <Plus className="h-3.5 w-3.5" /> Add LDP
            </Button>
          )}
          {ldp && canDo("ldpinstance", "change") && (
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7"
              onClick={() => setEditing(ldp)}
              aria-label="Edit LDP"
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          )}
          {ldp && canDo("ldpinstance", "delete") && (
            <Button
              size="icon"
              variant="ghost"
              className="h-7 w-7 text-muted-foreground hover:text-destructive"
              onClick={() => setDeleting(ldp)}
              aria-label="Delete LDP"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </span>
      </div>
      {q.isError && <QueryError error={q.error} />}
      {q.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
      {q.data && !ldp && (
        <p className="text-sm text-muted-foreground">
          No LDP process on this device.
        </p>
      )}
      {ldp && <KvCard title="Instance" rows={rows} />}
      <Dialog open={editing !== false} onOpenChange={(o) => !o && close()}>
        <DialogContent size="2xl" className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editing
                ? `Edit LDP on ${device.name}`
                : `Add LDP on ${device.name}`}
            </DialogTitle>
          </DialogHeader>
          {editing !== false && (
            <LDPInstanceForm
              item={editing}
              device={device}
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
        item={deleting}
        endpoint="/api/routing/ldp-instances/"
        queryKey="ldp-instances"
        label={(v) => `LDP on ${v.device.name}`}
        onOpenChange={(o) => !o && setDeleting(null)}
        onDeleted={refresh}
      />
    </section>
  )
}
