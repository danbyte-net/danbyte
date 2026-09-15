import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type {
  EIGRPInstance,
  EIGRPInterface,
  InterfaceOption,
  ISISInstance,
  ISISInterface,
  OSPFArea,
  OSPFAreaMini,
  OSPFInstance,
  OSPFInterface,
  Paginated,
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

import { MultiPick } from "./multi-pick"
import {
  ROUTING_OBJECT_TYPES,
  CellInput,
  CellSelect,
  RulesTable,
  numOrNull,
  numText,
  usePickList,
  useRoutingSave,
} from "./form-bits"

// OSPF and IS-IS: the area catalog, an instance on a device, and the rows
// that enrol its interfaces. An interface row is edited from the instance's
// card, so the device is known and the picker lists that device's ports.

const SOURCES = [
  { value: "connected", label: "connected" },
  { value: "static", label: "static" },
  { value: "bgp", label: "bgp" },
  { value: "ospf", label: "ospf" },
  { value: "isis", label: "isis" },
  { value: "eigrp", label: "eigrp" },
  { value: "kernel", label: "kernel" },
]
const TRI = [
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
]
const triFrom = (v: boolean | null | undefined) =>
  v == null ? null : v ? "on" : "off"
const triTo = (v: string | null) =>
  v === "on" ? true : v === "off" ? false : null

function useVrfs() {
  return useQuery({
    queryKey: ["vrfs-picker"],
    queryFn: () => api<Paginated<VRFOption>>("/api/vrfs/"),
  })
}
function useInstanceStatuses() {
  return useQuery({
    queryKey: ["statuses", "routinginstance"],
    queryFn: () =>
      api<Paginated<Status>>(
        "/api/statuses/?available_to=routinginstance&picker=1"
      ),
    staleTime: 5 * 60_000,
  })
}
function useDeviceInterfaces(deviceId: string | null) {
  return useQuery({
    queryKey: ["interfaces-picker", deviceId],
    queryFn: () =>
      api<Paginated<InterfaceOption>>(`/api/interfaces/?device=${deviceId}`),
    enabled: !!deviceId,
  })
}

interface RedistDraft {
  sequence: number
  source: string
  policyId: string | null
  metric: string
}

const NONE = "__none__"

function RedistributeSection({
  rows,
  onChange,
  error,
}: {
  rows: RedistDraft[]
  onChange: (rows: RedistDraft[]) => void
  error?: string
}) {
  const policies = usePickList<{ id: string; name: string }>(
    "routing-policies",
    "/api/routing/policies/",
    (p) => p.name
  )
  // Radix refuses an empty item value, so "no policy" is a sentinel.
  const policyOptions = [
    { value: NONE, label: "-" },
    ...policies.map((p) => ({ value: p.id, label: p.label })),
  ]
  return (
    <FormSection title="Redistribute" card>
      <RulesTable<RedistDraft>
        rows={rows}
        onChange={onChange}
        headers={[
          { label: "Source", width: "w-32" },
          { label: "Policy", width: "w-48" },
          { label: "Metric", width: "w-24" },
        ]}
        newRow={(sequence) => ({
          sequence,
          source: "connected",
          policyId: null,
          metric: "",
        })}
        addLabel="Add source"
        emptyText="Nothing redistributed."
        renderRow={(r, update) => [
          <CellSelect
            key="src"
            value={r.source}
            onChange={(v) => update({ source: v })}
            options={SOURCES}
            width="w-32"
          />,
          <CellSelect
            key="pol"
            value={r.policyId ?? NONE}
            onChange={(v) => update({ policyId: v === NONE ? null : v })}
            options={policyOptions}
            width="w-48"
          />,
          <CellInput
            key="metric"
            type="number"
            value={r.metric}
            onChange={(v) => update({ metric: v })}
          />,
        ]}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
    </FormSection>
  )
}

const redistFrom = (
  rows: {
    source: string
    policy: { id: string } | null
    metric: number | null
  }[]
) =>
  rows.map((r, i) => ({
    sequence: (i + 1) * 10,
    source: r.source,
    policyId: r.policy?.id ?? null,
    metric: numText(r.metric),
  }))
const redistPayload = (rows: RedistDraft[]) =>
  rows.map((r) => ({
    source: r.source,
    policy_id: r.policyId || null,
    metric: numOrNull(r.metric),
  }))

// ─── OSPF area ───────────────────────────────────────────────────────────────

export function OSPFAreaForm({
  item,
  onSaved,
  onCancel,
}: {
  item?: OSPFArea
  onSaved: (v: OSPFArea) => void
  onCancel: () => void
}) {
  const isEdit = !!item
  const [name, setName] = useState(item?.name ?? "")
  const [areaId, setAreaId] = useState(item?.area_id ?? "")
  const [kind, setKind] = useState<string | null>(item?.kind ?? "normal")
  const [description, setDescription] = useState(item?.description ?? "")
  const [tagIds, setTagIds] = useState<number[]>(
    item?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    item?.custom_fields ?? {}
  )
  const { mutation, fieldErrors } = useRoutingSave<OSPFArea>({
    objectType: ROUTING_OBJECT_TYPES.ospfarea,
    endpoint: "/api/routing/ospf-areas/",
    queryKey: "ospf-areas",
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
          area_id: areaId.trim(),
          kind,
          description: description.trim(),
          tag_ids: tagIds,
          custom_fields: customFields,
        })
      }}
      className="@container grid gap-4"
    >
      <FormSection title="Area" card>
        <div className="grid gap-3 @md:grid-cols-3">
          <FormText
            label="Name"
            required
            autoFocus={!isEdit}
            value={name}
            onChange={setName}
            placeholder="backbone"
            error={fieldErrors.name}
          />
          <FormText
            label="Area ID"
            required
            mono
            value={areaId}
            onChange={setAreaId}
            placeholder="0 or 0.0.0.0"
            error={fieldErrors.area_id}
          />
          <FormSelect
            label="Kind"
            value={kind}
            onChange={setKind}
            options={[
              { value: "normal", label: "Normal" },
              { value: "stub", label: "Stub" },
              { value: "totally-stub", label: "Totally stubby" },
              { value: "nssa", label: "NSSA" },
              { value: "totally-nssa", label: "Totally NSSA" },
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
          model="ospfarea"
          value={customFields}
          onChange={setCustomFields}
        />
      </FormSection>
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create area"}
      />
    </form>
  )
}

