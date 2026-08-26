import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { type TunnelGroup, type TunnelGroupWritePayload } from "@/lib/api"
import {
  FormFooter,
  FormSection,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { useSaveObject } from "@/lib/save-object"

export interface TunnelGroupFormProps {
  item?: TunnelGroup
  onSaved: (v: TunnelGroup) => void
  onCancel: () => void
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
}

export function TunnelGroupForm({
  item,
  onSaved,
  onCancel,
}: TunnelGroupFormProps) {
  const isEdit = !!item
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const saveObject = useSaveObject()
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
      const payload: TunnelGroupWritePayload = {
        name: name.trim(),
        slug: slug.trim() || slugify(name),
        description: description.trim(),
      }
      return saveObject<TunnelGroup>({
        objectType: "api.tunnelgroup",
        endpoint: "/api/tunnel-groups/",
        id: isEdit ? item!.id : undefined,
        payload,
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["tunnel-groups"] })
      qc.invalidateQueries({ queryKey: ["tunnel-groups-picker"] })
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
      className="@container grid gap-4"
    >
      <FormSection title="Tunnel group" card>
        <div className="grid gap-3 @md:grid-cols-2">
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
        </div>
        <FormTextarea
          label="Description"
          value={description}
          onChange={setDescription}
          error={fieldErrors.description}
        />
      </FormSection>
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create group"}
      />
    </form>
  )
}
