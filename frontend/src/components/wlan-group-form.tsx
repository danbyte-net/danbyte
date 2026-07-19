import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type WirelessLANGroup,
  type WirelessLANGroupWritePayload,
} from "@/lib/api"
import {
  FormFooter,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"

export interface WlanGroupFormProps {
  item?: WirelessLANGroup
  onSaved: (v: WirelessLANGroup) => void
  onCancel: () => void
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
}

export function WlanGroupForm({ item, onSaved, onCancel }: WlanGroupFormProps) {
  const isEdit = !!item
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const [name, setName] = useState(item?.name ?? "")
  const [slug, setSlug] = useState(item?.slug ?? "")
  const [slugDirty, setSlugDirty] = useState(isEdit)
  const [description, setDescription] = useState(item?.description ?? "")

  useEffect(() => {
    if (!item) return
    setName(item.name)
    setSlug(item.slug)
    setSlugDirty(true)
    setDescription(item.description)
    reset()
  }, [item, reset])

  function onNameChange(v: string) {
    setName(v)
    if (!slugDirty && !isEdit) setSlug(slugify(v))
  }

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: WirelessLANGroupWritePayload = {
        name: name.trim(),
        slug: slug.trim() || slugify(name),
        description: description.trim(),
      }
      if (isEdit)
        return api<WirelessLANGroup>(`/api/wireless-lan-groups/${item!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<WirelessLANGroup>("/api/wireless-lan-groups/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["wireless-lan-groups"] })
      qc.invalidateQueries({ queryKey: ["wireless-lan-groups-picker"] })
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
