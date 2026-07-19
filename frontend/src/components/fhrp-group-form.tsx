import { useEffect, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  api,
  type FHRPGroup,
  type FHRPGroupWritePayload,
  type FHRPProtocol,
  type Paginated,
  type TagOption,
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
import { IpPicker } from "@/components/ip-picker"
import { TagMultiSelect } from "@/components/cells/tag-multi-select"
import { CustomFieldInputs } from "@/components/custom-field-inputs"
import { useFieldErrors } from "@/components/forms"

export interface FhrpGroupFormProps {
  group?: FHRPGroup
  onSaved: (g: FHRPGroup) => void
  onCancel: () => void
}

const PROTOCOLS: { value: FHRPProtocol; label: string }[] = [
  { value: "vrrp2", label: "VRRPv2" },
  { value: "vrrp3", label: "VRRPv3" },
  { value: "hsrp", label: "HSRP" },
  { value: "glbp", label: "GLBP" },
  { value: "carp", label: "CARP" },
]
const AUTH_TYPES = [
  { value: "", label: "None" },
  { value: "plaintext", label: "Plaintext" },
  { value: "md5", label: "MD5" },
] as const

export function FhrpGroupForm({
  group,
  onSaved,
  onCancel,
}: FhrpGroupFormProps) {
  const isEdit = !!group
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()

  const [name, setName] = useState(group?.name ?? "")
  const [protocol, setProtocol] = useState<FHRPProtocol>(
    group?.protocol ?? "vrrp3"
  )
  const [groupId, setGroupId] = useState<string>(
    group ? String(group.group_id) : ""
  )
  const [authType, setAuthType] = useState<"" | "plaintext" | "md5">(
    group?.auth_type ?? ""
  )
  const [authKey, setAuthKey] = useState(group?.auth_key ?? "")
  const [virtualIpId, setVirtualIpId] = useState<string | null>(
    group?.virtual_ip?.id ?? null
  )
  const [description, setDescription] = useState(group?.description ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    group?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    group?.custom_fields ?? {}
  )

  useEffect(() => {
    if (!group) return
    setName(group.name)
    setProtocol(group.protocol)
    setGroupId(String(group.group_id))
    setAuthType(group.auth_type)
    setAuthKey(group.auth_key)
    setVirtualIpId(group.virtual_ip?.id ?? null)
    setDescription(group.description)
    setTagIds(group.tags.map((t) => t.id))
    setCustomFields(group.custom_fields ?? {})
    reset()
  }, [group, reset])

  const tags = useQuery({
    queryKey: ["tags-picker"],
    queryFn: () => api<Paginated<TagOption>>("/api/tags/"),
    staleTime: 10 * 60_000,
  })

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: FHRPGroupWritePayload = {
        name: name.trim(),
        protocol,
        group_id: Number(groupId),
        auth_type: authType,
        auth_key: authType ? authKey : "",
        virtual_ip_id: virtualIpId,
        description: description.trim(),
        tag_ids: tagIds,
        custom_fields: customFields,
      }
      if (isEdit)
        return api<FHRPGroup>(`/api/fhrp-groups/${group!.id}/`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        })
      return api<FHRPGroup>("/api/fhrp-groups/", {
        method: "POST",
        body: JSON.stringify(payload),
      })
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["fhrp-groups"] })
      qc.invalidateQueries({ queryKey: ["fhrp-group", saved.id] })
      toast.success(
        isEdit
          ? `Updated ${saved.protocol_display} ${saved.group_id}`
          : `Created ${saved.protocol_display} ${saved.group_id}`
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
      <div className="grid grid-cols-2 gap-3">
        <Field label="Protocol" error={fieldErrors.protocol}>
          <Select
            value={protocol}
            onValueChange={(v) => setProtocol(v as FHRPProtocol)}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROTOCOLS.map((p) => (
                <SelectItem key={p.value} value={p.value}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Group ID" hint="0–255" error={fieldErrors.group_id}>
          <Input
            required
            type="number"
            min={0}
            max={255}
            placeholder="10"
            value={groupId}
            onChange={(e) => setGroupId(e.target.value)}
            className="font-mono"
          />
        </Field>
      </div>

      <Field label="Name" hint="optional label" error={fieldErrors.name}>
        <Input
          placeholder="gw-vrrp-prod"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>

      <IpPicker
        label="Virtual IP"
        hint="optional"
        value={virtualIpId}
        onChange={setVirtualIpId}
        noneLabel="No virtual IP"
        placeholder="Select an IP…"
        error={fieldErrors.virtual_ip_id}
      />

      <div className="grid grid-cols-2 gap-3">
        <Field label="Auth type" error={fieldErrors.auth_type}>
          <Select
            value={authType || "none"}
            onValueChange={(v) =>
              setAuthType(v === "none" ? "" : (v as "plaintext" | "md5"))
            }
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {AUTH_TYPES.map((a) => (
                <SelectItem key={a.value || "none"} value={a.value || "none"}>
                  {a.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field label="Auth key" error={fieldErrors.auth_key}>
          <Input
            placeholder={authType ? "shared secret" : "—"}
            value={authKey}
            disabled={!authType}
            onChange={(e) => setAuthKey(e.target.value)}
            className="font-mono"
          />
        </Field>
      </div>

      <Field label="Description" error={fieldErrors.description}>
        <Textarea
          rows={2}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="e.g. Default gateway redundancy for the prod VLAN"
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
        model="fhrpgroup"
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
              : "Create FHRP group"}
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
