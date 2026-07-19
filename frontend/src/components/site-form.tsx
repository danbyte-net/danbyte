import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Check, ChevronsUpDown } from "lucide-react"

import { api } from "@/lib/api"
import type {
  Paginated,
  RegionOption,
  Site,
  SiteGatewayPolicy,
  SiteWritePayload,
  TagOption,
  VRFOption,
} from "@/lib/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { TagMultiSelect } from "@/components/cells/tag-multi-select"
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
import { FormCombobox, FormSelect, useFieldErrors } from "@/components/forms"

export interface SiteFormProps {
  site?: Site
  onSaved: (saved: Site) => void
  onCancel: () => void
}

const GATEWAY_POLICIES: { value: SiteGatewayPolicy; label: string }[] = [
  { value: "first", label: "First usable address" },
  { value: "last", label: "Last usable address" },
  { value: "none", label: "No automatic gateway" },
]

export function SiteForm({ site, onSaved, onCancel }: SiteFormProps) {
  const isEdit = !!site
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [name, setName] = useState(site?.name ?? "")
  const [regionId, setRegionId] = useState<string | null>(
    site?.region?.id ?? null
  )
  const [location, setLocation] = useState(site?.location ?? "")
  const [latitude, setLatitude] = useState(site?.latitude ?? "")
  const [longitude, setLongitude] = useState(site?.longitude ?? "")
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
  const tags = useQuery({
    queryKey: ["tags-picker"],
    queryFn: () => api<Paginated<TagOption>>("/api/tags/"),
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

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: SiteWritePayload = {
        name: name.trim(),
        region_id: regionId,
        location: location.trim(),
        latitude: String(latitude).trim() || null,
        longitude: String(longitude).trim() || null,
        description: description.trim(),
        gateway_policy: gatewayPolicy,
        ...(isEdit ? { default_prefix_id: defaultPrefixId } : {}),
        vrf_ids: vrfIds,
        tag_ids: tagIds,
        custom_fields: customFields,
      }
      if (isEdit)
        return api<Site>(`/api/sites/${site.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<Site>("/api/sites/", {
        method: "POST",
        body: JSON.stringify(payload),
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
      <Field label="Name" error={fieldErrors.name}>
        <Input
          autoFocus={!isEdit}
          required
          placeholder="dc-fra-01"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>

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

      {site?.id && <MonitoringEngineField scope="site" objectId={site.id} />}

      {site?.id && (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[11px] tracking-[0.08em] text-zinc-500 uppercase">
            SNMP credentials
          </span>
          <SnmpBindingControl scope="site" objectId={site.id} canEdit />
        </div>
      )}

      <Field label="Address" hint="optional" error={fieldErrors.location}>
        <Input
          placeholder="Frankfurt, DE"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Latitude"
          hint="or place it on the Site map"
          error={fieldErrors.latitude}
        >
          <Input
            placeholder="55.676098"
            className="font-mono text-[13px]"
            value={String(latitude)}
            onChange={(e) => setLatitude(e.target.value)}
          />
        </Field>
        <Field label="Longitude" error={fieldErrors.longitude}>
          <Input
            placeholder="12.568337"
            className="font-mono text-[13px]"
            value={String(longitude)}
            onChange={(e) => setLongitude(e.target.value)}
          />
        </Field>
      </div>

      <Field label="Description" error={fieldErrors.description}>
        <Textarea
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g. Primary EU data center"
        />
      </Field>

      <Field
        label="Gateway policy"
        hint="auto-creates a gateway IP on new prefixes"
      >
        <Select
          value={gatewayPolicy}
          onValueChange={(v) => setGatewayPolicy(v as SiteGatewayPolicy)}
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {GATEWAY_POLICIES.map((p) => (
              <SelectItem key={p.value} value={p.value}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {/* Edit-only: a brand-new site has no prefixes to choose from yet. */}
      {isEdit && (
        <FormSelect
          label="Default prefix"
          hint="pre-selected when staff here add an address — a hint, not a limit"
          value={defaultPrefixId}
          onChange={setDefaultPrefixId}
          noneLabel="No default — staff pick every time"
          options={(sitePrefixes.data?.results ?? []).map((p) => ({
            value: p.id,
            label: p.cidr,
          }))}
        />
      )}

      <Field label="VRFs" hint="documentation only — not enforced">
        <VrfMultiSelect
          options={vrfs.data?.results ?? []}
          value={vrfIds}
          onChange={setVrfIds}
        />
      </Field>

      <Field label="Tags" error={fieldErrors.tag_ids}>
        <TagMultiSelect
          options={tags.data?.results ?? []}
          value={tagIds}
          onChange={setTagIds}
        />
      </Field>

      <CustomFieldInputs
        model="site"
        value={customFields}
        onChange={setCustomFields}
      />

      <div className="mt-2 flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          onClick={onCancel}
          disabled={mutation.isPending}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={mutation.isPending}>
          {mutation.isPending
            ? "Saving…"
            : isEdit
              ? "Save changes"
              : "Create Site"}
        </Button>
      </div>
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

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string
  hint?: string
  error?: string
  children: React.ReactNode
}) {
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between">
        <Label className="text-xs">{label}</Label>
        {hint && (
          <span className="text-[10px] text-muted-foreground">{hint}</span>
        )}
      </div>
      {children}
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  )
}
