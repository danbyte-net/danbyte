import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Pencil, Trash2 } from "lucide-react"
import { toast } from "sonner"

import {
  api,
  type Paginated,
  type TenantGroup,
  type TenantGroupWritePayload,
} from "@/lib/api"
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
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  FormCombobox,
  FormFooter,
  FormRow,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { QueryError } from "@/components/query-error"
import { useMe } from "@/lib/use-me"
import { apiErrorToast } from "@/lib/api-toast"

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
}

/** "Tenant groups" management block rendered below the tenants table —
 * a small bordered table plus a dialog-based add/edit form. Groups are
 * navigation metadata over tenants, so they live on the same page rather
 * than a separate route. */
export function TenantGroupsSection() {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<TenantGroup | null>(null)
  const [deleting, setDeleting] = useState<TenantGroup | null>(null)
  const qc = useQueryClient()
  const { canDo } = useMe()
  const canAdd = canDo("tenantgroup", "add")
  const canEdit = canDo("tenantgroup", "change")
  const canDelete = canDo("tenantgroup", "delete")

  const query = useQuery({
    queryKey: ["tenant-groups"],
    queryFn: () => api<Paginated<TenantGroup>>("/api/tenant-groups/"),
  })
  const groups = query.data?.results ?? []

  const deleteMutation = useMutation({
    mutationFn: () =>
      api<void>(`/api/tenant-groups/${deleting!.id}/`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success(`Deleted ${deleting!.name}`)
      qc.invalidateQueries({ queryKey: ["tenant-groups"] })
      // Members and children are SET_NULL'd server-side — refresh both.
      qc.invalidateQueries({ queryKey: ["tenants"] })
      setDeleting(null)
    },
    onError: (err) => apiErrorToast(err),
  })

  return (
    <section className="mt-8">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-[11px] font-semibold tracking-wide text-foreground uppercase">
          Tenant groups
        </h2>
        {canAdd && (
          <Button
            size="sm"
            variant="outline"
            className="h-7"
            onClick={() => {
              setEditing(null)
              setDialogOpen(true)
            }}
          >
            + Add group
          </Button>
        )}
      </div>

      {query.isLoading && (
        <p className="text-sm text-muted-foreground">Loading…</p>
      )}
      {query.isError && <QueryError error={query.error} />}
      {query.data &&
        (groups.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No tenant groups yet. Groups organise tenants into a tree — they
            never gate access.
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Parent</TableHead>
                  <TableHead>Tenants</TableHead>
                  <TableHead>Children</TableHead>
                  <TableHead className="w-full">Description</TableHead>
                  {(canEdit || canDelete) && <TableHead className="w-20" />}
                </TableRow>
              </TableHeader>
              <TableBody>
                {groups.map((g) => (
                  <TableRow key={g.id}>
                    <TableCell className="py-2 font-medium">{g.name}</TableCell>
                    <TableCell className="py-2 text-muted-foreground">
                      {g.parent?.name ?? "—"}
                    </TableCell>
                    <TableCell className="num py-2 text-xs">
                      {g.tenant_count}
                    </TableCell>
                    <TableCell className="num py-2 text-xs">
                      {g.child_count}
                    </TableCell>
                    <TableCell className="py-2">
                      <span className="line-clamp-1 block text-muted-foreground">
                        {g.description || "—"}
                      </span>
                    </TableCell>
                    {(canEdit || canDelete) && (
                      <TableCell className="py-1 text-right whitespace-nowrap">
                        {canEdit && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            aria-label="Edit group"
                            onClick={() => {
                              setEditing(g)
                              setDialogOpen(true)
                            }}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {canDelete && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-destructive hover:text-destructive"
                            aria-label="Delete group"
                            onClick={() => setDeleting(g)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ))}

      <TenantGroupDialog
        group={editing}
        groups={groups}
        open={dialogOpen}
        onOpenChange={(o) => {
          setDialogOpen(o)
          if (!o) setEditing(null)
        }}
      />

      <AlertDialog
        open={!!deleting}
        onOpenChange={(o) => !o && setDeleting(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete group {deleting?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              No tenants are deleted — the {deleting?.tenant_count ?? 0} tenant
              {(deleting?.tenant_count ?? 0) === 1 ? "" : "s"} in this group
              become ungrouped, and its {deleting?.child_count ?? 0} child group
              {(deleting?.child_count ?? 0) === 1 ? "" : "s"} move to the top
              level.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              className="text-destructive-foreground bg-destructive hover:bg-destructive/90"
              disabled={deleteMutation.isPending}
              onClick={(e) => {
                e.preventDefault()
                deleteMutation.mutate()
              }}
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete group"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

function TenantGroupDialog({
  group,
  groups,
  open,
  onOpenChange,
}: {
  group: TenantGroup | null
  groups: TenantGroup[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const isEdit = !!group
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [name, setName] = useState("")
  const [slug, setSlug] = useState("")
  const [slugDirty, setSlugDirty] = useState(false)
  const [parentId, setParentId] = useState<string | null>(null)
  const [description, setDescription] = useState("")

  useEffect(() => {
    if (!open) return
    setName(group?.name ?? "")
    setSlug(group?.slug ?? "")
    setSlugDirty(!!group)
    setParentId(group?.parent?.id ?? null)
    setDescription(group?.description ?? "")
    reset()
  }, [open, group, reset])

  function onNameChange(v: string) {
    setName(v)
    if (!slugDirty && !isEdit) setSlug(slugify(v))
  }

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: TenantGroupWritePayload = {
        name: name.trim(),
        slug: slug.trim() || slugify(name),
        parent_id: parentId,
        description: description.trim(),
      }
      if (isEdit)
        return api<TenantGroup>(`/api/tenant-groups/${group!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<TenantGroup>("/api/tenant-groups/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["tenant-groups"] })
      qc.invalidateQueries({ queryKey: ["tenants"] })
      toast.success(isEdit ? `Updated ${saved.name}` : `Created ${saved.name}`)
      onOpenChange(false)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? `Edit ${group!.name}` : "Add tenant group"}
          </DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            mutation.mutate()
          }}
          className="grid gap-4"
        >
          <FormRow>
            <FormText
              label="Name"
              required
              autoFocus={!isEdit}
              value={name}
              onChange={onNameChange}
              error={fieldErrors.name}
            />
            <FormText
              label="Slug"
              hint="URL-safe id"
              value={slug}
              onChange={(v) => {
                setSlugDirty(true)
                setSlug(slugify(v))
              }}
              mono
              error={fieldErrors.slug}
            />
          </FormRow>
          <FormCombobox
            label="Parent group"
            value={parentId}
            onChange={setParentId}
            options={groups
              .filter((g) => g.id !== group?.id)
              .map((g) => ({ value: g.id, label: g.name }))}
            noneLabel="No parent"
            placeholder="No parent"
            error={fieldErrors.parent_id}
          />
          <FormTextarea
            label="Description"
            value={description}
            onChange={setDescription}
            error={fieldErrors.description}
          />
          <FormFooter
            onCancel={() => onOpenChange(false)}
            submitting={mutation.isPending}
            submitLabel={isEdit ? "Save changes" : "Create group"}
          />
        </form>
      </DialogContent>
    </Dialog>
  )
}
