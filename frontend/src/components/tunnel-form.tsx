import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type IPSecProfileOption,
  type Paginated,
  type Status,
  type Tunnel,
  type TunnelEncapsulation,
  type TunnelGroupOption,
  type TunnelWritePayload,
} from "@/lib/api"
import {
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
import { CustomFieldInputs } from "@/components/custom-field-inputs"
import { useSaveObject } from "@/lib/save-object"

const ENCAPS: { value: TunnelEncapsulation; label: string }[] = [
  { value: "ipsec-tunnel", label: "IPSec - Tunnel" },
  { value: "ipsec-transport", label: "IPSec - Transport" },
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
  const saveObject = useSaveObject()

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
      return saveObject<Tunnel>({
        objectType: "api.tunnel",
        endpoint: "/api/tunnels/",
        id: isEdit ? tunnel!.id : undefined,
        payload,
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
      className="@container grid gap-4"
    >
      <FormColumns>
        <FormColumn>
          <FormSection title="Tunnel" card>
            <FormText
              label="Name"
              required
              autoFocus={!isEdit}
              value={name}
              onChange={setName}
              error={fieldErrors.name}
            />
            <div className="grid gap-3 @md:grid-cols-2">
              <FormStatusSelect
                value={statusId}
                onChange={setStatusId}
                options={statuses.data?.results ?? []}
                noneLabel="No status"
                placeholder="Select a status…"
                error={fieldErrors.status_id}
              />
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
            </div>
          </FormSection>

          <FormSection title="Notes" card>
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
          </FormSection>
        </FormColumn>

        <FormColumn>
          <FormSection title="Encapsulation" card>
            <div className="grid gap-3 @md:grid-cols-2">
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
