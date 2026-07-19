import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type Manufacturer,
  type ManufacturerWritePayload,
} from "@/lib/api"
import {
  FormFooter,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"

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

  const [name, setName] = useState(manufacturer?.name ?? "")
  const [url, setUrl] = useState(manufacturer?.url ?? "")
  const [description, setDescription] = useState(
    manufacturer?.description ?? ""
  )

  useEffect(() => {
    if (!manufacturer) return
    setName(manufacturer.name)
    setUrl(manufacturer.url)
    setDescription(manufacturer.description)
    reset()
  }, [manufacturer, reset])

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: ManufacturerWritePayload = {
        name: name.trim(),
        url: url.trim(),
        description: description.trim(),
      }
      if (isEdit)
        return api<Manufacturer>(`/api/manufacturers/${manufacturer!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<Manufacturer>("/api/manufacturers/", {
        method: "POST",
        body: JSON.stringify(payload),
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
      className="grid gap-4"
    >
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
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create manufacturer"}
      />
    </form>
  )
}
