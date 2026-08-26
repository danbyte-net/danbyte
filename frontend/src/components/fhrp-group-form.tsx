import { useEffect, useState } from "react"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"

import {
  type FHRPGroup,
  type FHRPGroupWritePayload,
  type FHRPProtocol,
} from "@/lib/api"
import { Input } from "@/components/ui/input"
import { IpPicker } from "@/components/ip-picker"
import { CustomFieldInputs } from "@/components/custom-field-inputs"
import {
  Field,
  FormFooter,
  FormSection,
  FormSelect,
  FormTags,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { useSaveObject } from "@/lib/save-object"

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
  { value: "plaintext", label: "Plaintext" },
  { value: "md5", label: "MD5" },
]

export function FhrpGroupForm({
  group,
  onSaved,
  onCancel,
}: FhrpGroupFormProps) {
  const isEdit = !!group
  const qc = useQueryClient()
  const { fieldErrors, handleApiError, reset } = useFieldErrors()
  const saveObject = useSaveObject()

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
      return saveObject<FHRPGroup>({
        objectType: "api.fhrpgroup",
        endpoint: "/api/fhrp-groups/",
        id: isEdit ? group!.id : undefined,
        payload,
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
      className="@container grid gap-4"
    >
      <FormSection title="Group" card>
        <div className="grid gap-3 @md:grid-cols-2">
          <FormSelect
            label="Protocol"
            value={protocol}
            onChange={(v) => setProtocol((v as FHRPProtocol) ?? "vrrp3")}
            options={PROTOCOLS}
            error={fieldErrors.protocol}
          />
          <FormText
            label="Group ID"
            required
            hint="0–255"
            type="number"
            min={0}
            max={255}
            mono
            placeholder="10"
            value={groupId}
            onChange={setGroupId}
            error={fieldErrors.group_id}
          />
        </div>

        <FormText
          label="Name"
          hint="optional label"
          value={name}
          onChange={setName}
          placeholder="gw-vrrp-prod"
          error={fieldErrors.name}
        />

        <IpPicker
          label="Virtual IP"
          hint="optional"
          value={virtualIpId}
          onChange={setVirtualIpId}
          noneLabel="No virtual IP"
          placeholder="Select an IP…"
          error={fieldErrors.virtual_ip_id}
        />

        <FormTextarea
          label="Description"
          rows={2}
          value={description}
          onChange={setDescription}
          placeholder="e.g. Default gateway redundancy for the prod VLAN"
          error={fieldErrors.description}
        />
      </FormSection>

      <FormSection title="Authentication" card>
        <div className="grid gap-3 @md:grid-cols-2">
          <FormSelect
            label="Auth type"
            value={authType || null}
            onChange={(v) => setAuthType((v as "plaintext" | "md5") ?? "")}
            noneLabel="None"
            options={AUTH_TYPES}
            error={fieldErrors.auth_type}
          />
          <Field label="Auth key" error={fieldErrors.auth_key}>
            <Input
              placeholder={authType ? "shared secret" : "-"}
              value={authKey}
              disabled={!authType}
              onChange={(e) => setAuthKey(e.target.value)}
              className="font-mono"
            />
          </Field>
        </div>
      </FormSection>

      <FormTags
        label="Tags"
        value={tagIds}
        onChange={setTagIds}
        error={fieldErrors.tag_ids}
      />

      <CustomFieldInputs
        model="fhrpgroup"
        value={customFields}
        onChange={setCustomFields}
      />

      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create FHRP group"}
      />
    </form>
  )
}
