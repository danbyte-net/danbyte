import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import type { QueryClient } from "@tanstack/react-query"
import { Copy, Pencil, Replace, Trash2, X } from "lucide-react"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
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
import { Field, FormCheckbox } from "@/components/forms"
import type { BulkFieldSpec } from "@/components/forms"
import { Input } from "@/components/ui/input"
import { BulkEditDialog } from "@/components/bulk-edit-dialog"
import { PendingLabel } from "@/components/pending-label"
import { apiErrorToast } from "@/lib/api-toast"
import {
  BatchFailure,
  IDS_PER_CALL,
  batchCount,
  batchStoppedToast,
  runBatches,
  sumOf,
} from "@/lib/bulk-batches"
import type { BatchProgress } from "@/lib/bulk-batches"
import { invalidatePortCounts } from "@/lib/port-utilization"

// Generic bulk bar for component tables (interfaces, ports, VM interfaces,
// device-type component templates). Tick rows → the bar floats up; Edit
// opens a KEEP/SET dialog where only explicitly chosen fields are sent to
// the viewset's bulk-update endpoint; Delete confirms then bulk-deletes.
// Edit and Delete send more rows than one call takes in batches (#286);
// rename and clone check names across the whole selection, so they take
// one call's worth at most.
//
//   <ComponentBulkBar
//     endpoint="/api/interfaces/"
//     kindLabel="interface"
//     selected={rows} onCleared={...} invalidate={[["device-interfaces"]]}
//     fields={[{ key: "type", label: "Type", kind: "text" }, ...]}
//     tags
//   />

// The spec union and the per-kind editor now live in @/components/forms
// (field-spec / field-editor) so single-object forms can render the same
// controls. Re-exported here because the component panes import the type
// alongside <ComponentBulkBar/>.
export type { BulkFieldSpec, DcimChoiceListKey } from "@/components/forms"
export { bulkFields } from "@/components/bulk-edit-dialog"

// Writes to these move port counts, so every count-showing query goes stale
// with them - whatever keys the caller passes in.
const PORT_ENDPOINTS = new Set([
  "/api/interfaces/",
  "/api/front-ports/",
  "/api/rear-ports/",
])

function refresh(
  qc: QueryClient,
  endpoint: string,
  invalidate: unknown[][]
): void {
  invalidate.forEach((k) => qc.invalidateQueries({ queryKey: k }))
  if (PORT_ENDPOINTS.has(endpoint)) invalidatePortCounts(qc)
}

export interface ComponentBulkBarProps {
  endpoint: string
  kindLabel: string
  selected: { id: string; name: string }[]
  onCleared: () => void
  /** Query keys to invalidate after a successful write. */
  invalidate: unknown[][]
  fields: BulkFieldSpec[]
  tags?: boolean
  /** Hide the delete button (e.g. read-only contexts). */
  canDelete?: boolean
  /** Hide rename / clone where the endpoint has no bulk-rename / bulk-clone. */
  rename?: boolean
  clone?: boolean
}

export function ComponentBulkBar({
  endpoint,
  kindLabel,
  selected,
  onCleared,
  invalidate,
  fields,
  tags = false,
  canDelete = true,
  rename = true,
  clone = true,
}: ComponentBulkBarProps) {
  const [editOpen, setEditOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [cloneOpen, setCloneOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const qc = useQueryClient()
  if (selected.length === 0) return null
  const ids = selected.map((r) => r.id)

  return (
    <>
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center">
        <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-border bg-popover px-2 py-1.5 text-popover-foreground shadow-lg">
          <span className="pl-2 text-xs font-medium">
            {selected.length} {kindLabel}
            {selected.length === 1 ? "" : "s"} selected
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
          {rename && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              onClick={() => setRenameOpen(true)}
            >
              <Replace className="mr-1 h-3 w-3" /> Rename
            </Button>
          )}
          {clone && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              onClick={() => setCloneOpen(true)}
            >
              <Copy className="mr-1 h-3 w-3" /> Clone
            </Button>
          )}
          {canDelete && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 text-destructive hover:text-destructive"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 className="mr-1 h-3 w-3" /> Delete
            </Button>
          )}
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

      {editOpen && (
        <BulkEditDialog
          endpoint={endpoint}
          noun={[kindLabel, `${kindLabel}s`]}
          ids={ids}
          fields={fields}
          tags={tags}
          invalidate={invalidate}
          afterWrite={() => refresh(qc, endpoint, [])}
          onClose={() => setEditOpen(false)}
          onDone={() => {
            setEditOpen(false)
            onCleared()
          }}
        />
      )}

      {renameOpen && (
        <RenameCloneDialog
          mode="rename"
          endpoint={endpoint}
          kindLabel={kindLabel}
          selected={selected}
          invalidate={invalidate}
          onClose={() => setRenameOpen(false)}
          onDone={() => {
            setRenameOpen(false)
            onCleared()
          }}
        />
      )}

      {cloneOpen && (
        <RenameCloneDialog
          mode="clone"
          endpoint={endpoint}
          kindLabel={kindLabel}
          selected={selected}
          invalidate={invalidate}
          onClose={() => setCloneOpen(false)}
          onDone={() => {
            setCloneOpen(false)
            onCleared()
          }}
        />
      )}

      <BulkDeleteDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        endpoint={endpoint}
        kindLabel={kindLabel}
        selected={selected}
        invalidate={invalidate}
        onDone={() => {
          setDeleteOpen(false)
          onCleared()
        }}
      />
    </>
  )
}

