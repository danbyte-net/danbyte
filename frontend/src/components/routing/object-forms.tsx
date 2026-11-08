import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import { Plus, X } from "lucide-react"

import { apiAll } from "@/lib/api-all"
import type {
  ASNMini,
  BFDProfile,
  Community,
  EthernetSegment,
  InterfaceOption,
  PolicyRule,
  ROA,
  RoutingKeychain,
  RPKICache,
  StaticRoute,
  Status,
  VRFOption,
} from "@/lib/api"
import {
  FormCheckbox,
  FormCombobox,
  FormFooter,
  FormSection,
  FormSelect,
  FormStatusSelect,
  FormTags,
  FormText,
  FormTextarea,
} from "@/components/forms"
import { CustomFieldInputs } from "@/components/custom-field-inputs"
import { DevicePicker } from "@/components/device-picker"
import { PrefixPicker } from "@/components/prefix-picker"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

import {
  ROUTING_OBJECT_TYPES,
  numOrNull,
  numText,
  useRoutingSave,
} from "./form-bits"
import {
  firstError,
  OwnerField,
  ownerOf,
  ownerPayload,
  portPayload,
  useOwnerPorts,
} from "./owner"
import type { OwnerKind, RoutingOwner } from "./owner"

// ─── BFD profile ─────────────────────────────────────────────────────────────

export function BFDProfileForm({
  item,
  onSaved,
  onCancel,
}: {
  item?: BFDProfile
  onSaved: (v: BFDProfile) => void
  onCancel: () => void
}) {
  const isEdit = !!item
  const [name, setName] = useState(item?.name ?? "")
  const [minTx, setMinTx] = useState(numText(item?.min_tx ?? 300))
  const [minRx, setMinRx] = useState(numText(item?.min_rx ?? 300))
  const [multiplier, setMultiplier] = useState(numText(item?.multiplier ?? 3))
  const [echo, setEcho] = useState(item?.echo ?? false)
  const [description, setDescription] = useState(item?.description ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    item?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    item?.custom_fields ?? {}
  )
  const { mutation, fieldErrors } = useRoutingSave<BFDProfile>({
    objectType: ROUTING_OBJECT_TYPES.bfdprofile,
    endpoint: "/api/routing/bfd-profiles/",
    queryKey: "bfd-profiles",
    id: item?.id,
    label: (v) => v.name,
    onSaved,
  })
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        mutation.mutate({
          name: name.trim(),
          min_tx: numOrNull(minTx),
          min_rx: numOrNull(minRx),
          multiplier: numOrNull(multiplier),
          echo,
          description: description.trim(),
          tag_ids: tagIds,
          custom_fields: customFields,
        })
      }}
      className="@container grid gap-4"
    >
      <FormSection title="Profile" card>
        <FormText
          label="Name"
          required
          mono
          autoFocus={!isEdit}
          value={name}
          onChange={setName}
          placeholder="FAST"
          error={fieldErrors.name}
        />
        <div className="grid gap-3 @md:grid-cols-3">
          <FormText
            label="Min TX"
            required
            type="number"
            hint="ms"
            value={minTx}
            onChange={setMinTx}
            error={fieldErrors.min_tx}
          />
          <FormText
            label="Min RX"
            required
            type="number"
            hint="ms"
            value={minRx}
            onChange={setMinRx}
            error={fieldErrors.min_rx}
          />
          <FormText
            label="Multiplier"
            required
            type="number"
            value={multiplier}
            onChange={setMultiplier}
            info="Missed packets before the session is down."
            error={fieldErrors.multiplier}
          />
        </div>
        <FormCheckbox
          label="Echo mode"
          checked={echo}
          onChange={setEcho}
          info="Echo packets are looped back by the peer's forwarding plane, so the timers can be faster than its control plane."
        />
        <FormTextarea
          label="Description"
          value={description}
          onChange={setDescription}
          error={fieldErrors.description}
        />
        <FormTags value={tagIds} onChange={setTagIds} label="Tags" />
        <CustomFieldInputs
          model="bfdprofile"
          value={customFields}
          onChange={setCustomFields}
        />
      </FormSection>
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create profile"}
      />
    </form>
  )
}

// ─── Ethernet segment ────────────────────────────────────────────────────────

const ESI_KINDS = [
  { value: "type3", label: "Type 3: es-id + system MAC" },
  { value: "type0", label: "Type 0: full ESI" },
]

type SegmentMember = EthernetSegment["interfaces"][number]

/** The member ports live on different devices by design, so they are
 * picked one device at a time: a device, one of its ports, Add. */
