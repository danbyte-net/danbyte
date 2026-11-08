import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { apiAll } from "@/lib/api-all"
import type {
  CoolingSource,
  CoolingSourceWritePayload,
  LocationOption,
  Status,
} from "@/lib/api"
import { useSiteOptions } from "@/lib/use-site-options"
import { useDcimChoices } from "@/lib/use-dcim-choices"
import { kwToWatts, wattsToKw } from "@/lib/rack-capacity"
import {
  FormColumn,
  FormColumns,
  FormCombobox,
  FormFooter,
  FormSection,
  FormSelect,
  FormStatusSelect,
  FormTags,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { DevicePicker } from "@/components/device-picker"
import { CustomFieldInputs } from "@/components/custom-field-inputs"
import { useSaveObject } from "@/lib/save-object"

export interface CoolingSourceFormProps {
  source?: CoolingSource
  onSaved: (v: CoolingSource) => void
  onCancel: () => void
}

/** A cooling unit (#434): where it stands, what it is, and the heat it is
 * rated to remove - entered in kW, stored in watts. */
export function CoolingSourceForm({
  source,
  onSaved,
  onCancel,
}: CoolingSourceFormProps) {
  const isEdit = !!source
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const saveObject = useSaveObject()
  const choices = useDcimChoices()

  const [name, setName] = useState(source?.name ?? "")
  const [siteId, setSiteId] = useState<string | null>(source?.site?.id ?? null)
  const [locationId, setLocationId] = useState<string | null>(
    source?.location?.id ?? null
  )
  const [statusId, setStatusId] = useState<string | null>(
    source?.status?.id ?? null
  )
  const [type, setType] = useState<string>(source?.type ?? "other")
  const [fluid, setFluid] = useState<string | null>(source?.fluid || null)
  const [ratedKw, setRatedKw] = useState(wattsToKw(source?.rated_capacity_w))
  const [group, setGroup] = useState(source?.redundancy_group ?? "")
  const [deviceId, setDeviceId] = useState<string | null>(
    source?.device?.id ?? null
  )
  const [comments, setComments] = useState(source?.comments ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    source?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    source?.custom_fields ?? {}
  )

  useEffect(() => {
    if (!source) return
    setName(source.name)
    setSiteId(source.site?.id ?? null)
    setLocationId(source.location?.id ?? null)
    setStatusId(source.status?.id ?? null)
    setType(source.type)
    setFluid(source.fluid || null)
    setRatedKw(wattsToKw(source.rated_capacity_w))
    setGroup(source.redundancy_group)
    setDeviceId(source.device?.id ?? null)
    setComments(source.comments)
    setTagIds(source.tags.map((t) => t.id))
    setCustomFields(source.custom_fields)
    reset()
  }, [source, reset])

  const sites = useSiteOptions()
  // Locations are per-site - the list follows the chosen site.
  const locations = useQuery({
    queryKey: ["locations-picker", siteId],
    queryFn: () =>
      apiAll<LocationOption>(`/api/locations/?picker=1&site=${siteId}`),
    enabled: !!siteId,
    staleTime: 5 * 60_000,
  })
  const statuses = useQuery({
    queryKey: ["statuses", "coolingsource"],
    queryFn: () =>
      apiAll<Status>("/api/statuses/?available_to=coolingsource&picker=1"),
    staleTime: 5 * 60_000,
  })

  // A new source starts at the catalog's default status for its kind.
  useEffect(() => {
    if (isEdit || statusId) return
    const d = statuses.data?.results.find((s) =>
      s.default_for.includes("coolingsource")
    )
    if (d) setStatusId(d.id)
  }, [isEdit, statusId, statuses.data])

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: CoolingSourceWritePayload = {
        name: name.trim(),
        site_id: siteId ?? "",
        location_id: locationId,
        status_id: statusId,
        type,
        fluid: fluid ?? "",
        rated_capacity_w: kwToWatts(ratedKw),
        redundancy_group: group.trim(),
        device_id: deviceId,
        comments: comments.trim(),
        tag_ids: tagIds,
        custom_fields: customFields,
      }
      return saveObject<CoolingSource>({
        objectType: "api.coolingsource",
        endpoint: "/api/cooling-sources/",
        id: isEdit ? source.id : undefined,
        payload,
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["cooling-sources"] })
      qc.invalidateQueries({ queryKey: ["cooling-sources-picker"] })
      qc.invalidateQueries({ queryKey: ["cooling-source", saved.id] })
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
      <FormColumns>
        <FormColumn>
          <FormSection title="Cooling source" card>
            <div className="grid gap-3 @md:grid-cols-2">
              <FormText
                label="Name"
                required
                autoFocus={!isEdit}
                value={name}
                onChange={setName}
                error={fieldErrors.name}
              />
              <FormStatusSelect
                value={statusId}
                onChange={setStatusId}
                options={statuses.data?.results ?? []}
                noneLabel="No status"
                placeholder="Select a status…"
                error={fieldErrors.status_id}
              />
            </div>
            <div className="grid gap-3 @md:grid-cols-2">
              <FormCombobox
                label="Site"
                required
                value={siteId}
                onChange={(v) => {
                  setSiteId(v)
                  setLocationId(null) // locations are per-site
                }}
                options={sites.options.map((s) => ({
                  value: s.id,
                  label: s.name,
                }))}
                placeholder="Select site"
                searchPlaceholder="Search sites…"
                emptyText="No sites."
                error={fieldErrors.site_id}
              />
              <FormCombobox
                label="Location"
                hint="optional"
                value={locationId}
                onChange={setLocationId}
                options={(locations.data?.results ?? []).map((l) => ({
                  value: l.id,
                  label: l.name,
                }))}
                noneLabel="No location"
                placeholder={
                  siteId ? "Select a location…" : "Pick a site first"
                }
                searchPlaceholder="Search locations…"
                emptyText="No locations in this site."
                disabled={!siteId}
                error={fieldErrors.location_id}
              />
            </div>
            <DevicePicker
              label="Device"
              hint="optional"
              info="The device that is this unit, when it is tracked as one."
              value={deviceId}
              onChange={setDeviceId}
              siteId={siteId ?? undefined}
              noneLabel="No device"
              error={fieldErrors.device_id}
            />
          </FormSection>

          <FormSection title="Notes" card>
            <FormTextarea
              label="Comments"
              value={comments}
              onChange={setComments}
              error={fieldErrors.comments}
            />
          </FormSection>
        </FormColumn>

        <FormColumn>
          <FormSection title="Unit" card>
            <div className="grid gap-3 @md:grid-cols-2">
              <FormSelect
                label="Type"
                value={type}
                onChange={(v) => setType(v ?? "other")}
                options={choices.cooling_source_types}
                error={fieldErrors.type}
              />
              <FormSelect
                label="Fluid"
                value={fluid}
                onChange={setFluid}
                noneLabel="Not recorded"
                placeholder="Not recorded"
                options={choices.cooling_fluids}
                error={fieldErrors.fluid}
              />
            </div>
            <div className="grid gap-3 @md:grid-cols-2">
              <FormText
                label="Rated capacity (kW)"
                hint="optional"
                info="The heat the unit removes. The racks its feeds reach are measured against it."
                type="number"
                inputMode="decimal"
                min={0}
                step={0.001}
                value={ratedKw}
                onChange={setRatedKw}
                error={fieldErrors.rated_capacity_w}
              />
              <FormText
                label="Redundancy group"
                hint="optional"
                info="Units sharing a group back each other up."
                value={group}
                onChange={setGroup}
                error={fieldErrors.redundancy_group}
              />
            </div>
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
        model="coolingsource"
        value={customFields}
        onChange={setCustomFields}
      />
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create source"}
      />
    </form>
  )
}
