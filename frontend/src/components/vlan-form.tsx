import { useEffect, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useSiteOptions } from "@/lib/use-site-options"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"

import { api, ApiError } from "@/lib/api"
import type {
  Paginated,
  Status,
  VLAN,
  VLANGroupOption,
  VLANWritePayload,
  VRFOption,
  ZoneOption,
} from "@/lib/api"
import { CustomFieldInputs } from "@/components/custom-field-inputs"
import {
  FormColor,
  FormCombobox,
  FormFooter,
  FormSection,
  FormStatusSelect,
  FormTags,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { useSaveObject } from "@/lib/save-object"

export interface VlanFormInitial {
  vlanId?: number
}

export interface VlanFormProps {
  vlan?: VLAN
  initial?: VlanFormInitial
  /** Create-only: field values carried over from a source VLAN via
   * GET /api/vlans/<id>/clone/. Identity (VID + name) starts blank. */
  clone?: Partial<VLAN>
  onSaved: (saved: VLAN) => void
  onCancel: () => void
}

export function VlanForm({
  vlan,
  initial,
  clone,
  onSaved,
  onCancel,
}: VlanFormProps) {
  const isEdit = !!vlan
  // Cloneable fields read from the edit object or the clone seed; the VID and
  // name deliberately read from `vlan` only, so a clone starts blank there.
  const src = vlan ?? clone
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const saveObject = useSaveObject()

  const [vlanId, setVlanId] = useState<string>(
    vlan ? String(vlan.vlan_id) : initial?.vlanId ? String(initial.vlanId) : ""
  )
  const [name, setName] = useState(vlan?.name ?? "")
  const [siteId, setSiteId] = useState<string | null>(src?.site?.id ?? null)
  const [groupId, setGroupId] = useState<string | null>(src?.group?.id ?? null)
  const [zoneId, setZoneId] = useState<string | null>(src?.zone?.id ?? null)
  const [vrfId, setVrfId] = useState<string | null>(src?.vrf?.id ?? null)
  const [statusId, setStatusId] = useState<string | null>(
    src?.status?.id ?? null
  )
  const [color, setColor] = useState(src?.color ?? "")
  const [description, setDescription] = useState(src?.description ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    src?.tags?.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    src?.custom_fields ?? {}
  )

  useEffect(() => {
    if (!vlan) return
    setVlanId(String(vlan.vlan_id))
    setName(vlan.name)
    setSiteId(vlan.site?.id ?? null)
    setGroupId(vlan.group?.id ?? null)
    setZoneId(vlan.zone?.id ?? null)
    setVrfId(vlan.vrf?.id ?? null)
    setColor(vlan.color ?? "")
    setDescription(vlan.description)
    setTagIds(vlan.tags.map((t) => t.id))
    setCustomFields(vlan.custom_fields ?? {})
    reset()
  }, [vlan, reset])

  const sites = useSiteOptions()
  // Enhanced site separation: a single-site user's creates land in their own
  // site - prefill and lock the picker (useSiteOptions already filtered it).
  const siteLocked = !!sites.lockedId
  useEffect(() => {
    if (!isEdit && sites.lockedId && !siteId) setSiteId(sites.lockedId)
  }, [isEdit, sites.lockedId, siteId])
  const groups = useQuery({
    queryKey: ["vlan-groups-picker"],
    queryFn: () =>
      api<Paginated<VLANGroupOption>>("/api/vlan-groups/?picker=1"),
    staleTime: 10 * 60_000,
  })
  const vrfs = useQuery({
    queryKey: ["vrfs-picker"],
    queryFn: () => api<Paginated<VRFOption>>("/api/vrfs/"),
    staleTime: 10 * 60_000,
  })
  const zones = useQuery({
    queryKey: ["zones-picker"],
    queryFn: () => api<Paginated<ZoneOption>>("/api/zones/?picker=1"),
    staleTime: 10 * 60_000,
  })
  const statuses = useQuery({
    queryKey: ["statuses", "vlan"],
    queryFn: () =>
      api<Paginated<Status>>("/api/statuses/?available_to=vlan&picker=1"),
    staleTime: 5 * 60_000,
  })
  // A new VLAN starts in the tenant's default VLAN status (Active).
  const defaulted = useRef(false)
  useEffect(() => {
    if (isEdit || defaulted.current || statusId || !statuses.data) return
    defaulted.current = true
    const d = statuses.data.results.find((s) => s.default_for.includes("vlan"))
    if (d) setStatusId(d.id)
  }, [isEdit, statusId, statuses.data])

  // "Save and add another": keep the form open with the shared context
  // (site, role, table…) and clear only what names this one.
  const againRef = useRef(false)
  const mutation = useMutation({
    mutationFn: async () => {
      const num = Number(vlanId)
      if (!Number.isInteger(num) || num < 1 || num > 4094) {
        throw new ApiError(
          400,
          { vlan_id: ["VLAN ID must be 1–4094."] },
          "VLAN ID range"
        )
      }
      const payload: VLANWritePayload = {
        vlan_id: num,
        name: name.trim(),
        site_id: siteId,
        group_id: groupId,
        zone_id: zoneId,
        vrf_id: vrfId,
        status_id: statusId,
        color,
        description: description.trim(),
        tag_ids: tagIds,
        custom_fields: customFields,
      }
      return saveObject<VLAN>({
        objectType: "api.vlan",
        endpoint: "/api/vlans/",
        id: isEdit ? vlan!.id : undefined,
        payload,
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["vlans"] })
      qc.invalidateQueries({ queryKey: ["vlans-picker"] })
      qc.invalidateQueries({ queryKey: ["vlan", saved.id] })
      toast.success(
        isEdit
          ? `Updated VLAN ${saved.vlan_id}`
          : `Created VLAN ${saved.vlan_id}`
      )
      if (againRef.current) {
        againRef.current = false
        setVlanId(String(Number(vlanId) + 1))
        setName("")
        return
      }
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
      <FormSection title="VLAN" card>
        <div className="grid gap-3 @md:grid-cols-2">
          <FormText
            label="VLAN ID"
            required
            autoFocus={!isEdit}
            type="number"
            inputMode="numeric"
            min={1}
            max={4094}
            mono
            value={vlanId}
            onChange={setVlanId}
            placeholder="100"
            error={fieldErrors.vlan_id}
          />
          <FormText
            label="Name"
            required
            value={name}
            onChange={setName}
            placeholder="prod"
            error={fieldErrors.name}
          />
        </div>

        <FormStatusSelect
          value={statusId}
          onChange={setStatusId}
          options={statuses.data?.results ?? []}
          noneLabel="No status"
          placeholder="Select a status…"
          error={fieldErrors.status_id}
        />

        <FormColor
          label="Color"
          hint="Colours the VLAN's badge and topology rail"
          value={color}
          onChange={setColor}
          error={fieldErrors.color}
        />

        <FormTextarea
          label="Description"
          rows={2}
          value={description}
          onChange={setDescription}
          placeholder="e.g. Production application tier"
          error={fieldErrors.description}
        />
      </FormSection>

      <FormSection title="Placement" card>
        <FormCombobox
          label="Site"
          value={siteId}
          onChange={setSiteId}
          disabled={siteLocked}
          options={sites.options.map((s) => ({ value: s.id, label: s.name }))}
          noneLabel="No site"
          placeholder="No site"
          searchPlaceholder="Search sites…"
          emptyText="No sites."
          error={fieldErrors.site_id}
        />
        <FormCombobox
          label="Group"
          value={groupId}
          onChange={setGroupId}
          options={(groups.data?.results ?? []).map((g) => ({
            value: g.id,
            label: g.name,
            hint: `${g.min_vid}–${g.max_vid}`,
          }))}
          noneLabel="No group"
          placeholder="No group"
          searchPlaceholder="Search groups…"
          emptyText="No VLAN groups."
          error={fieldErrors.group_id}
        />
        <FormCombobox
          label="Zone"
          value={zoneId}
          onChange={setZoneId}
          options={(zones.data?.results ?? []).map((z) => ({
            value: z.id,
            label: z.name,
            color: z.color || null,
          }))}
          noneLabel="No zone"
          placeholder="No zone"
          searchPlaceholder="Search zones…"
          emptyText="No zones."
          error={fieldErrors.zone_id}
        />
        <FormCombobox
          label="VRF"
          hint="optional"
          info="The routing table this VLAN's SVI lives in. A prefix on the VLAN in another VRF is flagged on its page."
          value={vrfId}
          onChange={setVrfId}
          options={(vrfs.data?.results ?? []).map((v) => ({
            value: v.id,
            label: v.name,
            color: v.color || null,
          }))}
          noneLabel="No VRF"
          placeholder="No VRF"
          searchPlaceholder="Search VRFs…"
          emptyText="No VRFs."
          error={fieldErrors.vrf_id}
        />
      </FormSection>

      <FormTags
        label="Tags"
        value={tagIds}
        onChange={setTagIds}
        error={fieldErrors.tag_ids}
      />

      <CustomFieldInputs
        model="vlan"
        value={customFields}
        onChange={setCustomFields}
      />

      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create VLAN"}
        secondary={
          isEdit ? undefined : (
            <Button
              type="button"
              variant="outline"
              disabled={mutation.isPending}
              onClick={() => {
                againRef.current = true
                mutation.mutate()
              }}
            >
              Save and add another
            </Button>
          )
        }
      />
    </form>
  )
}
