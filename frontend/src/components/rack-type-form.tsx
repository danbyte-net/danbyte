import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  ManufacturerOption,
  Paginated,
  RackType,
  RackTypeWritePayload,
  RackWidth,
} from "@/lib/api"
import {
  FormCheckbox,
  FormCombobox,
  FormFooter,
  FormSelect,
  FormTags,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { useSaveObject } from "@/lib/save-object"

const WIDTHS: { value: RackWidth; label: string }[] = [
  { value: 10, label: '10"' },
  { value: 19, label: '19"' },
  { value: 21, label: '21"' },
  { value: 23, label: '23"' },
]

export interface RackTypeFormProps {
  rackType?: RackType
  onSaved: (saved: RackType) => void
  onCancel: () => void
}

export function RackTypeForm({
  rackType,
  onSaved,
  onCancel,
}: RackTypeFormProps) {
  const isEdit = !!rackType
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const saveObject = useSaveObject()

  const [name, setName] = useState(rackType?.name ?? "")
  const [manufacturerId, setManufacturerId] = useState<string | null>(
    rackType?.manufacturer?.id ?? null
  )
  const [width, setWidth] = useState<RackWidth>(rackType?.width ?? 19)
  const [uHeight, setUHeight] = useState(
    rackType ? String(rackType.u_height) : "42"
  )
  const [startingUnit, setStartingUnit] = useState(
    rackType ? String(rackType.starting_unit) : "1"
  )
  const [descUnits, setDescUnits] = useState(rackType?.desc_units ?? false)
  const [outerWidth, setOuterWidth] = useState(
    rackType?.outer_width_mm != null ? String(rackType.outer_width_mm) : ""
  )
  const [outerDepth, setOuterDepth] = useState(
    rackType?.outer_depth_mm != null ? String(rackType.outer_depth_mm) : ""
  )
  const [maxWeight, setMaxWeight] = useState(rackType?.max_weight ?? "")
  const [maxWeightUnit, setMaxWeightUnit] = useState(
    rackType?.max_weight_unit || "kg"
  )
  const [description, setDescription] = useState(rackType?.description ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    rackType?.tags.map((t) => t.id) ?? []
  )

  useEffect(() => {
    if (!rackType) return
    setName(rackType.name)
    setManufacturerId(rackType.manufacturer?.id ?? null)
    setWidth(rackType.width)
    setUHeight(String(rackType.u_height))
    setStartingUnit(String(rackType.starting_unit))
    setDescUnits(rackType.desc_units)
    setOuterWidth(
      rackType.outer_width_mm != null ? String(rackType.outer_width_mm) : ""
    )
    setOuterDepth(
      rackType.outer_depth_mm != null ? String(rackType.outer_depth_mm) : ""
    )
    setMaxWeight(rackType.max_weight ?? "")
    setMaxWeightUnit(rackType.max_weight_unit || "kg")
    setDescription(rackType.description)
    setTagIds(rackType.tags.map((t) => t.id))
    reset()
  }, [rackType, reset])

  const manufacturers = useQuery({
    queryKey: ["manufacturers-picker"],
    queryFn: () =>
      api<Paginated<ManufacturerOption>>("/api/manufacturers/?picker=1"),
    staleTime: 10 * 60_000,
  })

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: RackTypeWritePayload = {
        name: name.trim(),
        manufacturer_id: manufacturerId,
        width,
        u_height: uHeight.trim() === "" ? 42 : Number(uHeight),
        starting_unit: startingUnit.trim() === "" ? 1 : Number(startingUnit),
        desc_units: descUnits,
        outer_width_mm: outerWidth.trim() === "" ? null : Number(outerWidth),
        outer_depth_mm: outerDepth.trim() === "" ? null : Number(outerDepth),
        max_weight: maxWeight.trim() === "" ? null : maxWeight.trim(),
        max_weight_unit: maxWeight.trim() === "" ? "" : maxWeightUnit,
        description: description.trim(),
        tag_ids: tagIds,
      }
      return saveObject<RackType>({
        objectType: "api.racktype",
        endpoint: "/api/rack-types/",
        id: isEdit ? rackType!.id : undefined,
        payload,
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["rack-types"] })
      qc.invalidateQueries({ queryKey: ["rack-types-picker"] })
      qc.invalidateQueries({ queryKey: ["rack-type", saved.id] })
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
      <FormText
        label="Name"
        required
        autoFocus={!isEdit}
        value={name}
        onChange={setName}
        placeholder="NetShelter SX 42U 600mm"
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

      <div className="grid grid-cols-2 gap-3">
        <FormSelect
          label="Width"
          value={String(width)}
          onChange={(v) => v && setWidth(Number(v) as RackWidth)}
          options={WIDTHS.map((w) => ({
            value: String(w.value),
            label: w.label,
          }))}
          error={fieldErrors.width}
        />
        <FormText
          label="Height (U)"
          type="number"
          min={1}
          value={uHeight}
          onChange={setUHeight}
          error={fieldErrors.u_height}
        />
        <FormText
          label="Starting unit"
          type="number"
          value={startingUnit}
          onChange={setStartingUnit}
          error={fieldErrors.starting_unit}
        />
        <FormText
          label="Outer width (mm)"
          hint="optional — cabinet footprint, for 3D & drawings"
          type="number"
          min={100}
          max={2000}
          value={outerWidth}
          onChange={setOuterWidth}
          error={fieldErrors.outer_width_mm}
        />
        <FormText
          label="Outer depth (mm)"
          hint="optional — blank = 1000"
          type="number"
          min={100}
          max={3000}
          value={outerDepth}
          onChange={setOuterDepth}
          error={fieldErrors.outer_depth_mm}
        />
        <FormText
          label="Weight budget"
          hint="optional — the cabinet's load rating"
          type="number"
          min={0}
          value={maxWeight}
          onChange={setMaxWeight}
          error={fieldErrors.max_weight}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <FormSelect
          label="Budget unit"
          value={maxWeightUnit}
          onChange={(v) => setMaxWeightUnit(v ?? "kg")}
          options={[
            { value: "kg", label: "kg" },
            { value: "g", label: "g" },
            { value: "lb", label: "lb" },
            { value: "oz", label: "oz" },
          ]}
          error={fieldErrors.max_weight_unit}
        />
      </div>

      <FormCheckbox
        label="Descending units"
        hint="Number units top-to-bottom (U1 at the top)"
        checked={descUnits}
        onChange={setDescUnits}
      />

      <FormTextarea
        label="Description"
        value={description}
        onChange={setDescription}
        error={fieldErrors.description}
      />

      <FormTags
        label="Tags"
        value={tagIds}
        onChange={setTagIds}
        error={fieldErrors.tag_ids}
      />

      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create rack type"}
      />
    </form>
  )
}