function SegmentMembersField({
  value,
  onChange,
  error,
}: {
  value: SegmentMember[]
  onChange: (v: SegmentMember[]) => void
  error?: string
}) {
  const [device, setDevice] = useState<{ id: string; name: string } | null>(
    null
  )
  const [ifaceId, setIfaceId] = useState<string | null>(null)
  const interfaces = useQuery({
    queryKey: ["interfaces-picker", device?.id ?? null],
    queryFn: () =>
      apiAll<InterfaceOption>(`/api/interfaces/?device=${device!.id}`),
    enabled: !!device,
  })
  const chosen = new Set(value.map((m) => m.id))
  const options = (interfaces.data?.results ?? [])
    .filter((i) => !chosen.has(i.id))
    .map((i) => ({ value: i.id, label: i.name }))
  const add = () => {
    const iface = interfaces.data?.results.find((i) => i.id === ifaceId)
    if (!device || !iface || chosen.has(iface.id)) return
    onChange([...value, { id: iface.id, name: iface.name, device }])
    setIfaceId(null)
  }
  return (
    <div className="grid gap-2">
      <div className="grid gap-3 @md:grid-cols-[1fr_1fr_auto]">
        <DevicePicker
          label="Device"
          value={device?.id ?? null}
          onChange={(id) => {
            if (!id) setDevice(null)
            setIfaceId(null)
          }}
          onPickLabel={(id, name) => setDevice({ id, name })}
        />
        <FormCombobox
          label="Interface"
          value={ifaceId}
          onChange={setIfaceId}
          options={options}
          placeholder={device ? "Pick an interface" : "Pick a device first"}
          disabled={!device}
          searchPlaceholder="Search interfaces…"
          emptyText="No interfaces left on this device."
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="self-end"
          disabled={!ifaceId}
          onClick={add}
        >
          <Plus className="h-3.5 w-3.5" /> Add
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {value.length === 0 && (
          <span className="text-xs text-muted-foreground">
            No member interfaces yet.
          </span>
        )}
        {value.map((m) => (
          <Badge key={m.id} variant="secondary" className="gap-1 font-mono">
            {m.device.name}:{m.name}
            <button
              type="button"
              onClick={() => onChange(value.filter((v) => v.id !== m.id))}
              className="-mr-0.5 inline-flex h-3 w-3 items-center justify-center hover:text-destructive"
              aria-label={`Remove ${m.device.name}:${m.name}`}
            >
              <X className="h-2.5 w-2.5" />
            </button>
          </Badge>
        ))}
      </div>
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  )
}

export function EthernetSegmentForm({
  item,
  onSaved,
  onCancel,
}: {
  item?: EthernetSegment
  onSaved: (v: EthernetSegment) => void
  onCancel: () => void
}) {
  const isEdit = !!item
  const [name, setName] = useState(item?.name ?? "")
  const [kind, setKind] = useState<string | null>(item?.esi ? "type0" : "type3")
  const [esi, setEsi] = useState(item?.esi ?? "")
  const [esId, setEsId] = useState(numText(item?.es_id))
  const [sysMac, setSysMac] = useState(item?.sys_mac ?? "")
  const [dfPreference, setDfPreference] = useState(numText(item?.df_preference))
  const [members, setMembers] = useState<SegmentMember[]>(
    item?.interfaces ?? []
  )
  const [description, setDescription] = useState(item?.description ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    item?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    item?.custom_fields ?? {}
  )
  const { mutation, fieldErrors } = useRoutingSave<EthernetSegment>({
    objectType: ROUTING_OBJECT_TYPES.ethernetsegment,
    endpoint: "/api/routing/ethernet-segments/",
    queryKey: "ethernet-segments",
    id: item?.id,
    label: (v) => v.name,
    onSaved,
  })
  const full = kind === "type0"
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        mutation.mutate({
          name: name.trim(),
          esi: full ? esi.trim() : "",
          es_id: full ? null : numOrNull(esId),
          sys_mac: full ? "" : sysMac.trim(),
          df_preference: numOrNull(dfPreference),
          interface_ids: members.map((m) => m.id),
          description: description.trim(),
          tag_ids: tagIds,
          custom_fields: customFields,
        })
      }}
      className="@container grid gap-4"
    >
      <FormSection title="Segment" card>
        <div className="grid gap-3 @md:grid-cols-2">
          <FormText
            label="Name"
            required
            mono
            autoFocus={!isEdit}
            value={name}
            onChange={setName}
            placeholder="srv01-bond0"
            error={fieldErrors.name}
          />
          <FormSelect
            label="Identity"
            value={kind}
            onChange={setKind}
            options={ESI_KINDS}
            info="A type-3 ESI is derived from the es-id and the system MAC every leaf shares; a type-0 ESI is written out in full."
          />
        </div>
        {full ? (
          <FormText
            label="ESI"
            required
            mono
            value={esi}
            onChange={setEsi}
            placeholder="00:11:22:33:44:55:66:77:88:99"
            error={fieldErrors.esi}
          />
        ) : (
          <div className="grid gap-3 @md:grid-cols-2">
            <FormText
              label="ES-ID"
              required
              type="number"
              value={esId}
              onChange={setEsId}
              placeholder="1"
              error={fieldErrors.es_id}
            />
            <FormText
              label="System MAC"
              required
              mono
              value={sysMac}
              onChange={setSysMac}
              placeholder="00:1c:73:00:00:01"
              error={fieldErrors.sys_mac}
            />
          </div>
        )}
        <FormText
          label="Default DF preference"
          type="number"
          value={dfPreference}
          onChange={setDfPreference}
          info="Designated-forwarder election preference; higher wins. Each member port may set its own on the segment page."
          error={fieldErrors.df_preference}
        />
      </FormSection>
      <FormSection title="Interfaces" card>
        <SegmentMembersField
          value={members}
          onChange={setMembers}
          error={fieldErrors.interface_ids}
        />
      </FormSection>
      <FormSection title="Notes" card>
        <FormTextarea
          label="Description"
          value={description}
          onChange={setDescription}
          error={fieldErrors.description}
        />
        <FormTags value={tagIds} onChange={setTagIds} label="Tags" />
        <CustomFieldInputs
          model="ethernetsegment"
          value={customFields}
          onChange={setCustomFields}
        />
      </FormSection>
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create segment"}
      />
    </form>
  )
}

