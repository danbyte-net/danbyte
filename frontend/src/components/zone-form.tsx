import { useEffect, useRef, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import type { Zone, ZoneWritePayload } from "@/lib/api"
import { Button } from "@/components/ui/button"
import {
  FormColor,
  FormFooter,
  FormSection,
  FormTags,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { CustomFieldInputs } from "@/components/custom-field-inputs"
import { useSaveObject } from "@/lib/save-object"

export interface ZoneFormProps {
  zone?: Zone
  onSaved: (z: Zone) => void
  onCancel: () => void
}

export function ZoneForm({ zone, onSaved, onCancel }: ZoneFormProps) {
  const isEdit = !!zone
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const saveObject = useSaveObject()

  const [name, setName] = useState(zone?.name ?? "")
  const [color, setColor] = useState(zone?.color ?? "")
  const [description, setDescription] = useState(zone?.description ?? "")
  const [weight, setWeight] = useState(zone ? String(zone.weight) : "100")
  const [tagIds, setTagIds] = useState<number[]>(
    zone?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    zone?.custom_fields ?? {}
  )
  // "Create & add another": stay on the form and reset it after saving, so a
  // whole zone catalog (trust/untrust/dmz/…) can be typed in one sitting.
  const addAnother = useRef(false)

  useEffect(() => {
    if (!zone) return
    setName(zone.name)
    setColor(zone.color)
    setDescription(zone.description)
    setWeight(String(zone.weight))
    setTagIds(zone.tags.map((t) => t.id))
    setCustomFields(zone.custom_fields ?? {})
    reset()
  }, [zone, reset])

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: ZoneWritePayload = {
        name: name.trim(),
        color: color || "",
        description: description.trim(),
        weight: weight.trim() === "" ? 100 : Number(weight),
        tag_ids: tagIds,
        custom_fields: customFields,
      }
      return saveObject<Zone>({
        objectType: "api.zone",
        endpoint: "/api/zones/",
        id: isEdit ? zone!.id : undefined,
        payload,
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["zones"] })
      qc.invalidateQueries({ queryKey: ["zones-picker"] })
      qc.invalidateQueries({ queryKey: ["zone", saved.id] })
      toast.success(isEdit ? `Updated ${saved.name}` : `Created ${saved.name}`)
      if (addAnother.current) {
        addAnother.current = false
        setName("")
        setColor("")
        setDescription("")
        setWeight("100")
        setTagIds([])
        setCustomFields({})
        reset()
        return // stay here for the next one
      }
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
      <FormSection title="Zone" card>
        <FormText
          label="Name"
          required
          autoFocus={!isEdit}
          value={name}
          onChange={setName}
          placeholder="trust"
          error={fieldErrors.name}
        />
        <div className="grid gap-3 @md:grid-cols-2">
          <FormColor
            label="Color"
            value={color}
            onChange={setColor}
            error={fieldErrors.color}
          />
          <FormText
            label="Weight"
            type="number"
            value={weight}
            onChange={setWeight}
            hint="Lower sorts first"
            error={fieldErrors.weight}
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
      </FormSection>

      <FormTags
        label="Tags"
        value={tagIds}
        onChange={setTagIds}
        error={fieldErrors.tag_ids}
      />
      <CustomFieldInputs
        model="zone"
        value={customFields}
        onChange={setCustomFields}
      />
      <div className="flex items-center gap-2">
        {!isEdit && (
          <Button
            type="button"
            variant="outline"
            disabled={mutation.isPending}
            onClick={() => {
              addAnother.current = true
              mutation.mutate()
            }}
          >
            Create & add another
          </Button>
        )}
        <div className="flex-1">
          <FormFooter
            onCancel={onCancel}
            submitting={mutation.isPending}
            submitLabel={isEdit ? "Save changes" : "Create zone"}
          />
        </div>
      </div>
    </form>
  )
}
