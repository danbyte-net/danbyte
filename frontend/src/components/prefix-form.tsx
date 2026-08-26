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
  type VRFOption,
} from "@/lib/api"
import { CustomFieldInputs } from "@/components/custom-field-inputs"
import { VlanPicker } from "@/components/vlan-picker"
import {
  FormCheckbox,
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
import { useSaveObject } from "@/lib/save-object"

// Pure form body - no dialog chrome. Rendered by /prefixes/new and
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
  const saveObject = useSaveObject()
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
  // site - prefill and lock the picker (useSiteOptions already filtered it).
  const siteLocked = !!sites.lockedId
  useEffect(() => {
    if (!isEdit && sites.lockedId && !siteId) setSiteId(sites.lockedId)
  }, [isEdit, sites.lockedId, siteId])
  // Locations belong to a site - only offer ones in the selected site.
  const locations = useQuery({
    queryKey: ["locations-picker", siteId],
    queryFn: () =>
      api<Paginated<Location>>(`/api/locations/?site=${siteId ?? ""}`),
    enabled: !!siteId,
    staleTime: 5 * 60_000,
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
      return saveObject<Prefix>({
        objectType: "api.prefix",
        endpoint: "/api/prefixes/",
        id: isEdit ? prefix!.id : undefined,
        payload,
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
      className="@container grid gap-4"
    >
      <FormColumns>
        <FormColumn>
          <FormSection title="Prefix" card>
            <FormText
              label="Prefix (CIDR)"
              required
              autoFocus={!isEdit}
              value={cidr}
              onChange={setCidr}
              mono
              placeholder="10.0.10.0/24"
              error={fieldErrors.cidr}
            />

            <div className="grid gap-3 @md:grid-cols-2">
              <FormStatusSelect
                value={statusId}
                onChange={setStatusId}
                options={statuses.data?.results ?? []}
                error={fieldErrors.status_id}
              />
              <FormCombobox
                label="VRF"
                value={vrfId}
                onChange={setVrfId}
                options={(vrfs.data?.results ?? []).map((v) => ({
                  value: v.id,
                  label: v.rd ? `${v.name} · ${v.rd}` : v.name,
                  color: v.color,
                }))}
                noneLabel="Global"
                placeholder="Global"
                searchPlaceholder="Search VRFs…"
                emptyText="No VRFs."
                error={fieldErrors.vrf_id}
              />
            </div>

            <div className="grid gap-3 @md:grid-cols-2">
              <VlanPicker
                value={vlanId}
                onChange={setVlanId}
                noneLabel="No VLAN"
                placeholder="No VLAN"
                error={fieldErrors.vlan_id}
              />
              <FormText
                label="Gateway"
                hint="optional"
                value={gateway}
                onChange={setGateway}
                mono
                placeholder="10.0.10.1"
                error={fieldErrors.gateway}
              />
            </div>
          </FormSection>
        </FormColumn>

        <FormColumn>
          <FormSection title="Placement" card>
            <FormSelect
              label="Site"
              hint={siteLocked ? "locked to your site" : "optional"}
              value={siteId}
              onChange={(v) => {
                setSiteId(v)
                setLocationId(null) // locations are site-specific
              }}
              noneLabel="No site"
              placeholder="No site"
              disabled={siteLocked}
              options={sites.options.map((s) => ({
                value: s.id,
                label: s.name,
              }))}
              error={fieldErrors.site_id}
            />

            <FormSelect
              label="Location"
              hint={
                siteId
                  ? "Optional - a range within the site"
                  : "Pick a site first"
              }
              value={locationId}
              onChange={setLocationId}
              noneLabel="No location"
              placeholder="No location"
              disabled={!siteId}
              options={(locations.data?.results ?? []).map((l) => ({
                value: l.id,
                label: l.name,
              }))}
              error={fieldErrors.location_id}
            />

            <FormCheckbox
              label="Assign IPs in this range to the site"
              hint="New IPs created here inherit the prefix's site, so site-scoped users and filters pick them up."
              checked={autoAssignSite}
              onChange={setAutoAssignSite}
            />
          </FormSection>

          <FormSection title="Notes" card>
            <FormTextarea
              label="Description"
              rows={3}
              value={description}
              onChange={setDescription}
              placeholder="e.g. Prod East - application servers"
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
        model="prefix"
        value={customFields}
        onChange={setCustomFields}
      />

      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create prefix"}
      />
    </form>
  )
}
