import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type CustomFieldGroup,
  type CustomFieldGroupWritePayload,
} from "@/lib/api"
import {
  FormCheckbox,
  FormFooter,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"

export interface CustomFieldGroupFormProps {
  group?: CustomFieldGroup
  onSaved: (saved: CustomFieldGroup) => void
  onCancel: () => void
}

export function CustomFieldGroupForm({
  group,
  onSaved,
  onCancel,
}: CustomFieldGroupFormProps) {
  const isEdit = !!group
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [name, setName] = useState(group?.name ?? "")
  const [slug, setSlug] = useState(group?.slug ?? "")
  const [description, setDescription] = useState(group?.description ?? "")
  const [weight, setWeight] = useState(group ? String(group.weight) : "0")
  const [collapsed, setCollapsed] = useState(group?.collapsed ?? false)

  useEffect(() => {
    if (!group) return
    setName(group.name)
    setSlug(group.slug)
    setDescription(group.description)
    setWeight(String(group.weight))
    setCollapsed(group.collapsed)
    reset()
  }, [group, reset])

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: CustomFieldGroupWritePayload = {
        name: name.trim(),
        slug: slug.trim(),
        description: description.trim(),
        weight: weight.trim() === "" ? 0 : Number(weight),
        collapsed,
      }
      if (isEdit)
        return api<CustomFieldGroup>(`/api/custom-field-groups/${group!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<CustomFieldGroup>("/api/custom-field-groups/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["custom-field-groups"] })
      qc.invalidateQueries({ queryKey: ["custom-field-group", saved.id] })
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
        onChange={setName}
        placeholder="Operations"
        error={fieldErrors.name}
      />
      <FormText
        label="Slug"
        mono
        value={slug}
        onChange={setSlug}
        hint="Auto-generated from the name if left blank."
        placeholder="operations"
        error={fieldErrors.slug}
      />
      <FormTextarea
        label="Description"
        value={description}
        onChange={setDescription}
        placeholder="What this section groups together"
        error={fieldErrors.description}
      />
      <FormText
        label="Weight"
        type="number"
        value={weight}
        onChange={setWeight}
        hint="Section order, low → high."
        error={fieldErrors.weight}
      />
      <FormCheckbox
        label="Start collapsed on detail pages"
        checked={collapsed}
        onChange={setCollapsed}
      />

      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create group"}
      />
    </form>
  )
}
