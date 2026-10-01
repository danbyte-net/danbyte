import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  CabinetType,
  CabinetTypeWritePayload,
  ManufacturerOption,
  Paginated,
} from "@/lib/api"
import {
  FormColumn,
  FormColumns,
  FormCombobox,
  FormFooter,
  FormSection,
  FormTags,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import {
  CabinetSizeFields,
  NO_SIZES,
  mm,
  mmOrNull,
  sizeValues,
} from "@/components/cabinet-size-fields"
import type { CabinetSizeValues } from "@/components/cabinet-size-fields"
import { useSaveObject } from "@/lib/save-object"

export interface CabinetTypeFormProps {
  cabinetType?: CabinetType
  onSaved: (saved: CabinetType) => void
  onCancel: () => void
}

export function CabinetTypeForm({
  cabinetType,
  onSaved,
  onCancel,
}: CabinetTypeFormProps) {
  const isEdit = !!cabinetType
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const saveObject = useSaveObject()

  const [name, setName] = useState(cabinetType?.name ?? "")
  const [manufacturerId, setManufacturerId] = useState<string | null>(
    cabinetType?.manufacturer?.id ?? null
  )
  const [sizes, setSizes] = useState<CabinetSizeValues>(() =>
    cabinetType ? sizeValues(cabinetType) : NO_SIZES
  )
  const [description, setDescription] = useState(cabinetType?.description ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    cabinetType?.tags.map((t) => t.id) ?? []
  )

  useEffect(() => {
    if (!cabinetType) return
    setName(cabinetType.name)
    setManufacturerId(cabinetType.manufacturer?.id ?? null)
    setSizes(sizeValues(cabinetType))
    setDescription(cabinetType.description)
    setTagIds(cabinetType.tags.map((t) => t.id))
    reset()
  }, [cabinetType, reset])

  const manufacturers = useQuery({
    queryKey: ["manufacturers-picker"],
    queryFn: () =>
      api<Paginated<ManufacturerOption>>("/api/manufacturers/?picker=1"),
    staleTime: 10 * 60_000,
  })

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: CabinetTypeWritePayload = {
        name: name.trim(),
        manufacturer_id: manufacturerId,
        inner_width_mm: mm(sizes.inner_width_mm),
        inner_height_mm: mm(sizes.inner_height_mm),
        outer_width_mm: mmOrNull(sizes.outer_width_mm),
        outer_height_mm: mmOrNull(sizes.outer_height_mm),
        outer_depth_mm: mmOrNull(sizes.outer_depth_mm),
        description: description.trim(),
        tag_ids: tagIds,
      }
      return saveObject<CabinetType>({
        objectType: "api.cabinettype",
        endpoint: "/api/cabinet-types/",
        id: cabinetType?.id,
        payload,
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["cabinet-types"] })
      qc.invalidateQueries({ queryKey: ["cabinet-types-picker"] })
      qc.invalidateQueries({ queryKey: ["cabinet-type", saved.id] })
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
      <FormColumns>
        <FormColumn>
          <FormSection title="Cabinet type" card>
            <FormText
              label="Name"
              required
              autoFocus={!isEdit}
              value={name}
              onChange={setName}
              placeholder="AE 1060.500"
              error={fieldErrors.name}
            />
            <FormCombobox
              label="Manufacturer"
              hint="optional"
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
          </FormSection>

          <FormSection title="Notes" card>
            <FormTextarea
              label="Description"
              value={description}
              onChange={setDescription}
              error={fieldErrors.description}
            />
          </FormSection>
        </FormColumn>

        <FormColumn>
          <FormSection title="Sizes" card>
            <CabinetSizeFields
              value={sizes}
              onChange={setSizes}
              errors={fieldErrors}
            />
          </FormSection>
        </FormColumn>
      </FormColumns>

      <FormTags
        label="Tags"
        value={tagIds}
        onChange={setTagIds}
        error={fieldErrors.tag_ids}
      />

      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create cabinet type"}
      />
    </form>
  )
}
