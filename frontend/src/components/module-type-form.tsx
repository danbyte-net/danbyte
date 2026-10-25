import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  type ManufacturerOption,
  type ModuleType,
  type ModuleTypeWritePayload,
} from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import {
  FormCombobox,
  FormFooter,
  FormSection,
  FormSelect,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { useSaveObject } from "@/lib/save-object"
import { useDcimChoices } from "@/lib/use-dcim-choices"

export interface ModuleTypeFormProps {
  moduleType?: ModuleType
  onSaved: (m: ModuleType) => void
  onCancel: () => void
}

export function ModuleTypeForm({
  moduleType,
  onSaved,
  onCancel,
}: ModuleTypeFormProps) {
  const isEdit = !!moduleType
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const saveObject = useSaveObject()

  const [name, setName] = useState(moduleType?.name ?? "")
  const [manufacturerId, setManufacturerId] = useState<string | null>(
    moduleType?.manufacturer?.id ?? null
  )
  const [partNumber, setPartNumber] = useState(moduleType?.part_number ?? "")
  const [coolingMethod, setCoolingMethod] = useState<string | null>(
    moduleType?.cooling_method || null
  )
  const [description, setDescription] = useState(moduleType?.description ?? "")

  useEffect(() => {
    if (!moduleType) return
    setName(moduleType.name)
    setManufacturerId(moduleType.manufacturer?.id ?? null)
    setPartNumber(moduleType.part_number)
    setCoolingMethod(moduleType.cooling_method || null)
    setDescription(moduleType.description)
    reset()
  }, [moduleType, reset])
  const choices = useDcimChoices()

  const manufacturers = useQuery({
    queryKey: ["manufacturers-picker"],
    queryFn: () => apiAll<ManufacturerOption>("/api/manufacturers/?picker=1"),
    staleTime: 10 * 60_000,
  })

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: ModuleTypeWritePayload = {
        name: name.trim(),
        manufacturer_id: manufacturerId,
        part_number: partNumber.trim(),
        cooling_method: coolingMethod ?? "",
        description: description.trim(),
      }
      return saveObject<ModuleType>({
        objectType: "api.moduletype",
        endpoint: "/api/module-types/",
        id: isEdit ? moduleType!.id : undefined,
        payload,
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["module-types"] })
      qc.invalidateQueries({ queryKey: ["module-type", saved.id] })
      toast.success(isEdit ? "Module type updated" : "Module type created")
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
      <FormSection title="Module type" card>
        <FormText
          label="Name"
          required
          autoFocus={!isEdit}
          value={name}
          onChange={setName}
          placeholder="C9300-NM-8X"
          error={fieldErrors.name}
        />
        <div className="grid gap-3 @md:grid-cols-2">
          <FormCombobox
            label="Manufacturer"
            value={manufacturerId}
            onChange={setManufacturerId}
            noneLabel="No manufacturer"
            placeholder="Pick a manufacturer"
            searchPlaceholder="Search…"
            emptyText="No manufacturers."
            options={(manufacturers.data?.results ?? []).map((m) => ({
              value: m.id,
              label: m.name,
            }))}
            error={fieldErrors.manufacturer_id}
          />
          <FormText
            label="Part number"
            value={partNumber}
            onChange={setPartNumber}
            mono
            error={fieldErrors.part_number}
          />
          <FormSelect
            label="Cooling"
            value={coolingMethod}
            onChange={setCoolingMethod}
            noneLabel="Unspecified"
            placeholder="Unspecified"
            options={choices.cooling_method}
            error={fieldErrors.cooling_method}
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

      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create module type"}
      />
    </form>
  )
}
