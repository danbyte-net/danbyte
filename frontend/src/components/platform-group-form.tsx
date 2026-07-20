import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type Paginated,
  type PlatformGroup,
  type PlatformGroupOption,
  type PlatformGroupWritePayload,
} from "@/lib/api"
import {
  FormCombobox,
  FormFooter,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"

export interface PlatformGroupFormProps {
  group?: PlatformGroup
  onSaved: (g: PlatformGroup) => void
  onCancel: () => void
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
}

export function PlatformGroupForm({
  group,
  onSaved,
  onCancel,
}: PlatformGroupFormProps) {
  const isEdit = !!group
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [name, setName] = useState(group?.name ?? "")
  const [slug, setSlug] = useState(group?.slug ?? "")
  const [slugDirty, setSlugDirty] = useState(isEdit)
  const [parentId, setParentId] = useState<string | null>(
    group?.parent?.id ?? null
  )
  const [description, setDescription] = useState(group?.description ?? "")

  useEffect(() => {
    if (!group) return
    setName(group.name)
    setSlug(group.slug)
    setSlugDirty(true)
    setParentId(group.parent?.id ?? null)
    setDescription(group.description)
    reset()
  }, [group, reset])

  function onNameChange(v: string) {
    setName(v)
    if (!slugDirty && !isEdit) setSlug(slugify(v))
  }

  const groups = useQuery({
    queryKey: ["platform-groups-picker"],
    queryFn: () =>
      api<Paginated<PlatformGroupOption>>("/api/platform-groups/?picker=1"),
    staleTime: 10 * 60_000,
  })

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: PlatformGroupWritePayload = {
        name: name.trim(),
        slug: slug.trim() || slugify(name),
        parent_id: parentId,
        description: description.trim(),
      }
      if (isEdit)
        return api<PlatformGroup>(`/api/platform-groups/${group!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<PlatformGroup>("/api/platform-groups/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["platform-groups"] })
      qc.invalidateQueries({ queryKey: ["platform-groups-picker"] })
      qc.invalidateQueries({ queryKey: ["platform-group", saved.id] })
      toast.success(isEdit ? `Updated ${saved.name}` : `Created ${saved.name}`)
      onSaved(saved)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  // A group can't be its own parent; the server also rejects deeper cycles.
  const parentOptions = (groups.data?.results ?? []).filter(
    (g) => g.id !== group?.id
  )

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        mutation.mutate()
      }}
      className="grid gap-4"
    >
      <FormText
        label="Name"
        required
        autoFocus={!isEdit}
        value={name}
        onChange={onNameChange}
        placeholder="Windows"
        error={fieldErrors.name}
      />
      <FormText
        label="Slug"
        hint="URL-safe id"
        required
        placeholder="windows"
        value={slug}
        onChange={(v) => {
          setSlugDirty(true)
          setSlug(slugify(v))
        }}
        mono
        error={fieldErrors.slug}
      />
      <FormCombobox
        label="Parent group"
        hint="optional — nest under another group"
        value={parentId}
        onChange={setParentId}
        options={parentOptions.map((g) => ({
          value: g.id,
          label: g.name,
        }))}
        noneLabel="No parent"
        placeholder="Select a parent group…"
        searchPlaceholder="Search groups…"
        emptyText="No platform groups."
        error={fieldErrors.parent_id}
      />
      <FormTextarea
        label="Description"
        value={description}
        onChange={setDescription}
        error={fieldErrors.description}
      />
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create platform group"}
      />
    </form>
  )
}
