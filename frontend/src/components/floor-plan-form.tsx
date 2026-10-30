import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { apiAll } from "@/lib/api-all"
import { WHOLE_SITE } from "@/lib/floor-plan-scope"
import { useSiteOptions } from "@/lib/use-site-options"
import type {
  FloorPlan,
  FloorPlanWritePayload,
  Location,
  LocationOption,
} from "@/lib/api"
import {
  FormCombobox,
  FormFooter,
  FormSection,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { useSaveObject } from "@/lib/save-object"

export interface FloorPlanFormProps {
  plan?: FloorPlan
  /** Preselect the location (e.g. arriving from a Location page). */
  initialLocationId?: string
  /** Preselect the site (e.g. arriving from a Site page). */
  initialSiteId?: string
  onSaved: (saved: FloorPlan) => void
  onCancel: () => void
}

export function FloorPlanForm({
  plan,
  initialLocationId,
  initialSiteId,
  onSaved,
  onCancel,
}: FloorPlanFormProps) {
  const isEdit = !!plan
  const qc = useQueryClient()
  const { fieldErrors, handleApiError } = useFieldErrors()
  const saveObject = useSaveObject()

  const [name, setName] = useState(plan?.name ?? "")
  const [siteId, setSiteId] = useState<string | null>(
    plan?.site.id ?? initialSiteId ?? null
  )
  // Null: the whole site (a site-wide plan spans every building of it).
  const [locationId, setLocationId] = useState<string | null>(
    plan ? (plan.location?.id ?? null) : (initialLocationId ?? null)
  )
  const [gridWidth, setGridWidth] = useState(String(plan?.grid_width ?? 24))
  const [gridHeight, setGridHeight] = useState(String(plan?.grid_height ?? 16))
  const [cellMm, setCellMm] = useState(String(plan?.cell_mm ?? 600))
  const [ceilingMm, setCeilingMm] = useState(String(plan?.ceiling_mm ?? 3000))
  const [description, setDescription] = useState(plan?.description ?? "")

  const sites = useSiteOptions()
  // A location prefilled from a Location page names the site.
  const prefill = useQuery({
    queryKey: ["location", initialLocationId],
    queryFn: () => api<Location>(`/api/locations/${initialLocationId}/`),
    enabled: !plan && !siteId && !!initialLocationId,
  })
  const prefillSite = prefill.data?.site?.id
  useEffect(() => {
    if (prefillSite && !siteId) setSiteId(prefillSite)
  }, [prefillSite, siteId])
  // Locations are per-site - the list follows the chosen site.
  const locations = useQuery({
    queryKey: ["locations-picker", siteId],
    queryFn: () =>
      apiAll<LocationOption>(`/api/locations/?picker=1&site=${siteId}`),
    enabled: !!siteId,
  })

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: FloorPlanWritePayload = {
        name: name.trim(),
        site_id: siteId ?? undefined,
        location_id: locationId,
        grid_width: Math.min(512, Math.max(1, parseInt(gridWidth, 10) || 24)),
        grid_height: Math.min(512, Math.max(1, parseInt(gridHeight, 10) || 16)),
        cell_mm: Math.min(5000, Math.max(50, parseInt(cellMm, 10) || 600)),
        ceiling_mm: Math.min(
          20000,
          Math.max(1000, parseInt(ceilingMm, 10) || 3000)
        ),
        description,
      }
      return saveObject<FloorPlan>({
        objectType: "api.floorplan",
        endpoint: "/api/floor-plans/",
        id: isEdit ? plan!.id : undefined,
        payload,
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
      className="@container grid gap-4"
    >
      <FormSection title="Floor plan" card>
        <FormText
          label="Name"
          required
          autoFocus={!isEdit}
          value={name}
          onChange={setName}
          placeholder="Hall A"
          error={fieldErrors.name}
        />
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
            placeholder="Select a site…"
            searchPlaceholder="Search sites…"
            emptyText="No sites."
            disabled={isEdit}
            error={fieldErrors.site_id}
          />
          <FormCombobox
            label="Location"
            hint="The building or room this lays out"
            value={locationId}
            onChange={setLocationId}
            noneLabel={WHOLE_SITE}
            options={(locations.data?.results ?? []).map((l) => ({
              value: l.id,
              label: l.name,
            }))}
            placeholder={WHOLE_SITE}
            searchPlaceholder="Search locations…"
            emptyText="No locations."
            disabled={!siteId}
            error={fieldErrors.location_id}
          />
        </div>
        <FormTextarea
          label="Description"
          value={description}
          onChange={setDescription}
          error={fieldErrors.description}
        />
      </FormSection>

      <FormSection title="Grid" card>
        <div className="grid gap-3 @md:grid-cols-2">
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
        </div>
        <div className="grid gap-3 @md:grid-cols-2">
          <FormText
            label="Cell size (mm)"
            hint="Physical size of one grid cell - 600 = a raised-floor tile"
            type="number"
            min={50}
            max={5000}
            value={cellMm}
            onChange={setCellMm}
            error={fieldErrors.cell_mm}
          />
          <FormText
            label="Ceiling height (mm)"
            hint="Used by the 3D view and overhead tray defaults"
            type="number"
            min={1000}
            max={20000}
            value={ceilingMm}
            onChange={setCeilingMm}
            error={fieldErrors.ceiling_mm}
          />
        </div>
      </FormSection>

      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create floor plan"}
      />
    </form>
  )
}
