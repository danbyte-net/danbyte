import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type ManufacturerOption,
  type ModuleType,
  type ModuleTypeWritePayload,
  type Paginated,
} from "@/lib/api"
import {
  FormCombobox,
  FormFooter,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"

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

  const [name, setName] = useState(moduleType?.name ?? "")
  const [manufacturerId, setManufacturerId] = useState<string | null>(
    moduleType?.manufacturer?.id ?? null
  )
  const [partNumber, setPartNumber] = useState(moduleType?.part_number ?? "")
  const [description, setDescription] = useState(moduleType?.description ?? "")

  useEffect(() => {
    if (!moduleType) return
    setName(moduleType.name)
    setManufacturerId(moduleType.manufacturer?.id ?? null)
    setPartNumber(moduleType.part_number)
    setDescription(moduleType.description)
    reset()
  }, [moduleType, reset])

  const manufacturers = useQuery({
    queryKey: ["manufacturers-picker"],
    queryFn: () =>
      api<Paginated<ManufacturerOption>>("/api/manufacturers/?picker=1"),
    staleTime: 10 * 60_000,
  })

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: ModuleTypeWritePayload = {
        name: name.trim(),
        manufacturer_id: manufacturerId,
        part_number: partNumber.trim(),
        description: description.trim(),
      }
      if (isEdit)
        return api<ModuleType>(`/api/module-types/${moduleType!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<ModuleType>("/api/module-types/", {
        method: "POST",
        body: JSON.stringify(payload),
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
      className="grid gap-4"
    >
      <FormText
        label="Name"
        required
        autoFocus={!isEdit}
        value={name}
        onChange={setName}
        placeholder="C9300-NM-8X"
        error={fieldErrors.name}
      />
      <div className="grid grid-cols-2 gap-3">
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
      </div>
      <FormTextarea
        label="Description"
        value={description}
        onChange={setDescription}
        error={fieldErrors.description}
      />
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create module type"}
      />
    </form>
  )
}
