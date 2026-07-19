import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useSiteOptions } from "@/lib/use-site-options"
import { toast } from "sonner"

import {
  api,
  type Paginated,
  type Rack,
  type RackRoleOption,
  type RackWidth,
  type RackWritePayload,
  type LocationOption,
  type Status,
} from "@/lib/api"
import {
  FormCheckbox,
  FormCombobox,
  FormFooter,
  FormSelect,
  FormTags,
  FormText,
  FormTextarea,
  QuickAddDialog,
  useFieldErrors,
} from "@/components/forms"
import { CustomFieldInputs } from "@/components/custom-field-inputs"

const WIDTHS: { value: RackWidth; label: string }[] = [
  { value: 10, label: '10"' },
  { value: 19, label: '19"' },
  { value: 21, label: '21"' },
  { value: 23, label: '23"' },
]

export interface RackFormProps {
  rack?: Rack
  onSaved: (saved: Rack) => void
  onCancel: () => void
}

export function RackForm({ rack, onSaved, onCancel }: RackFormProps) {
  const isEdit = !!rack
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [name, setName] = useState(rack?.name ?? "")
  const [facilityId, setFacilityId] = useState(rack?.facility_id ?? "")
  const [siteId, setSiteId] = useState<string | null>(rack?.site?.id ?? null)
  const [roleId, setRoleId] = useState<string | null>(rack?.role?.id ?? null)
  const [locationId, setLocationId] = useState<string | null>(
    rack?.location?.id ?? null
  )
  const [statusId, setStatusId] = useState<string | null>(
    rack?.status?.id ?? null
  )
  const [width, setWidth] = useState<RackWidth>(rack?.width ?? 19)
  const [uHeight, setUHeight] = useState(rack ? String(rack.u_height) : "42")
  const [startingUnit, setStartingUnit] = useState(
    rack ? String(rack.starting_unit) : "1"
  )
  const [descUnits, setDescUnits] = useState(rack?.desc_units ?? false)
  const [maxWeight, setMaxWeight] = useState(rack?.max_weight ?? "")
  const [maxWeightUnit, setMaxWeightUnit] = useState(
    rack?.max_weight_unit || "kg"
  )
  const [description, setDescription] = useState(rack?.description ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    rack?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    rack?.custom_fields ?? {}
  )

  useEffect(() => {
    if (!rack) return
    setName(rack.name)
    setFacilityId(rack.facility_id)
    setSiteId(rack.site?.id ?? null)
    setRoleId(rack.role?.id ?? null)
    setLocationId(rack.location?.id ?? null)
    setStatusId(rack.status?.id ?? null)
    setWidth(rack.width)
    setUHeight(String(rack.u_height))
    setStartingUnit(String(rack.starting_unit))
    setDescUnits(rack.desc_units)
    setMaxWeight(rack.max_weight ?? "")
    setMaxWeightUnit(rack.max_weight_unit || "kg")
    setDescription(rack.description)
    setTagIds(rack.tags.map((t) => t.id))
    setCustomFields(rack.custom_fields ?? {})
    reset()
  }, [rack, reset])

  const sites = useSiteOptions()
  // Enhanced site separation: a single-site user's creates land in their own
  // site — prefill and lock the picker (useSiteOptions already filtered it).
  const siteLocked = !!sites.lockedId
  useEffect(() => {
    if (!isEdit && sites.lockedId && !siteId) setSiteId(sites.lockedId)
  }, [isEdit, sites.lockedId, siteId])
  const roles = useQuery({
    queryKey: ["rack-roles-picker"],
    queryFn: () => api<Paginated<RackRoleOption>>("/api/rack-roles/?picker=1"),
    staleTime: 10 * 60_000,
  })
  const statuses = useQuery({
    queryKey: ["statuses", "rack"],
    queryFn: () =>
      api<Paginated<Status>>("/api/statuses/?available_to=rack&picker=1"),
    staleTime: 5 * 60_000,
  })
  // Locations are per-site — the list follows the chosen site.
  const locations = useQuery({
    queryKey: ["locations-picker", siteId],
    queryFn: () =>
      api<Paginated<LocationOption>>(`/api/locations/?picker=1&site=${siteId}`),
    enabled: !!siteId,
    staleTime: 5 * 60_000,
  })

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: RackWritePayload = {
        name: name.trim(),
        facility_id: facilityId.trim(),
        site_id: siteId ?? "",
        role_id: roleId,
        location_id: locationId,
        status_id: statusId,
        width,
        u_height: uHeight.trim() === "" ? 42 : Number(uHeight),
        starting_unit: startingUnit.trim() === "" ? 1 : Number(startingUnit),
        desc_units: descUnits,
        max_weight: maxWeight.trim() === "" ? null : maxWeight.trim(),
        max_weight_unit: maxWeight.trim() === "" ? "" : maxWeightUnit,
        description: description.trim(),
        tag_ids: tagIds,
        custom_fields: customFields,
      }
      if (isEdit)
        return api<Rack>(`/api/racks/${rack!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<Rack>("/api/racks/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["racks"] })
      qc.invalidateQueries({ queryKey: ["racks-picker"] })
      qc.invalidateQueries({ queryKey: ["rack", saved.id] })
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
        placeholder="rack-a1"
        error={fieldErrors.name}
      />

      <FormText
        label="Facility ID"
        hint="optional"
        value={facilityId}
        onChange={setFacilityId}
        mono
        placeholder="R101"
        error={fieldErrors.facility_id}
      />

      <FormCombobox
        label="Site"
        value={siteId}
        onChange={(v) => {
          setSiteId(v)
          setLocationId(null) // locations are per-site
        }}
        disabled={siteLocked}
        options={sites.options.map((s) => ({
          value: s.id,
          label: s.name,
        }))}
        placeholder="Select a site…"
        searchPlaceholder="Search sites…"
        emptyText="No sites."
        error={fieldErrors.site_id}
        quickAdd={
          <QuickAddDialog
            title="New site"
            endpoint="/api/sites/"
            fields={[{ name: "name", label: "Name", required: true }]}
            onCreated={(s) => {
              qc.invalidateQueries({ queryKey: ["sites-picker"] })
              setSiteId(s.id)
            }}
          />
        }
      />

      <FormCombobox
        label="Location"
        hint="optional · within the site"
        value={locationId}
        onChange={setLocationId}
        options={(locations.data?.results ?? []).map((l) => ({
          value: l.id,
          label: l.name,
        }))}
        noneLabel="No location"
        placeholder={siteId ? "Select a location…" : "Pick a site first"}
        searchPlaceholder="Search locations…"
        emptyText="No locations in this site."
        disabled={!siteId}
        error={fieldErrors.location_id}
      />

      <FormCombobox
        label="Role"
        hint="optional"
        value={roleId}
        onChange={setRoleId}
        options={(roles.data?.results ?? []).map((r) => ({
          value: r.id,
          label: r.name,
        }))}
        noneLabel="No role"
        placeholder="Select a rack role…"
        searchPlaceholder="Search roles…"
        emptyText="No rack roles."
        error={fieldErrors.role_id}
        quickAdd={
          <QuickAddDialog
            title="New rack role"
            endpoint="/api/rack-roles/"
            fields={[
              { name: "name", label: "Name", required: true },
              { name: "description", label: "Description", type: "textarea" },
            ]}
            onCreated={(r) => {
              qc.invalidateQueries({ queryKey: ["rack-roles-picker"] })
              setRoleId(r.id)
            }}
          />
        }
      />

      <div className="grid grid-cols-2 gap-3">
        <FormCombobox
          label="Status"
          value={statusId}
          onChange={setStatusId}
          options={(statuses.data?.results ?? []).map((s) => ({
            value: s.id,
            label: s.name,
          }))}
          noneLabel="No status"
          placeholder="Select a status…"
          error={fieldErrors.status_id}
        />
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
      </div>

      <div className="grid grid-cols-2 gap-3">
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
          label="Weight budget"
          hint="optional — floor / rack load rating"
          type="number"
          min={0}
          value={maxWeight}
          onChange={setMaxWeight}
          error={fieldErrors.max_weight}
        />
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

      <CustomFieldInputs
        model="rack"
        value={customFields}
        onChange={setCustomFields}
      />

      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create rack"}
      />
    </form>
  )
}