// ─── Community ───────────────────────────────────────────────────────────────

export function CommunityForm({
  item,
  onSaved,
  onCancel,
}: {
  item?: Community
  onSaved: (v: Community) => void
  onCancel: () => void
}) {
  const isEdit = !!item
  const [value, setValue] = useState(item?.value ?? "")
  const [name, setName] = useState(item?.name ?? "")
  const [kind, setKind] = useState<string | null>(item?.kind ?? "standard")
  const [description, setDescription] = useState(item?.description ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    item?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    item?.custom_fields ?? {}
  )
  const { mutation, fieldErrors } = useRoutingSave<Community>({
    objectType: ROUTING_OBJECT_TYPES.community,
    endpoint: "/api/routing/communities/",
    queryKey: "communities",
    id: item?.id,
    label: (v) => v.value,
    onSaved,
  })
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        mutation.mutate({
          value: value.trim(),
          name: name.trim(),
          kind,
          description: description.trim(),
          tag_ids: tagIds,
          custom_fields: customFields,
        })
      }}
      className="@container grid gap-4"
    >
      <FormSection title="Community" card>
        <div className="grid gap-3 @md:grid-cols-3">
          <FormText
            label="Value"
            required
            mono
            autoFocus={!isEdit}
            value={value}
            onChange={setValue}
            placeholder="65000:100"
            error={fieldErrors.value}
          />
          <FormText
            label="Name"
            required
            value={name}
            onChange={setName}
            placeholder="CUSTOMER-ROUTES"
            error={fieldErrors.name}
          />
          <FormSelect
            label="Kind"
            value={kind}
            onChange={setKind}
            options={[
              { value: "standard", label: "Standard" },
              { value: "large", label: "Large" },
              { value: "extended", label: "Extended" },
            ]}
            error={fieldErrors.kind}
          />
        </div>
        <FormTextarea
          label="Description"
          value={description}
          onChange={setDescription}
          error={fieldErrors.description}
        />
        <FormTags value={tagIds} onChange={setTagIds} label="Tags" />
        <CustomFieldInputs
          model="community"
          value={customFields}
          onChange={setCustomFields}
        />
      </FormSection>
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create community"}
      />
    </form>
  )
}

// ─── Keychain ────────────────────────────────────────────────────────────────

export function RoutingKeychainForm({
  item,
  onSaved,
  onCancel,
}: {
  item?: RoutingKeychain
  onSaved: (v: RoutingKeychain) => void
  onCancel: () => void
}) {
  const isEdit = !!item
  const [name, setName] = useState(item?.name ?? "")
  const [algorithm, setAlgorithm] = useState<string | null>(
    item?.algorithm ?? "md5"
  )
  const [description, setDescription] = useState(item?.description ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    item?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    item?.custom_fields ?? {}
  )
  // Write-only: never pre-filled, blank leaves the stored key alone.
  const [psk, setPsk] = useState("")
  const { mutation, fieldErrors } = useRoutingSave<RoutingKeychain>({
    objectType: ROUTING_OBJECT_TYPES.routingkeychain,
    endpoint: "/api/routing/keychains/",
    queryKey: "routing-keychains",
    id: item?.id,
    label: (v) => v.name,
    onSaved,
  })
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        mutation.mutate({
          name: name.trim(),
          algorithm,
          description: description.trim(),
          tag_ids: tagIds,
          custom_fields: customFields,
          ...(psk ? { psk } : {}),
        })
      }}
      className="@container grid gap-4"
    >
      <FormSection title="Keychain" card>
        <div className="grid gap-3 @md:grid-cols-2">
          <FormText
            label="Name"
            required
            mono
            autoFocus={!isEdit}
            value={name}
            onChange={setName}
            placeholder="ISIS-KEY"
            error={fieldErrors.name}
          />
          <FormSelect
            label="Algorithm"
            value={algorithm}
            onChange={setAlgorithm}
            options={[
              { value: "md5", label: "MD5" },
              { value: "sha1", label: "SHA-1" },
              { value: "sha256", label: "SHA-256" },
              { value: "hmac-sha-256", label: "HMAC-SHA-256" },
            ]}
            error={fieldErrors.algorithm}
          />
        </div>
        <FormText
          label="Key"
          type="password"
          autoComplete="new-password"
          value={psk}
          onChange={setPsk}
          placeholder={item?.psk_set ? "Stored - type to replace" : "Not set"}
          hint={item?.psk_set ? "blank keeps the stored key" : "optional"}
          info="The key is written to the deployment's secret store, never to this record. An administrator must enable a store under Settings → Security first."
          error={fieldErrors.psk}
        />
        <FormTextarea
          label="Description"
          value={description}
          onChange={setDescription}
          error={fieldErrors.description}
        />
        <FormTags value={tagIds} onChange={setTagIds} label="Tags" />
        <CustomFieldInputs
          model="routingkeychain"
          value={customFields}
          onChange={setCustomFields}
        />
      </FormSection>
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create keychain"}
      />
    </form>
  )
}

// ─── Static route ────────────────────────────────────────────────────────────

