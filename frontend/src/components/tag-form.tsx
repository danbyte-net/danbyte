import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { type Tag, type TagWritePayload } from "@/lib/api"
import {
  FormText,
  FormColor,
  FormFooter,
  useFieldErrors,
} from "@/components/forms"
import { useSaveObject } from "@/lib/save-object"

export interface TagFormProps {
  tag?: Tag
  onSaved: (saved: Tag) => void
  onCancel: () => void
}

export function TagForm({ tag, onSaved, onCancel }: TagFormProps) {
  const isEdit = !!tag
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const saveObject = useSaveObject()

  const [name, setName] = useState(tag?.name ?? "")
  const [color, setColor] = useState(tag?.color ?? "")

  useEffect(() => {
    if (!tag) return
    setName(tag.name)
    setColor(tag.color)
    reset()
  }, [tag, reset])

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: TagWritePayload = { name: name.trim(), color: color || "" }
      return saveObject<Tag>({
        objectType: "core.tag",
        endpoint: "/api/tags/",
        id: isEdit ? String(tag!.id) : undefined,
        payload,
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["tags"] })
      qc.invalidateQueries({ queryKey: ["tags-picker"] })
      qc.invalidateQueries({ queryKey: ["tag", String(saved.id)] })
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
        placeholder="prod"
        error={fieldErrors.name}
      />
      <FormColor
        label="Color"
        hint="Optional — leave empty for a neutral chip"
        value={color}
        onChange={setColor}
        error={fieldErrors.color}
      />
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create tag"}
      />
    </form>
  )
}
