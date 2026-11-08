import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import type { LocationType, LocationTypeWritePayload } from "@/lib/api"
import {
  FormColor,
  FormFooter,
  FormIcon,
  FormSection,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { useSaveObject } from "@/lib/save-object"

export interface LocationTypeFormProps {
  locationType?: LocationType
  onSaved: (saved: LocationType) => void
  onCancel: () => void
}

export function LocationTypeForm({
  locationType,
  onSaved,
  onCancel,
}: LocationTypeFormProps) {
  const isEdit = !!locationType
  const qc = useQueryClient()
  const { fieldErrors, handleApiError } = useFieldErrors()
  const saveObject = useSaveObject()

  const [name, setName] = useState(locationType?.name ?? "")
  const [color, setColor] = useState(locationType?.color ?? "")
  const [icon, setIcon] = useState(locationType?.icon ?? "")
  const [description, setDescription] = useState(
    locationType?.description ?? ""
  )

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: LocationTypeWritePayload = {
        name: name.trim(),
        color,
        icon,
        description: description.trim(),
      }
      return saveObject<LocationType>({
        objectType: "api.locationtype",
        endpoint: "/api/location-types/",
        id: locationType?.id,
        payload,
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["location-types"] })
      qc.invalidateQueries({ queryKey: ["location-types-picker"] })
      qc.invalidateQueries({ queryKey: ["location-type", saved.id] })
      qc.invalidateQueries({ queryKey: ["locations"] })
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
      <FormSection title="Location type" card>
        <FormText
          label="Name"
          required
          autoFocus={!isEdit}
          value={name}
          onChange={setName}
          placeholder="Building, Floor, Hall, Manhole…"
          error={fieldErrors.name || fieldErrors.slug}
        />
        <FormTextarea
          label="Description"
          value={description}
          onChange={setDescription}
          error={fieldErrors.description}
        />
      </FormSection>

      <FormSection title="Appearance" card>
        <div className="grid gap-3 @md:grid-cols-2">
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
        </div>
      </FormSection>
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create location type"}
      />
    </form>
  )
}
