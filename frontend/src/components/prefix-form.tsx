import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useSiteOptions } from "@/lib/use-site-options"
import { toast } from "sonner"

import {
  api,
  type Location,
  type Paginated,
  type Prefix,
  type PrefixWritePayload,
  type Status,
  type TagOption,
  type VLANOption,
  type VRFOption,
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
import { CustomFieldInputs } from "@/components/custom-field-inputs"
import { useFieldErrors, FormCheckbox } from "@/components/forms"

// Pure form body — no dialog chrome. Rendered by /prefixes/new and
// /prefixes/$id/edit routes. Replaces PrefixFormDialog.

export interface PrefixFormInitial {
  cidr?: string
  vrfId?: string | null
  siteId?: string | null
  locationId?: string | null
}

export interface PrefixFormProps {
  prefix?: Prefix
  initial?: PrefixFormInitial
  /** Clone seed (create only): carried fields from
   * GET /api/prefixes/<id>/clone/. The CIDR is absent by design (starts blank);
   * classification/VRF/VLAN/site are pre-filled. Distinct from `prefix` so this
   * still POSTs. */
  clone?: Partial<Prefix>
  onSaved: (saved: Prefix) => void
  onCancel: () => void
}

const NONE = "__none__"

export function PrefixForm({
  prefix,
  initial,
  clone,
  onSaved,
  onCancel,
}: PrefixFormProps) {
  const isEdit = !!prefix
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  // Cloneable fields read from the edit object or the clone seed; the CIDR reads
  // from `prefix`/`initial` only, so a clone starts it blank.
  const seed = prefix ?? clone

  const [cidr, setCidr] = useState(prefix?.cidr ?? initial?.cidr ?? "")
  const [statusId, setStatusId] = useState<string | null>(
    seed?.status?.id ?? null
  )
  const [vrfId, setVrfId] = useState<string | null>(
    seed?.vrf?.id ?? initial?.vrfId ?? null
  )
  const [siteId, setSiteId] = useState<string | null>(
    seed?.site?.id ?? initial?.siteId ?? null
  )
  const [locationId, setLocationId] = useState<string | null>(
    seed?.location?.id ?? initial?.locationId ?? null
  )
  const [autoAssignSite, setAutoAssignSite] = useState<boolean>(
    seed?.auto_assign_site ?? false
  )
  const [vlanId, setVlanId] = useState<string | null>(seed?.vlan?.id ?? null)
  const [gateway, setGateway] = useState(prefix?.gateway ?? "")
  const [description, setDescription] = useState(seed?.description ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    seed?.tags?.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    seed?.custom_fields ?? {}
  )

  // Re-seed when the prefix prop changes (edit page refetch).
  useEffect(() => {
    if (!prefix) return
    setCidr(prefix.cidr)
    setStatusId(prefix.status?.id ?? null)
    setVrfId(prefix.vrf?.id ?? null)
    setSiteId(prefix.site?.id ?? null)
    setLocationId(prefix.location?.id ?? null)
    setAutoAssignSite(prefix.auto_assign_site)
    setVlanId(prefix.vlan?.id ?? null)
    setGateway(prefix.gateway ?? "")
    setDescription(prefix.description)
    setTagIds(prefix.tags.map((t) => t.id))
    setCustomFields(prefix.custom_fields ?? {})
    reset()
  }, [prefix, reset])

  const statuses = useQuery({
    queryKey: ["statuses", "prefix"],
    queryFn: () =>
      api<Paginated<Status>>("/api/statuses/?available_to=prefix&picker=1"),
    staleTime: 5 * 60_000,
  })
  const vrfs = useQuery({
    queryKey: ["vrfs-picker"],
    queryFn: () => api<Paginated<VRFOption>>("/api/vrfs/"),
    staleTime: 10 * 60_000,
  })
  const sites = useSiteOptions()
  // Enhanced site separation: a single-site user's creates land in their own
  // site — prefill and lock the picker (useSiteOptions already filtered it).
  const siteLocked = !!sites.lockedId
  useEffect(() => {
    if (!isEdit && sites.lockedId && !siteId) setSiteId(sites.lockedId)
  }, [isEdit, sites.lockedId, siteId])
  // Locations belong to a site — only offer ones in the selected site.
  const locations = useQuery({
    queryKey: ["locations-picker", siteId],
    queryFn: () =>
      api<Paginated<Location>>(`/api/locations/?site=${siteId ?? ""}`),
    enabled: !!siteId,
    staleTime: 5 * 60_000,
  })
  const vlans = useQuery({
    queryKey: ["vlans-picker"],
    queryFn: () => api<Paginated<VLANOption>>("/api/vlans/"),
    staleTime: 10 * 60_000,
  })
  const tags = useQuery({
    queryKey: ["tags-picker"],
    queryFn: () => api<Paginated<TagOption>>("/api/tags/"),
    staleTime: 10 * 60_000,
  })

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: PrefixWritePayload = {
        cidr: cidr.trim(),
        status_id: statusId,
        vrf_id: vrfId,
        site_id: siteId,
        location_id: locationId,
        vlan_id: vlanId,
        gateway: gateway.trim() || null,
        description: description.trim(),
        auto_assign_site: autoAssignSite,
        tag_ids: tagIds,
        custom_fields: customFields,
      }
      if (isEdit) {
        return api<Prefix>(`/api/prefixes/${prefix!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      }
      return api<Prefix>("/api/prefixes/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["prefixes"] })
      qc.invalidateQueries({ queryKey: ["prefix", saved.id] })
      qc.invalidateQueries({ queryKey: ["prefix-space-map"] })
      toast.success(isEdit ? `Updated ${saved.cidr}` : `Created ${saved.cidr}`)
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
      <Field label="Prefix (CIDR)" error={fieldErrors.cidr}>
        <Input
          autoFocus={!isEdit}
          required
          placeholder="10.0.10.0/24"
          value={cidr}
          onChange={(e) => setCidr(e.target.value)}
          className="font-mono"
        />
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Status" error={fieldErrors.status_id}>
          <Select
            value={statusId ?? NONE}
            onValueChange={(v) => setStatusId(v === NONE ? null : v)}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="No status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>No status</SelectItem>
              {statuses.data?.results.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="VRF" error={fieldErrors.vrf_id}>
          <Select
            value={vrfId ?? NONE}
            onValueChange={(v) => setVrfId(v === NONE ? null : v)}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Global" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Global</SelectItem>
              {vrfs.data?.results.map((v) => (
                <SelectItem key={v.id} value={v.id}>
                  {v.name}{" "}
                  {v.rd && (
                    <span className="text-muted-foreground">· {v.rd}</span>
                  )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Site" error={fieldErrors.site_id}>
          <Select
            value={siteId ?? NONE}
            onValueChange={(v) => {
              setSiteId(v === NONE ? null : v)
              setLocationId(null) // locations are site-specific
            }}
            disabled={siteLocked}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="No site" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>No site</SelectItem>
              {sites.options.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="VLAN" error={fieldErrors.vlan_id}>
          <Select
            value={vlanId ?? NONE}
            onValueChange={(v) => setVlanId(v === NONE ? null : v)}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder="No VLAN" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>No VLAN</SelectItem>
              {vlans.data?.results.map((v) => (
                <SelectItem key={v.id} value={v.id}>
                  {v.vlan_id} · {v.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <Field
        label="Location"
        hint={
          siteId ? "Optional — a range within the site" : "Pick a site first"
        }
        error={fieldErrors.location_id}
      >
        <Select
          value={locationId ?? NONE}
          onValueChange={(v) => setLocationId(v === NONE ? null : v)}
          disabled={!siteId}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="No location" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>No location</SelectItem>
            {locations.data?.results.map((l) => (
              <SelectItem key={l.id} value={l.id}>
                {l.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <FormCheckbox
        label="Assign IPs in this range to the site"
        hint="New IPs created here inherit the prefix's site, so site-scoped users and filters pick them up."
        checked={autoAssignSite}
        onChange={setAutoAssignSite}
      />

      <Field label="Gateway" hint="Optional" error={fieldErrors.gateway}>
        <Input
          placeholder="10.0.10.1"
          value={gateway}
          onChange={(e) => setGateway(e.target.value)}
          className="font-mono"
        />
      </Field>

      <Field label="Description" error={fieldErrors.description}>
        <Textarea
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g. Prod East — application servers"
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
        model="prefix"
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
              : "Create prefix"}
        </Button>
      </div>
    </form>
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
