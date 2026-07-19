import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useSiteOptions } from "@/lib/use-site-options"
import { toast } from "sonner"

import {
  api,
  ApiError,
  type Paginated,
  type TagOption,
  type VLAN,
  type VLANGroupOption,
  type VLANWritePayload,
  type ZoneOption,
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
import { useFieldErrors } from "@/components/forms"

export interface VlanFormInitial {
  vlanId?: number
}

export interface VlanFormProps {
  vlan?: VLAN
  initial?: VlanFormInitial
  onSaved: (saved: VLAN) => void
  onCancel: () => void
}

const NONE = "__none__"

export function VlanForm({ vlan, initial, onSaved, onCancel }: VlanFormProps) {
  const isEdit = !!vlan
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [vlanId, setVlanId] = useState<string>(
    vlan ? String(vlan.vlan_id) : initial?.vlanId ? String(initial.vlanId) : ""
  )
  const [name, setName] = useState(vlan?.name ?? "")
  const [siteId, setSiteId] = useState<string | null>(vlan?.site?.id ?? null)
  const [groupId, setGroupId] = useState<string | null>(vlan?.group?.id ?? null)
  const [zoneId, setZoneId] = useState<string | null>(vlan?.zone?.id ?? null)
  const [description, setDescription] = useState(vlan?.description ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    vlan?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    vlan?.custom_fields ?? {}
  )

  useEffect(() => {
    if (!vlan) return
    setVlanId(String(vlan.vlan_id))
    setName(vlan.name)
    setSiteId(vlan.site?.id ?? null)
    setGroupId(vlan.group?.id ?? null)
    setZoneId(vlan.zone?.id ?? null)
    setDescription(vlan.description)
    setTagIds(vlan.tags.map((t) => t.id))
    setCustomFields(vlan.custom_fields ?? {})
    reset()
  }, [vlan, reset])

  const sites = useSiteOptions()
  // Enhanced site separation: a single-site user's creates land in their own
  // site — prefill and lock the picker (useSiteOptions already filtered it).
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
  const zones = useQuery({
    queryKey: ["zones-picker"],
    queryFn: () => api<Paginated<ZoneOption>>("/api/zones/?picker=1"),
    staleTime: 10 * 60_000,
  })
  const tags = useQuery({
    queryKey: ["tags-picker"],
    queryFn: () => api<Paginated<TagOption>>("/api/tags/"),
    staleTime: 10 * 60_000,
  })

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
        description: description.trim(),
        tag_ids: tagIds,
        custom_fields: customFields,
      }
      if (isEdit) {
        return api<VLAN>(`/api/vlans/${vlan!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      }
      return api<VLAN>("/api/vlans/", {
        method: "POST",
        body: JSON.stringify(payload),
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
      <div className="grid grid-cols-[120px_1fr] gap-3">
        <Field label="VLAN ID" error={fieldErrors.vlan_id}>
          <Input
            autoFocus={!isEdit}
            required
            type="number"
            min={1}
            max={4094}
            inputMode="numeric"
            placeholder="100"
            value={vlanId}
            onChange={(e) => setVlanId(e.target.value)}
            className="font-mono"
          />
        </Field>
        <Field label="Name" error={fieldErrors.name}>
          <Input
            required
            placeholder="prod"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </Field>
      </div>

      <Field label="Site" error={fieldErrors.site_id}>
        <Select
          value={siteId ?? NONE}
          onValueChange={(v) => setSiteId(v === NONE ? null : v)}
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

      <Field label="Group" error={fieldErrors.group_id}>
        <Select
          value={groupId ?? NONE}
          onValueChange={(v) => setGroupId(v === NONE ? null : v)}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="No group" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>No group</SelectItem>
            {groups.data?.results.map((g) => (
              <SelectItem key={g.id} value={g.id}>
                {g.name}{" "}
                <span className="text-muted-foreground">
                  · {g.min_vid}–{g.max_vid}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="Zone" error={fieldErrors.zone_id}>
        <Select
          value={zoneId ?? NONE}
          onValueChange={(v) => setZoneId(v === NONE ? null : v)}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="No zone" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>No zone</SelectItem>
            {zones.data?.results.map((z) => (
              <SelectItem key={z.id} value={z.id}>
                {z.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="Description" error={fieldErrors.description}>
        <Textarea
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g. Production application tier"
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
        model="vlan"
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
              : "Create VLAN"}
        </Button>
      </div>
    </form>
  )
}

function Field({
  label,
  error,
  children,
}: {
  label: string
  error?: string
  children: React.ReactNode
}) {
  return (
    <div className="grid gap-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  )
}