const KINDS = [
  { value: "nexthop", label: "Next hop" },
  { value: "interface", label: "Interface" },
  { value: "blackhole", label: "Blackhole" },
  { value: "reject", label: "Reject" },
]

export function StaticRouteForm({
  item,
  owner,
  onSaved,
  onCancel,
}: {
  item?: StaticRoute | null
  /** Pre-set box when adding from a device's or VM's own Routing tab. */
  owner?: RoutingOwner
  onSaved: (v: StaticRoute) => void
  onCancel: () => void
}) {
  const isEdit = !!item
  const start = (item ? ownerOf(item) : null) ?? owner ?? null
  const [on, setOn] = useState<{ kind: OwnerKind; id: string | null }>({
    kind: start?.kind ?? "device",
    id: start?.id ?? null,
  })
  const [vrfId, setVrfId] = useState<string | null>(item?.vrf?.id ?? null)
  const [prefix, setPrefix] = useState(item?.prefix ?? "")
  const [prefixObjId, setPrefixObjId] = useState<string | null>(
    item?.prefix_obj?.id ?? null
  )
  const [kind, setKind] = useState<string | null>(item?.kind ?? "nexthop")
  const [nextHop, setNextHop] = useState(item?.next_hop ?? "")
  const [nextHopIfaceId, setNextHopIfaceId] = useState<string | null>(
    item?.next_hop_interface?.id ?? item?.next_hop_vm_interface?.id ?? null
  )
  const [nextHopVrfId, setNextHopVrfId] = useState<string | null>(
    item?.next_hop_vrf?.id ?? null
  )
  const [table, setTable] = useState(numText(item?.table))
  const [distance, setDistance] = useState(numText(item?.distance))
  const [metric, setMetric] = useState(numText(item?.metric))
  const [tag, setTag] = useState(numText(item?.tag))
  const [bfd, setBfd] = useState(item?.bfd ?? false)
  const [statusId, setStatusId] = useState<string | null>(
    item?.status?.id ?? null
  )
  const [description, setDescription] = useState(item?.description ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    item?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    item?.custom_fields ?? {}
  )

  const vrfs = useQuery({
    queryKey: ["vrfs-picker"],
    queryFn: () => apiAll<VRFOption>("/api/vrfs/"),
  })
  const statuses = useQuery({
    queryKey: ["statuses", "staticroute"],
    queryFn: () =>
      apiAll<Status>("/api/statuses/?available_to=staticroute&picker=1"),
    staleTime: 5 * 60_000,
  })
  const interfaces = useOwnerPorts(on.id ? { kind: on.kind, id: on.id } : null)
  const boxPicked = !!on.id
  const pickFirst = on.kind === "vm" ? "Pick a VM first" : "Pick a device first"
  // A new route starts on the catalog's default status (the one flagged
  // default for static routes), the way the box would show it as active.
  useEffect(() => {
    if (isEdit || statusId || !statuses.data) return
    const d = statuses.data.results.find((st) =>
      st.default_for.includes("staticroute")
    )
    if (d) setStatusId(d.id)
  }, [isEdit, statusId, statuses.data])
  const vrfOptions = (vrfs.data?.results ?? []).map((v) => ({
    value: v.id,
    label: v.rd ? `${v.name} · ${v.rd}` : v.name,
    color: v.color,
  }))
  const viaHop = kind === "nexthop"
  const viaIface = kind === "interface"
  const ifaceOptions = (interfaces.data?.results ?? []).map((i) => ({
    value: i.id,
    label: i.name,
  }))

  const { mutation, fieldErrors } = useRoutingSave<StaticRoute>({
    objectType: ROUTING_OBJECT_TYPES.staticroute,
    endpoint: "/api/routing/static-routes/",
    queryKey: "static-routes",
    id: item?.id,
    label: (v) => v.prefix,
    onSaved,
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        mutation.mutate({
          ...ownerPayload(on.id ? { ...on, id: on.id, name: "" } : null),
          vrf_id: vrfId,
          table: vrfId ? null : numOrNull(table),
          prefix: prefix.trim(),
          prefix_obj_id: prefixObjId,
          kind,
          next_hop: viaHop ? nextHop.trim() : "",
          ...portPayload(on.kind, viaHop || viaIface ? nextHopIfaceId : null, [
            "next_hop_interface_id",
            "next_hop_vm_interface_id",
          ]),
          next_hop_vrf_id: viaHop || viaIface ? nextHopVrfId : null,
          distance: numOrNull(distance),
          metric: numOrNull(metric),
          tag: numOrNull(tag),
          bfd,
          status_id: statusId,
          description: description.trim(),
          tag_ids: tagIds,
          custom_fields: customFields,
        })
      }}
      className="@container grid gap-4"
    >
      <FormSection title="Route" card>
        <OwnerField
          value={on}
          onChange={(v) => {
            setOn(v)
            setNextHopIfaceId(null)
          }}
          locked={!!owner}
          error={firstError(
            fieldErrors,
            "device_id",
            "virtual_machine_id",
            "device"
          )}
        />
        <div className="grid gap-3 @md:grid-cols-2">
          <FormCombobox
            label="VRF"
            value={vrfId}
            onChange={setVrfId}
            options={vrfOptions}
            noneLabel="Global"
            placeholder="Global"
            searchPlaceholder="Search VRFs…"
            emptyText="No VRFs."
            error={fieldErrors.vrf_id}
          />
          <FormText
            label="Table"
            type="number"
            min={1}
            value={vrfId ? "" : table}
            onChange={setTable}
            disabled={!!vrfId}
            placeholder={vrfId ? "The VRF's" : "Main"}
            info="A kernel table number for policy routing (ip route … table 100). A VRF is already its own table, so it takes one or the other."
            error={fieldErrors.table}
          />
        </div>
        <div className="grid gap-3 @md:grid-cols-2">
          <FormText
            label="Prefix"
            required
            mono
            autoFocus={!isEdit}
            value={prefix}
            onChange={setPrefix}
            placeholder="0.0.0.0/0"
            error={fieldErrors.prefix}
          />
          <PrefixPicker
            label="IPAM prefix"
            hint="optional - the prefix object this route names"
            value={prefixObjId}
            onChange={(v) => {
              setPrefixObjId(v)
            }}
            error={fieldErrors.prefix_obj_id}
          />
        </div>
        <FormStatusSelect
          value={statusId}
          onChange={setStatusId}
          options={statuses.data?.results ?? []}
          placeholder="Select a status…"
          error={fieldErrors.status_id}
        />
      </FormSection>

      <FormSection title="Via" card>
        <FormSelect
          label="Kind"
          value={kind}
          onChange={setKind}
          options={KINDS}
          error={fieldErrors.kind}
        />
        {viaHop && (
          <div className="grid gap-3 @md:grid-cols-2">
            <FormText
              label="Next hop"
              mono
              value={nextHop}
              onChange={setNextHop}
              placeholder="10.0.0.1"
              info="An address, an interface, or both - `ip route 0.0.0.0/0 10.1.1.1 eth0`."
              error={fieldErrors.next_hop}
            />
            <FormCombobox
              label="Interface"
              value={nextHopIfaceId}
              onChange={setNextHopIfaceId}
              options={ifaceOptions}
              noneLabel="None"
              placeholder={boxPicked ? "None" : pickFirst}
              disabled={!boxPicked}
              searchPlaceholder="Search interfaces…"
              emptyText="No interfaces."
              error={firstError(
                fieldErrors,
                "next_hop_interface_id",
                "next_hop_vm_interface_id",
                "next_hop_interface",
                "next_hop_vm_interface"
              )}
            />
          </div>
        )}
        {viaIface && (
          <FormCombobox
            label="Interface"
            required
            value={nextHopIfaceId}
            onChange={setNextHopIfaceId}
            options={ifaceOptions}
            placeholder={boxPicked ? "Pick an interface" : pickFirst}
            disabled={!boxPicked}
            searchPlaceholder="Search interfaces…"
            emptyText="No interfaces."
            info="The route points out of this port with no next-hop address - the point-to-point shape some platforms write."
            error={firstError(
              fieldErrors,
              "next_hop_interface_id",
              "next_hop_vm_interface_id",
              "next_hop_interface",
              "next_hop_vm_interface"
            )}
          />
        )}
        {(viaHop || viaIface) && (
          <FormCombobox
            label="Next hop VRF"
            hint="route leaking - the table the next hop is looked up in"
            value={nextHopVrfId}
            onChange={setNextHopVrfId}
            options={vrfOptions}
            noneLabel="Same table"
            placeholder="Same table"
            searchPlaceholder="Search VRFs…"
            emptyText="No VRFs."
            error={fieldErrors.next_hop_vrf_id}
          />
        )}
        <div className="grid gap-3 @md:grid-cols-3">
          <FormText
            label="Distance"
            type="number"
            value={distance}
            onChange={setDistance}
            error={fieldErrors.distance}
          />
          <FormText
            label="Metric"
            type="number"
            value={metric}
            onChange={setMetric}
            error={fieldErrors.metric}
          />
          <FormText
            label="Tag"
            type="number"
            value={tag}
            onChange={setTag}
            error={fieldErrors.tag}
          />
        </div>
        <FormCheckbox label="BFD" checked={bfd} onChange={setBfd} />
      </FormSection>

      <FormSection title="Notes" card>
        <FormTextarea
          label="Description"
          value={description}
          onChange={setDescription}
          error={fieldErrors.description}
        />
        <FormTags value={tagIds} onChange={setTagIds} label="Tags" />
        <CustomFieldInputs
          model="staticroute"
          value={customFields}
          onChange={setCustomFields}
        />
      </FormSection>

      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create route"}
      />
    </form>
  )
}

