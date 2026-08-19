import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Download,
  ExternalLink,
  FilePlus,
  History,
  Link2,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react"
import { toast } from "sonner"

import {
  api,
  type Document,
  type DocumentCategory,
  type Paginated,
} from "@/lib/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
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
  FormColor,
  FormFooter,
  FormSelect,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { ColorBadge } from "@/components/cells/color-badge"
import { EmptyState } from "@/components/empty-state"
import { QueryError } from "@/components/query-error"
import { TimeCell } from "@/components/cells/time-ago"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"

// ─── Documents tab ────────────────────────────────────────────────────────
//
// Files and external links attached to a single object (device / rack / site /
// location). Mirrors ObjectImages but hits the standalone `/api/documents/`
// resource, filtered by `object_type` (`app.model` label) + `object_id`.
//
// A document is either a file (download via the auth-checked `download_url`) or
// a link (opens externally, flagged when the periodic link check found it
// broken). A newer document can *supersede* an older one; superseded rows fold
// behind a "show older" toggle so the current set stays clean.

interface DocDialogState {
  mode: "create" | "edit"
  kind: "file" | "link"
  doc?: Document
  supersedesId?: string
  presetName?: string
}

export function ObjectDocuments({
  objectType,
  objectId,
}: {
  objectType: string
  objectId: string
}) {
  const { canDo } = useMe()
  const canAdd = canDo("document", "add")
  const canChange = canDo("document", "change")
  const canDelete = canDo("document", "delete")

  const [dialog, setDialog] = useState<DocDialogState | null>(null)
  const [deleting, setDeleting] = useState<Document | null>(null)
  const [showOlder, setShowOlder] = useState(false)

  const docsKey = ["object-documents", objectType, objectId]
  const q = useQuery({
    queryKey: docsKey,
    queryFn: () =>
      api<Paginated<Document>>(
        `/api/documents/?object_type=${objectType}&object_id=${objectId}`
      ),
  })

  const categories = useQuery({
    queryKey: ["document-categories"],
    queryFn: () =>
      api<Paginated<DocumentCategory>>("/api/document-categories/"),
    staleTime: 5 * 60_000,
  })

  const docs = q.data?.results ?? []
  // A doc is "older" when a newer doc supersedes it. Fold those away by default.
  const supersededIds = useMemo(
    () => new Set(docs.map((d) => d.supersedes).filter(Boolean) as string[]),
    [docs]
  )
  const current = docs.filter((d) => !supersededIds.has(d.id))
  const older = docs.filter((d) => supersededIds.has(d.id))

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-medium">
          Documents
          {current.length > 0 && (
            <span className="ml-1.5 text-muted-foreground">
              {current.length}
            </span>
          )}
        </h2>
        {canAdd && (
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setDialog({ mode: "create", kind: "file" })}
            >
              <FilePlus className="h-3.5 w-3.5" />
              Add file
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setDialog({ mode: "create", kind: "link" })}
            >
              <Link2 className="h-3.5 w-3.5" />
              Add link
            </Button>
          </div>
        )}
      </div>

      {q.isError && <QueryError error={q.error} />}

      {q.data && current.length === 0 && (
        <EmptyState title="No documents yet.">
          {canAdd
            ? "Attach a file or link with the buttons above."
            : "Files and links attached here will appear in this tab."}
        </EmptyState>
      )}

      {current.length > 0 && (
        <ul className="space-y-2">
          {current.map((d) => (
            <DocumentRow
              key={d.id}
              doc={d}
              canChange={canChange}
              canAdd={canAdd}
              canDelete={canDelete}
              onEdit={() =>
                setDialog({
                  mode: "edit",
                  kind: d.url ? "link" : "file",
                  doc: d,
                })
              }
              onSupersede={() =>
                setDialog({
                  mode: "create",
                  kind: d.url ? "link" : "file",
                  supersedesId: d.id,
                  presetName: d.name,
                })
              }
              onDelete={() => setDeleting(d)}
            />
          ))}
        </ul>
      )}

      {older.length > 0 && (
        <div className="space-y-2">
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground"
            onClick={() => setShowOlder((v) => !v)}
          >
            <History className="h-3.5 w-3.5" />
            {showOlder
              ? "Hide older versions"
              : `Show older versions (${older.length})`}
          </Button>
          {showOlder && (
            <ul className="space-y-2">
              {older.map((d) => (
                <DocumentRow
                  key={d.id}
                  doc={d}
                  superseded
                  canChange={canChange}
                  canAdd={canAdd}
                  canDelete={canDelete}
                  onEdit={() =>
                    setDialog({
                      mode: "edit",
                      kind: d.url ? "link" : "file",
                      doc: d,
                    })
                  }
                  onSupersede={() =>
                    setDialog({
                      mode: "create",
                      kind: d.url ? "link" : "file",
                      supersedesId: d.id,
                      presetName: d.name,
                    })
                  }
                  onDelete={() => setDeleting(d)}
                />
              ))}
            </ul>
          )}
        </div>
      )}

      {dialog && (
        <DocumentFormDialog
          key={dialog.doc?.id ?? dialog.supersedesId ?? dialog.kind}
          state={dialog}
          objectType={objectType}
          objectId={objectId}
          categories={categories.data?.results ?? []}
          onOpenChange={(o) => !o && setDialog(null)}
          onSaved={() => setDialog(null)}
        />
      )}

      <DocumentDeleteDialog
        doc={deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      />
    </div>
  )
}