function BulkDeleteDialog({
  open,
  onOpenChange,
  endpoint,
  kindLabel,
  selected,
  invalidate,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  endpoint: string
  kindLabel: string
  selected: { id: string; name: string }[]
  invalidate: unknown[][]
  onDone: () => void
}) {
  const qc = useQueryClient()
  const ids = selected.map((r) => r.id)
  const [progress, setProgress] = useState<BatchProgress | null>(null)
  const del = useMutation({
    mutationFn: async () =>
      sumOf(
        await runBatches(
          ids,
          IDS_PER_CALL,
          (part) =>
            api<{ deleted: number }>(`${endpoint}bulk-delete/`, {
              method: "POST",
              body: JSON.stringify({ ids: part }),
            }),
          setProgress
        ),
        (r) => r.deleted
      ),
    onSuccess: (deleted) => {
      toast.success(`Deleted ${deleted}`)
      onDone()
    },
    onError: (e) => {
      if (!(e instanceof BatchFailure)) {
        apiErrorToast(e)
        return
      }
      // Some batches went through: say how many, and close. The rest stay
      // selected for another go.
      const went: { deleted: number }[] = e.results
      batchStoppedToast(
        `Deleted ${sumOf(went, (r) => r.deleted)} of ${ids.length} ${kindLabel}s.`,
        e
      )
      onOpenChange(false)
    },
    onSettled: () => refresh(qc, endpoint, invalidate),
  })
  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => {
        if (o || !del.isPending) onOpenChange(o)
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Delete {ids.length} {kindLabel}
            {ids.length === 1 ? "" : "s"}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {selected
              .slice(0, 5)
              .map((r) => r.name)
              .join(", ")}
            {selected.length > 5 ? ` … and ${selected.length - 5} more` : ""}.
            This can't be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={del.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={del.isPending}
            onClick={(e) => {
              e.preventDefault()
              del.mutate()
            }}
          >
            <PendingLabel
              label="Delete"
              verb="Deleting…"
              pending={del.isPending}
              progress={progress}
              batches={batchCount(ids.length, IDS_PER_CALL)}
            />
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// Bulk rename (find/replace, optional regex) or bulk clone (duplicate with a
// renamed copy) - one dialog for both. Shows a live
// before→after preview; the backend re-validates name collisions.
function RenameCloneDialog({
  mode,
  endpoint,
  kindLabel,
  selected,
  invalidate,
  onClose,
  onDone,
}: {
  mode: "rename" | "clone"
  endpoint: string
  kindLabel: string
  selected: { id: string; name: string }[]
  invalidate: unknown[][]
  onClose: () => void
  onDone: () => void
}) {
  const qc = useQueryClient()
  const [find, setFind] = useState("")
  const [replace, setReplace] = useState("")
  const [useRegex, setUseRegex] = useState(false)

  // Live preview - the backend runs Python's re.sub, so a replacement
  // written for it uses \g<1> / \1 backreferences. JavaScript wants $1, and
  // rendering the raw Python form made the preview lie (it showed the literal
  // "\g<1>" while the server produced the right name). Translate before
  // previewing so what's shown is what will be saved.
  // \g<1> and \1 are numbered → $1; \g<name> is named → $<name>.
  const jsReplacement = (r: string) =>
    r
      .replace(/\\g<(\w+)>/g, (_m, g) =>
        /^\d+$/.test(g) ? `$${g}` : `$<${g}>`
      )
      .replace(/\\(\d)/g, "$$$1")

  let regexError: string | null = null
  const preview = selected.map((r) => {
    let next = r.name
    if (find) {
      if (useRegex) {
        try {
          next = r.name.replace(new RegExp(find, "g"), jsReplacement(replace))
        } catch (e) {
          regexError = (e as Error).message
        }
      } else {
        next = r.name.split(find).join(replace)
      }
    } else if (mode === "clone") {
      next = `${r.name} copy`
    }
    return { id: r.id, old: r.name, next }
  })
  const changed = preview.filter((p) => p.next !== p.old).length
  // Clones must all differ; a rename with no find does nothing.
  const dupClone =
    mode === "clone" &&
    new Set(preview.map((p) => p.next)).size !== preview.length
  // The server checks every new name against the whole selection - a shift
  // or a swap only works in one call - and a second run would rename or
  // clone again. So no batches here: past one call's worth, say so (#286).
  const tooMany = selected.length > IDS_PER_CALL

  const run = useMutation({
    mutationFn: () =>
      api<{ renamed?: number; created?: number }>(`${endpoint}bulk-${mode}/`, {
        method: "POST",
        body: JSON.stringify({
          ids: selected.map((r) => r.id),
          find,
          replace,
          use_regex: useRegex,
        }),
      }),
    onSuccess: (r) => {
      refresh(qc, endpoint, invalidate)
      const n = r.renamed ?? r.created ?? 0
      toast.success(
        mode === "rename"
          ? `Renamed ${n} ${kindLabel}${n === 1 ? "" : "s"}`
          : `Cloned ${n} ${kindLabel}${n === 1 ? "" : "s"}`
      )
      onDone()
    },
    onError: (e) => apiErrorToast(e),
  })

  const canRun =
    !tooMany &&
    !regexError &&
    !dupClone &&
    (mode === "clone" || (!!find && changed > 0))

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-auto">
        <DialogHeader>
          <DialogTitle>
            {mode === "rename" ? "Rename" : "Clone"} {selected.length}{" "}
            {kindLabel}
            {selected.length === 1 ? "" : "s"}
          </DialogTitle>
        </DialogHeader>
        <p className="text-[12px] text-muted-foreground">
          {mode === "rename"
            ? "Find text in each name and replace it. Leave replace empty to strip the found text."
            : "Duplicate each selected row. Use find/replace to give the copies new names (e.g. 1/0/ → 2/0/); otherwise they get a “ copy” suffix."}
        </p>
        <div className="grid gap-3">
          <Field
            label="Find"
            hint={useRegex ? "Regular expression" : undefined}
          >
            <Input
              value={find}
              onChange={(e) => setFind(e.target.value)}
              placeholder={mode === "clone" ? "(optional)" : "text to find"}
              autoFocus
              className="font-mono text-[13px]"
            />
          </Field>
          <Field label="Replace with">
            <Input
              value={replace}
              onChange={(e) => setReplace(e.target.value)}
              placeholder="(empty)"
              className="font-mono text-[13px]"
            />
          </Field>
          <FormCheckbox
            label="Use a regular expression"
            checked={useRegex}
            onChange={setUseRegex}
          />
          {regexError && (
            <p className="text-[12px] text-destructive">
              Invalid regex: {regexError}
            </p>
          )}
          {dupClone && (
            <p className="text-[12px] text-destructive">
              Clones would share a name - add a find/replace so they differ.
            </p>
          )}
          {tooMany && (
            <p className="text-[12px] text-destructive">
              At most {IDS_PER_CALL} {kindLabel}s at a time.
            </p>
          )}
        </div>

        <div className="mt-1 rounded-md border border-border">
          <div className="border-b border-border px-3 py-1.5 text-[11px] font-medium text-muted-foreground">
            Preview {mode === "rename" ? `(${changed} will change)` : ""}
          </div>
          <ul className="max-h-52 divide-y divide-border overflow-auto">
            {preview.slice(0, 40).map((p) => (
              <li
                key={p.id}
                className="flex items-center gap-2 px-3 py-1 font-mono text-[12px]"
              >
                <span className="truncate text-muted-foreground">{p.old}</span>
                <span className="text-muted-foreground">→</span>
                <span
                  className={
                    p.next !== p.old
                      ? "truncate text-foreground"
                      : "truncate text-muted-foreground/60"
                  }
                >
                  {p.next}
                </span>
              </li>
            ))}
            {preview.length > 40 && (
              <li className="px-3 py-1 text-[11px] text-muted-foreground">
                …and {preview.length - 40} more
              </li>
            )}
          </ul>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => run.mutate()}
            disabled={!canRun || run.isPending}
          >
            {run.isPending
              ? mode === "rename"
                ? "Renaming…"
                : "Cloning…"
              : mode === "rename"
                ? `Rename ${changed}`
                : `Clone ${selected.length}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
