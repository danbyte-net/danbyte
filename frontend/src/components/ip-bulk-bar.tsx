import { useState } from "react"
import { BulkExport } from "@/components/bulk-export"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { Pencil, Play, Trash2, X } from "lucide-react"
import { toast } from "sonner"

import { api, type IPAddress } from "@/lib/api"
import { Button } from "@/components/ui/button"
import {
  CheckProgress,
  useCheckRun,
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

export interface IpBulkBarProps {
  selected: IPAddress[]
  onCleared: () => void
  /** Where Cancel returns to. Defaults to /ips. */
  returnTo?: string
}

export function IpBulkBar({ selected, onCleared, returnTo }: IpBulkBarProps) {
  const [deleteOpen, setDeleteOpen] = useState(false)
  const checkRun = useCheckRun()

  const checkNow = useMutation({
    mutationFn: (ipIds: string[]) =>
      api<{ targets: number; checks: number; run_id?: string }>(
        "/api/monitoring/bulk-check-now/",
        { method: "POST", body: JSON.stringify({ ip_ids: ipIds }) }
      ),
    onSuccess: (res) => {
      if (res.checks > 0) {
        toast.success(
          `Checking ${res.checks} check${res.checks === 1 ? "" : "s"} across ${res.targets} IP${res.targets === 1 ? "" : "s"}…`
        )
        if (res.run_id) checkRun.start(res.run_id)
      } else toast.info("No monitored checks on the selected IPs.")
    },
    onError: (err) => apiErrorToast(err),
  })

  if (selected.length === 0) return null
  const ids = selected.map((p) => p.id)
  const search = { ids: ids.join(","), returnTo }

  return (
    <>
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center lg:left-60">
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
          <Button size="sm" variant="ghost" className="h-7 px-2" asChild>
            <Link to="/ips/bulk-edit" search={search}>
              <Pencil className="mr-1 h-3 w-3" /> Edit
            </Link>
          </Button>
          <BulkExport ioType="ipaddress" ids={ids} />
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
        sample={selected.slice(0, 5).map((p) => p.ip_address)}
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
      api<{ deleted: number }>("/api/ips/bulk-delete/", {
        method: "POST",
        body: JSON.stringify({ ids }),
      }),
    onSuccess: (res) => {
      toast.success(`Deleted ${res.deleted} IP${res.deleted === 1 ? "" : "s"}.`)
      qc.invalidateQueries({ queryKey: ["prefix-ips"] })
      qc.invalidateQueries({ queryKey: ["ips"] })
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
            Delete {ids.length} IP{ids.length === 1 ? "" : "s"}?
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
