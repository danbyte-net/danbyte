import { BulkExport } from "@/components/bulk-export"
import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Pencil, Play, ScanSearch, Trash2, X } from "lucide-react"
import { toast } from "sonner"

import { api, type Prefix } from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import {
  CheckProgress,
  DiscoverProgress,
  useCheckRun,
  useDiscoveryRun,
} from "@/components/monitoring/auto-discover-button"
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
import { apiErrorToast } from "@/lib/api-toast"

// Floating action bar that sits at the bottom of /prefixes whenever the
// user has selected rows. Edit is a Link to /prefixes/bulk-edit (real
// page, not a modal). Bulk delete stays inline as AlertDialog.

export interface PrefixBulkBarProps {
  selected: Prefix[]
  onCleared: () => void
}

export function PrefixBulkBar({ selected, onCleared }: PrefixBulkBarProps) {
  const [deleteOpen, setDeleteOpen] = useState(false)
  const qc = useQueryClient()
  const checkRun = useCheckRun()
  const discoverRun = useDiscoveryRun()

  const checkNow = useMutation({
    mutationFn: (prefixIds: string[]) =>
      api<{ targets: number; checks: number; run_id?: string }>(
        "/api/monitoring/bulk-check-now/",
        { method: "POST", body: JSON.stringify({ prefix_ids: prefixIds }) }
      ),
    onSuccess: (res) => {
      if (res.checks > 0) {
        toast.success(
          `Checking ${res.checks} check${res.checks === 1 ? "" : "s"} across ${res.targets} IP${res.targets === 1 ? "" : "s"}…`
        )
        if (res.run_id) checkRun.start(res.run_id)
      } else toast.info("No monitoring checks on the selected prefixes.")
    },
    onError: (err) => apiErrorToast(err),
  })

  // Fan the selected prefixes out under one progress run.
  const discoverNow = useMutation({
    mutationFn: (prefixIds: string[]) =>
      api<{
        queued: boolean
        run_id?: string
        scanned: number
        shards: number
        skipped: number
        prefixes?: number
      }>("/api/monitoring/bulk-discover/", {
        method: "POST",
        body: JSON.stringify({ prefix_ids: prefixIds }),
      }),
    onSuccess: (res) => {
      if (!res.queued || !res.run_id) {
        toast.warning(
          `Nothing to sweep${res.skipped ? ` — ${res.skipped} skipped (too large to enumerate)` : ""}.`
        )
        return
      }
      const parts = [
        `Sweeping ${res.scanned.toLocaleString()} hosts across ${res.prefixes} prefix${res.prefixes === 1 ? "" : "es"} in the background`,
      ]
      if (res.skipped) parts.push(`${res.skipped} skipped`)
      toast.success(parts.join(" · ") + ".")
      discoverRun.start(res.run_id)
    },
    onError: (err) => apiErrorToast(err),
  })

  // Smart toggle: if every selected prefix already has auto-discover on, turn
  // them off; otherwise enable it on all of them.
  const allOn = selected.length > 0 && selected.every((p) => p.auto_discover)
  const autoDiscover = useMutation({
    mutationFn: (next: boolean) =>
      Promise.all(
        selected.map((p) =>
          api(`/api/prefixes/${p.id}/`, {
            method: "PATCH",
            body: JSON.stringify({ auto_discover: next }),
          })
        )
      ),
    onSuccess: (_d, next) => {
      toast.success(
        `Auto-discovery ${next ? "enabled" : "disabled"} on ${selected.length} prefix${selected.length === 1 ? "" : "es"}.`
      )
      qc.invalidateQueries({ queryKey: ["prefixes"] })
    },
    onError: (err) => apiErrorToast(err),
  })

  if (selected.length === 0) return null
  const ids = selected.map((p) => p.id)

  return (
    <>
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center">
        <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border bg-popover px-2 py-1.5 text-popover-foreground shadow-lg">
          <span className="pl-2 text-xs font-medium text-foreground">
            {selected.length} selected
          </span>
          <span className="h-4 w-px bg-border" />
          {checkRun.run ? (
            <CheckProgress run={checkRun.run} dense />
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              disabled={checkNow.isPending}
              onClick={() => checkNow.mutate(ids)}
            >
              <Play className="mr-1 h-3 w-3" />
              {checkNow.isPending ? "Checking…" : "Check now"}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2"
            disabled={autoDiscover.isPending}
            onClick={() => autoDiscover.mutate(!allOn)}
            title="Toggle periodic ICMP discovery on the selected prefixes (needs discovery enabled in Monitoring settings)."
          >
            {autoDiscover.isPending ? (
              <Spinner className="mr-1 h-3 w-3" />
            ) : (
              <ScanSearch className="mr-1 h-3 w-3" />
            )}
            {allOn ? "Auto-discover: Off" : "Auto-discover: On"}
          </Button>
          {discoverRun.run ? (
            <DiscoverProgress run={discoverRun.run} dense />
          ) : (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              disabled={discoverNow.isPending}
              onClick={() => discoverNow.mutate(ids)}
              title="ICMP-sweep the selected prefixes now and create IPs for new responders"
            >
              <ScanSearch className="mr-1 h-3 w-3" />
              {discoverNow.isPending ? "Scanning…" : "Discover now"}
            </Button>
          )}
          <Button size="sm" variant="ghost" className="h-7 px-2" asChild>
            <Link to="/prefixes/bulk-edit" search={{ ids: ids.join(",") }}>
              <Pencil className="mr-1 h-3 w-3" /> Edit
            </Link>
          </Button>
          <BulkExport ioType="prefix" ids={ids} />
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

      <BulkDeleteConfirm
        ids={ids}
        sample={selected.slice(0, 5).map((p) => p.cidr)}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onDone={onCleared}
      />
    </>
  )
}

function BulkDeleteConfirm({
  ids,
  sample,
  open,
  onOpenChange,
  onDone,
}: {
  ids: string[]
  sample: string[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => void
}) {
  const qc = useQueryClient()
  const m = useMutation({
    mutationFn: () =>
      api<{ deleted: number }>("/api/prefixes/bulk-delete/", {
        method: "POST",
        body: JSON.stringify({ ids }),
      }),
    onSuccess: (res) => {
      toast.success(
        `Deleted ${res.deleted} prefix${res.deleted === 1 ? "" : "es"}.`
      )
      qc.invalidateQueries({ queryKey: ["prefixes"] })
      qc.invalidateQueries({ queryKey: ["prefix-space-map"] })
      onOpenChange(false)
      onDone()
    },
    onError: (err) => apiErrorToast(err),
  })

  const extra = Math.max(0, ids.length - sample.length)

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete {ids.length} prefix{ids.length === 1 ? "" : "es"}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This action can't be undone. The following will be removed:
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="rounded-md bg-muted/40 px-3 py-2 font-mono text-xs text-foreground">
          {sample.map((c) => (
            <li key={c}>{c}</li>
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
