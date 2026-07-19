import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type ContactGroup,
  type ContactGroupWritePayload,
  type Paginated,
} from "@/lib/api"
import {
  FormCombobox,
  FormFooter,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"

export interface ContactGroupFormProps {
  item?: ContactGroup
  onSaved: (v: ContactGroup) => void
  onCancel: () => void
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
}

export function ContactGroupForm({
  item,
  onSaved,
  onCancel,
}: ContactGroupFormProps) {
  const isEdit = !!item
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const [name, setName] = useState(item?.name ?? "")
  const [slug, setSlug] = useState(item?.slug ?? "")
  const [slugDirty, setSlugDirty] = useState(isEdit)
  const [parentId, setParentId] = useState<string | null>(
    item?.parent?.id ?? null
  )
  const [description, setDescription] = useState(item?.description ?? "")

  const groupsQuery = useQuery({
    queryKey: ["contact-groups-picker"],
    queryFn: () => api<Paginated<ContactGroup>>("/api/contact-groups/"),
  })
  // A group can't be its own parent — drop self from the options when editing.
  const parentOptions = (groupsQuery.data?.results ?? [])
    .filter((g) => g.id !== item?.id)
    .map((g) => ({ value: g.id, label: g.name }))

  useEffect(() => {
    if (!item) return
    setName(item.name)
    setSlug(item.slug)
    setSlugDirty(true)
    setParentId(item.parent?.id ?? null)
    setDescription(item.description)
    reset()
  }, [item, reset])

  function onNameChange(v: string) {
    setName(v)
    if (!slugDirty && !isEdit) setSlug(slugify(v))
  }

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: ContactGroupWritePayload = {
        name: name.trim(),
        slug: slug.trim() || slugify(name),
        parent_id: parentId,
        description: description.trim(),
      }
      if (isEdit)
        return api<ContactGroup>(`/api/contact-groups/${item!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<ContactGroup>("/api/contact-groups/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["contact-groups"] })
      qc.invalidateQueries({ queryKey: ["contact-groups-picker"] })
      qc.invalidateQueries({ queryKey: ["contact-group", saved.id] })
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
        placeholder="noc"
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
        hint="optional"
        value={parentId}
        onChange={setParentId}
        options={parentOptions}
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
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create group"}
      />
    </form>
  )
}
