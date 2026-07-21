import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Pencil, Trash2, X } from "lucide-react"
import { toast } from "sonner"

import { api, type Paginated, type Tenant, type TenantGroup } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
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
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { apiErrorToast } from "@/lib/api-toast"

const SELECT_CLS =
  "h-9 w-full rounded-md border border-border bg-transparent px-3 text-sm"

export interface TenantBulkBarProps {
  selected: Tenant[]
  onCleared: () => void
}

export function TenantBulkBar({ selected, onCleared }: TenantBulkBarProps) {
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  if (selected.length === 0) return null
  const ids = selected.map((t) => t.id)
  return (
    <>
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center">
        <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border bg-popover px-2 py-1.5 text-popover-foreground shadow-lg">
          <span className="pl-2 text-xs font-medium text-foreground">
            {selected.length} selected
          </span>
          <span className="h-4 w-px bg-border" />
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2"
            onClick={() => setEditOpen(true)}
          >
            <Pencil className="mr-1 h-3 w-3" /> Edit
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2 text-destructive hover:text-destructive"
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 className="mr-1 h-3 w-3" /> Delete
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            onClick={onCleared}
            title="Clear selection"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      </div>

      <BulkEditDialog
        ids={ids}
        open={editOpen}
        onOpenChange={setEditOpen}
        onDone={onCleared}
      />
      <BulkDeleteConfirm
        selected={selected}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDone={onCleared}
      />
    </>
  )
}

function BulkEditDialog({
  ids,
  open,
  onOpenChange,
  onDone,
}: {
  ids: string[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const qc = useQueryClient()
  // "" = leave unchanged; "__none__" = clear the group.
  const [group, setGroup] = useState("")
  const [active, setActive] = useState("")

  const groupsQuery = useQuery({
    queryKey: ["tenant-groups"],
    queryFn: () => api<Paginated<TenantGroup>>("/api/tenant-groups/"),
    enabled: open,
  })
  const groups = groupsQuery.data?.results ?? []

  const m = useMutation({
    mutationFn: () => {
      const fields: Record<string, unknown> = {}
      if (group === "__none__") fields.group_id = null
      else if (group) fields.group_id = group
      if (active) fields.is_active = active === "active"
      return api<{ updated: number }>("/api/tenants/bulk-update/", {
        method: "POST",
        body: JSON.stringify({ ids, fields }),
      })
    },
    onSuccess: (res) => {
      toast.success(
        `Updated ${res.updated} tenant${res.updated === 1 ? "" : "s"}.`
      )
      qc.invalidateQueries({ queryKey: ["tenants"] })
      onOpenChange(false)
      onDone()
    },
    onError: (err) => apiErrorToast(err),
  })

  const nothing = !group && !active

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit {ids.length} tenants</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-1.5">
            <Label className="text-xs">Tenant group</Label>
            <select
              className={SELECT_CLS}
              value={group}
              onChange={(e) => setGroup(e.target.value)}
            >
              <option value="">Leave unchanged</option>
              <option value="__none__">No group (clear)</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs">Status</Label>
            <select
              className={SELECT_CLS}
              value={active}
              onChange={(e) => setActive(e.target.value)}
            >
              <option value="">Leave unchanged</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={nothing || m.isPending} onClick={() => m.mutate()}>
            {m.isPending ? "Saving…" : "Apply"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function BulkDeleteConfirm({
  selected,
  open,
  onOpenChange,
  onDone,
}: {
  selected: Tenant[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const qc = useQueryClient()
  const ids = selected.map((t) => t.id)
  const totalObjects = selected.reduce(
    (n, t) =>
      n +
      (t.site_count ?? 0) +
      (t.prefix_count ?? 0) +
      (t.vlan_count ?? 0) +
      (t.ip_count ?? 0),
    0
  )
  const m = useMutation({
    mutationFn: () =>
      api<{ deleted: number }>("/api/tenants/bulk-delete/", {
        method: "POST",
        body: JSON.stringify({ ids }),
      }),
    onSuccess: (res) => {
      toast.success(
        `Deleted ${res.deleted} tenant${res.deleted === 1 ? "" : "s"}.`
      )
      qc.invalidateQueries({ queryKey: ["tenants"] })
      qc.invalidateQueries({ queryKey: ["tenants-picker"] })
      onOpenChange(false)
      onDone()
    },
    onError: (err) => apiErrorToast(err),
  })

  const sample = selected.slice(0, 6).map((t) => t.name)
  const extra = Math.max(0, ids.length - sample.length)
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete {ids.length} tenant{ids.length === 1 ? "" : "s"}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This permanently deletes each tenant and{" "}
            <strong>everything it owns</strong>
            {totalObjects > 0
              ? ` — about ${totalObjects.toLocaleString()} sites/prefixes/VLANs/IPs plus all other records`
              : ""}
            . This can't be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="rounded-md bg-muted/40 px-3 py-2 text-xs text-foreground">
          {sample.map((s) => (
            <li key={s}>{s}</li>
          ))}
          {extra > 0 && (
            <li className="text-muted-foreground">…and {extra} more</li>
          )}
        </ul>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={m.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="text-destructive-foreground bg-destructive hover:bg-destructive/90"
            disabled={m.isPending}
            onClick={(e) => {
              e.preventDefault()
              m.mutate()
            }}
          >
            {m.isPending ? "Deleting…" : `Delete ${ids.length}`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
