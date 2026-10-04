import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { Trash2, X } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { apiErrorToast } from "@/lib/api-toast"
import {
  BatchFailure,
  IDS_PER_CALL,
  askInBatches,
  batchCount,
  batchStoppedToast,
  runBatches,
  sumCounts,
  sumOf,
} from "@/lib/bulk-batches"
import type { BatchProgress } from "@/lib/bulk-batches"
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
import { Loading } from "@/components/loading"
import { PendingLabel } from "@/components/pending-label"

/** What a `bulk-delete` endpoint built on the backend's SafeBulkDeleteMixin
 * answers - for a dry run as for the real thing. */
export interface SafeBulkDeleteResult {
  deleted: number
  deleted_ids: string[]
  skipped: { id: string; name: string; reason: string }[]
  impact: { label: string; count: number }[]
  /** What the rows let go of but keep, such as a stack's member devices. */
  released?: { label: string; count: number }[]
  dry_run: boolean
}

export interface SafeBulkDeleteBarProps<T extends { id: string }> {
  selected: T[]
  /** The list endpoint, e.g. "/api/circuits/"; `bulk-delete/` is appended. */
  endpoint: string
  /** ["circuit", "circuits"] */
  noun: [string, string]
  /** Query key prefixes to refresh after a delete. */
  invalidate: string[][]
  onCleared: () => void
  /** More of the bar's actions, before Delete - an Edit link. */
  actions?: React.ReactNode
  /** Offer Delete (default true). */
  canDelete?: boolean
}

const plural = (n: number, [one, many]: [string, string]) =>
  `${n} ${n === 1 ? one : many}`

/** Several answers as one, for a selection sent in batches: the rows and
 * what goes with them added up, and every batch's kept rows. */
export function mergeDeleteAnswers(
  answers: SafeBulkDeleteResult[]
): SafeBulkDeleteResult {
  return {
    deleted: sumOf(answers, (a) => a.deleted),
    deleted_ids: answers.flatMap((a) => a.deleted_ids),
    skipped: answers.flatMap((a) => a.skipped),
    impact: sumCounts(answers.map((a) => a.impact)),
    released: sumCounts(answers.map((a) => a.released ?? [])),
    dry_run: answers.every((a) => a.dry_run),
  }
}

/**
 * The selection bar for lists whose rows may be in use. Delete first asks the
 * server what would happen (a dry run): which rows go, what goes with them,
 * and which are skipped because something still uses them - then deletes
 * only the free ones. Nothing is removed halfway without the user seeing it.
 * More rows than one call takes go in batches, the dry run and the delete
 * alike (#286); a batch that fails stops the delete, and the toast says how
 * far it got.
 */
