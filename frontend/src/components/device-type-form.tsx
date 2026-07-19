import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type DeviceType,
  type DeviceTypeWritePayload,
  type ManufacturerOption,
  type Paginated,
  type TagOption,
} from "@/lib/api"
import {
  Field,
  FormFooter,
  FormSelect,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { TagMultiSelect } from "@/components/cells/tag-multi-select"
import { CustomFieldInputs } from "@/components/custom-field-inputs"
import {
  LifecycleFormSection,
  lifecycleFormValue,
  lifecyclePayload,
} from "@/components/lifecycle-fields"

export interface DeviceTypeFormProps {
  deviceType?: DeviceType
  onSaved: (d: DeviceType) => void
  onCancel: () => void
}

export function DeviceTypeForm({
  deviceType,
  onSaved,
  onCancel,
}: DeviceTypeFormProps) {
  const isEdit = !!deviceType
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [name, setName] = useState(deviceType?.name ?? "")
  const [manufacturerId, setManufacturerId] = useState<string | null>(
    deviceType?.manufacturer?.id ?? null
  )
  const [model, setModel] = useState(deviceType?.model ?? "")
  const [partNumber, setPartNumber] = useState(deviceType?.part_number ?? "")
  const [uHeight, setUHeight] = useState(
    deviceType ? String(deviceType.u_height) : "1"
  )
  const [rackWidth, setRackWidth] = useState<"full" | "half">(
    deviceType?.rack_width ?? "full"
  )
  const [description, setDescription] = useState(deviceType?.description ?? "")
  const [isFullDepth, setIsFullDepth] = useState(
    deviceType?.is_full_depth ?? true
  )
  const [airflow, setAirflow] = useState<string | null>(
    deviceType?.airflow || null
  )
  const [weight, setWeight] = useState(deviceType?.weight ?? "")
  const [weightUnit, setWeightUnit] = useState(deviceType?.weight_unit || "kg")
  const [subdeviceRole, setSubdeviceRole] = useState<string | null>(
    deviceType?.subdevice_role || null
  )
  const [excludeUtil, setExcludeUtil] = useState(
    deviceType?.exclude_from_utilization ?? false
  )
  const [tagIds, setTagIds] = useState<number[]>(
    deviceType?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    deviceType?.custom_fields ?? {}
  )
  const [lifecycle, setLifecycle] = useState(lifecycleFormValue(deviceType))

  useEffect(() => {
    if (!deviceType) return
    setName(deviceType.name)
    setManufacturerId(deviceType.manufacturer?.id ?? null)
    setModel(deviceType.model)
    setPartNumber(deviceType.part_number)
    setUHeight(String(deviceType.u_height))
    setRackWidth(deviceType.rack_width)
    setDescription(deviceType.description)
    setIsFullDepth(deviceType.is_full_depth)
    setAirflow(deviceType.airflow || null)
    setWeight(deviceType.weight ?? "")
    setWeightUnit(deviceType.weight_unit || "kg")
    setSubdeviceRole(deviceType.subdevice_role || null)
    setExcludeUtil(deviceType.exclude_from_utilization ?? false)
    setTagIds(deviceType.tags.map((t) => t.id))
    setCustomFields(deviceType.custom_fields ?? {})
    setLifecycle(lifecycleFormValue(deviceType))
    reset()
  }, [deviceType, reset])

  const manufacturers = useQuery({
    queryKey: ["manufacturers-picker"],
    queryFn: () =>
      api<Paginated<ManufacturerOption>>("/api/manufacturers/?picker=1"),
    staleTime: 10 * 60_000,
  })
  const tags = useQuery({
    queryKey: ["tags-picker"],
    queryFn: () => api<Paginated<TagOption>>("/api/tags/"),
    staleTime: 10 * 60_000,
  })

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: DeviceTypeWritePayload = {
        name: name.trim(),
        manufacturer_id: manufacturerId,
        model: model.trim(),
        part_number: partNumber.trim(),
        u_height: uHeight.trim() === "" ? 0 : Number(uHeight),
        rack_width: rackWidth,
        description: description.trim(),
        is_full_depth: isFullDepth,
        airflow: airflow ?? "",
        weight: String(weight).trim() === "" ? null : String(weight).trim(),
        weight_unit: String(weight).trim() === "" ? "" : weightUnit,
        subdevice_role: subdeviceRole ?? "",
        exclude_from_utilization: excludeUtil,
        tag_ids: tagIds,
        custom_fields: customFields,
        ...lifecyclePayload(lifecycle),
      }
      if (isEdit)
        return api<DeviceType>(`/api/device-types/${deviceType!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<DeviceType>("/api/device-types/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["device-types"] })
      qc.invalidateQueries({ queryKey: ["device-types-picker"] })
      qc.invalidateQueries({ queryKey: ["device-type", saved.id] })
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
        placeholder="Catalyst 9300"
        error={fieldErrors.name}
      />
      <FormSelect
        label="Manufacturer"
        value={manufacturerId}
        onChange={setManufacturerId}
        noneLabel="No manufacturer"
        options={(manufacturers.data?.results ?? []).map((m) => ({
          value: m.id,
          label: m.name,
        }))}
        error={fieldErrors.manufacturer_id}
      />
      <div className="grid grid-cols-2 gap-3">
        <FormText
          label="Model"
          value={model}
          onChange={setModel}
          placeholder="C9300-48P"
          error={fieldErrors.model}
        />
        <FormText
          label="Part number"
          value={partNumber}
          onChange={setPartNumber}
          error={fieldErrors.part_number}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <FormText
          label="Rack units (U)"
          type="number"
          value={uHeight}
          onChange={setUHeight}
          hint="0 for non-rack"
          error={fieldErrors.u_height}
        />
        <FormSelect
          label="Rack width"
          hint="half = two per U"
          value={rackWidth}
          onChange={(v) => setRackWidth(v === "half" ? "half" : "full")}
          options={[
            { value: "full", label: "Full width (19″)" },
            { value: "half", label: "Half width (2 side-by-side)" },
          ]}
          error={fieldErrors.rack_width}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <FormSelect
          label="Airflow"
          hint="optional"
          value={airflow}
          onChange={setAirflow}
          noneLabel="Unspecified"
          placeholder="Unspecified"
          options={[
            { value: "front-to-rear", label: "Front to rear" },
            { value: "rear-to-front", label: "Rear to front" },
            { value: "left-to-right", label: "Left to right" },
            { value: "right-to-left", label: "Right to left" },
            { value: "passive", label: "Passive" },
            { value: "mixed", label: "Mixed" },
          ]}
          error={fieldErrors.airflow}
        />
        <div className="grid grid-cols-[1fr_90px] gap-2">
          <FormText
            label="Weight"
            type="number"
            value={String(weight)}
            onChange={setWeight}
            hint="optional"
            error={fieldErrors.weight}
          />
          <FormSelect
            label="Unit"
            value={weightUnit}
            onChange={(v) => v && setWeightUnit(v)}
            options={[
              { value: "kg", label: "kg" },
              { value: "g", label: "g" },
              { value: "lb", label: "lb" },
              { value: "oz", label: "oz" },
            ]}
          />
        </div>
      </div>
      <FormSelect
        label="Subdevice role"
        hint="optional — chassis nesting"
        value={subdeviceRole}
        onChange={setSubdeviceRole}
        noneLabel="Neither"
        placeholder="Neither"
        options={[
          { value: "parent", label: "Parent (chassis with device bays)" },
          { value: "child", label: "Child (installs into a parent's bay)" },
        ]}
        error={fieldErrors.subdevice_role}
      />
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <label className="flex items-center gap-1.5 text-[13px]">
          <input
            type="checkbox"
            className="ck"
            checked={isFullDepth}
            onChange={(e) => setIsFullDepth(e.target.checked)}
          />
          Full depth
          <span className="text-[11px] text-muted-foreground">
            occupies both rack faces
          </span>
        </label>
        <label className="flex items-center gap-1.5 text-[13px]">
          <input
            type="checkbox"
            className="ck"
            checked={excludeUtil}
            onChange={(e) => setExcludeUtil(e.target.checked)}
          />
          Exclude from utilisation
          <span className="text-[11px] text-muted-foreground">
            blanking panels, cable management
          </span>
        </label>
      </div>
      <FormTextarea
        label="Description"
        value={description}
        onChange={setDescription}
        error={fieldErrors.description}
      />
      <LifecycleFormSection
        value={lifecycle}
        onChange={setLifecycle}
        errors={fieldErrors}
      />
      <Field label="Tags" error={fieldErrors.tag_ids}>
        <TagMultiSelect
          options={tags.data?.results ?? []}
          value={tagIds}
          onChange={setTagIds}
        />
      </Field>
      <CustomFieldInputs
        model="devicetype"
        value={customFields}
        onChange={setCustomFields}
      />
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create device type"}
      />
    </form>
  )
}