// ─── OSPF instance ───────────────────────────────────────────────────────────

export function OSPFInstanceForm({
  item,
  device,
  onSaved,
  onCancel,
}: {
  item?: OSPFInstance | null
  device: { id: string; name: string }
  onSaved: (v: OSPFInstance) => void
  onCancel: () => void
}) {
  const isEdit = !!item
  const [vrfId, setVrfId] = useState<string | null>(item?.vrf?.id ?? null)
  const [processId, setProcessId] = useState(item?.process_id ?? "")
  const [version, setVersion] = useState<string | null>(
    String(item?.version ?? 2)
  )
  const [routerId, setRouterId] = useState(item?.router_id ?? "")
  const [refBw, setRefBw] = useState(numText(item?.reference_bandwidth))
  const [passive, setPassive] = useState(item?.passive_by_default ?? false)
  const [defaultOriginate, setDefaultOriginate] = useState(
    item?.default_originate ?? false
  )
  const [bfd, setBfd] = useState(item?.bfd ?? false)
  const [statusId, setStatusId] = useState<string | null>(
    item?.status?.id ?? null
  )
  const [description, setDescription] = useState(item?.description ?? "")
  const [redist, setRedist] = useState<RedistDraft[]>(
    redistFrom(item?.redistributions ?? [])
  )
  const [tagIds, setTagIds] = useState<number[]>(
    item?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    item?.custom_fields ?? {}
  )
  const vrfs = useVrfs()
  const statuses = useInstanceStatuses()
  useEffect(() => {
    if (isEdit || statusId || !statuses.data) return
    const d = statuses.data.results.find((st) =>
      st.default_for.includes("routinginstance")
    )
    if (d) setStatusId(d.id)
  }, [isEdit, statusId, statuses.data])
  const { mutation, fieldErrors } = useRoutingSave<OSPFInstance>({
    objectType: ROUTING_OBJECT_TYPES.ospfinstance,
    endpoint: "/api/routing/ospf-instances/",
    queryKey: "ospf-instances",
    id: item?.id,
    label: (v) => `OSPF ${v.process_id} on ${v.device.name}`,
    onSaved,
  })
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        mutation.mutate({
          device_id: device.id,
          vrf_id: vrfId,
          process_id: processId.trim(),
          version: Number(version ?? 2),
          router_id: routerId.trim(),
          reference_bandwidth: numOrNull(refBw),
          passive_by_default: passive,
          default_originate: defaultOriginate,
          bfd,
          status_id: statusId,
          description: description.trim(),
          redistributions: redistPayload(redist),
          tag_ids: tagIds,
          custom_fields: customFields,
        })
      }}
      className="@container grid gap-4"
    >
      <FormSection title="Instance" card>
        <div className="grid gap-3 @md:grid-cols-3">
          <FormText
            label="Process"
            mono
            autoFocus={!isEdit}
            value={processId}
            onChange={setProcessId}
            placeholder="1 or UNDERLAY"
            error={fieldErrors.process_id}
          />
          <FormSelect
            label="Version"
            value={version}
            onChange={setVersion}
            options={[
              { value: "2", label: "OSPFv2" },
              { value: "3", label: "OSPFv3" },
            ]}
          />
          <FormCombobox
            label="VRF"
            value={vrfId}
            onChange={setVrfId}
            options={(vrfs.data?.results ?? []).map((v) => ({
              value: v.id,
              label: v.rd ? `${v.name} · ${v.rd}` : v.name,
              color: v.color,
            }))}
            noneLabel="Global"
            placeholder="Global"
            error={fieldErrors.vrf_id}
          />
        </div>
        <div className="grid gap-3 @md:grid-cols-3">
          <FormText
            label="Router ID"
            mono
            value={routerId}
            onChange={setRouterId}
            placeholder="10.0.0.11"
            error={fieldErrors.router_id}
          />
          <FormText
            label="Reference bandwidth"
            type="number"
            hint="Mbit/s"
            value={refBw}
            onChange={setRefBw}
            error={fieldErrors.reference_bandwidth}
          />
          <FormStatusSelect
            value={statusId}
            onChange={setStatusId}
            options={statuses.data?.results ?? []}
            error={fieldErrors.status_id}
          />
        </div>
        <div className="grid gap-3 @md:grid-cols-3">
          <FormCheckbox
            label="Passive by default"
            checked={passive}
            onChange={setPassive}
          />
          <FormCheckbox
            label="Default originate"
            checked={defaultOriginate}
            onChange={setDefaultOriginate}
          />
          <FormCheckbox label="BFD" checked={bfd} onChange={setBfd} />
        </div>
        <FormTextarea
          label="Description"
          value={description}
          onChange={setDescription}
          error={fieldErrors.description}
        />
        <FormTags value={tagIds} onChange={setTagIds} label="Tags" />
        <CustomFieldInputs
          model="ospfinstance"
          value={customFields}
          onChange={setCustomFields}
        />
      </FormSection>
      <RedistributeSection
        rows={redist}
        onChange={setRedist}
        error={fieldErrors.redistributions}
      />
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create instance"}
      />
    </form>
  )
}