// ─── Policy rule (ip rule) ───────────────────────────────────────────────────

const RULE_ACTIONS = [
  { value: "lookup", label: "Lookup" },
  { value: "blackhole", label: "Blackhole" },
  { value: "unreachable", label: "Unreachable" },
  { value: "prohibit", label: "Prohibit" },
]
const FAMILIES = [
  { value: "ipv4", label: "IPv4" },
  { value: "ipv6", label: "IPv6" },
]

export function PolicyRuleForm({
  item,
  owner,
  onSaved,
  onCancel,
}: {
  item?: PolicyRule | null
  /** Pre-set box when adding from a device's or VM's own Routing tab. */
  owner?: RoutingOwner
  onSaved: (v: PolicyRule) => void
  onCancel: () => void
}) {
  const isEdit = !!item
  const start = (item ? ownerOf(item) : null) ?? owner ?? null
  const [on, setOn] = useState<{ kind: OwnerKind; id: string | null }>({
    kind: start?.kind ?? "device",
    id: start?.id ?? null,
  })
  const [family, setFamily] = useState<string | null>(item?.family ?? "ipv4")
  const [priority, setPriority] = useState(numText(item?.priority))
  const [action, setAction] = useState<string | null>(item?.action ?? "lookup")
  const [table, setTable] = useState(numText(item?.table))
  const [vrfId, setVrfId] = useState<string | null>(item?.vrf?.id ?? null)
  const [fromPrefix, setFromPrefix] = useState(item?.from_prefix ?? "")
  const [toPrefix, setToPrefix] = useState(item?.to_prefix ?? "")
  const [iifId, setIifId] = useState<string | null>(
    item?.iif?.id ?? item?.vm_iif?.id ?? null
  )
  const [oifId, setOifId] = useState<string | null>(
    item?.oif?.id ?? item?.vm_oif?.id ?? null
  )
  const [fwmark, setFwmark] = useState(numText(item?.fwmark))
  const [invert, setInvert] = useState(item?.invert ?? false)
  const [statusId, setStatusId] = useState<string | null>(
    item?.status?.id ?? null
  )
  const [description, setDescription] = useState(item?.description ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    item?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    item?.custom_fields ?? {}
  )

  const vrfs = useQuery({
    queryKey: ["vrfs-picker"],
    queryFn: () => apiAll<VRFOption>("/api/vrfs/"),
  })
  const statuses = useQuery({
    queryKey: ["statuses", "staticroute"],
    queryFn: () =>
      apiAll<Status>("/api/statuses/?available_to=staticroute&picker=1"),
    staleTime: 5 * 60_000,
  })
  const interfaces = useOwnerPorts(on.id ? { kind: on.kind, id: on.id } : null)
  const boxPicked = !!on.id
  const pickFirst = on.kind === "vm" ? "Pick a VM first" : "Pick a device first"
  const vrfOptions = (vrfs.data?.results ?? []).map((v) => ({
    value: v.id,
    label: v.rd ? `${v.name} · ${v.rd}` : v.name,
    color: v.color,
  }))
  const ifaceOptions = (interfaces.data?.results ?? []).map((i) => ({
    value: i.id,
    label: i.name,
  }))
  const lookup = action === "lookup"

  const { mutation, fieldErrors } = useRoutingSave<PolicyRule>({
    objectType: ROUTING_OBJECT_TYPES.policyrule,
    endpoint: "/api/routing/ip-rules/",
    queryKey: "policy-rules",
    id: item?.id,
    label: (v) => `Rule ${v.priority}`,
    onSaved,
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        mutation.mutate({
          ...ownerPayload(on.id ? { ...on, id: on.id, name: "" } : null),
          family,
          priority: numOrNull(priority),
          action,
          table: lookup && !vrfId ? numOrNull(table) : null,
          vrf_id: lookup ? vrfId : null,
          from_prefix: fromPrefix.trim(),
          to_prefix: toPrefix.trim(),
          ...portPayload(on.kind, iifId, ["iif_id", "vm_iif_id"]),
          ...portPayload(on.kind, oifId, ["oif_id", "vm_oif_id"]),
          fwmark: numOrNull(fwmark),
          invert,
          status_id: statusId,
          description: description.trim(),
          tag_ids: tagIds,
          custom_fields: customFields,
        })
      }}
      className="@container grid gap-4"
    >
      <FormSection title="Rule" card>
        <OwnerField
          value={on}
          onChange={(v) => {
            setOn(v)
            setIifId(null)
            setOifId(null)
          }}
          locked={!!owner}
          error={firstError(
            fieldErrors,
            "device_id",
            "virtual_machine_id",
            "device"
          )}
        />
        <div className="grid gap-3 @md:grid-cols-3">
          <FormText
            label="Priority"
            type="number"
            required
            min={0}
            autoFocus={!isEdit}
            value={priority}
            onChange={setPriority}
            error={fieldErrors.priority}
          />
          <FormSelect
            label="Family"
            value={family}
            onChange={setFamily}
            options={FAMILIES}
            info="Set from the prefixes when they are given."
            error={fieldErrors.family}
          />
          <FormSelect
            label="Action"
            value={action}
            onChange={setAction}
            options={RULE_ACTIONS}
            error={fieldErrors.action}
          />
        </div>
        {lookup && (
          <div className="grid gap-3 @md:grid-cols-2">
            <FormText
              label="Table"
              type="number"
              min={1}
              value={vrfId ? "" : table}
              onChange={setTable}
              disabled={!!vrfId}
              error={fieldErrors.table}
            />
            <FormCombobox
              label="VRF"
              value={vrfId}
              onChange={setVrfId}
              options={vrfOptions}
              noneLabel="None"
              placeholder="None"
              searchPlaceholder="Search VRFs…"
              emptyText="No VRFs."
              info="Look up the VRF's table instead of a table number."
              error={fieldErrors.vrf_id}
            />
          </div>
        )}
        <FormStatusSelect
          value={statusId}
          onChange={setStatusId}
          options={statuses.data?.results ?? []}
          placeholder="Select a status…"
          error={fieldErrors.status_id}
        />
      </FormSection>

      <FormSection title="Match" card>
        <div className="grid gap-3 @md:grid-cols-2">
          <FormText
            label="From"
            mono
            value={fromPrefix}
            onChange={setFromPrefix}
            placeholder="10.0.0.0/24"
            error={fieldErrors.from_prefix}
          />
          <FormText
            label="To"
            mono
            value={toPrefix}
            onChange={setToPrefix}
            placeholder="0.0.0.0/0"
            error={fieldErrors.to_prefix}
          />
          <FormCombobox
            label="In interface"
            value={iifId}
            onChange={setIifId}
            options={ifaceOptions}
            noneLabel="Any"
            placeholder={boxPicked ? "Any" : pickFirst}
            disabled={!boxPicked}
            searchPlaceholder="Search interfaces…"
            emptyText="No interfaces."
            error={firstError(
              fieldErrors,
              "iif_id",
              "vm_iif_id",
              "iif",
              "vm_iif"
            )}
          />
          <FormCombobox
            label="Out interface"
            value={oifId}
            onChange={setOifId}
            options={ifaceOptions}
            noneLabel="Any"
            placeholder={boxPicked ? "Any" : pickFirst}
            disabled={!boxPicked}
            searchPlaceholder="Search interfaces…"
            emptyText="No interfaces."
            error={firstError(
              fieldErrors,
              "oif_id",
              "vm_oif_id",
              "oif",
              "vm_oif"
            )}
          />
          <FormText
            label="Firewall mark"
            type="number"
            min={0}
            value={fwmark}
            onChange={setFwmark}
            error={fieldErrors.fwmark}
          />
        </div>
        <FormCheckbox
          label="Invert"
          checked={invert}
          onChange={setInvert}
          info="Match what the selectors do not: ip rule add not …"
        />
      </FormSection>

      <FormSection title="Notes" card>
        <FormTextarea
          label="Description"
          value={description}
          onChange={setDescription}
          error={fieldErrors.description}
        />
        <FormTags value={tagIds} onChange={setTagIds} label="Tags" />
        <CustomFieldInputs
          model="policyrule"
          value={customFields}
          onChange={setCustomFields}
        />
      </FormSection>

      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create rule"}
      />
    </form>
  )
}

