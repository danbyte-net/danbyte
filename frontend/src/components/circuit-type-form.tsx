import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type CircuitType, type CircuitTypeWritePayload } from "@/lib/api"
import {
  FormColor,
  FormFooter,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"

export interface CircuitTypeFormProps {
  item?: CircuitType
  onSaved: (v: CircuitType) => void
  onCancel: () => void
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
}

export function CircuitTypeForm({
  item,
  onSaved,
  onCancel,
}: CircuitTypeFormProps) {
  const isEdit = !!item
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const [name, setName] = useState(item?.name ?? "")
  const [slug, setSlug] = useState(item?.slug ?? "")
  const [slugDirty, setSlugDirty] = useState(isEdit)
  const [color, setColor] = useState(item?.color ?? "")
  const [description, setDescription] = useState(item?.description ?? "")

  useEffect(() => {
    if (!item) return
    setName(item.name)
    setSlug(item.slug)
    setSlugDirty(true)
    setColor(item.color)
    setDescription(item.description)
    reset()
  }, [item, reset])

  function onNameChange(v: string) {
    setName(v)
    if (!slugDirty && !isEdit) setSlug(slugify(v))
  }

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: CircuitTypeWritePayload = {
        name: name.trim(),
        slug: slug.trim() || slugify(name),
        color: color || undefined,
        description: description.trim(),
      }
      if (isEdit)
        return api<CircuitType>(`/api/circuit-types/${item!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<CircuitType>("/api/circuit-types/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["circuit-types"] })
      qc.invalidateQueries({ queryKey: ["circuit-types-picker"] })
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
        value={slug}
        onChange={(v) => {
          setSlugDirty(true)
          setSlug(slugify(v))
        }}
        mono
        error={fieldErrors.slug}
      />
      <FormColor label="Color" value={color} onChange={setColor} />
      <FormTextarea
        label="Description"
        value={description}
        onChange={setDescription}
        error={fieldErrors.description}
      />
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create type"}
      />
    </form>
  )
}
