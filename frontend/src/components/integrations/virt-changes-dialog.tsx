import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type ColumnDef } from "@tanstack/react-table"
import { toast } from "sonner"

import {
  api,
  type Paginated,
  type VirtChange,
  type VirtualizationSource,
} from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { InfoTip } from "@/components/ui/info-tip"
import { DataTable } from "@/components/data-table"
import { EmptyState } from "@/components/empty-state"

const KIND_VARIANT: Record<
  VirtChange["kind"],
  "default" | "secondary" | "destructive"
> = {
  new_guest: "default",
  spec_change: "secondary",
  removed_guest: "destructive",
  iface_extra: "secondary",
  iface_change: "secondary",
}

/** What accepting each kind DOES, in Danbyte - "Accept" alone hides whether
 * a row is written, created or deleted. Nothing here ever touches the
 * hypervisor: the integration only reads from it. */
const ACCEPT_LABEL: Record<VirtChange["kind"], string> = {
  new_guest: "Add VM",
  spec_change: "Take specs",
  removed_guest: "Delete VM",
  iface_extra: "Delete interface",
  iface_change: "Take values",
}
const DESTRUCTIVE: VirtChange["kind"][] = ["removed_guest", "iface_extra"]

// Interface fields as they appear in an iface_change payload.
const IFACE_LABELS: Record<string, string> = {
  mac_address: "MAC",
  mtu: "MTU",
  vlan_vid: "VLAN",
}

// Spec fields as they appear in change payloads, with display labels and
// value formatting (RAM in GB when it divides cleanly, disk in GB).
const SPEC_FIELDS: {
  key: string
  label: string
  fmt: (v: unknown) => string
}[] = [
  { key: "vcpus", label: "vCPU", fmt: (v) => String(v) },
  {
    key: "memory_mb",
    label: "RAM",
    fmt: (v) => {
      const mb = Number(v)
      return mb >= 1024 && mb % 1024 === 0 ? `${mb / 1024} GB` : `${mb} MB`
    },
  },
  { key: "disk_gb", label: "Disk", fmt: (v) => `${v} GB` },
]

/** One labeled spec value, e.g. "RAM · 32 GB" or "RAM · 2 GB → 32 GB". */
function SpecChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] whitespace-nowrap">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono">{value}</span>
    </span>
  )
}

/** Structured "What changes" cell: the affected spec columns as chips. */
function ChangeDetail({ c }: { c: VirtChange }) {
  if (c.kind === "removed_guest") {
    return (
      <span className="text-xs text-muted-foreground">
        Removes the synced VM
      </span>
    )
  }
  if (c.kind === "new_guest") {
    const d = c.detail as Record<string, unknown>
    const chips = SPEC_FIELDS.filter((f) => d[f.key] != null).map((f) => (
      <SpecChip key={f.key} label={f.label} value={f.fmt(d[f.key])} />
    ))
    return (
      <span className="flex flex-wrap items-center gap-1">
        {chips.length ? chips : <span className="text-xs">Create VM</span>}
      </span>
    )
  }
  if (c.kind === "iface_extra") {
    // {names: [...]}. Without this the generic branch below rendered it as
    // "names · undefined → undefined".
    const names = (c.detail as { names?: string[] }).names ?? []
    return (
      <span className="flex flex-wrap items-center gap-1">
        {names.map((n) => (
          <SpecChip key={n} label="Not on hypervisor" value={n} />
        ))}
      </span>
    )
  }
  if (c.kind === "iface_change") {
    // {interfaces: {name: {field: {danbyte, hypervisor}}}}
    const ifaces =
      (
        c.detail as {
          interfaces?: Record<
            string,
            Record<string, { danbyte: unknown; hypervisor: unknown }>
          >
        }
      ).interfaces ?? {}
    return (
      <span className="flex flex-wrap items-center gap-1">
        {Object.entries(ifaces).flatMap(([name, fields]) =>
          Object.entries(fields).map(([key, v]) => (
            <SpecChip
              key={`${name}.${key}`}
              label={`${name} ${IFACE_LABELS[key] ?? key}`}
              value={`${v.danbyte ?? "-"} → ${v.hypervisor ?? "-"}`}
            />
          ))
        )}
      </span>
    )
  }
  // spec_change: {field: {danbyte, hypervisor}} - old → new per column.
  const diffs = c.detail as Record<
    string,
    { danbyte: unknown; hypervisor: unknown }
  >
  return (
    <span className="flex flex-wrap items-center gap-1">
      {Object.entries(diffs).map(([key, v]) => {
        const f = SPEC_FIELDS.find((s) => s.key === key)
        const fmt = f?.fmt ?? ((x: unknown) => String(x))
        return (
          <SpecChip
            key={key}
            label={f?.label ?? key}
            value={`${fmt(v.danbyte)} → ${fmt(v.hypervisor)}`}
          />
        )
      })}
    </span>
  )
}