// ─── OSPF interface ──────────────────────────────────────────────────────────

export function OSPFInterfaceForm({
  item,
  instance,
  onSaved,
  onCancel,
}: {
  item?: OSPFInterface | null
  instance: OSPFInstance
  onSaved: (v: OSPFInterface) => void
  onCancel: () => void
}) {
  const isEdit = !!item
  const [interfaceId, setInterfaceId] = useState<string | null>(
    item?.interface.id ?? null
  )
  const [areaId, setAreaId] = useState<string | null>(item?.area.id ?? null)
  const [cost, setCost] = useState(numText(item?.cost))
  const [networkType, setNetworkType] = useState<string | null>(
    item?.network_type || null
  )
  const [passive, setPassive] = useState<string | null>(triFrom(item?.passive))
  const [priority, setPriority] = useState(numText(item?.priority))
  const [hello, setHello] = useState(numText(item?.hello))
  const [dead, setDead] = useState(numText(item?.dead))
  const [bfd, setBfd] = useState(item?.bfd ?? false)
  const [mtuIgnore, setMtuIgnore] = useState(item?.mtu_ignore ?? false)
  const [auth, setAuth] = useState<string | null>(
    item?.authentication ?? "none"
  )
  const [keychainId, setKeychainId] = useState<string | null>(
    item?.keychain?.id ?? null
  )
  const interfaces = useDeviceInterfaces(instance.device.id)
  const areas = usePickList<OSPFAreaMini>(
    "ospf-areas",
    "/api/routing/ospf-areas/",
    (a) => `${a.name} (${a.area_id})`
  )
  const keychains = usePickList<{ id: string; name: string }>(
    "routing-keychains",
    "/api/routing/keychains/",
    (k) => k.name
  )
  const used = new Set(instance.interfaces.map((i) => i.interface.id))
  const { mutation, fieldErrors } = useRoutingSave<OSPFInterface>({
    objectType: ROUTING_OBJECT_TYPES.ospfinterface,
    endpoint: "/api/routing/ospf-interfaces/",
    queryKey: "ospf-instances",
    id: item?.id,
    label: (v) => v.interface.name,
    onSaved,
  })
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        mutation.mutate({
          instance_id: instance.id,
          interface_id: interfaceId,
          area_id: areaId,
          cost: numOrNull(cost),
          network_type: networkType ?? "",
          passive: triTo(passive),
          priority: numOrNull(priority),
          hello: numOrNull(hello),
          dead: numOrNull(dead),
          bfd,
          mtu_ignore: mtuIgnore,
          authentication: auth,
          keychain_id: auth === "none" ? null : keychainId,
        })
      }}
      className="@container grid gap-4"
    >
      <FormSection title="Interface" card>
        <div className="grid gap-3 @md:grid-cols-2">
          <FormCombobox
            label="Interface"
            required
            value={interfaceId}
            onChange={setInterfaceId}
            options={(interfaces.data?.results ?? [])
              .filter((i) => isEdit || !used.has(i.id))
              .map((i) => ({ value: i.id, label: i.name }))}
            placeholder="Pick an interface"
            searchPlaceholder="Search interfaces…"
            emptyText="Every interface is enrolled already."
            disabled={isEdit}
            error={fieldErrors.interface_id}
          />
          <FormCombobox
            label="Area"
            required
            value={areaId}
            onChange={setAreaId}
            options={areas.map((a) => ({ value: a.id, label: a.label }))}
            placeholder="Pick an area"
            emptyText="No areas - add one under Routing → OSPF areas."
            error={fieldErrors.area_id}
          />
        </div>
        <div className="grid gap-3 @md:grid-cols-3">
          <FormText
            label="Cost"
            type="number"
            value={cost}
            onChange={setCost}
            error={fieldErrors.cost}
          />
          <FormSelect
            label="Network type"
            value={networkType}
            onChange={setNetworkType}
            options={[
              { value: "broadcast", label: "Broadcast" },
              { value: "point-to-point", label: "Point-to-point" },
              { value: "nbma", label: "NBMA" },
              { value: "point-to-multipoint", label: "Point-to-multipoint" },
            ]}
            noneLabel="Platform default"
          />
          <FormSelect
            label="Passive"
            value={passive}
            onChange={setPassive}
            options={TRI}
            noneLabel={`Instance (${instance.passive_by_default ? "on" : "off"})`}
          />
        </div>
        <div className="grid gap-3 @md:grid-cols-3">
          <FormText
            label="Priority"
            type="number"
            value={priority}
            onChange={setPriority}
          />
          <FormText
            label="Hello"
            type="number"
            value={hello}
            onChange={setHello}
            hint="s"
          />
          <FormText
            label="Dead"
            type="number"
            value={dead}
            onChange={setDead}
            hint="s"
          />
        </div>
        <div className="grid gap-3 @md:grid-cols-3">
          <FormSelect
            label="Authentication"
            value={auth}
            onChange={setAuth}
            options={[
              { value: "none", label: "None" },
              { value: "simple", label: "Simple" },
              { value: "md5", label: "MD5" },
              { value: "sha", label: "SHA" },
            ]}
          />
          {auth !== "none" && (
            <FormCombobox
              label="Keychain"
              required
              value={keychainId}
              onChange={setKeychainId}
              options={keychains.map((k) => ({ value: k.id, label: k.label }))}
              placeholder="Pick a keychain"
              error={fieldErrors.keychain}
            />
          )}
        </div>
        <div className="grid gap-3 @md:grid-cols-3">
          <FormCheckbox label="BFD" checked={bfd} onChange={setBfd} />
          <FormCheckbox
            label="MTU ignore"
            checked={mtuIgnore}
            onChange={setMtuIgnore}
          />
        </div>
      </FormSection>
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Enrol interface"}
      />
    </form>
  )
}

