import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type IPRange,
  type IPRangeWritePayload,
  type IPRoleOption,
  type Paginated,
  type Prefix,
  type Status,
  type VRFOption,
} from "@/lib/api"
import { CustomFieldInputs } from "@/components/custom-field-inputs"
import {
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
import { cidrHostRange } from "@/lib/prefix-tree"
import { PrefixPicker, prefixDetailKey } from "@/components/prefix-picker"

export interface IpRangeFormProps {
  range?: IPRange
  onSaved: (saved: IPRange) => void
  onCancel: () => void
}

export function IpRangeForm({ range, onSaved, onCancel }: IpRangeFormProps) {
  const isEdit = !!range
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const saveObject = useSaveObject()

  const [startAddress, setStartAddress] = useState(range?.start_address ?? "")
  const [endAddress, setEndAddress] = useState(range?.end_address ?? "")
  const [statusId, setStatusId] = useState<string | null>(
    range?.status?.id ?? null
  )
  const [vrfId, setVrfId] = useState<string | null>(range?.vrf?.id ?? null)
  const [prefixId, setPrefixId] = useState<string | null>(
    range?.prefix?.id ?? null
  )
  const [roleId, setRoleId] = useState<string | null>(range?.role?.id ?? null)
  const [description, setDescription] = useState(range?.description ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    range?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    range?.custom_fields ?? {}
  )

  useEffect(() => {
    if (!range) return
    setStartAddress(range.start_address)
    setEndAddress(range.end_address)
    setStatusId(range.status?.id ?? null)
    setVrfId(range.vrf?.id ?? null)
    setPrefixId(range.prefix?.id ?? null)
    setRoleId(range.role?.id ?? null)
    setDescription(range.description)
    setTagIds(range.tags.map((t) => t.id))
    setCustomFields(range.custom_fields ?? {})
    reset()
  }, [range, reset])

  const statuses = useQuery({
    queryKey: ["statuses", "iprange"],
    queryFn: () =>
      api<Paginated<Status>>("/api/statuses/?available_to=iprange&picker=1"),
    staleTime: 5 * 60_000,
  })
  const vrfs = useQuery({
    queryKey: ["vrfs-picker"],
    queryFn: () => api<Paginated<VRFOption>>("/api/vrfs/"),
    staleTime: 10 * 60_000,
  })
  const roles = useQuery({
    queryKey: ["ip-roles-picker"],
    queryFn: () => api<Paginated<IPRoleOption>>("/api/ip-roles/"),
    staleTime: 10 * 60_000,
  })

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: IPRangeWritePayload = {
        start_address: startAddress.trim(),
        end_address: endAddress.trim(),
        status_id: statusId,
        vrf_id: vrfId,
        prefix_id: prefixId,
        role_id: roleId,
        description: description.trim(),
        tag_ids: tagIds,
        custom_fields: customFields,
      }
      return saveObject<IPRange>({
        objectType: "api.iprange",
        endpoint: "/api/ip-ranges/",
        id: isEdit ? range!.id : undefined,
        payload,
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["ip-ranges"] })
      qc.invalidateQueries({ queryKey: ["ip-range", saved.id] })
      toast.success(
        isEdit
          ? `Updated ${saved.start_address}–${saved.end_address}`
          : `Created ${saved.start_address}–${saved.end_address}`
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
      <FormSection title="Range" card>
        <div className="grid gap-3 @md:grid-cols-2">
          <FormText
            label="Start address"
            required
            autoFocus={!isEdit}
            mono
            value={startAddress}
            onChange={setStartAddress}
            placeholder="10.0.10.10"
            error={fieldErrors.start_address}
          />
          <FormText
            label="End address"
            required
            mono
            value={endAddress}
            onChange={setEndAddress}
            placeholder="10.0.10.50"
            error={fieldErrors.end_address}
          />
        </div>

        <PrefixPicker
          label="Parent prefix"
          hint="sets the VRF"
          value={prefixId}
          onChange={(v) => {
            setPrefixId(v)
            if (!v) return
            // Fetch the picked prefix (works for modal picks beyond the
            // combobox page too - the old find-in-first-page lookup didn't).
            qc.fetchQuery({
              queryKey: prefixDetailKey(v),
              queryFn: () => api<Prefix>(`/api/prefixes/${v}/`),
              staleTime: 10 * 60_000,
            }).then((p) => {
              // A range under a prefix inherits its VRF (the backend enforces
              // this too) - reflect it immediately.
              setVrfId(p.vrf?.id ?? null)
              // Pre-fill the span with the prefix's network → broadcast so the
              // user starts from the full subnet and narrows from there.
              const range = cidrHostRange(p.cidr)
              if (range) {
                setStartAddress(range.start)
                setEndAddress(range.end)
              }
            })
          }}
          noneLabel="No parent prefix"
          placeholder="No parent prefix"
          error={fieldErrors.prefix_id}
        />

        <FormCombobox
          label="VRF"
          hint={prefixId ? "from prefix" : undefined}
          value={vrfId}
          onChange={setVrfId}
          disabled={!!prefixId}
          options={(vrfs.data?.results ?? []).map((v) => ({
            value: v.id,
            label: v.name,
            color: v.color || null,
            hint: v.rd || undefined,
          }))}
          noneLabel="Global"
          placeholder="Global"
          searchPlaceholder="Search VRFs…"
          emptyText="No VRFs."
          error={fieldErrors.vrf_id}
        />
      </FormSection>

      <FormSection title="Classification" card>
        <div className="grid gap-3 @md:grid-cols-2">
          <FormStatusSelect
            value={statusId}
            onChange={setStatusId}
            options={statuses.data?.results ?? []}
            noneLabel="No status"
            error={fieldErrors.status_id}
          />
          <FormCombobox
            label="Role"
            value={roleId}
            onChange={setRoleId}
            options={(roles.data?.results ?? []).map((r) => ({
              value: r.id,
              label: r.name,
              color: r.color,
            }))}
            noneLabel="No role"
            placeholder="No role"
            searchPlaceholder="Search roles…"
            emptyText="No IP roles."
            error={fieldErrors.role_id}
          />
        </div>

        <FormTextarea
          label="Description"
          rows={3}
          value={description}
          onChange={setDescription}
          placeholder="e.g. DHCP pool - floor 3 wireless"
          error={fieldErrors.description}
        />
      </FormSection>

      <FormTags
        label="Tags"
        value={tagIds}
        onChange={setTagIds}
        error={fieldErrors.tag_ids}
      />

      <CustomFieldInputs
        model="iprange"
        value={customFields}
        onChange={setCustomFields}
      />

      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create IP range"}
      />
    </form>
  )
}
