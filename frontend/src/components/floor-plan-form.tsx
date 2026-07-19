import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { useSiteOptions } from "@/lib/use-site-options"
import type {
  FloorPlan,
  FloorPlanWritePayload,
  LocationOption,
  Paginated,
} from "@/lib/api"
import {
  FormCombobox,
  FormFooter,
  FormRow,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"

export interface FloorPlanFormProps {
  plan?: FloorPlan
  /** Preselect the location (e.g. arriving from a Location page). */
  initialLocationId?: string
  onSaved: (saved: FloorPlan) => void
  onCancel: () => void
}

export function FloorPlanForm({
  plan,
  initialLocationId,
  onSaved,
  onCancel,
}: FloorPlanFormProps) {
  const isEdit = !!plan
  const qc = useQueryClient()
  const { fieldErrors, handleApiError } = useFieldErrors()

  const [name, setName] = useState(plan?.name ?? "")
  const [siteId, setSiteId] = useState<string | null>(plan?.site.id ?? null)
  const [locationId, setLocationId] = useState<string | null>(
    plan?.location.id ?? initialLocationId ?? null
  )
  const [gridWidth, setGridWidth] = useState(String(plan?.grid_width ?? 24))
  const [gridHeight, setGridHeight] = useState(String(plan?.grid_height ?? 16))
  const [description, setDescription] = useState(plan?.description ?? "")

  const sites = useSiteOptions()
  // Locations are per-site — the list follows the chosen site. With no site
  // picked yet (e.g. prefilled location from a Location page) list them all
  // so the prefill resolves.
  const locations = useQuery({
    queryKey: ["locations-picker", siteId ?? "all"],
    queryFn: () =>
      api<Paginated<LocationOption>>(
        siteId
          ? `/api/locations/?picker=1&site=${siteId}`
          : "/api/locations/?picker=1"
      ),
  })

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: FloorPlanWritePayload = {
        name: name.trim(),
        location_id: locationId ?? undefined,
        grid_width: Math.min(512, Math.max(1, parseInt(gridWidth, 10) || 24)),
        grid_height: Math.min(512, Math.max(1, parseInt(gridHeight, 10) || 16)),
        description,
      }
      if (isEdit)
        return api<FloorPlan>(`/api/floor-plans/${plan.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<FloorPlan>("/api/floor-plans/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["floor-plans"] })
      qc.invalidateQueries({ queryKey: ["floor-plan", saved.id] })
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
        placeholder="Hall A"
        error={fieldErrors.name}
      />
      <FormRow>
        <FormCombobox
          label="Site"
          hint="Narrows the location list"
          value={siteId}
          onChange={(v) => {
            setSiteId(v)
            setLocationId(null) // locations are per-site
          }}
          options={sites.options.map((s) => ({
            value: s.id,
            label: s.name,
          }))}
          placeholder="Select a site…"
          searchPlaceholder="Search sites…"
          emptyText="No sites."
        />
        <FormCombobox
          label="Location"
          hint="The room / floor this lays out"
          value={locationId}
          onChange={setLocationId}
          options={(locations.data?.results ?? []).map((l) => ({
            value: l.id,
            label: l.name,
          }))}
          placeholder="Select a location…"
          searchPlaceholder="Search locations…"
          emptyText="No locations."
          error={fieldErrors.location_id}
        />
      </FormRow>
      <FormRow>
        <FormText
          label="Grid width"
          hint="Cells (1–512)"
          type="number"
          min={1}
          max={512}
          value={gridWidth}
          onChange={setGridWidth}
          error={fieldErrors.grid_width}
        />
        <FormText
          label="Grid height"
          hint="Cells (1–512)"
          type="number"
          min={1}
          max={512}
          value={gridHeight}
          onChange={setGridHeight}
          error={fieldErrors.grid_height}
        />
      </FormRow>
      <FormTextarea
        label="Description"
        value={description}
        onChange={setDescription}
        error={fieldErrors.description}
      />
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create floor plan"}
      />
    </form>
  )
}