// ─── IS-IS instance ──────────────────────────────────────────────────────────

const LEVELS = [
  { value: "1", label: "Level 1" },
  { value: "2", label: "Level 2" },
  { value: "1-2", label: "Level 1-2" },
]
const ISIS_AUTH = [
  { value: "none", label: "None" },
  { value: "text", label: "Clear text" },
  { value: "md5", label: "MD5" },
]

export function ISISInstanceForm({
  item,
  device,
  onSaved,
  onCancel,
}: {
  item?: ISISInstance | null
  device: { id: string; name: string }
  onSaved: (v: ISISInstance) => void
  onCancel: () => void
}) {
  const isEdit = !!item
  const [vrfId, setVrfId] = useState<string | null>(item?.vrf?.id ?? null)
  const [process, setProcess] = useState(item?.process ?? "")
  const [net, setNet] = useState(item?.net ?? "")
  const [isisRouterId, setIsisRouterId] = useState(item?.router_id ?? "")
  const [level, setLevel] = useState<string | null>(item?.level ?? "1-2")
  const [metricStyle, setMetricStyle] = useState<string | null>(
    item?.metric_style ?? "wide"
  )
  const [auth, setAuth] = useState<string | null>(
    item?.authentication ?? "none"
  )
  const [keychainId, setKeychainId] = useState<string | null>(
    item?.keychain?.id ?? null
  )
  const [bfd, setBfd] = useState(item?.bfd ?? false)
  const [statusId, setStatusId] = useState<string | null>(
    item?.status?.id ?? null
  )
  const [description, setDescription] = useState(item?.description ?? "")
  const [redist, setRedist] = useState<RedistDraft[]>(
    redistFrom(item?.redistributions ?? [])
  )
  const [tagIds, setTagIds] = useState<number[]>(
    item?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    item?.custom_fields ?? {}
  )
  const vrfs = useVrfs()
  const statuses = useInstanceStatuses()
  useEffect(() => {
    if (isEdit || statusId || !statuses.data) return
    const d = statuses.data.results.find((st) =>
      st.default_for.includes("routinginstance")
    )
    if (d) setStatusId(d.id)
  }, [isEdit, statusId, statuses.data])
  const keychains = usePickList<{ id: string; name: string }>(
    "routing-keychains",
    "/api/routing/keychains/",
    (k) => k.name
  )
  const { mutation, fieldErrors } = useRoutingSave<ISISInstance>({
    objectType: ROUTING_OBJECT_TYPES.isisinstance,
    endpoint: "/api/routing/isis-instances/",
    queryKey: "isis-instances",
    id: item?.id,
    label: (v) => `IS-IS ${v.process} on ${v.device.name}`,
    onSaved,
  })
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        mutation.mutate({
          device_id: device.id,
          vrf_id: vrfId,
          process: process.trim(),
          net: net.trim(),
          router_id: isisRouterId.trim(),
          level,
          metric_style: metricStyle,
          authentication: auth,
          keychain_id: auth === "none" ? null : keychainId,
          bfd,
          status_id: statusId,
          description: description.trim(),
          redistributions: redistPayload(redist),
          tag_ids: tagIds,
          custom_fields: customFields,
        })
      }}
      className="@container grid gap-4"
    >
      <FormSection title="Instance" card>
        <div className="grid gap-3 @md:grid-cols-3">
          <FormText
            label="Process"
            mono
            autoFocus={!isEdit}
            value={process}
            onChange={setProcess}
            placeholder="CORE"
            error={fieldErrors.process}
          />
          <div className="@md:col-span-2">
            <FormText
              label="NET"
              required
              mono
              value={net}
              onChange={setNet}
              placeholder="49.0001.0000.0000.0011.00"
              error={fieldErrors.net}
            />
          </div>
        </div>
        <div className="grid gap-3 @md:grid-cols-3">
          <FormSelect
            label="Level"
            value={level}
            onChange={setLevel}
            options={LEVELS}
          />
          <FormSelect
            label="Metric style"
            value={metricStyle}
            onChange={setMetricStyle}
            options={[
              { value: "wide", label: "Wide" },
              { value: "narrow", label: "Narrow" },
              { value: "transition", label: "Transition" },
            ]}
          />
          <FormText
            label="Router ID"
            mono
            value={isisRouterId}
            onChange={setIsisRouterId}
            placeholder="10.255.0.11"
            info="Blank leaves it to the template - the loopback, as a rule."
            error={fieldErrors.router_id}
          />
        </div>
        <div className="grid gap-3 @md:grid-cols-3">
          <FormCombobox
            label="VRF"
            value={vrfId}
            onChange={setVrfId}
            options={(vrfs.data?.results ?? []).map((v) => ({
              value: v.id,
              label: v.rd ? `${v.name} · ${v.rd}` : v.name,
              color: v.color,
            }))}
            noneLabel="Global"
            placeholder="Global"
            error={fieldErrors.vrf_id}
          />
          <FormSelect
            label="Authentication"
            value={auth}
            onChange={setAuth}
            options={ISIS_AUTH}
          />
          {auth !== "none" && (
            <FormCombobox
              label="Keychain"
              required
              value={keychainId}
              onChange={setKeychainId}
              options={keychains.map((k) => ({ value: k.id, label: k.label }))}
              placeholder="Pick a keychain"
              error={fieldErrors.keychain}
            />
          )}
          <FormStatusSelect
            value={statusId}
            onChange={setStatusId}
            options={statuses.data?.results ?? []}
            error={fieldErrors.status_id}
          />
        </div>
        <FormCheckbox label="BFD" checked={bfd} onChange={setBfd} />
        <FormTextarea
          label="Description"
          value={description}
          onChange={setDescription}
          error={fieldErrors.description}
        />
        <FormTags value={tagIds} onChange={setTagIds} label="Tags" />
        <CustomFieldInputs
          model="isisinstance"
          value={customFields}
          onChange={setCustomFields}
        />
      </FormSection>
      <RedistributeSection
        rows={redist}
        onChange={setRedist}
        error={fieldErrors.redistributions}
      />
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create instance"}
      />
    </form>
  )
}

