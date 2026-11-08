import { useEffect, useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import { apiAll } from "@/lib/api-all"
import { useSiteOptions } from "@/lib/use-site-options"
import type {
  Location,
  LocationTypeRef,
  LocationWritePayload,
  SiteOption,
  Status,
} from "@/lib/api"
import {
  FormColor,
  FormColumn,
  FormColumns,
  FormCombobox,
  FormFooter,
  FormIcon,
  FormSection,
  FormStatusSelect,
  FormText,
  FormTextarea,
  QuickAddDialog,
  useFieldErrors,
} from "@/components/forms"
import {
  BindingDraftsProvider,
  useBindingDraftsRoot,
} from "@/lib/binding-drafts"
import { useSaveObject } from "@/lib/save-object"
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
  const saveObject = useSaveObject()
  // The Monitoring section stages its picks; Save writes them (#324).
  const bindingDrafts = useBindingDraftsRoot()

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
  const [typeId, setTypeId] = useState<string | null>(
    location?.location_type?.id ?? null
  )
  const [code, setCode] = useState(location?.code ?? "")
  const [color, setColor] = useState(location?.color ?? "")
  const [icon, setIcon] = useState(location?.icon ?? "")
  const [description, setDescription] = useState(location?.description ?? "")
  // Site is a required FK - surface that client-side instead of leaning on the
  // server 400. Cleared once a site is chosen or the form re-seeds.
  const [siteError, setSiteError] = useState<string | null>(null)

  useEffect(() => {
    if (!location) return
    setName(location.name)
    setSiteId(location.site?.id ?? null)
    setParentId(location.parent?.id ?? null)
    setStatusId(location.status?.id ?? null)
    setTypeId(location.location_type?.id ?? null)
    setCode(location.code ?? "")
    setColor(location.color ?? "")
    setIcon(location.icon ?? "")
    setDescription(location.description)
    setSiteError(null)
    reset()
  }, [location, reset])

  const sites = useSiteOptions()
  // The type picker shows each type as its colour badge.
  const types = useQuery({
    queryKey: ["location-types-picker"],
    queryFn: () => apiAll<LocationTypeRef>("/api/location-types/?picker=1"),
    staleTime: 5 * 60_000,
  })
  const statuses = useQuery({
    queryKey: ["statuses", "location"],
    queryFn: () =>
      apiAll<Status>("/api/statuses/?available_to=location&picker=1"),
    staleTime: 5 * 60_000,
  })
  // Parent options: locations in the chosen site (excluding self).
  const locs = useQuery({
    queryKey: ["locations-bysite", siteId],
    queryFn: () =>
      apiAll<LocPick>(
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
        code: code.trim(),
        site_id: site,
        parent_id: parentId,
        location_type_id: typeId,
        status_id: statusId,
        color: color || "",
        icon: icon || "",
        description: description.trim(),
      }
      const saved = await saveObject<Location>({
        objectType: "api.location",
        endpoint: "/api/locations/",
        id: isEdit ? location.id : undefined,
        payload,
      })
      await bindingDrafts.commit()
      return saved
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
      <FormColumns>
        <FormColumn>
          <FormSection title="Location" card>
            <div className="grid gap-3 @md:grid-cols-[1fr_8rem]">
              <FormText
                label="Name"
                required
                autoFocus={!isEdit}
                value={name}
                onChange={setName}
                error={fieldErrors.name}
              />
              <FormText
                label="Code"
                hint="optional"
                value={code}
                onChange={setCode}
                placeholder="A1"
                error={fieldErrors.code}
              />
            </div>

            <FormCombobox
              label="Type"
              hint="optional"
              value={typeId}
              onChange={setTypeId}
              options={(types.data?.results ?? []).map((t) => ({
                value: t.id,
                label: t.name,
                color: t.color,
              }))}
              noneLabel="No type"
              placeholder="Select a type…"
              searchPlaceholder="Search types…"
              emptyText="No location types."
              error={fieldErrors.location_type_id}
              quickAdd={
                <QuickAddDialog
                  title="New location type"
                  endpoint="/api/location-types/"
                  fields={[
                    { name: "name", label: "Name", required: true },
                    {
                      name: "description",
                      label: "Description",
                      type: "textarea",
                    },
                  ]}
                  onCreated={(t) => {
                    qc.invalidateQueries({
                      queryKey: ["location-types-picker"],
                    })
                    setTypeId(t.id)
                  }}
                />
              }
            />

            <FormStatusSelect
              value={statusId}
              onChange={setStatusId}
              options={statuses.data?.results ?? []}
              placeholder="Select a status…"
              error={fieldErrors.status_id}
            />

            <FormCombobox
              label="Site"
              required
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
          </FormSection>
        </FormColumn>

        <FormColumn>
          <FormSection title="Appearance" card>
            <div className="grid gap-3 @md:grid-cols-2">
              <FormColor
                label="Color"
                value={color}
                onChange={setColor}
                error={fieldErrors.color}
              />
              <FormIcon
                label="Icon"
                value={icon}
                onChange={setIcon}
                error={fieldErrors.icon}
              />
            </div>
          </FormSection>

          <FormSection title="Notes" card>
            <FormTextarea
              label="Description"
              value={description}
              onChange={setDescription}
              error={fieldErrors.description}
            />
          </FormSection>

          {location?.id && (
            <BindingDraftsProvider value={bindingDrafts}>
              <FormSection title="Monitoring" card>
                <MonitoringEngineField
                  scope="location"
                  objectId={location.id}
                />
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-[11px] tracking-[0.08em] text-zinc-500 uppercase">
                    SNMP credentials
                  </span>
                  <SnmpBindingControl
                    scope="location"
                    objectId={location.id}
                    canEdit
                  />
                </div>
              </FormSection>
            </BindingDraftsProvider>
          )}
        </FormColumn>
      </FormColumns>

      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create location"}
      />
    </form>
  )
}
