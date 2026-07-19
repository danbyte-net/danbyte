import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import { useSiteOptions } from "@/lib/use-site-options"
import type {
  Location,
  LocationWritePayload,
  Paginated,
  SiteOption,
  Status,
} from "@/lib/api"
import {
  FormCombobox,
  FormFooter,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { MonitoringEngineField } from "@/components/monitoring-engine-field"
import { SnmpBindingControl } from "@/components/snmp-binding-control"

interface LocPick {
  id: string
  name: string
  site: SiteOption | null
}

export interface LocationFormProps {
  location?: Location
  onSaved: (v: Location) => void
  onCancel: () => void
}

export function LocationForm({
  location,
  onSaved,
  onCancel,
}: LocationFormProps) {
  const isEdit = !!location
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [name, setName] = useState(location?.name ?? "")
  const [siteId, setSiteId] = useState<string | null>(
    location?.site?.id ?? null
  )
  const [parentId, setParentId] = useState<string | null>(
    location?.parent?.id ?? null
  )
  const [statusId, setStatusId] = useState<string | null>(
    location?.status?.id ?? null
  )
  const [description, setDescription] = useState(location?.description ?? "")
  // Site is a required FK — surface that client-side instead of leaning on the
  // server 400. Cleared once a site is chosen or the form re-seeds.
  const [siteError, setSiteError] = useState<string | null>(null)

  useEffect(() => {
    if (!location) return
    setName(location.name)
    setSiteId(location.site?.id ?? null)
    setParentId(location.parent?.id ?? null)
    setStatusId(location.status?.id ?? null)
    setDescription(location.description)
    setSiteError(null)
    reset()
  }, [location, reset])

  const sites = useSiteOptions()
  const statuses = useQuery({
    queryKey: ["statuses", "location"],
    queryFn: () =>
      api<Paginated<Status>>("/api/statuses/?available_to=location&picker=1"),
    staleTime: 5 * 60_000,
  })
  // Parent options: locations in the chosen site (excluding self).
  const locs = useQuery({
    queryKey: ["locations-bysite", siteId],
    queryFn: () =>
      api<Paginated<LocPick>>(
        `/api/locations/?${new URLSearchParams({ site: siteId ?? "" }).toString()}`
      ),
    enabled: !!siteId,
    staleTime: 60_000,
  })
  const parentOptions = useMemo(
    () =>
      (locs.data?.results ?? [])
        .filter((l) => l.id !== location?.id)
        .map((l) => ({ value: l.id, label: l.name })),
    [locs.data, location?.id]
  )

  const mutation = useMutation({
    mutationFn: async (site: string) => {
      const payload: LocationWritePayload = {
        name: name.trim(),
        site_id: site,
        parent_id: parentId,
        status_id: statusId,
        description: description.trim(),
      }
      if (isEdit)
        return api<Location>(`/api/locations/${location.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<Location>("/api/locations/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["locations"] })
      qc.invalidateQueries({ queryKey: ["location", saved.id] })
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
        if (!siteId) {
          setSiteError("Site is required.")
          return
        }
        mutation.mutate(siteId)
      }}
      className="grid gap-4"
    >
      <div className="grid grid-cols-2 gap-3">
        <FormText
          label="Name"
          required
          autoFocus={!isEdit}
          value={name}
          onChange={setName}
          error={fieldErrors.name}
        />
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
      </div>

      <div className="grid grid-cols-2 gap-3">
        <FormCombobox
          label="Site"
          value={siteId}
          onChange={(v) => {
            setSiteId(v)
            setParentId(null) // parent must be in the same site
            if (v) setSiteError(null)
          }}
          options={sites.options.map((s) => ({
            value: s.id,
            label: s.name,
          }))}
          placeholder="Select site"
          searchPlaceholder="Search sites…"
          emptyText="No sites."
          error={siteError ?? fieldErrors.site_id}
        />
        <FormCombobox
          label="Parent location"
          hint="optional"
          value={parentId}
          onChange={setParentId}
          options={parentOptions}
          noneLabel="Top level"
          placeholder={siteId ? "Top level" : "Pick a site first"}
          searchPlaceholder="Search locations…"
          emptyText="No locations in this site."
          error={fieldErrors.parent_id}
        />
      </div>

      <FormTextarea
        label="Description"
        value={description}
        onChange={setDescription}
        error={fieldErrors.description}
      />
      {location?.id && (
        <MonitoringEngineField scope="location" objectId={location.id} />
      )}
      {location?.id && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[11px] tracking-[0.08em] text-zinc-500 uppercase">
            SNMP credentials
          </span>
          <SnmpBindingControl scope="location" objectId={location.id} canEdit />
        </div>
      )}
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create location"}
      />
    </form>
  )
}
