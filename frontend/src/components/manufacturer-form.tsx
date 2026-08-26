import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { type Manufacturer, type ManufacturerWritePayload } from "@/lib/api"
import {
  FormFooter,
  FormSection,
  FormTags,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { useSaveObject } from "@/lib/save-object"

export interface ManufacturerFormProps {
  manufacturer?: Manufacturer
  onSaved: (m: Manufacturer) => void
  onCancel: () => void
}

export function ManufacturerForm({
  manufacturer,
  onSaved,
  onCancel,
}: ManufacturerFormProps) {
  const isEdit = !!manufacturer
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const saveObject = useSaveObject()

  const [name, setName] = useState(manufacturer?.name ?? "")
  const [url, setUrl] = useState(manufacturer?.url ?? "")
  const [description, setDescription] = useState(
    manufacturer?.description ?? ""
  )
  const [tagIds, setTagIds] = useState<number[]>(
    manufacturer?.tags?.map((t) => t.id) ?? []
  )

  useEffect(() => {
    if (!manufacturer) return
    setName(manufacturer.name)
    setUrl(manufacturer.url)
    setDescription(manufacturer.description)
    setTagIds(manufacturer.tags?.map((t) => t.id) ?? [])
    reset()
  }, [manufacturer, reset])

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: ManufacturerWritePayload = {
        name: name.trim(),
        url: url.trim(),
        description: description.trim(),
        tag_ids: tagIds,
      }
      return saveObject<Manufacturer>({
        objectType: "api.manufacturer",
        endpoint: "/api/manufacturers/",
        id: isEdit ? manufacturer!.id : undefined,
        payload,
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["manufacturers"] })
      qc.invalidateQueries({ queryKey: ["manufacturers-picker"] })
      qc.invalidateQueries({ queryKey: ["manufacturer", saved.id] })
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
      <FormSection title="Manufacturer" card>
        <FormText
          label="Name"
          required
          autoFocus={!isEdit}
          value={name}
          onChange={setName}
          placeholder="Cisco"
          error={fieldErrors.name}
        />
        <FormText
          label="URL"
          type="url"
          value={url}
          onChange={setUrl}
          placeholder="https://cisco.com"
          error={fieldErrors.url}
        />
        <FormTextarea
          label="Description"
          value={description}
          onChange={setDescription}
          error={fieldErrors.description}
        />
      </FormSection>
      <FormTags
        label="Tags"
        value={tagIds}
        onChange={setTagIds}
        error={fieldErrors.tag_ids}
      />
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create manufacturer"}
      />
    </form>
  )
}
