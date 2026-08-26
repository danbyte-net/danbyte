import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { type VirtualChassis, type VirtualChassisWritePayload } from "@/lib/api"
import {
  FormFooter,
  FormSection,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { CustomFieldInputs } from "@/components/custom-field-inputs"
import { useSaveObject } from "@/lib/save-object"

export interface VirtualChassisFormProps {
  item?: VirtualChassis
  onSaved: (v: VirtualChassis) => void
  onCancel: () => void
}

// Create/edit form for a virtual chassis (switch stack). Members join from
// the device side (device edit → Stack membership); the master is set from
// the detail page once members exist.
export function VirtualChassisForm({
  item,
  onSaved,
  onCancel,
}: VirtualChassisFormProps) {
  const isEdit = !!item
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const saveObject = useSaveObject()
  const [name, setName] = useState(item?.name ?? "")
  const [domain, setDomain] = useState(item?.domain ?? "")
  const [description, setDescription] = useState(item?.description ?? "")
  const [comments, setComments] = useState(item?.comments ?? "")
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    item?.custom_fields ?? {}
  )

  useEffect(() => {
    if (!item) return
    setName(item.name)
    setDomain(item.domain)
    setDescription(item.description)
    setComments(item.comments)
    setCustomFields(item.custom_fields ?? {})
    reset()
  }, [item, reset])

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: VirtualChassisWritePayload = {
        name: name.trim(),
        domain: domain.trim(),
        description: description.trim(),
        comments: comments.trim(),
        custom_fields: customFields,
      }
      return saveObject<VirtualChassis>({
        objectType: "api.virtualchassis",
        endpoint: "/api/virtual-chassis/",
        id: isEdit ? item!.id : undefined,
        payload,
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["virtual-chassis"] })
      qc.invalidateQueries({ queryKey: ["virtual-chassis-picker"] })
      if (isEdit)
        qc.invalidateQueries({ queryKey: ["virtual-chassis", saved.id] })
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
      <FormSection title="Virtual chassis" card>
        <div className="grid gap-3 @md:grid-cols-2">
          <FormText
            label="Name"
            required
            autoFocus={!isEdit}
            value={name}
            onChange={setName}
            placeholder="stack-fra-01"
            error={fieldErrors.name}
          />
          <FormText
            label="Domain"
            hint="optional"
            value={domain}
            onChange={setDomain}
            mono
            placeholder="stack-domain-1"
            error={fieldErrors.domain}
          />
        </div>
      </FormSection>

      <FormSection title="Notes" card>
        <FormTextarea
          label="Description"
          value={description}
          onChange={setDescription}
          error={fieldErrors.description}
        />
        <FormTextarea
          label="Comments"
          hint="optional"
          value={comments}
          onChange={setComments}
          error={fieldErrors.comments}
        />
      </FormSection>

      <CustomFieldInputs
        model="virtualchassis"
        value={customFields}
        onChange={setCustomFields}
      />
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create virtual chassis"}
      />
    </form>
  )
}
