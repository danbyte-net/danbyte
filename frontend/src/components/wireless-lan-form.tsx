import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type Paginated,
  type Status,
  type TagOption,
  type VLANOption,
  type WirelessAuthCipher,
  type WirelessAuthType,
  type WirelessLAN,
  type WirelessLANGroupOption,
  type WirelessLANWritePayload,
} from "@/lib/api"
import {
  Field,
  FormCombobox,
  FormFooter,
  FormSelect,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { TagMultiSelect } from "@/components/cells/tag-multi-select"
import { CustomFieldInputs } from "@/components/custom-field-inputs"

const AUTH_TYPES: { value: WirelessAuthType; label: string }[] = [
  { value: "", label: "—" },
  { value: "open", label: "Open" },
  { value: "wep", label: "WEP" },
  { value: "wpa-personal", label: "WPA Personal (PSK)" },
  { value: "wpa-enterprise", label: "WPA Enterprise" },
]
const AUTH_CIPHERS: { value: WirelessAuthCipher; label: string }[] = [
  { value: "", label: "—" },
  { value: "auto", label: "Auto" },
  { value: "tkip", label: "TKIP" },
  { value: "aes", label: "AES" },
]

export interface WirelessLANFormProps {
  wlan?: WirelessLAN
  onSaved: (v: WirelessLAN) => void
  onCancel: () => void
}

export function WirelessLANForm({
  wlan,
  onSaved,
  onCancel,
}: WirelessLANFormProps) {
  const isEdit = !!wlan
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [ssid, setSsid] = useState(wlan?.ssid ?? "")
  const [groupId, setGroupId] = useState<string | null>(wlan?.group?.id ?? null)
  const [statusId, setStatusId] = useState<string | null>(
    wlan?.status?.id ?? null
  )
  const [vlanId, setVlanId] = useState<string | null>(wlan?.vlan?.id ?? null)
  const [authType, setAuthType] = useState<WirelessAuthType>(
    wlan?.auth_type ?? ""
  )
  const [authCipher, setAuthCipher] = useState<WirelessAuthCipher>(
    wlan?.auth_cipher ?? ""
  )
  const [description, setDescription] = useState(wlan?.description ?? "")
  const [comments, setComments] = useState(wlan?.comments ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    wlan?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    wlan?.custom_fields ?? {}
  )

  useEffect(() => {
    if (!wlan) return
    setSsid(wlan.ssid)
    setGroupId(wlan.group?.id ?? null)
    setStatusId(wlan.status?.id ?? null)
    setVlanId(wlan.vlan?.id ?? null)
    setAuthType(wlan.auth_type)
    setAuthCipher(wlan.auth_cipher)
    setDescription(wlan.description)
    setComments(wlan.comments)
    setTagIds(wlan.tags.map((t) => t.id))
    setCustomFields(wlan.custom_fields ?? {})
    reset()
  }, [wlan, reset])

  const groups = useQuery({
    queryKey: ["wireless-lan-groups-picker"],
    queryFn: () =>
      api<Paginated<WirelessLANGroupOption>>(
        "/api/wireless-lan-groups/?picker=1"
      ),
    staleTime: 10 * 60_000,
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
  const statuses = useQuery({
    queryKey: ["statuses", "wirelesslan"],
    queryFn: () =>
      api<Paginated<Status>>(
        "/api/statuses/?available_to=wirelesslan&picker=1"
      ),
    staleTime: 5 * 60_000,
  })

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: WirelessLANWritePayload = {
        ssid: ssid.trim(),
        group_id: groupId,
        status_id: statusId,
        vlan_id: vlanId,
        auth_type: authType,
        auth_cipher: authCipher,
        description: description.trim(),
        comments: comments.trim(),
        tag_ids: tagIds,
        custom_fields: customFields,
      }
      if (isEdit)
        return api<WirelessLAN>(`/api/wireless-lans/${wlan!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<WirelessLAN>("/api/wireless-lans/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["wireless-lans"] })
      qc.invalidateQueries({ queryKey: ["wireless-lan", saved.id] })
      qc.invalidateQueries({ queryKey: ["wireless-lan-groups"] })
      toast.success(isEdit ? `Updated ${saved.ssid}` : `Created ${saved.ssid}`)
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
      <div className="grid grid-cols-2 gap-3">
        <FormText
          label="SSID"
          required
          autoFocus={!isEdit}
          value={ssid}
          onChange={setSsid}
          error={fieldErrors.ssid}
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
          label="Group"
          hint="optional"
          value={groupId}
          onChange={setGroupId}
          options={(groups.data?.results ?? []).map((g) => ({
            value: g.id,
            label: g.name,
          }))}
          noneLabel="No group"
          placeholder="No group"
          searchPlaceholder="Search groups…"
          emptyText="No groups."
          error={fieldErrors.group_id}
        />
        <FormCombobox
          label="VLAN"
          hint="optional bridge"
          value={vlanId}
          onChange={setVlanId}
          options={(vlans.data?.results ?? []).map((v) => ({
            value: v.id,
            label: `${v.vlan_id} · ${v.name}`,
          }))}
          noneLabel="No VLAN"
          placeholder="No VLAN"
          searchPlaceholder="Search VLANs…"
          emptyText="No VLANs."
          error={fieldErrors.vlan_id}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <FormSelect
          label="Authentication"
          value={authType}
          onChange={(v) => setAuthType((v as WirelessAuthType) ?? "")}
          options={AUTH_TYPES}
        />
        <FormSelect
          label="Cipher"
          value={authCipher}
          onChange={(v) => setAuthCipher((v as WirelessAuthCipher) ?? "")}
          options={AUTH_CIPHERS}
        />
      </div>

      <FormText
        label="Description"
        value={description}
        onChange={setDescription}
        error={fieldErrors.description}
      />
      <FormTextarea
        label="Comments"
        value={comments}
        onChange={setComments}
        error={fieldErrors.comments}
      />
      <Field label="Tags" error={fieldErrors.tag_ids}>
        <TagMultiSelect
          options={tags.data?.results ?? []}
          value={tagIds}
          onChange={setTagIds}
        />
      </Field>
      <CustomFieldInputs
        model="wirelesslan"
        value={customFields}
        onChange={setCustomFields}
      />
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create wireless LAN"}
      />
    </form>
  )
}
