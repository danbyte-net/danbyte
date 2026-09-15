import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type {
  Community,
  InterfaceOption,
  Paginated,
  RoutingKeychain,
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

import {
  ROUTING_OBJECT_TYPES,
  numOrNull,
  numText,
  useRoutingSave,
} from "./form-bits"

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
  device,
  onSaved,
  onCancel,
}: {
  item?: StaticRoute | null
  /** Pre-set device when adding from a device's own Routing tab. */
  device?: { id: string; name: string }
  onSaved: (v: StaticRoute) => void
  onCancel: () => void
}) {
  const isEdit = !!item
  const [deviceId, setDeviceId] = useState<string | null>(
    item?.device.id ?? device?.id ?? null
  )
  const [vrfId, setVrfId] = useState<string | null>(item?.vrf?.id ?? null)
  const [prefix, setPrefix] = useState(item?.prefix ?? "")
  const [prefixObjId, setPrefixObjId] = useState<string | null>(
    item?.prefix_obj?.id ?? null
  )
  const [kind, setKind] = useState<string | null>(item?.kind ?? "nexthop")
  const [nextHop, setNextHop] = useState(item?.next_hop ?? "")
  const [nextHopIfaceId, setNextHopIfaceId] = useState<string | null>(
    item?.next_hop_interface?.id ?? null
  )
  const [nextHopVrfId, setNextHopVrfId] = useState<string | null>(
    item?.next_hop_vrf?.id ?? null
  )
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
    queryFn: () => api<Paginated<VRFOption>>("/api/vrfs/"),
  })
  const statuses = useQuery({
    queryKey: ["statuses", "staticroute"],
    queryFn: () =>
      api<Paginated<Status>>(
        "/api/statuses/?available_to=staticroute&picker=1"
      ),
    staleTime: 5 * 60_000,
  })
  const interfaces = useQuery({
    queryKey: ["interfaces-picker", deviceId],
    queryFn: () =>
      api<Paginated<InterfaceOption>>(`/api/interfaces/?device=${deviceId}`),
    enabled: !!deviceId,
  })
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
          device_id: deviceId,
          vrf_id: vrfId,
          prefix: prefix.trim(),
          prefix_obj_id: prefixObjId,
          kind,
          next_hop: viaHop ? nextHop.trim() : "",
          next_hop_interface_id: viaHop || viaIface ? nextHopIfaceId : null,
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
        <div className="grid gap-3 @md:grid-cols-2">
          <DevicePicker
            label="Device"
            required
            value={deviceId}
            onChange={(v) => {
              setDeviceId(v)
              setNextHopIfaceId(null)
            }}
            disabled={!!device}
            error={fieldErrors.device_id}
          />
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
              placeholder={deviceId ? "None" : "Pick a device first"}
              disabled={!deviceId}
              searchPlaceholder="Search interfaces…"
              emptyText="No interfaces."
              error={fieldErrors.next_hop_interface_id}
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
            placeholder={deviceId ? "Pick an interface" : "Pick a device first"}
            disabled={!deviceId}
            searchPlaceholder="Search interfaces…"
            emptyText="No interfaces."
            info="The route points out of this port with no next-hop address - the point-to-point shape some platforms write."
            error={fieldErrors.next_hop_interface_id}
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