// ─── RPKI cache ──────────────────────────────────────────────────────────────

export function RPKICacheForm({
  item,
  onSaved,
  onCancel,
}: {
  item?: RPKICache
  onSaved: (v: RPKICache) => void
  onCancel: () => void
}) {
  const isEdit = !!item
  const [name, setName] = useState(item?.name ?? "")
  const [address, setAddress] = useState(item?.address ?? "")
  const [port, setPort] = useState(numText(item?.port ?? 3323))
  const [transport, setTransport] = useState<string | null>(
    item?.transport ?? "tcp"
  )
  const [preference, setPreference] = useState(numText(item?.preference ?? 1))
  const [username, setUsername] = useState(item?.ssh_username ?? "")
  const [hostKey, setHostKey] = useState(item?.ssh_host_key ?? "")
  // Write-only: never pre-filled, blank leaves the stored key alone.
  const [privateKey, setPrivateKey] = useState("")
  const [description, setDescription] = useState(item?.description ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    item?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    item?.custom_fields ?? {}
  )
  const ssh = transport === "ssh"
  const { mutation, fieldErrors } = useRoutingSave<RPKICache>({
    objectType: ROUTING_OBJECT_TYPES.rpkicache,
    endpoint: "/api/routing/rpki-caches/",
    queryKey: "rpki-caches",
    id: item?.id,
    label: (v) => v.name,
    onSaved,
  })
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        mutation.mutate({
          name: name.trim(),
          address: address.trim(),
          port: numOrNull(port),
          transport,
          preference: numOrNull(preference),
          ssh_username: ssh ? username.trim() : "",
          ssh_host_key: ssh ? hostKey.trim() : "",
          ...(ssh && privateKey ? { ssh_private_key: privateKey } : {}),
          description: description.trim(),
          tag_ids: tagIds,
          custom_fields: customFields,
        })
      }}
      className="@container grid gap-4"
    >
      <FormSection title="Cache" card>
        <FormText
          label="Name"
          required
          mono
          autoFocus={!isEdit}
          value={name}
          onChange={setName}
          placeholder="routinator"
          error={fieldErrors.name}
        />
        <div className="grid gap-3 @md:grid-cols-4">
          <div className="@md:col-span-2">
            <FormText
              label="Address"
              required
              mono
              value={address}
              onChange={setAddress}
              placeholder="10.0.0.65"
              info="IP address or hostname of the RTR server."
              error={fieldErrors.address}
            />
          </div>
          <FormText
            label="Port"
            required
            type="number"
            value={port}
            onChange={setPort}
            error={fieldErrors.port}
          />
          <FormText
            label="Preference"
            required
            type="number"
            value={preference}
            onChange={setPreference}
            info="1-255; the router uses the lowest it can reach."
            error={fieldErrors.preference}
          />
        </div>
        <FormSelect
          label="Transport"
          value={transport}
          onChange={setTransport}
          options={[
            { value: "tcp", label: "TCP" },
            { value: "ssh", label: "SSH" },
          ]}
          error={fieldErrors.transport}
        />
      </FormSection>
      {ssh && (
        <FormSection title="SSH" card>
          <FormText
            label="Username"
            required
            mono
            value={username}
            onChange={setUsername}
            error={fieldErrors.ssh_username}
          />
          <FormTextarea
            label="Host key"
            value={hostKey}
            onChange={setHostKey}
            placeholder="ssh-ed25519 AAAA…"
            info="The server's public key the router expects."
            error={fieldErrors.ssh_host_key}
          />
          <FormTextarea
            label="Private key"
            value={privateKey}
            onChange={setPrivateKey}
            placeholder={
              item?.ssh_private_key_set
                ? "Stored - paste to replace"
                : "Not set"
            }
            info="Written to the deployment's secret store, never to this record. An administrator must enable a store under Settings → Security first."
            error={fieldErrors.ssh_private_key}
          />
        </FormSection>
      )}
      <FormSection title="Details" card>
        <FormTextarea
          label="Description"
          value={description}
          onChange={setDescription}
          error={fieldErrors.description}
        />
        <FormTags value={tagIds} onChange={setTagIds} label="Tags" />
        <CustomFieldInputs
          model="rpkicache"
          value={customFields}
          onChange={setCustomFields}
        />
      </FormSection>
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create cache"}
      />
    </form>
  )
}