// ─── IS-IS interface ─────────────────────────────────────────────────────────

export function ISISInterfaceForm({
  item,
  instance,
  onSaved,
  onCancel,
}: {
  item?: ISISInterface | null
  instance: ISISInstance
  onSaved: (v: ISISInterface) => void
  onCancel: () => void
}) {
  const isEdit = !!item
  const [interfaceId, setInterfaceId] = useState<string | null>(
    item?.interface.id ?? null
  )
  const [families, setFamilies] = useState<string[]>(item?.families ?? ["ipv4"])
  const [level, setLevel] = useState<string | null>(item?.level || null)
  const [metric, setMetric] = useState(numText(item?.metric))
  const [metricL2, setMetricL2] = useState(numText(item?.metric_l2))
  const [networkType, setNetworkType] = useState<string | null>(
    item?.network_type || null
  )
  const [passive, setPassive] = useState<string | null>(triFrom(item?.passive))
  const [helloInterval, setHelloInterval] = useState(
    numText(item?.hello_interval)
  )
  const [helloMultiplier, setHelloMultiplier] = useState(
    numText(item?.hello_multiplier)
  )
  const [bfd, setBfd] = useState(item?.bfd ?? false)
  const [auth, setAuth] = useState<string | null>(
    item?.authentication ?? "none"
  )
  const [keychainId, setKeychainId] = useState<string | null>(
    item?.keychain?.id ?? null
  )
  const interfaces = useDeviceInterfaces(instance.device.id)
  const keychains = usePickList<{ id: string; name: string }>(
    "routing-keychains",
    "/api/routing/keychains/",
    (k) => k.name
  )
  const used = new Set(instance.interfaces.map((i) => i.interface.id))
  const { mutation, fieldErrors } = useRoutingSave<ISISInterface>({
    objectType: ROUTING_OBJECT_TYPES.isisinterface,
    endpoint: "/api/routing/isis-interfaces/",
    queryKey: "isis-instances",
    id: item?.id,
    label: (v) => v.interface.name,
    onSaved,
  })
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        mutation.mutate({
          instance_id: instance.id,
          interface_id: interfaceId,
          families,
          level: level ?? "",
          metric: numOrNull(metric),
          metric_l2: numOrNull(metricL2),
          network_type: networkType ?? "",
          passive: triTo(passive),
          hello_interval: numOrNull(helloInterval),
          hello_multiplier: numOrNull(helloMultiplier),
          bfd,
          authentication: auth,
          keychain_id: auth === "none" ? null : keychainId,
        })
      }}
      className="@container grid gap-4"
    >
      <FormSection title="Interface" card>
        <div className="grid gap-3 @md:grid-cols-2">
          <FormCombobox
            label="Interface"
            required
            value={interfaceId}
            onChange={setInterfaceId}
            options={(interfaces.data?.results ?? [])
              .filter((i) => isEdit || !used.has(i.id))
              .map((i) => ({ value: i.id, label: i.name }))}
            placeholder="Pick an interface"
            searchPlaceholder="Search interfaces…"
            emptyText="Every interface is enrolled already."
            disabled={isEdit}
            error={fieldErrors.interface_id}
          />
          <div className="grid gap-1">
            <span className="text-xs font-medium">Families</span>
            <MultiPick
              options={[
                { id: "ipv4", label: "ipv4" },
                { id: "ipv6", label: "ipv6" },
              ]}
              value={families}
              onChange={setFamilies}
              placeholder="Add family"
              emptyText="No more."
            />
            {fieldErrors.families && (
              <p className="text-[11px] text-destructive">
                {fieldErrors.families}
              </p>
            )}
          </div>
        </div>
        <div className="grid gap-3 @md:grid-cols-3">
          <FormSelect
            label="Level"
            value={level}
            onChange={setLevel}
            options={LEVELS}
            noneLabel={`Instance (${instance.level})`}
          />
          <FormSelect
            label="Network type"
            value={networkType}
            onChange={setNetworkType}
            options={[
              { value: "point-to-point", label: "Point-to-point" },
              { value: "broadcast", label: "Broadcast" },
            ]}
            noneLabel="Platform default"
          />
          <FormSelect
            label="Passive"
            value={passive}
            onChange={setPassive}
            options={TRI}
            noneLabel="Off"
          />
        </div>
        <div className="grid gap-3 @md:grid-cols-4">
          <FormText
            label="Metric"
            type="number"
            value={metric}
            onChange={setMetric}
          />
          <FormText
            label="Metric (L2)"
            type="number"
            value={metricL2}
            onChange={setMetricL2}
          />
          <FormText
            label="Hello interval"
            type="number"
            value={helloInterval}
            onChange={setHelloInterval}
            hint="s"
          />
          <FormText
            label="Hello multiplier"
            type="number"
            value={helloMultiplier}
            onChange={setHelloMultiplier}
          />
        </div>
        <div className="grid gap-3 @md:grid-cols-3">
          <FormSelect
            label="Authentication"
            value={auth}
            onChange={setAuth}
            options={ISIS_AUTH}
          />
          {auth !== "none" && (
            <FormCombobox
              label="Keychain"
              required
              value={keychainId}
              onChange={setKeychainId}
              options={keychains.map((k) => ({ value: k.id, label: k.label }))}
              placeholder="Pick a keychain"
              error={fieldErrors.keychain}
            />
          )}
          <FormCheckbox label="BFD" checked={bfd} onChange={setBfd} />
        </div>
      </FormSection>
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Enrol interface"}
      />
    </form>
  )
}

