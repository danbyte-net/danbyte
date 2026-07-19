import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Pencil, Trash2, X } from "lucide-react"
import { toast } from "sonner"

import {
  api,
  type DcimChoice,
  type DcimChoices,
  type Paginated,
  type TagOption,
} from "@/lib/api"
import { useDcimChoices } from "@/lib/use-dcim-choices"
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
import { Field, FormCombobox, FormSelect } from "@/components/forms"
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

/** Keys of `/api/dcim/choices/` that hold a selectable option list. */
export type DcimChoiceListKey = {
  [K in keyof DcimChoices]: DcimChoices[K] extends DcimChoice[] ? K : never
}[keyof DcimChoices]

// A union, not a flat interface: `choices` is required when kind is "choice",
// so a choice-backed field can't be declared without saying where its options
// come from (which is how they used to silently render as text boxes).
export type BulkFieldSpec =
  | {
      key: string
      label: string
      kind: "text" | "int" | "bool" | "vlan" | "vrf"
      hint?: string
    }
  | {
      key: string
      label: string
      kind: "choice"
      /** Which `/api/dcim/choices/` list populates the dropdown. */
      choices: DcimChoiceListKey
      hint?: string
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
}

const KEEP = "__keep__"
const NONE = "__none__"

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
      className="bg-destructive text-white hover:bg-destructive/90"
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
  const dcimChoices = useDcimChoices()
  // Which fields the user chose to SET, and their values. Untouched = KEEP.
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [addTags, setAddTags] = useState<number[]>([])
  const [removeTags, setRemoveTags] = useState<number[]>([])

  const tagOptions = useQuery({
    queryKey: ["tags-picker"],
    queryFn: () => api<Paginated<TagOption>>("/api/tags/"),
    enabled: tags,
    staleTime: 10 * 60_000,
  })
  const vlanOptions = useQuery({
    queryKey: ["vlans-picker"],
    queryFn: () =>
      api<Paginated<{ id: string; vlan_id: number; name: string }>>(
        "/api/vlans/?picker=1"
      ),
    enabled: fields.some((f) => f.kind === "vlan"),
    staleTime: 5 * 60_000,
  })
  const vrfOptions = useQuery({
    queryKey: ["vrfs-picker"],
    queryFn: () =>
      api<Paginated<{ id: string; name: string }>>("/api/vrfs/?picker=1"),
    enabled: fields.some((f) => f.kind === "vrf"),
    staleTime: 5 * 60_000,
  })

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
      <DialogContent className="max-h-[85vh] overflow-auto sm:max-w-md">
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
          {fields.map((f) => {
            const active = f.key in values
            if (f.kind === "bool") {
              return (
                <FormSelect
                  key={f.key}
                  label={f.label}
                  value={active ? (values[f.key] ? "yes" : "no") : KEEP}
                  onChange={(v) =>
                    v === KEEP || v === null
                      ? unset(f.key)
                      : set(f.key, v === "yes")
                  }
                  options={[
                    { value: KEEP, label: "Keep current" },
                    { value: "yes", label: "Yes" },
                    { value: "no", label: "No" },
                  ]}
                />
              )
            }
            if (f.kind === "choice") {
              // Searchable + optgroup-aware: the type lists run to hundreds of
              // entries, and they carry their own `group`.
              return (
                <FormCombobox
                  key={f.key}
                  label={f.label}
                  hint={f.hint}
                  value={
                    active ? ((values[f.key] as string | null) ?? NONE) : KEEP
                  }
                  onChange={(v) =>
                    v === KEEP || v === null
                      ? unset(f.key)
                      : set(f.key, v === NONE ? null : v)
                  }
                  options={[
                    { value: KEEP, label: "Keep current" },
                    { value: NONE, label: `Clear ${f.label.toLowerCase()}` },
                    // `?? []`: a backend older than this build omits newer
                    // lists entirely, and spreading undefined would throw.
                    ...(dcimChoices[f.choices] ?? []),
                  ]}
                  searchPlaceholder={`Search ${f.label.toLowerCase()}…`}
                  emptyText="No matches."
                />
              )
            }
            if (f.kind === "vlan" || f.kind === "vrf") {
              const opts =
                f.kind === "vlan"
                  ? (vlanOptions.data?.results ?? []).map((v) => ({
                      value: v.id,
                      label: `${v.vlan_id} · ${v.name}`,
                    }))
                  : (vrfOptions.data?.results ?? []).map((v) => ({
                      value: v.id,
                      label: v.name,
                    }))
              return (
                <FormSelect
                  key={f.key}
                  label={f.label}
                  value={
                    active ? ((values[f.key] as string | null) ?? NONE) : KEEP
                  }
                  onChange={(v) =>
                    v === KEEP || v === null
                      ? unset(f.key)
                      : set(f.key, v === NONE ? null : v)
                  }
                  options={[
                    { value: KEEP, label: "Keep current" },
                    { value: NONE, label: `Clear ${f.label.toLowerCase()}` },
                    ...opts,
                  ]}
                />
              )
            }
            // text / int: a checkbox arms the field, the input carries it.
            return (
              <Field key={f.key} label={f.label} hint={f.hint}>
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="ck"
                    checked={active}
                    onChange={(e) =>
                      e.target.checked
                        ? set(f.key, f.kind === "int" ? null : "")
                        : unset(f.key)
                    }
                    title={active ? "Will be set" : "Keep current"}
                  />
                  <Input
                    type={f.kind === "int" ? "number" : "text"}
                    value={
                      active && values[f.key] !== null
                        ? String(values[f.key])
                        : ""
                    }
                    onChange={(e) =>
                      set(
                        f.key,
                        f.kind === "int"
                          ? e.target.value === ""
                            ? null
                            : Number(e.target.value)
                          : e.target.value
                      )
                    }
                    placeholder={active ? "" : "Keep current"}
                    disabled={!active}
                  />
                </div>
              </Field>
            )
          })}
          {tags && (
            <>
              <Field label="Add tags">
                <TagMultiSelect
                  options={tagOptions.data?.results ?? []}
                  value={addTags}
                  onChange={setAddTags}
                />
              </Field>
              <Field label="Remove tags">
                <TagMultiSelect
                  options={tagOptions.data?.results ?? []}
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