// ─── ROA ─────────────────────────────────────────────────────────────────────

/** The length a prefix carries, or null while it is still being typed. */
function prefixLength(prefix: string): number | null {
  const m = /\/(\d{1,3})\s*$/.exec(prefix)
  return m ? Number(m[1]) : null
}

export function ROAForm({
  item,
  onSaved,
  onCancel,
}: {
  item?: ROA
  onSaved: (v: ROA) => void
  onCancel: () => void
}) {
  const isEdit = !!item
  const [prefix, setPrefix] = useState(item?.prefix ?? "")
  const [maxLength, setMaxLength] = useState(numText(item?.max_length))
  const [asnId, setAsnId] = useState<string | null>(item?.origin_asn.id ?? null)
  const [aggregateId, setAggregateId] = useState<string | null>(
    item?.aggregate?.id ?? null
  )
  const [description, setDescription] = useState(item?.description ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    item?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    item?.custom_fields ?? {}
  )
  const asns = useQuery({
    queryKey: ["asns-picker"],
    queryFn: () => apiAll<ASNMini>("/api/asns/"),
    staleTime: 60_000,
  })
  const aggregates = useQuery({
    queryKey: ["aggregates-picker"],
    queryFn: () => apiAll<{ id: string; prefix: string }>("/api/aggregates/"),
    staleTime: 60_000,
  })
  const { mutation, fieldErrors } = useRoutingSave<ROA>({
    objectType: ROUTING_OBJECT_TYPES.roa,
    endpoint: "/api/routing/roas/",
    queryKey: "roas",
    id: item?.id,
    label: (v) => `${v.prefix}-${v.max_length}`,
    onSaved,
  })
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        const p = prefix.trim()
        mutation.mutate({
          prefix: p,
          // Blank means exactly the prefix - no more-specifics.
          max_length: numOrNull(maxLength) ?? prefixLength(p),
          origin_asn_id: asnId,
          aggregate_id: aggregateId,
          description: description.trim(),
          tag_ids: tagIds,
          custom_fields: customFields,
        })
      }}
      className="@container grid gap-4"
    >
      <FormSection title="ROA" card>
        <div className="grid gap-3 @md:grid-cols-3">
          <div className="@md:col-span-2">
            <FormText
              label="Prefix"
              required
              mono
              autoFocus={!isEdit}
              value={prefix}
              onChange={setPrefix}
              placeholder="10.16.0.0/12"
              error={fieldErrors.prefix}
            />
          </div>
          <FormText
            label="Max length"
            type="number"
            value={maxLength}
            onChange={setMaxLength}
            placeholder={String(prefixLength(prefix.trim()) ?? "")}
            info="The longest prefix the origin may announce from this block; blank is the prefix's own length."
            error={fieldErrors.max_length}
          />
        </div>
        <div className="grid gap-3 @md:grid-cols-2">
          <FormCombobox
            label="Origin AS"
            required
            value={asnId}
            onChange={setAsnId}
            options={(asns.data?.results ?? []).map((a) => ({
              value: a.id,
              label: `AS${a.asn}`,
            }))}
            placeholder="Pick an AS"
            searchPlaceholder="Search ASNs…"
            emptyText="No ASNs - add one under IPAM → ASNs."
            error={fieldErrors.origin_asn_id}
          />
          <FormCombobox
            label="Aggregate"
            value={aggregateId}
            onChange={setAggregateId}
            options={(aggregates.data?.results ?? []).map((a) => ({
              value: a.id,
              label: a.prefix,
            }))}
            noneLabel="None"
            placeholder="None"
            searchPlaceholder="Search aggregates…"
            emptyText="No aggregates."
            error={fieldErrors.aggregate_id}
          />
        </div>
        <FormTextarea
          label="Description"
          value={description}
          onChange={setDescription}
          info="Exported as the SLURM assertion's comment."
          error={fieldErrors.description}
        />
        <FormTags value={tagIds} onChange={setTagIds} label="Tags" />
        <CustomFieldInputs
          model="roa"
          value={customFields}
          onChange={setCustomFields}
        />
      </FormSection>
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create ROA"}
      />
    </form>
  )
}