// ─── One document row ──────────────────────────────────────────────────────

function DocumentRow({
  doc,
  superseded = false,
  canChange,
  canAdd,
  canDelete,
  onEdit,
  onSupersede,
  onDelete,
}: {
  doc: Document
  superseded?: boolean
  canChange: boolean
  canAdd: boolean
  canDelete: boolean
  onEdit: () => void
  onSupersede: () => void
  onDelete: () => void
}) {
  const isLink = !!doc.url
  return (
    <li className="rounded-lg border border-border bg-card p-3">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 shrink-0 text-muted-foreground">
          {isLink ? (
            <Link2 className="h-4 w-4" />
          ) : (
            <Download className="h-4 w-4" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-medium">{doc.name}</span>
            {doc.category_detail && (
              <ColorBadge
                name={doc.category_detail.name}
                color={doc.category_detail.color || undefined}
              />
            )}
            {superseded && <Badge variant="secondary">Superseded</Badge>}
            {isLink && doc.link_status === "broken" && (
              <Badge variant="destructive">Dead link</Badge>
            )}
          </div>

          {doc.description && (
            <p className="mt-1 text-xs whitespace-pre-wrap text-muted-foreground">
              {doc.description}
            </p>
          )}

          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            {isLink ? (
              <a
                href={doc.url ?? undefined}
                target="_blank"
                rel="noreferrer"
                className="link inline-flex max-w-full items-center gap-1 truncate"
              >
                <ExternalLink className="h-3 w-3 shrink-0" />
                <span className="truncate">{doc.url}</span>
              </a>
            ) : (
              doc.file_name && (
                <span className="truncate font-mono text-muted-foreground">
                  {doc.file_name}
                </span>
              )
            )}
            {isLink && doc.link_checked_at && (
              <span className="text-muted-foreground">
                · checked <TimeCell iso={doc.link_checked_at} />
              </span>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {!isLink && doc.download_url && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-muted-foreground hover:text-foreground"
              asChild
            >
              <a
                href={doc.download_url}
                target="_blank"
                rel="noreferrer"
                download
              >
                <Download className="h-3.5 w-3.5" />
                Download
              </a>
            </Button>
          )}
          {canAdd && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              title="Replace with a new version"
              onClick={onSupersede}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          )}
          {canChange && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              title="Edit"
              onClick={onEdit}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
          )}
          {canDelete && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-destructive"
              title="Delete"
              onClick={onDelete}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>
    </li>
  )
}

// ─── Add / edit / supersede dialog ─────────────────────────────────────────

function DocumentFormDialog({
  state,
  objectType,
  objectId,
  categories,
  onOpenChange,
  onSaved,
}: {
  state: DocDialogState
  objectType: string
  objectId: string
  categories: DocumentCategory[]
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const isEdit = state.mode === "edit"
  const isLink = state.kind === "link"

  const [name, setName] = useState(state.doc?.name ?? state.presetName ?? "")
  const [description, setDescription] = useState(state.doc?.description ?? "")
  const [category, setCategory] = useState<string | null>(
    state.doc?.category ?? null
  )
  const [url, setUrl] = useState(state.doc?.url ?? "")
  const [file, setFile] = useState<File | null>(null)

  useEffect(() => reset(), [reset])

  const invalidate = () =>
    qc.invalidateQueries({
      queryKey: ["object-documents", objectType, objectId],
    })

  const save = useMutation({
    mutationFn: () => {
      if (isEdit) {
        return api<Document>(`/api/documents/${state.doc!.id}/`, {
          method: "PATCH",
          body: JSON.stringify({
            name: name.trim(),
            description: description.trim(),
            category,
          }),
        })
      }
      if (isLink) {
        return api<Document>("/api/documents/", {
          method: "POST",
          body: JSON.stringify({
            object_type: objectType,
            object_id: objectId,
            name: name.trim(),
            description: description.trim(),
            category,
            url: url.trim(),
            ...(state.supersedesId ? { supersedes: state.supersedesId } : {}),
          }),
        })
      }
      // File upload - multipart. Omit unset optional fields so the browser
      // doesn't send empty strings the serializer would reject.
      const fd = new FormData()
      fd.append("object_type", objectType)
      fd.append("object_id", objectId)
      fd.append("name", name.trim())
      fd.append("description", description.trim())
      if (category) fd.append("category", category)
      if (file) fd.append("file", file)
      if (state.supersedesId) fd.append("supersedes", state.supersedesId)
      return api<Document>("/api/documents/", { method: "POST", body: fd })
    },
    onSuccess: (saved) => {
      invalidate()
      toast.success(isEdit ? `Updated ${saved.name}` : `Added ${saved.name}`)
      onSaved()
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  const title = isEdit
    ? "Edit document"
    : state.supersedesId
      ? isLink
        ? "Replace with a new link"
        : "Replace with a new file"
      : isLink
        ? "Add link"
        : "Add file"

  const canSubmit =
    name.trim().length > 0 &&
    (isEdit || (isLink ? url.trim().length > 0 : !!file))

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (canSubmit) save.mutate()
          }}
          className="grid gap-4"
        >
          <FormText
            label="Name"
            required
            autoFocus
            value={name}
            onChange={setName}
            placeholder="Rack elevation diagram"
            error={fieldErrors.name}
          />

          {!isEdit &&
            (isLink ? (
              <FormText
                label="URL"
                type="url"
                required
                value={url}
                onChange={setUrl}
                placeholder="https://example.com/runbook"
                error={fieldErrors.url}
              />
            ) : (
              <FileField
                fileName={file?.name}
                onPick={setFile}
                error={fieldErrors.file}
              />
            ))}

          <FormTextarea
            label="Description"
            value={description}
            onChange={setDescription}
            error={fieldErrors.description}
          />

          <CategoryField
            value={category}
            onChange={setCategory}
            categories={categories}
            error={fieldErrors.category}
          />

          <FormFooter
            onCancel={() => onOpenChange(false)}
            submitting={save.isPending}
            submitLabel={isEdit ? "Save changes" : "Save"}
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ─── File input field ──────────────────────────────────────────────────────

function FileField({
  fileName,
  onPick,
  error,
}: {
  fileName?: string
  onPick: (f: File | null) => void
  error?: string
}) {
  return (
    <div className="grid gap-1.5">
      <label className="text-xs font-medium">File</label>
      <input
        type="file"
        onChange={(e) => onPick(e.target.files?.[0] ?? null)}
        className="block w-full text-xs text-muted-foreground file:mr-3 file:rounded-md file:border file:border-border file:bg-muted file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-foreground hover:file:bg-muted/70"
      />
      {fileName && (
        <p className="truncate font-mono text-[11px] text-muted-foreground">
          {fileName}
        </p>
      )}
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  )
}

// ─── Category select + inline create ───────────────────────────────────────

function CategoryField({
  value,
  onChange,
  categories,
  error,
}: {
  value: string | null
  onChange: (v: string | null) => void
  categories: DocumentCategory[]
  error?: string
}) {
  const qc = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState("")
  const [newColor, setNewColor] = useState("")

  const create = useMutation({
    mutationFn: () =>
      api<DocumentCategory>("/api/document-categories/", {
        method: "POST",
        body: JSON.stringify({ name: newName.trim(), color: newColor }),
      }),
    onSuccess: (cat) => {
      qc.invalidateQueries({ queryKey: ["document-categories"] })
      onChange(cat.id)
      setCreating(false)
      setNewName("")
      setNewColor("")
      toast.success(`Created ${cat.name}`)
    },
    onError: (err) => apiErrorToast(err),
  })

  if (creating) {
    return (
      <div className="grid gap-2 rounded-md border border-border bg-muted/30 p-3">
        <FormText
          label="Category name"
          autoFocus
          value={newName}
          onChange={setNewName}
          placeholder="Runbooks"
        />
        <FormColor label="Color" value={newColor} onChange={setNewColor} />
        <div className="flex items-center justify-end gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setCreating(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={!newName.trim() || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? "Creating…" : "Create"}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="grid gap-1.5">
      <FormSelect
        label="Category"
        value={value}
        onChange={onChange}
        noneLabel="Uncategorized"
        options={categories.map((c) => ({ value: c.id, label: c.name }))}
        placeholder="Uncategorized"
        error={error}
      />
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="justify-self-start text-muted-foreground"
        onClick={() => setCreating(true)}
      >
        <Plus className="h-3.5 w-3.5" />
        New category
      </Button>
    </div>
  )
}

// ─── Delete confirm ────────────────────────────────────────────────────────

function DocumentDeleteDialog({
  doc,
  onOpenChange,
}: {
  doc: Document | null
  onOpenChange: (open: boolean) => void
}) {
  const qc = useQueryClient()
  const del = useMutation({
    mutationFn: () =>
      api<void>(`/api/documents/${doc!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${doc!.name}`)
      qc.invalidateQueries({
        queryKey: ["object-documents", doc!.object_type, doc!.object_id],
      })
      onOpenChange(false)
    },
    onError: (err) => apiErrorToast(err),
  })

  return (
    <AlertDialog open={!!doc} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {doc?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {doc?.url
              ? "This removes the link."
              : "This permanently removes the uploaded file."}{" "}
            This action can't be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={del.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="text-destructive-foreground bg-destructive hover:bg-destructive/90"
            disabled={del.isPending}
            onClick={(e) => {
              e.preventDefault()
              del.mutate()
            }}
          >
            {del.isPending ? "Deleting…" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
