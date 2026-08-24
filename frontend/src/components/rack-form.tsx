import { useEffect, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useSiteOptions } from "@/lib/use-site-options"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  LocationOption,
  Paginated,
  Rack,
  RackRoleOption,
  RackType,
  RackWidth,
  RackWritePayload,
  Status,
} from "@/lib/api"
import { useMe } from "@/lib/use-me"
import {
  FormSection,
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
import { useSaveObject } from "@/lib/save-object"

const WIDTHS: { value: RackWidth; label: string }[] = [
  { value: 10, label: '10"' },
  { value: 19, label: '19"' },
  { value: 21, label: '21"' },
  { value: 23, label: '23"' },
]

export interface RackFormProps {
  rack?: Rack
  /** Pre-pick a cabinet model on a NEW rack - "Add rack" from a rack type. */
  initialRackTypeId?: string
  onSaved: (saved: Rack) => void
  onCancel: () => void
}

export function RackForm({
  rack,
  initialRackTypeId,
  onSaved,
  onCancel,
}: RackFormProps) {
  const isEdit = !!rack
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const saveObject = useSaveObject()

  const [name, setName] = useState(rack?.name ?? "")
  const [facilityId, setFacilityId] = useState(rack?.facility_id ?? "")
  const [siteId, setSiteId] = useState<string | null>(rack?.site?.id ?? null)
  const [roleId, setRoleId] = useState<string | null>(rack?.role?.id ?? null)
  const [rackTypeId, setRackTypeId] = useState<string | null>(
    rack?.rack_type?.id ?? initialRackTypeId ?? null
  )
  const [createAccessories, setCreateAccessories] = useState(false)
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
  const [outerWidth, setOuterWidth] = useState(
    rack?.outer_width_mm != null ? String(rack.outer_width_mm) : ""
  )
  // The mounting rail opening is fixed (450 mm at 19"); any outer width beyond
  // it is the ZERO-U SPACE - the channel each side of the rails where vertical
  // PDUs and cable management live. Name it so widening the cabinet reads as
  // "make room for cable management", not a vanity dimension.
  const railOpeningMm = width === 23 ? 546 : 450
  const outerW = Number(outerWidth)
  const zeroUPerSideMm =
    outerWidth.trim() !== "" && outerW > railOpeningMm
      ? Math.round((outerW - railOpeningMm) / 2)
      : 0
  const zeroUHint =
    zeroUPerSideMm > 0
      ? `zero-U space: ${zeroUPerSideMm} mm each side for vertical PDUs & cable management`
      : "optional - widen past the rails to open zero-U space for vertical PDUs & cabling"
  const [outerDepth, setOuterDepth] = useState(
    rack?.outer_depth_mm != null ? String(rack.outer_depth_mm) : ""
  )
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
    setRackTypeId(rack.rack_type?.id ?? null)
    setLocationId(rack.location?.id ?? null)
    setStatusId(rack.status?.id ?? null)
    setWidth(rack.width)
    setUHeight(String(rack.u_height))
    setStartingUnit(String(rack.starting_unit))
    setDescUnits(rack.desc_units)
    setOuterWidth(
      rack.outer_width_mm != null ? String(rack.outer_width_mm) : ""
    )
    setOuterDepth(
      rack.outer_depth_mm != null ? String(rack.outer_depth_mm) : ""
    )
    setMaxWeight(rack.max_weight ?? "")
    setMaxWeightUnit(rack.max_weight_unit || "kg")
    setDescription(rack.description)
    setTagIds(rack.tags.map((t) => t.id))
    setCustomFields(rack.custom_fields ?? {})
    reset()
  }, [rack, reset])

  const sites = useSiteOptions()
  // Enhanced site separation: a single-site user's creates land in their own
  // site - prefill and lock the picker (useSiteOptions already filtered it).
  const siteLocked = !!sites.lockedId
  useEffect(() => {
    if (!isEdit && sites.lockedId && !siteId) setSiteId(sites.lockedId)
  }, [isEdit, sites.lockedId, siteId])
  const roles = useQuery({
    queryKey: ["rack-roles-picker"],
    queryFn: () => api<Paginated<RackRoleOption>>("/api/rack-roles/?picker=1"),
    staleTime: 10 * 60_000,
  })
  // Full shape (not ?picker=1): the accessory list drives the stamping
  // checkbox, and the dims drive the client-side prefill.
  const rackTypes = useQuery({
    queryKey: ["rack-types", "form"],
    queryFn: () => api<Paginated<RackType>>("/api/rack-types/"),
    staleTime: 5 * 60_000,
  })
  const chosenType =
    (rackTypes.data?.results ?? []).find((t) => t.id === rackTypeId) ?? null
  const { canDo } = useMe()
  const canStamp = canDo("device", "add")

  // Picking a cabinet model copies its profile into the editable dim
  // fields - the rack stays the source of truth and every value can still
  // be adjusted before saving.
  const applyTypeProfile = (t: RackType) => {
    setWidth(t.width)
    setUHeight(String(t.u_height))
    setStartingUnit(String(t.starting_unit))
    setDescUnits(t.desc_units)
    setOuterWidth(t.outer_width_mm != null ? String(t.outer_width_mm) : "")
    setOuterDepth(t.outer_depth_mm != null ? String(t.outer_depth_mm) : "")
    setMaxWeight(t.max_weight ?? "")
    setMaxWeightUnit(t.max_weight_unit || "kg")
  }
  // Arriving from a rack type ("Add rack" on its page) pre-picks the model
  // before its dims have loaded - apply the profile once they land, and only
  // once, so it never clobbers edits the operator has already made.
  const prefilled = useRef(false)
  useEffect(() => {
    if (isEdit || prefilled.current || !initialRackTypeId) return
    const t = (rackTypes.data?.results ?? []).find(
      (x) => x.id === initialRackTypeId
    )
    if (!t) return
    prefilled.current = true
    applyTypeProfile(t)
  }, [isEdit, initialRackTypeId, rackTypes.data, applyTypeProfile])
  const statuses = useQuery({
    queryKey: ["statuses", "rack"],
    queryFn: () =>
      api<Paginated<Status>>("/api/statuses/?available_to=rack&picker=1"),
    staleTime: 5 * 60_000,
  })
  // Locations are per-site - the list follows the chosen site.
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
        rack_type_id: rackTypeId,
        create_accessories:
          !isEdit && createAccessories && !!rackTypeId && canStamp,
        location_id: locationId,
        status_id: statusId,
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
        custom_fields: customFields,
      }
      return saveObject<Rack>({
        objectType: "api.rack",
        endpoint: "/api/racks/",
        id: isEdit ? rack!.id : undefined,
        payload,
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
      className="@container grid gap-4"
    >
      <FormSection title="Rack">
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

        <FormCombobox
          label="Rack type"
          hint="optional · cabinet model - picking one fills the dims below"
          value={rackTypeId}
          onChange={(v) => {
            setRackTypeId(v)
            if (!v) setCreateAccessories(false)
            const t = (rackTypes.data?.results ?? []).find((x) => x.id === v)
            if (t) applyTypeProfile(t)
          }}
          options={(rackTypes.data?.results ?? []).map((t) => ({
            value: t.id,
            label: t.manufacturer ? `${t.manufacturer.name} ${t.name}` : t.name,
          }))}
          noneLabel="No rack type"
          placeholder="Select a rack type…"
          searchPlaceholder="Search rack types…"
          emptyText="No rack types."
          error={fieldErrors.rack_type_id}
        />

        {!isEdit && chosenType && chosenType.accessories.length > 0 && (
          <FormCheckbox
            label={`Create ${chosenType.accessories.length} accessor${
              chosenType.accessories.length === 1 ? "y" : "ies"
            } (${chosenType.accessories.map((a) => a.label).join(", ")})`}
            hint={
              canStamp
                ? "Stamps each strip as a side-mounted device named {rack}-{label}"
                : "Requires permission to add devices"
            }
            checked={createAccessories && canStamp}
            onChange={(v) => setCreateAccessories(v && canStamp)}
            disabled={!canStamp}
          />
        )}
      </FormSection>

      <FormSection title="Dimensions" collapsible storageKey="rack" hasValues>
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
            label="Outer width (mm)"
            hint={zeroUHint}
            type="number"
            min={100}
            max={2000}
            value={outerWidth}
            onChange={setOuterWidth}
            error={fieldErrors.outer_width_mm}
          />
          <FormText
            label="Outer depth (mm)"
            hint="optional - blank = 1000"
            type="number"
            min={100}
            max={3000}
            value={outerDepth}
            onChange={setOuterDepth}
            error={fieldErrors.outer_depth_mm}
          />
          <FormText
            label="Weight budget"
            hint="optional - floor / rack load rating"
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
      </FormSection>

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
