import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api, type RackRole, type RackRoleWritePayload } from "@/lib/api"
import {
  FormColor,
  FormFooter,
  FormRow,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"

export interface RackRoleFormProps {
  role?: RackRole
  onSaved: (r: RackRole) => void
  onCancel: () => void
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
}

export function RackRoleForm({ role, onSaved, onCancel }: RackRoleFormProps) {
  const isEdit = !!role
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [name, setName] = useState(role?.name ?? "")
  const [slug, setSlug] = useState(role?.slug ?? "")
  const [slugDirty, setSlugDirty] = useState(isEdit)
  const [color, setColor] = useState(role?.color ?? "")
  const [description, setDescription] = useState(role?.description ?? "")

  useEffect(() => {
    if (!role) return
    setName(role.name)
    setSlug(role.slug)
    setSlugDirty(true)
    setColor(role.color)
    setDescription(role.description)
    reset()
  }, [role, reset])

  function onNameChange(v: string) {
    setName(v)
    if (!slugDirty && !isEdit) setSlug(slugify(v))
  }

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: RackRoleWritePayload = {
        name: name.trim(),
        slug: slug.trim() || slugify(name),
        color: color || "",
        description: description.trim(),
      }
      if (isEdit)
        return api<RackRole>(`/api/rack-roles/${role!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<RackRole>("/api/rack-roles/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["rack-roles"] })
      qc.invalidateQueries({ queryKey: ["rack-roles-picker"] })
      qc.invalidateQueries({ queryKey: ["rack-role", saved.id] })
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
        placeholder="Compute"
        error={fieldErrors.name}
      />
      <FormRow>
        <FormText
          label="Slug"
          hint="URL-safe id"
          required
          placeholder="compute"
          value={slug}
          onChange={(v) => {
            setSlugDirty(true)
            setSlug(slugify(v))
          }}
          mono
          error={fieldErrors.slug}
        />
        <FormColor
          label="Color"
          value={color}
          onChange={setColor}
          error={fieldErrors.color}
        />
      </FormRow>
      <FormTextarea
        label="Description"
        value={description}
        onChange={setDescription}
        error={fieldErrors.description}
      />
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create role"}
      />
    </form>
  )
}
