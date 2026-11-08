import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import type { AreaPattern, AreaType, AreaTypeWritePayload } from "@/lib/api"
import {
  FormColor,
  FormFooter,
  FormIcon,
  FormSection,
  FormSelect,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { AreaSwatch } from "@/components/floorplan/area-legend"
import { AREA_PATTERNS } from "@/components/floorplan/shapes"
import { useSaveObject } from "@/lib/save-object"

export interface AreaTypeFormProps {
  areaType?: AreaType
  onSaved: (saved: AreaType) => void
  onCancel: () => void
}

export function AreaTypeForm({
  areaType,
  onSaved,
  onCancel,
}: AreaTypeFormProps) {
  const isEdit = !!areaType
  const qc = useQueryClient()
  const { fieldErrors, handleApiError } = useFieldErrors()
  const saveObject = useSaveObject()

  const [name, setName] = useState(areaType?.name ?? "")
  const [color, setColor] = useState(areaType?.color ?? "")
  const [pattern, setPattern] = useState<AreaPattern>(
    areaType?.pattern ?? "solid"
  )
  const [icon, setIcon] = useState(areaType?.icon ?? "")
  const [description, setDescription] = useState(areaType?.description ?? "")

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: AreaTypeWritePayload = {
        name: name.trim(),
        color,
        pattern,
        icon,
        description: description.trim(),
      }
      return saveObject<AreaType>({
        objectType: "api.areatype",
        endpoint: "/api/area-types/",
        id: areaType?.id,
        payload,
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["area-types"] })
      qc.invalidateQueries({ queryKey: ["area-types-picker"] })
      qc.invalidateQueries({ queryKey: ["area-type", saved.id] })
      qc.invalidateQueries({ queryKey: ["floor-plan-contents"] })
      toast.success(isEdit ? `Updated ${saved.name}` : `Created ${saved.name}`)
      onSaved(saved)
    },
    onError: (err) => {
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  const preview = { id: "", name, color, pattern, icon }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        mutation.mutate()
      }}
      className="@container grid gap-4"
    >
      <FormSection title="Area type" card>
        <FormText
          label="Name"
          required
          autoFocus={!isEdit}
          value={name}
          onChange={setName}
          placeholder="Parking, Fence, Road, Gate…"
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
        <div className="grid gap-3 @md:grid-cols-3">
          <FormColor
            label="Color"
            value={color}
            onChange={setColor}
            error={fieldErrors.color}
          />
          <FormSelect
            label="Fill pattern"
            value={pattern}
            onChange={(v) => setPattern((v as AreaPattern) || "solid")}
            options={AREA_PATTERNS.map((p) => ({
              value: p.value,
              label: (
                <span className="inline-flex items-center gap-2">
                  <AreaSwatch type={{ ...preview, pattern: p.value }} />
                  {p.label}
                </span>
              ),
            }))}
            error={fieldErrors.pattern}
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
        submitLabel={isEdit ? "Save changes" : "Create area type"}
      />
    </form>
  )
}