/** The review inbox for one virtualization source. Rendered inline on the
 * source's own page and inside {@link VirtChangesDialog} from the list. */
export function VirtChangesPanel({ source }: { source: VirtualizationSource }) {
  const [confirm, setConfirm] = useState<VirtChange | null>(null)
  const qc = useQueryClient()
  const query = useQuery({
    queryKey: ["virt-changes", source.id],
    queryFn: () =>
      api<Paginated<VirtChange>>(
        `/api/virt-changes/?source=${source.id}&page_size=500`
      ),
  })
  const rows = query.data?.results ?? []

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["virt-changes"] })
    qc.invalidateQueries({ queryKey: ["virtualization-sources"] })
  }

  const resolve = useMutation({
    mutationFn: ({
      c,
      action,
    }: {
      c: VirtChange
      action: "accept" | "ignore"
    }) =>
      api(`/api/virt-changes/${c.id}/${action}/`, {
        method: "POST",
        body: "{}",
      }),
    onSuccess: (_, { action }) => {
      toast.success(action === "accept" ? "Change applied" : "Change ignored")
      invalidate()
    },
    onError: (e) => apiErrorToast(e),
  })

  const columns = useMemo<ColumnDef<VirtChange>[]>(
    () => [
      {
        id: "vm",
        header: "VM",
        enableSorting: false,
        cell: ({ row }) => (
          <span className="font-medium">
            {row.original.vm_name || `vmid ${row.original.vmid}`}
            <span className="ml-2 font-mono text-[11px] text-muted-foreground">
              {row.original.vmid}
              {row.original.node ? ` · ${row.original.node}` : ""}
            </span>
          </span>
        ),
      },
      {
        id: "kind",
        header: "Change",
        enableSorting: false,
        cell: ({ row }) => (
          <Badge
            variant={KIND_VARIANT[row.original.kind]}
            className="text-[10px]"
          >
            {row.original.kind_display}
          </Badge>
        ),
      },
      {
        id: "detail",
        header: "What changes",
        enableSorting: false,
        cell: ({ row }) => <ChangeDetail c={row.original} />,
      },
      {
        id: "actions",
        enableHiding: false,
        cell: ({ row }) => (
          <span className="flex justify-end gap-1">
            <Button
              size="sm"
              variant={
                DESTRUCTIVE.includes(row.original.kind)
                  ? "destructive"
                  : "default"
              }
              className="h-7 px-2 text-xs"
              disabled={resolve.isPending}
              onClick={() => {
                // Deleting inventory a person entered deserves a beat.
                if (DESTRUCTIVE.includes(row.original.kind)) {
                  setConfirm(row.original)
                  return
                }
                resolve.mutate({ c: row.original, action: "accept" })
              }}
            >
              {ACCEPT_LABEL[row.original.kind]}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-xs"
              disabled={resolve.isPending}
              onClick={() =>
                resolve.mutate({ c: row.original, action: "ignore" })
              }
            >
              Ignore
            </Button>
          </span>
        ),
      },
    ],
    [resolve]
  )

  return (
    <>
      {query.data && rows.length === 0 ? (
        <EmptyState title="Nothing to review.">
          The inventory matches the hypervisor. New VMs, spec changes and
          removals will appear here after the next sync.
        </EmptyState>
      ) : (
        <DataTable
          data={rows}
          columns={columns}
          tableId="virt-changes"
          flexColumn="detail"
        />
      )}
      <AlertDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm?.kind === "removed_guest"
                ? `Delete ${confirm?.vm_name || "this VM"} from Danbyte?`
                : "Delete these interfaces from Danbyte?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm?.kind === "removed_guest"
                ? "The hypervisor no longer has this VM. Its Danbyte record and everything hanging off it goes."
                : "The hypervisor doesn't report these interfaces, so accepting removes the Danbyte rows - including anything cabled or addressed on them."}{" "}
              Nothing on the hypervisor is touched either way.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(e) => {
                e.preventDefault()
                if (confirm) resolve.mutate({ c: confirm, action: "accept" })
                setConfirm(null)
              }}
            >
              Delete in Danbyte
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/** The same inbox as a modal, opened from the sources list. */
export function VirtChangesDialog({
  source,
  onOpenChange,
}: {
  source: VirtualizationSource
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent size="6xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            Pending changes - {source.name}
            <InfoTip>
              Danbyte only ever READS from a hypervisor - nothing here can
              change anything on {source.name}. This source is in{" "}
              {source.sync_mode} mode, so nothing is applied until you accept
              it, and accepting writes to the Danbyte inventory only. Ignore
              hides a row until it changes again.
            </InfoTip>
          </DialogTitle>
        </DialogHeader>
        <VirtChangesPanel source={source} />
      </DialogContent>
    </Dialog>
  )
}
