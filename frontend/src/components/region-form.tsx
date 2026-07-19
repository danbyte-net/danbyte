import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type Paginated,
  type Region,
  type RegionOption,
  type RegionWritePayload,
} from "@/lib/api"
import {
  FormCombobox,
  FormFooter,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"

export interface RegionFormProps {
  region?: Region
  onSaved: (v: Region) => void
  onCancel: () => void
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
}

export function RegionForm({ region, onSaved, onCancel }: RegionFormProps) {
  const isEdit = !!region
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const [name, setName] = useState(region?.name ?? "")
  const [slug, setSlug] = useState(region?.slug ?? "")
  const [slugDirty, setSlugDirty] = useState(isEdit)
  const [parentId, setParentId] = useState<string | null>(
    region?.parent?.id ?? null
  )
  const [description, setDescription] = useState(region?.description ?? "")

  useEffect(() => {
    if (!region) return
    setName(region.name)
    setSlug(region.slug)
    setSlugDirty(true)
    setParentId(region.parent?.id ?? null)
    setDescription(region.description)
    reset()
  }, [region, reset])

  function onNameChange(v: string) {
    setName(v)
    if (!slugDirty && !isEdit) setSlug(slugify(v))
  }

  const regions = useQuery({
    queryKey: ["regions-picker"],
    queryFn: () => api<Paginated<RegionOption>>("/api/regions/?picker=1"),
    staleTime: 10 * 60_000,
  })
  // Can't be its own parent.
  const parentOptions = (regions.data?.results ?? [])
    .filter((r) => r.id !== region?.id)
    .map((r) => ({ value: r.id, label: r.name }))

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: RegionWritePayload = {
        name: name.trim(),
        slug: slug.trim() || slugify(name),
        parent_id: parentId,
        description: description.trim(),
      }
      if (isEdit)
        return api<Region>(`/api/regions/${region!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<Region>("/api/regions/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["regions"] })
      qc.invalidateQueries({ queryKey: ["regions-picker"] })
      toast.success(isEdit ? `Updated ${saved.name}` : `Created ${saved.name}`)
      onSaved(saved)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

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
        error={fieldErrors.name}
      />
      <FormText
        label="Slug"
        hint="URL-safe id"
        required
        placeholder="us-east"
        value={slug}
        onChange={(v) => {
          setSlugDirty(true)
          setSlug(slugify(v))
        }}
        mono
        error={fieldErrors.slug}
      />
      <FormCombobox
        label="Parent region"
        hint="optional"
        value={parentId}
        onChange={setParentId}
        options={parentOptions}
        noneLabel="Top level"
        placeholder="Top level"
        searchPlaceholder="Search regions…"
        emptyText="No regions."
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
        submitLabel={isEdit ? "Save changes" : "Create region"}
      />
    </form>
  )
}