// ─── EIGRP instance ──────────────────────────────────────────────────────────

export function EIGRPInstanceForm({
  item,
  device,
  onSaved,
  onCancel,
}: {
  item?: EIGRPInstance | null
  device: { id: string; name: string }
  onSaved: (v: EIGRPInstance) => void
  onCancel: () => void
}) {
  const isEdit = !!item
  const [vrfId, setVrfId] = useState<string | null>(item?.vrf?.id ?? null)
  const [asn, setAsn] = useState(numText(item?.asn))
  const [name, setName] = useState(item?.name ?? "")
  const [routerId, setRouterId] = useState(item?.router_id ?? "")
  const [kValues, setKValues] = useState(item?.k_values ?? "")
  const [variance, setVariance] = useState(numText(item?.variance))
  const [maxPaths, setMaxPaths] = useState(numText(item?.maximum_paths))
  const [passive, setPassive] = useState(item?.passive_by_default ?? false)
  const [stub, setStub] = useState(item?.stub ?? false)
  const [bfd, setBfd] = useState(item?.bfd ?? false)
  const [statusId, setStatusId] = useState<string | null>(
    item?.status?.id ?? null
  )
  const [description, setDescription] = useState(item?.description ?? "")
  const [redist, setRedist] = useState<RedistDraft[]>(
    redistFrom(item?.redistributions ?? [])
  )
  const [tagIds, setTagIds] = useState<number[]>(
    item?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    item?.custom_fields ?? {}
  )
  const vrfs = useVrfs()
  const statuses = useInstanceStatuses()
  useEffect(() => {
    if (isEdit || statusId || !statuses.data) return
    const d = statuses.data.results.find((st) =>
      st.default_for.includes("routinginstance")
    )
    if (d) setStatusId(d.id)
  }, [isEdit, statusId, statuses.data])
  const { mutation, fieldErrors } = useRoutingSave<EIGRPInstance>({
    objectType: ROUTING_OBJECT_TYPES.eigrpinstance,
    endpoint: "/api/routing/eigrp-instances/",
    queryKey: "eigrp-instances",
    id: item?.id,
    label: (v) => `EIGRP ${v.asn} on ${v.device.name}`,
    onSaved,
  })
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        mutation.mutate({
          device_id: device.id,
          vrf_id: vrfId,
          asn: numOrNull(asn),
          name: name.trim(),
          router_id: routerId.trim(),
          k_values: kValues.trim(),
          variance: numOrNull(variance),
          maximum_paths: numOrNull(maxPaths),
          passive_by_default: passive,
          stub,
          bfd,
          status_id: statusId,
          description: description.trim(),
          redistributions: redistPayload(redist),
          tag_ids: tagIds,
          custom_fields: customFields,
        })
      }}
      className="@container grid gap-4"
    >
      <FormSection title="Instance" card>
        <div className="grid gap-3 @md:grid-cols-3">
          <FormText
            label="AS number"
            required
            type="number"
            autoFocus={!isEdit}
            value={asn}
            onChange={setAsn}
            placeholder="100"
            error={fieldErrors.asn}
          />
          <FormText
            label="Name"
            mono
            value={name}
            onChange={setName}
            placeholder="CORE"
            info="Named mode: router eigrp NAME with the AS under its address family. Blank is classic mode."
            error={fieldErrors.name}
          />
          <FormCombobox
            label="VRF"
            value={vrfId}
            onChange={setVrfId}
            options={(vrfs.data?.results ?? []).map((v) => ({
              value: v.id,
              label: v.rd ? `${v.name} · ${v.rd}` : v.name,
              color: v.color,
            }))}
            noneLabel="Global"
            placeholder="Global"
            error={fieldErrors.vrf_id}
          />
        </div>
        <div className="grid gap-3 @md:grid-cols-3">
          <FormText
            label="Router ID"
            mono
            value={routerId}
            onChange={setRouterId}
            placeholder="10.0.0.11"
            error={fieldErrors.router_id}
          />
          <FormText
            label="K values"
            mono
            value={kValues}
            onChange={setKValues}
            placeholder="1 0 1 0 0"
            info="K1 to K5, space-separated. Blank is the platform default."
            error={fieldErrors.k_values}
          />
          <FormStatusSelect
            value={statusId}
            onChange={setStatusId}
            options={statuses.data?.results ?? []}
            error={fieldErrors.status_id}
          />
        </div>
        <div className="grid gap-3 @md:grid-cols-3">
          <FormText
            label="Variance"
            type="number"
            value={variance}
            onChange={setVariance}
            error={fieldErrors.variance}
          />
          <FormText
            label="Maximum paths"
            type="number"
            value={maxPaths}
            onChange={setMaxPaths}
            error={fieldErrors.maximum_paths}
          />
        </div>
        <div className="grid gap-3 @md:grid-cols-3">
          <FormCheckbox
            label="Passive by default"
            checked={passive}
            onChange={setPassive}
          />
          <FormCheckbox label="Stub" checked={stub} onChange={setStub} />
          <FormCheckbox label="BFD" checked={bfd} onChange={setBfd} />
        </div>
        <FormTextarea
          label="Description"
          value={description}
          onChange={setDescription}
          error={fieldErrors.description}
        />
        <FormTags value={tagIds} onChange={setTagIds} label="Tags" />
        <CustomFieldInputs
          model="eigrpinstance"
          value={customFields}
          onChange={setCustomFields}
        />
      </FormSection>
      <RedistributeSection
        rows={redist}
        onChange={setRedist}
        error={fieldErrors.redistributions}
      />
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create instance"}
      />
    </form>
  )
}

