import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import type { SensitivityLabel, SensitivityLabelWritePayload } from "@/lib/api"
import {
  Field,
  FormCheckbox,
  FormColor,
  FormFooter,
  FormIcon,
  FormSection,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { SensitivityBadge } from "@/components/sensitivity-badge"
import { useSaveObject } from "@/lib/save-object"

export interface SensitivityLabelFormProps {
  label?: SensitivityLabel
  onSaved: (saved: SensitivityLabel) => void
  onCancel: () => void
}

/** Invalidated whenever a label changes: the catalog, its page and the
 * report dialog's picker. */
export const SENSITIVITY_LABEL_KEYS = [
  ["sensitivity-labels"],
  ["sensitivity-labels-picker"],
]

export function SensitivityLabelForm({
  label,
  onSaved,
  onCancel,
}: SensitivityLabelFormProps) {
  const isEdit = !!label
  const qc = useQueryClient()
  const { fieldErrors, handleApiError } = useFieldErrors()
  const saveObject = useSaveObject()

  const [name, setName] = useState(label?.name ?? "")
  const [color, setColor] = useState(label?.color ?? "")
  const [icon, setIcon] = useState(label?.icon ?? "")
  const [weight, setWeight] = useState(String(label?.weight ?? 100))
  const [isDefault, setIsDefault] = useState(label?.is_default ?? false)
  const [description, setDescription] = useState(label?.description ?? "")

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: SensitivityLabelWritePayload = {
        name: name.trim(),
        color,
        icon,
        weight: Math.max(0, Number(weight) || 0),
        is_default: isDefault,
        description: description.trim(),
      }
      return saveObject<SensitivityLabel>({
        objectType: "api.sensitivitylabel",
        endpoint: "/api/sensitivity-labels/",
        id: label?.id,
        payload,
      })
    },
    onSuccess: (saved) => {
      for (const queryKey of SENSITIVITY_LABEL_KEYS)
        qc.invalidateQueries({ queryKey })
      qc.invalidateQueries({ queryKey: ["sensitivity-label", saved.id] })
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
      <FormSection title="Sensitivity label" card>
        <FormText
          label="Name"
          required
          autoFocus={!isEdit}
          value={name}
          onChange={setName}
          placeholder="Internal, Confidential, Secret…"
          error={fieldErrors.name || fieldErrors.slug}
        />
        <FormTextarea
          label="Description"
          value={description}
          onChange={setDescription}
          error={fieldErrors.description}
        />
        <FormCheckbox
          label="Default for reports"
          info="New PDF reports start with this label. One label per tenant."
          checked={isDefault}
          onChange={setIsDefault}
          className="items-center text-[13px] whitespace-nowrap"
        />
      </FormSection>

      <FormSection title="Appearance" card>
        <div className="grid gap-3 @md:grid-cols-3">
          <FormColor
            label="Color"
            value={color}
            onChange={setColor}
            error={fieldErrors.color}
          />
          <FormIcon
            label="Icon"
            value={icon}
            onChange={setIcon}
            error={fieldErrors.icon}
          />
          <FormText
            label="Weight"
            type="number"
            value={weight}
            onChange={setWeight}
            info="Lower weights sort first."
            error={fieldErrors.weight}
          />
        </div>
        <Field label="Preview">
          <div>
            <SensitivityBadge label={{ name: name || "Label", color, icon }} />
          </div>
        </Field>
      </FormSection>
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create label"}
      />
    </form>
  )
}
