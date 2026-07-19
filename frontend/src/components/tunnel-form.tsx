import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type IPSecProfileOption,
  type Paginated,
  type Status,
  type TagOption,
  type Tunnel,
  type TunnelEncapsulation,
  type TunnelGroupOption,
  type TunnelWritePayload,
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

const ENCAPS: { value: TunnelEncapsulation; label: string }[] = [
  { value: "ipsec-tunnel", label: "IPSec — Tunnel" },
  { value: "ipsec-transport", label: "IPSec — Transport" },
  { value: "gre", label: "GRE" },
  { value: "ip-ip", label: "IP-in-IP" },
  { value: "wireguard", label: "WireGuard" },
]

export interface TunnelFormProps {
  tunnel?: Tunnel
  onSaved: (v: Tunnel) => void
  onCancel: () => void
}

export function TunnelForm({ tunnel, onSaved, onCancel }: TunnelFormProps) {
  const isEdit = !!tunnel
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [name, setName] = useState(tunnel?.name ?? "")
  const [statusId, setStatusId] = useState<string | null>(
    tunnel?.status?.id ?? null
  )
  const [encapsulation, setEncapsulation] = useState<TunnelEncapsulation>(
    tunnel?.encapsulation ?? "ipsec-tunnel"
  )
  const [tunnelId, setTunnelId] = useState(
    tunnel?.tunnel_id != null ? String(tunnel.tunnel_id) : ""
  )
  const [groupId, setGroupId] = useState<string | null>(
    tunnel?.group?.id ?? null
  )
  const [profileId, setProfileId] = useState<string | null>(
    tunnel?.ipsec_profile?.id ?? null
  )
  const [description, setDescription] = useState(tunnel?.description ?? "")
  const [comments, setComments] = useState(tunnel?.comments ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    tunnel?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    tunnel?.custom_fields ?? {}
  )

  useEffect(() => {
    if (!tunnel) return
    setName(tunnel.name)
    setStatusId(tunnel.status?.id ?? null)
    setEncapsulation(tunnel.encapsulation)
    setTunnelId(tunnel.tunnel_id != null ? String(tunnel.tunnel_id) : "")
    setGroupId(tunnel.group?.id ?? null)
    setProfileId(tunnel.ipsec_profile?.id ?? null)
    setDescription(tunnel.description)
    setComments(tunnel.comments)
    setTagIds(tunnel.tags.map((t) => t.id))
    setCustomFields(tunnel.custom_fields ?? {})
    reset()
  }, [tunnel, reset])

  const groups = useQuery({
    queryKey: ["tunnel-groups-picker"],
    queryFn: () =>
      api<Paginated<TunnelGroupOption>>("/api/tunnel-groups/?picker=1"),
    staleTime: 10 * 60_000,
  })
  const profiles = useQuery({
    queryKey: ["ipsec-profiles-picker"],
    queryFn: () =>
      api<Paginated<IPSecProfileOption>>("/api/ipsec-profiles/?picker=1"),
    staleTime: 10 * 60_000,
  })
  const tags = useQuery({
    queryKey: ["tags-picker"],
    queryFn: () => api<Paginated<TagOption>>("/api/tags/"),
    staleTime: 10 * 60_000,
  })
  const statuses = useQuery({
    queryKey: ["statuses", "tunnel"],
    queryFn: () =>
      api<Paginated<Status>>("/api/statuses/?available_to=tunnel&picker=1"),
    staleTime: 5 * 60_000,
  })

  const ipsec =
    encapsulation === "ipsec-tunnel" || encapsulation === "ipsec-transport"

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: TunnelWritePayload = {
        name: name.trim(),
        status_id: statusId,
        encapsulation,
        tunnel_id: tunnelId ? Number(tunnelId) : null,
        group_id: groupId,
        ipsec_profile_id: ipsec ? profileId : null,
        description: description.trim(),
        comments: comments.trim(),
        tag_ids: tagIds,
        custom_fields: customFields,
      }
      if (isEdit)
        return api<Tunnel>(`/api/tunnels/${tunnel!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<Tunnel>("/api/tunnels/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["tunnels"] })
      qc.invalidateQueries({ queryKey: ["tunnel", saved.id] })
      qc.invalidateQueries({ queryKey: ["tunnel-groups"] })
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
        <FormSelect
          label="Encapsulation"
          value={encapsulation}
          onChange={(v) =>
            setEncapsulation((v as TunnelEncapsulation) ?? "ipsec-tunnel")
          }
          options={ENCAPS}
        />
        <FormText
          label="Tunnel ID"
          hint="optional"
          type="number"
          value={tunnelId}
          onChange={setTunnelId}
          error={fieldErrors.tunnel_id}
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
        {ipsec && (
          <FormCombobox
            label="IPSec profile"
            hint="optional"
            value={profileId}
            onChange={setProfileId}
            options={(profiles.data?.results ?? []).map((p) => ({
              value: p.id,
              label: p.name,
            }))}
            noneLabel="No profile"
            placeholder="No profile"
            searchPlaceholder="Search profiles…"
            emptyText="No profiles."
            error={fieldErrors.ipsec_profile_id}
          />
        )}
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
        model="tunnel"
        value={customFields}
        onChange={setCustomFields}
      />
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create tunnel"}
      />
    </form>
  )
}
