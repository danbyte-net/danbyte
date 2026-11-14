import { useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { useSaveObject } from "@/lib/save-object"
import type {
  DependencyLineStyle,
  DependencyMedium,
  DependencyMediumWritePayload,
} from "@/lib/api"
import {
  Field,
  FormColor,
  FormFooter,
  FormIcon,
  FormSection,
  FormSelect,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import {
  DependencyMediumBadge,
  LINE_STYLES,
} from "@/components/dependency-medium-badge"

export interface DependencyMediumFormProps {
  medium?: DependencyMedium
  onSaved: (saved: DependencyMedium) => void
  onCancel: () => void
}

/** Invalidated whenever a medium changes: the catalog, its page, the
 * pickers and the dependency tables that show it. */
export const DEPENDENCY_MEDIUM_KEYS = [
  ["dependency-media"],
  ["dependency-media-picker"],
  ["device-dependencies"],
]

export function DependencyMediumForm({
  medium,
  onSaved,
  onCancel,
}: DependencyMediumFormProps) {
  const isEdit = !!medium
  const qc = useQueryClient()
  const saveObject = useSaveObject()
  const { fieldErrors, handleApiError } = useFieldErrors()

  const [name, setName] = useState(medium?.name ?? "")
  const [color, setColor] = useState(medium?.color ?? "")
  const [icon, setIcon] = useState(medium?.icon ?? "")
  const [lineStyle, setLineStyle] = useState<DependencyLineStyle>(
    medium?.line_style ?? "solid"
  )
  const [weight, setWeight] = useState(String(medium?.weight ?? 100))
  const [description, setDescription] = useState(medium?.description ?? "")

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: DependencyMediumWritePayload = {
        name: name.trim(),
        color,
        icon,
        line_style: lineStyle,
        weight: Math.max(0, Number(weight) || 0),
        description: description.trim(),
      }
      return saveObject<DependencyMedium>({
        objectType: "api.dependencymedium",
        endpoint: "/api/dependency-media/",
        id: medium?.id,
        payload,
      })
    },
    onSuccess: (saved) => {
      for (const queryKey of DEPENDENCY_MEDIUM_KEYS)
        qc.invalidateQueries({ queryKey })
      qc.invalidateQueries({ queryKey: ["dependency-medium", saved.id] })
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
      <FormSection title="Dependency medium" card>
        <FormText
          label="Name"
          required
          autoFocus={!isEdit}
          value={name}
          onChange={setName}
          placeholder="Fibre, Radio, VPN…"
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
        <div className="grid gap-3 @md:grid-cols-2 @2xl:grid-cols-4">
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
          <FormSelect
            label="Line"
            value={lineStyle}
            onChange={(v) => setLineStyle(v as DependencyLineStyle)}
            options={LINE_STYLES}
            info="How the maps draw a dependency over this medium."
            error={fieldErrors.line_style}
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
            <DependencyMediumBadge
              medium={{ name: name || "Medium", color, icon }}
            />
          </div>
        </Field>
      </FormSection>
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create medium"}
      />
    </form>
  )
}
