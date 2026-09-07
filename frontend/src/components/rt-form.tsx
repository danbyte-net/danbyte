import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { type RouteTarget, type RouteTargetWritePayload } from "@/lib/api"
import { CustomFieldInputs } from "@/components/custom-field-inputs"
import {
  FormFooter,
  FormSection,
  FormTags,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { useSaveObject } from "@/lib/save-object"

export interface RtFormProps {
  rt?: RouteTarget
  onSaved: (saved: RouteTarget) => void
  onCancel: () => void
}

export function RtForm({ rt, onSaved, onCancel }: RtFormProps) {
  const isEdit = !!rt
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const saveObject = useSaveObject()

  const [name, setName] = useState(rt?.name ?? "")
  const [description, setDescription] = useState(rt?.description ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    rt?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    rt?.custom_fields ?? {}
  )

  useEffect(() => {
    if (!rt) return
    setName(rt.name)
    setDescription(rt.description)
    setTagIds(rt.tags.map((t) => t.id))
    setCustomFields(rt.custom_fields ?? {})
    reset()
  }, [rt, reset])

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: RouteTargetWritePayload = {
        name: name.trim(),
        description: description.trim(),
        tag_ids: tagIds,
        custom_fields: customFields,
      }
      return saveObject<RouteTarget>({
        objectType: "api.routetarget",
        endpoint: "/api/route-targets/",
        id: isEdit ? rt!.id : undefined,
        payload,
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["rts"] })
      qc.invalidateQueries({ queryKey: ["rts-picker"] })
      qc.invalidateQueries({ queryKey: ["rt", saved.id] })
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
      <FormSection title="Route target" card>
        <FormText
          label="Name"
          required
          hint="ASN:value"
          autoFocus={!isEdit}
          mono
          value={name}
          onChange={setName}
          placeholder="65000:100"
          error={fieldErrors.name}
        />
        <FormTextarea
          label="Description"
          rows={2}
          value={description}
          onChange={setDescription}
          placeholder="e.g. Shared production hub RT"
          error={fieldErrors.description}
        />
      </FormSection>

      <FormTags
        label="Tags"
        value={tagIds}
        onChange={setTagIds}
        error={fieldErrors.tag_ids}
      />

      <CustomFieldInputs
        model="routetarget"
        value={customFields}
        onChange={setCustomFields}
      />

      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create RT"}
      />
    </form>
  )
}
