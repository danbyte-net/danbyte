import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
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
import { toFieldSpec } from "@/lib/use-editable-fields"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldEditor, useFieldEditorOptions } from "@/components/forms"
import type { BulkFieldSpec, EditableFieldSpec } from "@/components/forms"
import { TagMultiSelect } from "@/components/cells/tag-multi-select"
import { Loading } from "@/components/loading"
import { PendingLabel } from "@/components/pending-label"
import { QueryError } from "@/components/query-error"

// The one bulk-edit dialog: KEEP/SET per field, only the fields the user set
// go to the list's `bulk-update/`, more rows than one call takes go in
// batches (#286). The component tables hand it their own field list; the
// lists whose viewset declares a BulkEditSpec (#314) let the server name the
// fields through `bulk-edit-fields/` (ServerBulkEditDialog).

/** The fields a bulk edit sends: what was set, with a choice that stands for
 * several fields (`expand`) replaced by those fields. */
export function bulkFields(
  values: Record<string, unknown>,
  fields: BulkFieldSpec[]
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values)) {
    const spec = fields.find((f) => f.key === key)
    if (spec?.kind === "options" && spec.expand && value != null)
      Object.assign(out, spec.expand(String(value)))
    else out[key] = value
  }
  return out
}

const plural = (n: number, [one, many]: [string, string]) =>
  `${n} ${n === 1 ? one : many}`

export interface BulkEditDialogProps {
  /** The list endpoint, e.g. "/api/interfaces/"; `bulk-update/` is appended. */
  endpoint: string
  /** ["interface", "interfaces"] */
  noun: [string, string]
  ids: string[]
  fields: BulkFieldSpec[]
  tags: boolean
  /** Query keys to invalidate after a write. */
  invalidate: unknown[][]
  /** Anything else a write makes stale (port counts). */
  afterWrite?: () => void
  onClose: () => void
  onDone: () => void
}

type FormProps = BulkEditDialogProps & { onBusy: (busy: boolean) => void }

export function BulkEditDialog({
  endpoint,
  noun,
  ids,
  fields,
  tags,
  invalidate,
  afterWrite,
  onClose,
  onDone,
}: BulkEditDialogProps) {
  const [busy, setBusy] = useState(false)
  return (
    <Shell ids={ids} noun={noun} busy={busy} onClose={onClose}>
      <EditForm
        endpoint={endpoint}
        noun={noun}
        ids={ids}
        fields={fields}
        tags={tags}
        invalidate={invalidate}
        afterWrite={afterWrite}
        onClose={onClose}
        onDone={onDone}
        onBusy={setBusy}
      />
    </Shell>
  )
}

/** The dialog for a list whose server declares its bulk-edit fields: reads
 * `<endpoint>bulk-edit-fields/` and renders them. */
export function ServerBulkEditDialog(
  props: Omit<BulkEditDialogProps, "fields" | "tags">
) {
  const [busy, setBusy] = useState(false)
  const q = useQuery({
    queryKey: ["bulk-edit-fields", props.endpoint],
    queryFn: () =>
      api<{ fields: EditableFieldSpec[]; tags: boolean }>(
        `${props.endpoint}bulk-edit-fields/`
      ),
    staleTime: 60 * 60_000,
  })
  const fields = (q.data?.fields ?? [])
    .map(toFieldSpec)
    .filter((f): f is BulkFieldSpec => !!f)
  return (
    <Shell ids={props.ids} noun={props.noun} busy={busy} onClose={props.onClose}>
      {q.isError ? (
        <QueryError error={q.error} />
      ) : !q.data ? (
        <Loading className="min-h-24" />
      ) : (
        <EditForm
          {...props}
          fields={fields}
          tags={q.data.tags}
          onBusy={setBusy}
        />
      )}
    </Shell>
  )
}

function Shell({
  ids,
  noun,
  busy,
  onClose,
  children,
}: {
  ids: string[]
  noun: [string, string]
  /** A save is running: the dialog stays open until it settles. */
  busy: boolean
  onClose: () => void
  children: React.ReactNode
}) {
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent size="lg" className="max-h-[85vh] overflow-auto">
        <DialogHeader>
          <DialogTitle>Edit {plural(ids.length, noun)}</DialogTitle>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  )
}

function EditForm({
  endpoint,
  noun,
  ids,
  fields,
  tags,
  invalidate,
  afterWrite,
  onClose,
  onDone,
  onBusy,
}: FormProps) {
  const qc = useQueryClient()
  // Which fields the user chose to SET, and their values. Untouched = KEEP.
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [addTags, setAddTags] = useState<number[]>([])
  const [removeTags, setRemoveTags] = useState<number[]>([])
  const [progress, setProgress] = useState<BatchProgress | null>(null)
  const options = useFieldEditorOptions(fields, { tags })

  const save = useMutation({
    mutationFn: async () => {
      const out = bulkFields(values, fields)
      if (addTags.length) out.add_tag_ids = addTags
      if (removeTags.length) out.remove_tag_ids = removeTags
      const answers = await runBatches(
        ids,
        IDS_PER_CALL,
        (part) =>
          api<{ updated: number }>(`${endpoint}bulk-update/`, {
            method: "POST",
            body: JSON.stringify({ ids: part, fields: out }),
          }),
        setProgress
      )
      return sumOf(answers, (r) => r.updated)
    },
    onSuccess: (updated) => {
      toast.success(`Updated ${plural(updated, noun)}`)
      onDone()
    },
    onError: (e) => {
      if (!(e instanceof BatchFailure)) {
        apiErrorToast(e)
        return
      }
      // Some batches went through: say how many. The dialog stays open with
      // its fields - applying the same edit again is harmless.
      const went: { updated: number }[] = e.results
      batchStoppedToast(
        `Updated ${sumOf(went, (r) => r.updated)} of ${plural(ids.length, noun)}.`,
        e
      )
    },
    onSettled: () => {
      invalidate.forEach((k) => qc.invalidateQueries({ queryKey: k }))
      afterWrite?.()
    },
  })

  const pending = save.isPending
  useEffect(() => onBusy(pending), [onBusy, pending])

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
    <>
      <p className="text-[12px] text-muted-foreground">
        Fields left on <span className="font-medium">Keep</span> are untouched.
        Everything else is applied to every selected row.
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
        <Button variant="outline" onClick={onClose} disabled={save.isPending}>
          Cancel
        </Button>
        <Button onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
          <PendingLabel
            label={`Apply to ${ids.length}`}
            verb="Applying…"
            pending={save.isPending}
            progress={progress}
            batches={batchCount(ids.length, IDS_PER_CALL)}
          />
        </Button>
      </DialogFooter>
    </>
  )
}
