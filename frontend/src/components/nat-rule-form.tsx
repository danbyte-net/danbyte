import { useMemo, useState } from "react"
import { useMutation, useQuery } from "@tanstack/react-query"
import { toast } from "sonner"

import { api } from "@/lib/api"
import type { NATRule, Paginated, Status } from "@/lib/api"
import { DevicePicker } from "@/components/device-picker"
import { IpPicker } from "@/components/ip-picker"
import { PrefixPicker } from "@/components/prefix-picker"
import {
  FormColumn,
  FormColumns,
  FormCombobox,
  FormFooter,
  FormSection,
  FormStatusSelect,
  FormTags,
  FormText,
  FormTextarea,
  useFieldErrors,
} from "@/components/forms"
import { CustomFieldInputs } from "@/components/custom-field-inputs"
import { useSaveObject } from "@/lib/save-object"

/**
 * Create/edit one NAT rule (#151).
 *
 * Laid out as the translation reads - what arrives on the outside, what it
 * becomes on the inside - rather than as a flat list of fields, because that
 * is the shape of the thing being written down.
 */

const KINDS = [
  { value: "dnat", label: "Destination NAT (port forward)" },
  { value: "snat", label: "Source NAT" },
  { value: "static", label: "Static (1:1) NAT" },
  { value: "masquerade", label: "Masquerade" },
]

const PROTOCOLS = [
  { value: "tcp", label: "TCP" },
  { value: "udp", label: "UDP" },
  { value: "tcp-udp", label: "TCP/UDP" },
  { value: "icmp", label: "ICMP" },
  { value: "any", label: "Any" },
]

/** Protocols that carry no port, so the port fields have nothing to say. */
const PORTLESS = new Set(["icmp", "any"])

export function NATRuleForm({
  rule,
  device,
  onSaved,
  onCancel,
}: {
  rule?: NATRule | null
  /** Pre-set firewall when adding from a device's own pane. */
  device?: { id: string; name: string }
  onSaved: (v: NATRule) => void
  onCancel: () => void
}) {
  const isEdit = !!rule
  const { fieldErrors, handleApiError } = useFieldErrors()
  const saveObject = useSaveObject()

  const [name, setName] = useState(rule?.name ?? "")
  const [kind, setKind] = useState<string | null>(rule?.kind ?? "dnat")
  const [protocol, setProtocol] = useState<string | null>(
    rule?.protocol ?? "tcp"
  )
  const [deviceId, setDeviceId] = useState<string | null>(
    rule?.device?.id ?? device?.id ?? null
  )
  const [externalIpId, setExternalIpId] = useState<string | null>(
    rule?.external_ip?.id ?? null
  )
  const [externalPorts, setExternalPorts] = useState(rule?.external_ports ?? "")
  const [internalIpId, setInternalIpId] = useState<string | null>(
    rule?.internal_ip?.id ?? null
  )
  const [internalPorts, setInternalPorts] = useState(rule?.internal_ports ?? "")
  const [sourceIpId, setSourceIpId] = useState<string | null>(
    rule?.source_ip?.id ?? null
  )
  const [sourcePrefixId, setSourcePrefixId] = useState<string | null>(
    rule?.source_prefix?.id ?? null
  )
  const [statusId, setStatusId] = useState<string | null>(
    rule?.status?.id ?? null
  )
  const [description, setDescription] = useState(rule?.description ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    rule?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    rule?.custom_fields ?? {}
  )

  const statuses = useQuery({
    queryKey: ["statuses", "natrule"],
    queryFn: () =>
      api<Paginated<Status>>("/api/statuses/?available_to=natrule&picker=1"),
    staleTime: 5 * 60_000,
  })

  const portless = useMemo(() => PORTLESS.has(protocol ?? ""), [protocol])

  const mutation = useMutation({
    mutationFn: () =>
      saveObject<NATRule>({
        objectType: "api.natrule",
        endpoint: "/api/nat-rules/",
        id: isEdit ? rule.id : undefined,
        payload: {
          name: name.trim(),
          kind,
          protocol,
          device_id: deviceId,
          external_ip_id: externalIpId,
          // A protocol with no ports must send blanks, not whatever was typed
          // before the protocol changed - otherwise the server rejects a form
          // whose port fields are not even on screen.
          external_ports: portless ? "" : externalPorts.trim(),
          internal_ip_id: internalIpId,
          internal_ports: portless ? "" : internalPorts.trim(),
          source_ip_id: sourceIpId,
          source_prefix_id: sourcePrefixId,
          status_id: statusId,
          description: description.trim(),
          tag_ids: tagIds,
          custom_fields: customFields,
        },
      }),
    onSuccess: (saved) => {
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
      <FormColumns>
        <FormColumn>
          <FormSection title="Rule" card>
            <FormText
              label="Name"
              required
              autoFocus={!isEdit}
              value={name}
              onChange={setName}
              placeholder="CRM HTTPS"
              error={fieldErrors.name}
            />
            <FormCombobox
              label="Type"
              value={kind}
              onChange={setKind}
              options={KINDS}
              error={fieldErrors.kind}
            />
            <FormCombobox
              label="Protocol"
              value={protocol}
              onChange={setProtocol}
              options={PROTOCOLS}
              error={fieldErrors.protocol}
            />
            <DevicePicker
              label="Firewall"
              hint="optional - the device enforcing the rule"
              value={deviceId}
              onChange={setDeviceId}
              error={fieldErrors.device_id}
            />
            <FormStatusSelect
              value={statusId}
              onChange={setStatusId}
              options={statuses.data?.results ?? []}
              placeholder="Select a status…"
              error={fieldErrors.status_id}
            />
          </FormSection>

          <FormSection title="Restrict to" card>
            <PrefixPicker
              label="Source prefix"
              hint="optional - who the rule applies to"
              value={sourcePrefixId}
              onChange={setSourcePrefixId}
              error={fieldErrors.source_prefix_id}
            />
            <IpPicker
              label="Source address"
              hint="optional"
              value={sourceIpId}
              onChange={setSourceIpId}
              error={fieldErrors.source_ip_id}
            />
          </FormSection>
        </FormColumn>

        <FormColumn>
          <FormSection title="Outside" card>
            <IpPicker
              label="External address"
              hint="the address reached from outside"
              value={externalIpId}
              onChange={setExternalIpId}
              error={fieldErrors.external_ip_id}
            />
            {!portless && (
              <FormText
                label="External port"
                mono
                hint="a port (443) or a range (8000-8100)"
                value={externalPorts}
                onChange={setExternalPorts}
                placeholder="443"
                error={fieldErrors.external_ports}
              />
            )}
          </FormSection>

          <FormSection title="Inside" card>
            <IpPicker
              label="Internal address"
              hint="what it is translated to"
              value={internalIpId}
              onChange={setInternalIpId}
              error={fieldErrors.internal_ip_id}
            />
            {!portless && (
              <FormText
                label="Internal port"
                mono
                hint="blank keeps the external port"
                value={internalPorts}
                onChange={setInternalPorts}
                placeholder="8443"
                error={fieldErrors.internal_ports}
              />
            )}
          </FormSection>
        </FormColumn>
      </FormColumns>

      <FormTextarea
        label="Description"
        value={description}
        onChange={setDescription}
        error={fieldErrors.description}
      />
      <FormTags
        label="Tags"
        value={tagIds}
        onChange={setTagIds}
        error={fieldErrors.tag_ids}
      />
      <CustomFieldInputs
        model="natrule"
        value={customFields}
        onChange={setCustomFields}
      />
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create rule"}
      />
    </form>
  )
}