export function SafeBulkDeleteBar<T extends { id: string }>({
  selected,
  endpoint,
  noun,
  invalidate,
  onCleared,
  actions,
  canDelete = true,
}: SafeBulkDeleteBarProps<T>) {
  const [open, setOpen] = useState(false)
  if (selected.length === 0) return null
  return (
    <>
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center">
        <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border bg-popover px-2 py-1.5 text-popover-foreground shadow-lg">
          <span className="pl-2 text-xs font-medium text-foreground">
            {selected.length} selected
          </span>
          <span className="h-4 w-px bg-border" />
          {actions}
          {canDelete && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-destructive hover:text-destructive"
              onClick={() => setOpen(true)}
            >
              <Trash2 className="mr-1 h-3 w-3" /> Delete
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            onClick={onCleared}
            aria-label="Clear selection"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      </div>
      {open && (
        <SafeBulkDeleteDialog
          ids={selected.map((r) => r.id)}
          endpoint={endpoint}
          noun={noun}
          invalidate={invalidate}
          onClose={() => setOpen(false)}
          onDone={onCleared}
        />
      )}
    </>
  )
}

function SafeBulkDeleteDialog({
  ids,
  endpoint,
  noun,
  invalidate,
  onClose,
  onDone,
}: {
  ids: string[]
  endpoint: string
  noun: [string, string]
  invalidate: string[][]
  onClose: () => void
  onDone: () => void
}) {
  const qc = useQueryClient()
  const url = `${endpoint}bulk-delete/`
  const [progress, setProgress] = useState<BatchProgress | null>(null)
  const send = (part: string[], dryRun: boolean) =>
    api<SafeBulkDeleteResult>(url, {
      method: "POST",
      body: JSON.stringify(
        dryRun ? { ids: part, dry_run: true } : { ids: part }
      ),
    })
  const preview = useMutation({
    mutationFn: async () =>
      mergeDeleteAnswers(
        await askInBatches(ids, IDS_PER_CALL, (part) => send(part, true))
      ),
    onError: (err) => {
      apiErrorToast(err)
      onClose()
    },
  })
  const run = useMutation({
    mutationFn: async () =>
      mergeDeleteAnswers(
        await runBatches(
          ids,
          IDS_PER_CALL,
          (part) => send(part, false),
          setProgress
        )
      ),
    onSuccess: (res) => {
      const skipped = res.skipped.length
      toast.success(
        `Deleted ${plural(res.deleted, noun)}.` +
          (skipped ? ` ${skipped} still in use, kept.` : "")
      )
      onClose()
      onDone()
    },
    onError: (err) => {
      if (!(err instanceof BatchFailure)) {
        apiErrorToast(err)
        return
      }
      // Some batches went through: say how many rows went, and close. The
      // rest stay selected for another go.
      const went: SafeBulkDeleteResult[] = err.results
      batchStoppedToast(
        `Deleted ${sumOf(went, (r) => r.deleted)} of ${plural(ids.length, noun)}.`,
        err
      )
      onClose()
    },
    onSettled: () => {
      for (const key of invalidate) qc.invalidateQueries({ queryKey: key })
    },
  })
  const { mutate: ask } = preview
  useEffect(() => {
    ask()
  }, [ask])

  const p = preview.data
  const free = p?.deleted ?? 0
  return (
    <AlertDialog open onOpenChange={(o) => !o && !run.isPending && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete {plural(ids.length, noun)}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            This can&apos;t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {!p ? (
          <Loading className="min-h-16" />
        ) : (
          <div className="space-y-3 text-xs">
            <p className="text-foreground">
              {free
                ? `${plural(free, noun)} will be deleted.`
                : "Nothing can be deleted."}
            </p>
            {p.impact.length > 0 && (
              <div>
                <p className="mb-1 text-muted-foreground">Removed with them</p>
                <ul className="rounded-md bg-muted/40 px-3 py-2 text-foreground">
                  {p.impact.map((i) => (
                    <li key={i.label}>
                      {i.count} {i.label}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {!!p.released?.length && (
              <div>
                <p className="mb-1 text-muted-foreground">Released, kept</p>
                <ul className="rounded-md bg-muted/40 px-3 py-2 text-foreground">
                  {p.released.map((i) => (
                    <li key={i.label}>
                      {i.count} {i.label}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {p.skipped.length > 0 && (
              <div>
                <p className="mb-1 text-muted-foreground">Kept, still in use</p>
                <ul className="max-h-40 overflow-y-auto rounded-md bg-muted/40 px-3 py-2 text-foreground">
                  {p.skipped.map((s) => (
                    <li key={s.id}>
                      <span className="font-medium">{s.name}</span>{" "}
                      <span className="text-muted-foreground">{s.reason}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={run.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={!p || free === 0 || run.isPending}
            onClick={(e) => {
              e.preventDefault()
              run.mutate()
            }}
          >
            <PendingLabel
              label={`Delete ${free || ""}`.trim()}
              verb="Deleting…"
              pending={run.isPending}
              progress={progress}
              batches={batchCount(ids.length, IDS_PER_CALL)}
            />
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
