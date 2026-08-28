import { useEffect, useRef, useState, type ReactNode } from "react"
import { useTimezoneOptions } from "@/lib/use-timezones"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Check, ChevronsUpDown } from "lucide-react"

import { api } from "@/lib/api"
import type {
  GeocodeCandidate,
  Paginated,
  RegionOption,
  Site,
  SiteGatewayPolicy,
  SiteWritePayload,
  VRFOption,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { VrfCell } from "@/components/cells/vrf-cell"
import { MonitoringEngineField } from "@/components/monitoring-engine-field"
import { SnmpBindingControl } from "@/components/snmp-binding-control"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { CustomFieldInputs } from "@/components/custom-field-inputs"
import {
  Field,
  FormSection,
  FormColor,
  FormColumn,
  FormColumns,
  FormCombobox,
  FormFooter,
  FormIcon,
  FormSelect,
  FormTags,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { useSaveObject } from "@/lib/save-object"
import { useMe } from "@/lib/use-me"

export interface SiteFormProps {
  /** Extra card rendered in the right column (the edit page's address-scope
   * panel) - inside the columns, so it shares the form's chrome instead of
   * floating below the sticky footer in its own style. */
  scopePanel?: ReactNode
  site?: Site
  onSaved: (saved: Site) => void
  onCancel: () => void
}

const GATEWAY_POLICIES: { value: SiteGatewayPolicy; label: string }[] = [
  { value: "first", label: "First usable address" },
  { value: "last", label: "Last usable address" },
  { value: "none", label: "No automatic gateway" },
]

export function SiteForm({
  site,
  onSaved,
  onCancel,
  scopePanel,
}: SiteFormProps) {
  const { canDo } = useMe()
  const isEdit = !!site
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const timezoneOptions = useTimezoneOptions()
  const saveObject = useSaveObject()

  const [name, setName] = useState(site?.name ?? "")
  const [regionId, setRegionId] = useState<string | null>(
    site?.region?.id ?? null
  )
  const [location, setLocation] = useState(site?.location ?? "")
  const [timeZone, setTimeZone] = useState(site?.time_zone ?? "")
  const [latitude, setLatitude] = useState(site?.latitude ?? "")
  const [longitude, setLongitude] = useState(site?.longitude ?? "")
  const [color, setColor] = useState(site?.color ?? "")
  const [icon, setIcon] = useState(site?.icon ?? "")
  const [description, setDescription] = useState(site?.description ?? "")
  const [gatewayPolicy, setGatewayPolicy] = useState<SiteGatewayPolicy>(
    site?.gateway_policy ?? "first"
  )
  const [defaultPrefixId, setDefaultPrefixId] = useState<string | null>(
    site?.default_prefix?.id ?? null
  )
  const [vrfIds, setVrfIds] = useState<string[]>(
    site?.vrfs.map((v) => v.id) ?? []
  )
  const [tagIds, setTagIds] = useState<number[]>(
    site?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    site?.custom_fields ?? {}
  )

  useEffect(() => {
    if (!site) return
    setName(site.name)
    setRegionId(site.region?.id ?? null)
    setLocation(site.location)
    setLatitude(site.latitude ?? "")
    setLongitude(site.longitude ?? "")
    setColor(site.color ?? "")
    setIcon(site.icon ?? "")
    setDescription(site.description)
    setGatewayPolicy(site.gateway_policy)
    setDefaultPrefixId(site.default_prefix?.id ?? null)
    setVrfIds(site.vrfs.map((v) => v.id))
    setTagIds(site.tags.map((t) => t.id))
    setCustomFields(site.custom_fields ?? {})
    reset()
  }, [site, reset])

  const regions = useQuery({
    queryKey: ["regions-picker"],
    queryFn: () => api<Paginated<RegionOption>>("/api/regions/?picker=1"),
    staleTime: 10 * 60_000,
  })
  const vrfs = useQuery({
    queryKey: ["vrfs-picker"],
    queryFn: () => api<Paginated<VRFOption>>("/api/vrfs/?picker=1"),
    staleTime: 10 * 60_000,
  })
  // Candidates for the site's default: its own prefixes. (The server also
  // accepts a shared prefix with no site; those aren't offered here to keep the
  // list short and the intent obvious.)
  const sitePrefixes = useQuery({
    queryKey: ["site-prefixes", site?.id],
    queryFn: () =>
      api<Paginated<{ id: string; cidr: string }>>(
        `/api/prefixes/?site=${site!.id}&page_size=500`
      ),
    enabled: isEdit,
    staleTime: 60_000,
  })

  // Address → coordinates. One Nominatim request per explicit click (OSM
  // usage policy) - the picked candidate just fills the lat/lng inputs.
  const [geoCandidates, setGeoCandidates] = useState<GeocodeCandidate[] | null>(
    null
  )
  // `auto` is the leave-the-field flow: the top candidate fills the
  // coordinates directly (only ever attempted while they are empty), and
  // errors stay silent - blurring a half-typed address must not nag.
  const autoGeoRef = useRef("")
  const geocode = useMutation({
    mutationFn: ({ q }: { q: string; auto?: boolean }) =>
      api<{ results: GeocodeCandidate[] }>(
        `/api/sites/geocode/?${new URLSearchParams({ q })}`
      ),
    onSuccess: (data, vars) => {
      if (vars.auto) {
        const c = data.results[0]
        if (!c) return
        setLatitude(c.latitude.toFixed(6))
        setLongitude(c.longitude.toFixed(6))
        toast.success(`Placed at ${c.label}`)
      } else {
        setGeoCandidates(data.results)
      }
    },
    onError: (err, vars) => {
      if (vars.auto) return
      const msg = handleApiError(err)
      if (msg) toast.error(msg)
    },
  })

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: SiteWritePayload = {
        name: name.trim(),
        region_id: regionId,
        location: location.trim(),
        time_zone: timeZone.trim(),
        latitude: String(latitude).trim() || null,
        longitude: String(longitude).trim() || null,
        color: color || "",
        icon: icon || "",
        description: description.trim(),
        gateway_policy: gatewayPolicy,
        ...(isEdit ? { default_prefix_id: defaultPrefixId } : {}),
        vrf_ids: vrfIds,
        tag_ids: tagIds,
        custom_fields: customFields,
      }
      return saveObject<Site>({
        objectType: "api.site",
        endpoint: "/api/sites/",
        id: isEdit ? site.id : undefined,
        payload,
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["sites"] })
      qc.invalidateQueries({ queryKey: ["sites-picker"] })
      qc.invalidateQueries({ queryKey: ["site", saved.id] })
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
          <FormSection title="Site" card>
            <FormText
              label="Name"
              required
              autoFocus={!isEdit}
              placeholder="dc-fra-01"
              value={name}
              onChange={setName}
              error={fieldErrors.name}
            />

            <FormCombobox
              label="Region"
              hint="optional"
              value={regionId}
              onChange={setRegionId}
              options={(regions.data?.results ?? []).map((r) => ({
                value: r.id,
                label: r.name,
              }))}
              noneLabel="No region"
              placeholder="No region"
              searchPlaceholder="Search regions…"
              emptyText="No regions."
              error={fieldErrors.region_id}
            />
          </FormSection>

          <FormSection title="Location" card>
            <Field label="Address" hint="optional" error={fieldErrors.location}>
              <div className="flex gap-2">
                <Input
                  placeholder="Frankfurt, DE"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  onBlur={() => {
                    // Auto-place: one lookup per distinct address, and never
                    // while coordinates are already set (typed or auto-filled).
                    const q = location.trim()
                    if (
                      !q ||
                      String(latitude).trim() ||
                      String(longitude).trim()
                    )
                      return
                    if (autoGeoRef.current === q || geocode.isPending) return
                    autoGeoRef.current = q
                    geocode.mutate({ q, auto: true })
                  }}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9 shrink-0"
                  disabled={!location.trim() || geocode.isPending}
                  onClick={() => geocode.mutate({ q: location.trim() })}
                >
                  {geocode.isPending ? "Searching…" : "Find on OSM"}
                </Button>
              </div>
              {geoCandidates && geoCandidates.length === 0 && (
                <p className="mt-1 text-xs text-muted-foreground">
                  No match - try adding a city or country to the address.
                </p>
              )}
              {geoCandidates && geoCandidates.length > 0 && (
                <div className="mt-1.5 grid gap-1">
                  {geoCandidates.map((c, i) => (
                    <button
                      key={i}
                      type="button"
                      className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs hover:bg-muted/60"
                      onClick={() => {
                        setLatitude(c.latitude.toFixed(6))
                        setLongitude(c.longitude.toFixed(6))
                        setGeoCandidates(null)
                      }}
                    >
                      <span className="min-w-0 truncate">{c.label}</span>
                      <span className="ml-auto shrink-0 text-muted-foreground">
                        {c.kind}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </Field>

            <FormCombobox
              label="Time zone"
              hint="optional"
              value={timeZone || null}
              onChange={(v) => setTimeZone(v ?? "")}
              options={timezoneOptions}
              noneLabel="Inherit from the deployment"
              placeholder="Inherit from the deployment"
              searchPlaceholder="Search zones…"
              emptyText="No matching zone."
              error={fieldErrors.time_zone}
            />

            <div className="grid gap-3 @md:grid-cols-2">
              <FormText
                label="Latitude"
                hint="or place it on the Site map"
                mono
                placeholder="55.676098"
                value={String(latitude)}
                onChange={setLatitude}
                error={fieldErrors.latitude}
              />
              <FormText
                label="Longitude"
                mono
                placeholder="12.568337"
                value={String(longitude)}
                onChange={setLongitude}
                error={fieldErrors.longitude}
              />
            </div>

            <div className="grid gap-3 @md:grid-cols-2">
              <FormColor
                label="Marker color"
                hint="shown on the Site map"
                value={color}
                onChange={setColor}
                error={fieldErrors.color}
              />
              <FormIcon
                label="Marker icon"
                value={icon}
                onChange={setIcon}
                error={fieldErrors.icon}
              />
            </div>
          </FormSection>
        </FormColumn>

        <FormColumn>
          <FormSection title="Networking" card>
            <FormSelect
              label="Gateway policy"
              hint="auto-creates a gateway IP on new prefixes"
              value={gatewayPolicy}
              onChange={(v) =>
                setGatewayPolicy((v ?? "first") as SiteGatewayPolicy)
              }
              options={GATEWAY_POLICIES.map((p) => ({
                value: p.value,
                label: p.label,
              }))}
            />

            {/* Edit-only: a brand-new site has no prefixes to choose from yet. */}
            {isEdit && (
              <FormSelect
                label="Default prefix"
                hint="pre-selected when staff here add an address - a hint, not a limit"
                value={defaultPrefixId}
                onChange={setDefaultPrefixId}
                noneLabel="No default - staff pick every time"
                options={(sitePrefixes.data?.results ?? []).map((p) => ({
                  value: p.id,
                  label: p.cidr,
                }))}
              />
            )}

            <Field label="VRFs" hint="documentation only - not enforced">
              <VrfMultiSelect
                options={vrfs.data?.results ?? []}
                value={vrfIds}
                onChange={setVrfIds}
              />
            </Field>
          </FormSection>

          {site?.id && (
            <FormSection title="Monitoring" card>
              <MonitoringEngineField
                scope="site"
                objectId={site.id}
                disabled={!canDo("site", "change")}
              />
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-[11px] tracking-[0.08em] text-zinc-500 uppercase">
                  SNMP credentials
                </span>
                <SnmpBindingControl
                  scope="site"
                  objectId={site.id}
                  canEdit={canDo("site", "change")}
                />
              </div>
            </FormSection>
          )}

          {scopePanel}

          <FormSection title="Notes" card>
            <FormTextarea
              label="Description"
              rows={2}
              value={description}
              onChange={setDescription}
              placeholder="e.g. Primary EU data center"
              error={fieldErrors.description}
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
        model="site"
        value={customFields}
        onChange={setCustomFields}
      />

      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create site"}
      />
    </form>
  )
}

function VrfMultiSelect({
  options,
  value,
  onChange,
}: {
  options: VRFOption[]
  value: string[]
  onChange: (next: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const valueSet = new Set(value)
  const selected = options.filter((o) => valueSet.has(o.id))

  function toggle(id: string) {
    onChange(valueSet.has(id) ? value.filter((v) => v !== id) : [...value, id])
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {selected.map((vrf) => (
        <span key={vrf.id} className="inline-flex items-center gap-1">
          <VrfCell vrf={vrf} linked={false} />
          <button
            type="button"
            onClick={() => toggle(vrf.id)}
            className="inline-flex h-4 w-4 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
            aria-label={`Remove ${vrf.name}`}
          >
            ×
          </button>
        </span>
      ))}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 px-2 text-[11px]"
          >
            <ChevronsUpDown className="mr-1 h-3 w-3" />
            Add VRF…
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-64 p-0">
          <Command>
            <CommandInput placeholder="Search VRFs…" className="h-8 text-xs" />
            <CommandList>
              <CommandEmpty>No VRFs.</CommandEmpty>
              <CommandGroup>
                {options.map((vrf) => {
                  const isSel = valueSet.has(vrf.id)
                  return (
                    <CommandItem
                      key={vrf.id}
                      value={vrf.name}
                      onSelect={() => toggle(vrf.id)}
                      className="gap-2"
                    >
                      <Check
                        className={cn(
                          "h-3.5 w-3.5",
                          isSel ? "opacity-100" : "opacity-0"
                        )}
                      />
                      <VrfCell vrf={vrf} linked={false} />
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  )
}
