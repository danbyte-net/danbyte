import { useEffect, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type {
  Cabinet,
  CabinetRoleOption,
  CabinetTypeOption,
  CabinetWritePayload,
  LocationOption,
  Paginated,
  Status,
} from "@/lib/api"
import { cabinetTypeLabel, invalidateCabinetViews } from "@/lib/cabinets"
import { useSaveObject } from "@/lib/save-object"
import { invalidateSiteViews } from "@/lib/site-cache"
import { useSiteOptions } from "@/lib/use-site-options"
import {
  FormColumn,
  FormColumns,
  FormCombobox,
  FormFooter,
  FormSection,
  FormStatusSelect,
  FormTags,
  FormText,
  FormTextarea,
  QuickAddDialog,
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
import { CustomFieldInputs } from "@/components/custom-field-inputs"

export interface CabinetFormProps {
  cabinet?: Cabinet
  /** Pre-pick a cabinet type on a NEW cabinet - "Add cabinet" from a type. */
  initialCabinetTypeId?: string
  onSaved: (saved: Cabinet) => void
  onCancel: () => void
}

export function CabinetForm({
  cabinet,
  initialCabinetTypeId,
  onSaved,
  onCancel,
}: CabinetFormProps) {
  const isEdit = !!cabinet
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const saveObject = useSaveObject()

  const [name, setName] = useState(cabinet?.name ?? "")
  const [facilityId, setFacilityId] = useState(cabinet?.facility_id ?? "")
  const [siteId, setSiteId] = useState<string | null>(cabinet?.site.id ?? null)
  const [locationId, setLocationId] = useState<string | null>(
    cabinet?.location?.id ?? null
  )
  const [roleId, setRoleId] = useState<string | null>(cabinet?.role?.id ?? null)
  const [cabinetTypeId, setCabinetTypeId] = useState<string | null>(
    cabinet?.cabinet_type?.id ?? initialCabinetTypeId ?? null
  )
  const [statusId, setStatusId] = useState<string | null>(
    cabinet?.status?.id ?? null
  )
  const [sizes, setSizes] = useState<CabinetSizeValues>(() =>
    cabinet ? sizeValues(cabinet) : NO_SIZES
  )
  const [description, setDescription] = useState(cabinet?.description ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    cabinet?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    cabinet?.custom_fields ?? {}
  )

  useEffect(() => {
    if (!cabinet) return
    setName(cabinet.name)
    setFacilityId(cabinet.facility_id)
    setSiteId(cabinet.site.id)
    setLocationId(cabinet.location?.id ?? null)
    setRoleId(cabinet.role?.id ?? null)
    setCabinetTypeId(cabinet.cabinet_type?.id ?? null)
    setStatusId(cabinet.status?.id ?? null)
    setSizes(sizeValues(cabinet))
    setDescription(cabinet.description)
    setTagIds(cabinet.tags.map((t) => t.id))
    setCustomFields(cabinet.custom_fields)
    reset()
  }, [cabinet, reset])

  const sites = useSiteOptions()
  // Enhanced site separation: a single-site user's creates land in their own
  // site - prefill and lock the picker (useSiteOptions already filtered it).
  const siteLocked = !!sites.lockedId
  useEffect(() => {
    if (!isEdit && sites.lockedId && !siteId) setSiteId(sites.lockedId)
  }, [isEdit, sites.lockedId, siteId])

  const roles = useQuery({
    queryKey: ["cabinet-roles-picker"],
    queryFn: () =>
      api<Paginated<CabinetRoleOption>>("/api/cabinet-roles/?picker=1"),
    staleTime: 10 * 60_000,
  })
  // The picker shape carries each type's sizes for the client-side prefill.
  const cabinetTypes = useQuery({
    queryKey: ["cabinet-types-picker"],
    queryFn: () =>
      api<Paginated<CabinetTypeOption>>("/api/cabinet-types/?picker=1"),
    staleTime: 5 * 60_000,
  })
  const statuses = useQuery({
    queryKey: ["statuses", "cabinet"],
    queryFn: () =>
      api<Paginated<Status>>("/api/statuses/?available_to=cabinet&picker=1"),
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

  // Arriving from a cabinet type ("Add cabinet" on its page) pre-picks the
  // type before its sizes have loaded - fill them once they land, and only
  // once, so it never clobbers sizes the operator has already typed.
  const prefilled = useRef(false)
  useEffect(() => {
    if (isEdit || prefilled.current || !initialCabinetTypeId) return
    const t = cabinetTypes.data?.results.find(
      (x) => x.id === initialCabinetTypeId
    )
    if (!t) return
    prefilled.current = true
    setSizes(sizeValues(t))
  }, [isEdit, initialCabinetTypeId, cabinetTypes.data])

  // A new cabinet starts on the status flagged default for cabinets - once,
  // so picking "No status" afterwards sticks.
  const defaulted = useRef(false)
  useEffect(() => {
    if (isEdit || defaulted.current || !statuses.data) return
    defaulted.current = true
    const d = statuses.data.results.find((s) =>
      s.default_for.includes("cabinet")
    )
    if (d) setStatusId(d.id)
  }, [isEdit, statuses.data])

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: CabinetWritePayload = {
        name: name.trim(),
        facility_id: facilityId.trim(),
        site_id: siteId ?? "",
        location_id: locationId,
        role_id: roleId,
        cabinet_type_id: cabinetTypeId,
        status_id: statusId,
        inner_width_mm: mm(sizes.inner_width_mm),
        inner_height_mm: mm(sizes.inner_height_mm),
        outer_width_mm: mmOrNull(sizes.outer_width_mm),
        outer_height_mm: mmOrNull(sizes.outer_height_mm),
        outer_depth_mm: mmOrNull(sizes.outer_depth_mm),
        description: description.trim(),
        tag_ids: tagIds,
        custom_fields: customFields,
      }
      return saveObject<Cabinet>({
        objectType: "api.cabinet",
        endpoint: "/api/cabinets/",
        id: cabinet?.id,
        payload,
      })
    },
    onSuccess: (saved) => {
      invalidateCabinetViews(qc)
      qc.invalidateQueries({ queryKey: ["cabinet", saved.id] })
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
          <FormSection title="Cabinet" card>
            <FormText
              label="Name"
              required
              autoFocus={!isEdit}
              value={name}
              onChange={setName}
              placeholder="dist-board-1"
              error={fieldErrors.name}
            />

            <div className="grid gap-3 @md:grid-cols-2">
              <FormText
                label="Facility ID"
                hint="optional"
                value={facilityId}
                onChange={setFacilityId}
                mono
                placeholder="=UH1+K1"
                error={fieldErrors.facility_id}
              />
              <FormStatusSelect
                value={statusId}
                onChange={setStatusId}
                options={statuses.data?.results ?? []}
                error={fieldErrors.status_id}
              />
            </div>

            <FormCombobox
              label="Site"
              required
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
                    invalidateSiteViews(qc)
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
                color: r.color,
              }))}
              noneLabel="No role"
              placeholder="Select a cabinet role…"
              searchPlaceholder="Search roles…"
              emptyText="No cabinet roles."
              error={fieldErrors.role_id}
              quickAdd={
                <QuickAddDialog
                  title="New cabinet role"
                  endpoint="/api/cabinet-roles/"
                  fields={[
                    { name: "name", label: "Name", required: true },
                    {
                      name: "description",
                      label: "Description",
                      type: "textarea",
                    },
                  ]}
                  onCreated={(r) => {
                    qc.invalidateQueries({
                      queryKey: ["cabinet-roles-picker"],
                    })
                    setRoleId(r.id)
                  }}
                />
              }
            />

            <FormCombobox
              label="Cabinet type"
              hint="optional · fills the sizes"
              value={cabinetTypeId}
              onChange={(v) => {
                setCabinetTypeId(v)
                // Picking a type copies its sizes into the fields below; the
                // cabinet stays the source of truth and each stays editable.
                const t = cabinetTypes.data?.results.find((x) => x.id === v)
                if (t) setSizes(sizeValues(t))
              }}
              options={(cabinetTypes.data?.results ?? []).map((t) => ({
                value: t.id,
                label: cabinetTypeLabel(t),
              }))}
              noneLabel="No cabinet type"
              placeholder="Select a cabinet type…"
              searchPlaceholder="Search cabinet types…"
              emptyText="No cabinet types."
              error={fieldErrors.cabinet_type_id}
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

      <CustomFieldInputs
        model="cabinet"
        value={customFields}
        onChange={setCustomFields}
      />

      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create cabinet"}
      />
    </form>
  )
}
