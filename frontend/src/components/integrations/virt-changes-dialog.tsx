import { useMemo } from "react"
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
}

/** Summarise a change's detail for the table's "What changes" column. */
function summarise(c: VirtChange): string {
  if (c.kind === "new_guest") {
    const d = c.detail as { vcpus?: number; memory_mb?: number }
    return `Create VM${d.vcpus ? ` — ${d.vcpus} vCPU` : ""}${
      d.memory_mb ? `, ${d.memory_mb} MB` : ""
    }`
  }
  if (c.kind === "removed_guest") return "Delete the synced VM"
  // spec_change: {field: {danbyte, hypervisor}}
  return Object.entries(
    c.detail as Record<string, { danbyte: unknown; hypervisor: unknown }>
  )
    .map(([f, v]) => `${f}: ${String(v.danbyte)} → ${String(v.hypervisor)}`)
    .join(", ")
}

/** The review inbox for one virtualization source — accept applies a change,
 * ignore dismisses it until it changes again. */
export function VirtChangesDialog({
  source,
  onOpenChange,
}: {
  source: VirtualizationSource
  onOpenChange: (open: boolean) => void
}) {
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
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">
            {summarise(row.original)}
          </span>
        ),
      },
      {
        id: "actions",
        enableHiding: false,
        cell: ({ row }) => (
          <span className="flex justify-end gap-1">
            <Button
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={resolve.isPending}
              onClick={() =>
                resolve.mutate({ c: row.original, action: "accept" })
              }
            >
              Accept
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
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent size="2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            Pending changes — {source.name}
            <InfoTip>
              This source is in {source.sync_mode} mode, so nothing is applied
              until you accept it. Accept writes the change to the inventory;
              ignore hides it until it changes again.
            </InfoTip>
          </DialogTitle>
        </DialogHeader>
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
      </DialogContent>
    </Dialog>
  )
}
