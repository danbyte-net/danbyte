import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
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
import {
  Field,
  FieldEditor,
  FormCheckbox,
  useFieldEditorOptions,
} from "@/components/forms"
import type { BulkFieldSpec } from "@/components/forms"
import { Input } from "@/components/ui/input"
import { TagMultiSelect } from "@/components/cells/tag-multi-select"
import { apiErrorToast } from "@/lib/api-toast"

// Generic bulk bar for component tables (interfaces, ports, VM interfaces,
// device-type component templates). Tick rows → the bar floats up; Edit
// opens a KEEP/SET dialog where only explicitly chosen fields are sent to
// the viewset's bulk-update endpoint; Delete confirms then bulk-deletes.
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
}: ComponentBulkBarProps) {
  const [editOpen, setEditOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [cloneOpen, setCloneOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
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
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2"
            onClick={() => setRenameOpen(true)}
          >
            <Replace className="mr-1 h-3 w-3" /> Rename
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 px-2"
            onClick={() => setCloneOpen(true)}
          >
            <Copy className="mr-1 h-3 w-3" /> Clone
          </Button>
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
          kindLabel={kindLabel}
          ids={ids}
          fields={fields}
          tags={tags}
          invalidate={invalidate}
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

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
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
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <BulkDeleteAction
              endpoint={endpoint}
              ids={ids}
              invalidate={invalidate}
              onDone={() => {
                setDeleteOpen(false)
                onCleared()
              }}
            />
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function BulkDeleteAction({
  endpoint,
  ids,
  invalidate,
  onDone,
}: {
  endpoint: string
  ids: string[]
  invalidate: unknown[][]
  onDone: () => void
}) {
  const qc = useQueryClient()
  const del = useMutation({
    mutationFn: () =>
      api<{ deleted: number }>(`${endpoint}bulk-delete/`, {
        method: "POST",
        body: JSON.stringify({ ids }),
      }),
    onSuccess: (r) => {
      invalidate.forEach((k) => qc.invalidateQueries({ queryKey: k }))
      toast.success(`Deleted ${r.deleted}`)
      onDone()
    },
    onError: (e) => apiErrorToast(e),
  })
  return (
    <AlertDialogAction
      variant="destructive"
      onClick={(e) => {
        e.preventDefault()
        del.mutate()
      }}
    >
      {del.isPending ? "Deleting…" : "Delete"}
    </AlertDialogAction>
  )
}

function BulkEditDialog({
  endpoint,
  kindLabel,
  ids,
  fields,
  tags,
  invalidate,
  onClose,
  onDone,
}: {
  endpoint: string
  kindLabel: string
  ids: string[]
  fields: BulkFieldSpec[]
  tags: boolean
  invalidate: unknown[][]
  onClose: () => void
  onDone: () => void
}) {
  const qc = useQueryClient()
  // Which fields the user chose to SET, and their values. Untouched = KEEP.
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [addTags, setAddTags] = useState<number[]>([])
  const [removeTags, setRemoveTags] = useState<number[]>([])
  const options = useFieldEditorOptions(fields, { tags })

  const save = useMutation({
    mutationFn: () => {
      const out: Record<string, unknown> = { ...values }
      if (addTags.length) out.add_tag_ids = addTags
      if (removeTags.length) out.remove_tag_ids = removeTags
      return api<{ updated: number }>(`${endpoint}bulk-update/`, {
        method: "POST",
        body: JSON.stringify({ ids, fields: out }),
      })
    },
    onSuccess: (r) => {
      invalidate.forEach((k) => qc.invalidateQueries({ queryKey: k }))
      toast.success(`Updated ${r.updated} ${kindLabel}s`)
      onDone()
    },
    onError: (e) => apiErrorToast(e),
  })

  const dirty =
    Object.keys(values).length > 0 ||
    addTags.length > 0 ||
    removeTags.length > 0

  const set = (key: string, v: unknown) =>
    setValues((prev) => ({ ...prev, [key]: v }))
  const unset = (key: string) =>
    setValues((prev) => {
      const next = { ...prev }
      delete next[key]
      return next
    })

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        size="lg"
        className="max-h-[85vh] overflow-auto sm:max-w-md"
      >
        <DialogHeader>
          <DialogTitle>
            Edit {ids.length} {kindLabel}
            {ids.length === 1 ? "" : "s"}
          </DialogTitle>
        </DialogHeader>
        <p className="text-[12px] text-muted-foreground">
          Fields left on <span className="font-medium">Keep</span> are
          untouched. Everything else is applied to every selected row.
        </p>
        <div className="grid gap-3">
          {fields.map((f) => (
            <FieldEditor
              key={f.key}
              spec={f}
              mode="keep"
              value={values[f.key]}
              onChange={(v) => set(f.key, v)}
              onClear={() => unset(f.key)}
              options={options}
            />
          ))}
          {tags && (
            <>
              <Field label="Add tags">
                <TagMultiSelect
                  options={options.tags}
                  value={addTags}
                  onChange={setAddTags}
                />
              </Field>
              <Field label="Remove tags">
                <TagMultiSelect
                  options={options.tags}
                  value={removeTags}
                  onChange={setRemoveTags}
                />
              </Field>
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => save.mutate()}
            disabled={!dirty || save.isPending}
          >
            {save.isPending ? "Applying…" : `Apply to ${ids.length}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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

  // Live preview - same literal/regex substitution the backend applies.
  let regexError: string | null = null
  const preview = selected.map((r) => {
    let next = r.name
    if (find) {
      if (useRegex) {
        try {
          next = r.name.replace(new RegExp(find, "g"), replace)
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
      invalidate.forEach((k) => qc.invalidateQueries({ queryKey: k }))
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
    !regexError && !dupClone && (mode === "clone" || (!!find && changed > 0))

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