// ─── EIGRP interface ─────────────────────────────────────────────────────────

const EIGRP_AUTH = [
  { value: "none", label: "None" },
  { value: "md5", label: "MD5" },
  { value: "hmac-sha-256", label: "HMAC-SHA-256" },
]

export function EIGRPInterfaceForm({
  item,
  instance,
  onSaved,
  onCancel,
}: {
  item?: EIGRPInterface | null
  instance: EIGRPInstance
  onSaved: (v: EIGRPInterface) => void
  onCancel: () => void
}) {
  const isEdit = !!item
  const [interfaceId, setInterfaceId] = useState<string | null>(
    item?.interface.id ?? null
  )
  const [passive, setPassive] = useState<string | null>(triFrom(item?.passive))
  const [splitHorizon, setSplitHorizon] = useState<string | null>(
    triFrom(item?.split_horizon)
  )
  const [hello, setHello] = useState(numText(item?.hello_interval))
  const [hold, setHold] = useState(numText(item?.hold_time))
  const [bandwidth, setBandwidth] = useState(numText(item?.bandwidth_percent))
  const [summaries, setSummaries] = useState(
    (item?.summary_addresses ?? []).join(", ")
  )
  const [bfd, setBfd] = useState(item?.bfd ?? false)
  const [auth, setAuth] = useState<string | null>(
    item?.authentication ?? "none"
  )
  const [keychainId, setKeychainId] = useState<string | null>(
    item?.keychain?.id ?? null
  )
  const interfaces = useDeviceInterfaces(instance.device.id)
  const keychains = usePickList<{ id: string; name: string }>(
    "routing-keychains",
    "/api/routing/keychains/",
    (k) => k.name
  )
  const used = new Set(instance.interfaces.map((i) => i.interface.id))
  const { mutation, fieldErrors } = useRoutingSave<EIGRPInterface>({
    objectType: ROUTING_OBJECT_TYPES.eigrpinterface,
    endpoint: "/api/routing/eigrp-interfaces/",
    queryKey: "eigrp-instances",
    id: item?.id,
    label: (v) => v.interface.name,
    onSaved,
  })
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        mutation.mutate({
          instance_id: instance.id,
          interface_id: interfaceId,
          passive: triTo(passive),
          split_horizon: triTo(splitHorizon),
          hello_interval: numOrNull(hello),
          hold_time: numOrNull(hold),
          bandwidth_percent: numOrNull(bandwidth),
          summary_addresses: summaries
            .split(/[\s,]+/)
            .map((v) => v.trim())
            .filter(Boolean),
          bfd,
          authentication: auth,
          keychain_id: auth === "none" ? null : keychainId,
        })
      }}
      className="@container grid gap-4"
    >
      <FormSection title="Interface" card>
        <div className="grid gap-3 @md:grid-cols-3">
          <FormCombobox
            label="Interface"
            required
            value={interfaceId}
            onChange={setInterfaceId}
            options={(interfaces.data?.results ?? [])
              .filter((i) => isEdit || !used.has(i.id))
              .map((i) => ({ value: i.id, label: i.name }))}
            placeholder="Pick an interface"
            searchPlaceholder="Search interfaces…"
            emptyText="Every interface is enrolled already."
            disabled={isEdit}
            error={fieldErrors.interface_id}
          />
          <FormSelect
            label="Passive"
            value={passive}
            onChange={setPassive}
            options={TRI}
            noneLabel={`Instance (${instance.passive_by_default ? "on" : "off"})`}
          />
          <FormSelect
            label="Split horizon"
            value={splitHorizon}
            onChange={setSplitHorizon}
            options={TRI}
            noneLabel="Platform default"
          />
        </div>
        <div className="grid gap-3 @md:grid-cols-3">
          <FormText
            label="Hello"
            type="number"
            hint="s"
            value={hello}
            onChange={setHello}
            error={fieldErrors.hello_interval}
          />
          <FormText
            label="Hold time"
            type="number"
            hint="s"
            value={hold}
            onChange={setHold}
            error={fieldErrors.hold_time}
          />
          <FormText
            label="Bandwidth"
            type="number"
            hint="%"
            value={bandwidth}
            onChange={setBandwidth}
            error={fieldErrors.bandwidth_percent}
          />
        </div>
        <FormText
          label="Summary addresses"
          mono
          value={summaries}
          onChange={setSummaries}
          placeholder="10.1.0.0/16, 10.2.0.0/16"
          info="Networks summarised out of this port - ip summary-address eigrp."
          error={fieldErrors.summary_addresses}
        />
        <div className="grid gap-3 @md:grid-cols-3">
          <FormSelect
            label="Authentication"
            value={auth}
            onChange={setAuth}
            options={EIGRP_AUTH}
          />
          {auth !== "none" && (
            <FormCombobox
              label="Keychain"
              required
              value={keychainId}
              onChange={setKeychainId}
              options={keychains.map((k) => ({ value: k.id, label: k.label }))}
              placeholder="Pick a keychain"
              error={fieldErrors.keychain}
            />
          )}
          <FormCheckbox
            label="BFD"
            checked={bfd}
            onChange={setBfd}
            className="self-end"
          />
        </div>
      </FormSection>
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Enrol interface"}
      />
    </form>
  )
}
