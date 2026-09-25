import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type {
  AfiSafi,
  ASN,
  BGPAddressFamily,
  BGPInstance,
  BGPPeerGroup,
  BGPPeerGroupMini,
  BGPSession,
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
import { DevicePicker } from "@/components/device-picker"

import { MultiPick } from "./multi-pick"
import {
  BFDFields,
  ROUTING_OBJECT_TYPES,
  CellInput,
  CellSelect,
  RulesTable,
  numOrNull,
  numText,
  usePickList,
  useRoutingSave,
} from "./form-bits"
import {
  firstError,
  OwnerField,
  ownerName,
  ownerOf,
  ownerParam,
  ownerPayload,
  portOf,
  portPayload,
  useOwnerPorts,
} from "./owner"
import type { OwnerKind, RoutingOwner } from "./owner"

// BGP forms: the instance ("router bgp" on a device), its address families,
// peer groups, and sessions. A session field left on "inherit" stays null
// and the peer group's value applies - the page shows the effective result.

export const AFI_SAFI: { id: AfiSafi; label: string }[] = [
  { id: "ipv4-unicast", label: "ipv4-unicast" },
  { id: "ipv6-unicast", label: "ipv6-unicast" },
  { id: "vpnv4-unicast", label: "vpnv4-unicast" },
  { id: "vpnv6-unicast", label: "vpnv6-unicast" },
  { id: "l2vpn-evpn", label: "l2vpn-evpn" },
  { id: "ipv4-labeled-unicast", label: "ipv4-labeled-unicast" },
]

// Tri-state knobs: null is "inherit" (session) / "platform default" (group),
// drawn as the select's none row - the primitive refuses "" as a value.

const NO_POLICY = "__none__"
const TRI = [
  { value: "on", label: "On" },
  { value: "off", label: "Off" },
]
const triFrom = (v: boolean | null | undefined) =>
  v == null ? null : v ? "on" : "off"
const triTo = (v: string | null) =>
  v === "on" ? true : v === "off" ? false : null

const SEND_COMMUNITY = [
  { value: "none", label: "None" },
  { value: "standard", label: "Standard" },
  { value: "extended", label: "Extended" },
  { value: "both", label: "Standard and extended" },
  { value: "large", label: "Large" },
]

const REMOTE_MODES = [
  { value: "asn", label: "Number" },
  { value: "external", label: "External (any other AS)" },
  { value: "internal", label: "Internal (own AS)" },
]

function useStatuses(scope: string) {
  return useQuery({
    queryKey: ["statuses", scope],
    queryFn: () =>
      api<Paginated<Status>>(`/api/statuses/?available_to=${scope}&picker=1`),
    staleTime: 5 * 60_000,
  })
}

function useDefaultStatus(
  scope: string,
  statuses: Status[] | undefined,
  statusId: string | null,
  setStatusId: (v: string) => void,
  isEdit: boolean
) {
  useEffect(() => {
    if (isEdit || statusId || !statuses) return
    const d = statuses.find((st) => st.default_for.includes(scope))
    if (d) setStatusId(d.id)
  }, [isEdit, statusId, statuses, scope, setStatusId])
}

function useAsns() {
  return useQuery({
    queryKey: ["asns-picker"],
    queryFn: () => api<Paginated<ASN>>("/api/asns/?page_size=500"),
    staleTime: 60_000,
  })
}

// ─── The shared neighbour knobs ──────────────────────────────────────────────

interface KnobState {
  afs: AfiSafi[]
  importPolicyId: string | null
  exportPolicyId: string | null
  bfd: string | null
  bfdProfileId: string | null
  ebgpMultihop: string
  nextHopSelf: string | null
  rrClient: string | null
  sendCommunity: string | null
  keepalive: string
  holdTime: string
  keychainId: string | null
  defaultOriginate: string | null
  maximumPrefix: string
  allowasIn: string
  asOverride: string | null
  removePrivateAs: string | null
  softReconfiguration: string | null
  defaultOriginatePolicyId: string | null
  extendedNexthop: string | null
  ttlSecurityHops: string
}

function knobsFrom(k?: Partial<BGPPeerGroup> | Partial<BGPSession>): KnobState {
  return {
    afs: k?.address_families ?? [],
    importPolicyId: k?.import_policy?.id ?? null,
    exportPolicyId: k?.export_policy?.id ?? null,
    bfd: triFrom(k?.bfd),
    bfdProfileId: k?.bfd_profile?.id ?? null,
    ebgpMultihop: numText(k?.ebgp_multihop),
    nextHopSelf: triFrom(k?.next_hop_self),
    rrClient: triFrom(k?.route_reflector_client),
    sendCommunity: k?.send_community || null,
    keepalive: numText(k?.keepalive),
    holdTime: numText(k?.hold_time),
    keychainId: k?.keychain?.id ?? null,
    defaultOriginate: triFrom(k?.default_originate),
    maximumPrefix: numText(k?.maximum_prefix),
    allowasIn: numText(k?.allowas_in),
    asOverride: triFrom(k?.as_override),
    removePrivateAs: triFrom(k?.remove_private_as),
    softReconfiguration: triFrom(k?.soft_reconfiguration),
    defaultOriginatePolicyId: k?.default_originate_policy?.id ?? null,
    extendedNexthop: triFrom(k?.capability_extended_nexthop),
    ttlSecurityHops: numText(k?.ttl_security_hops),
  }
}

function knobsPayload(k: KnobState) {
  return {
    address_families: k.afs,
    import_policy_id: k.importPolicyId,
    export_policy_id: k.exportPolicyId,
    bfd: triTo(k.bfd),
    bfd_profile_id: k.bfd === "off" ? null : k.bfdProfileId,
    ebgp_multihop: numOrNull(k.ebgpMultihop),
    next_hop_self: triTo(k.nextHopSelf),
    route_reflector_client: triTo(k.rrClient),
    send_community: k.sendCommunity ?? "",
    keepalive: numOrNull(k.keepalive),
    hold_time: numOrNull(k.holdTime),
    keychain_id: k.keychainId,
    default_originate: triTo(k.defaultOriginate),
    maximum_prefix: numOrNull(k.maximumPrefix),
    allowas_in: numOrNull(k.allowasIn),
    as_override: triTo(k.asOverride),
    remove_private_as: triTo(k.removePrivateAs),
    soft_reconfiguration: triTo(k.softReconfiguration),
    default_originate_policy_id:
      k.defaultOriginate === "off" ? null : k.defaultOriginatePolicyId,
    capability_extended_nexthop: triTo(k.extendedNexthop),
    ttl_security_hops: numOrNull(k.ttlSecurityHops),
  }
}

function KnobFields({
  k,
  set,
  errors,
  inherit,
}: {
  k: KnobState
  set: (patch: Partial<KnobState>) => void
  errors: Record<string, string | undefined>
  /** On a session: unset means "as the group says". */
  inherit: boolean
}) {
  const policies = usePickList<{ id: string; name: string }>(
    "routing-policies",
    "/api/routing/policies/",
    (p) => p.name
  )
  const keychains = usePickList<{ id: string; name: string }>(
    "routing-keychains",
    "/api/routing/keychains/",
    (p) => p.name
  )
  const none = inherit ? "Inherit" : "None"
  return (
    <>
      <div className="grid gap-1">
        <span className="text-xs font-medium">Address families</span>
        <MultiPick
          options={AFI_SAFI}
          value={k.afs}
          onChange={(v) => set({ afs: v as AfiSafi[] })}
          placeholder="Add address family"
          emptyText="No more."
        />
        {errors.address_families && (
          <p className="text-[11px] text-destructive">
            {errors.address_families}
          </p>
        )}
      </div>
      <div className="grid gap-3 @md:grid-cols-2">
        <FormCombobox
          label="Import policy"
          value={k.importPolicyId}
          onChange={(v) => set({ importPolicyId: v })}
          options={policies.map((p) => ({ value: p.id, label: p.label }))}
          noneLabel={none}
          placeholder={none}
          error={errors.import_policy_id}
        />
        <FormCombobox
          label="Export policy"
          value={k.exportPolicyId}
          onChange={(v) => set({ exportPolicyId: v })}
          options={policies.map((p) => ({ value: p.id, label: p.label }))}
          noneLabel={none}
          placeholder={none}
          error={errors.export_policy_id}
        />
      </div>
      <div className="grid gap-3 @md:grid-cols-3">
        <FormSelect
          label="Next-hop self"
          value={k.nextHopSelf}
          onChange={(v) => set({ nextHopSelf: v })}
          options={TRI}
          noneLabel={none}
        />
        <FormSelect
          label="Route reflector client"
          value={k.rrClient}
          onChange={(v) => set({ rrClient: v })}
          options={TRI}
          noneLabel={none}
        />
        <FormSelect
          label="Send community"
          value={k.sendCommunity}
          onChange={(v) => set({ sendCommunity: v })}
          options={SEND_COMMUNITY}
          noneLabel={none}
        />
      </div>
      <div className="grid gap-3 @md:grid-cols-3">
        <FormText
          label="eBGP multihop"
          type="number"
          hint="TTL"
          value={k.ebgpMultihop}
          onChange={(v) => set({ ebgpMultihop: v })}
          error={errors.ebgp_multihop}
        />
        <FormText
          label="Keepalive"
          type="number"
          value={k.keepalive}
          onChange={(v) => set({ keepalive: v })}
          error={errors.keepalive}
        />
        <FormText
          label="Hold time"
          type="number"
          value={k.holdTime}
          onChange={(v) => set({ holdTime: v })}
          error={errors.hold_time}
        />
      </div>
      <div className="grid gap-3 @md:grid-cols-3">
        <FormSelect
          label="Default originate"
          value={k.defaultOriginate}
          onChange={(v) => set({ defaultOriginate: v })}
          options={TRI}
          noneLabel={none}
        />
        {k.defaultOriginate === "on" && (
          <FormCombobox
            label="Default originate policy"
            value={k.defaultOriginatePolicyId}
            onChange={(v) => set({ defaultOriginatePolicyId: v })}
            options={policies.map((p) => ({ value: p.id, label: p.label }))}
            noneLabel="-"
            placeholder="-"
            info="Conditional: the default is only sent while this policy matches something."
            error={errors.default_originate_policy_id}
          />
        )}
        <FormText
          label="Maximum prefix"
          type="number"
          value={k.maximumPrefix}
          onChange={(v) => set({ maximumPrefix: v })}
          info="The session is torn down past this many received prefixes."
          error={errors.maximum_prefix}
        />
        <FormText
          label="Allowas-in"
          type="number"
          value={k.allowasIn}
          onChange={(v) => set({ allowasIn: v })}
          info="Times the local AS may appear in a received path."
          error={errors.allowas_in}
        />
      </div>
      <div className="grid gap-3 @md:grid-cols-3">
        <FormSelect
          label="AS override"
          value={k.asOverride}
          onChange={(v) => set({ asOverride: v })}
          options={TRI}
          noneLabel={none}
        />
        <FormSelect
          label="Remove private AS"
          value={k.removePrivateAs}
          onChange={(v) => set({ removePrivateAs: v })}
          options={TRI}
          noneLabel={none}
        />
        <FormSelect
          label="Soft reconfiguration"
          value={k.softReconfiguration}
          onChange={(v) => set({ softReconfiguration: v })}
          options={TRI}
          noneLabel={none}
        />
      </div>
      <div className="grid gap-3 @md:grid-cols-3">
        <FormSelect
          label="Extended next-hop"
          value={k.extendedNexthop}
          onChange={(v) => set({ extendedNexthop: v })}
          options={TRI}
          noneLabel={none}
          info="RFC 5549: IPv4 routes over an IPv6 next hop. Every unnumbered EVPN fabric session carries it."
        />
        <FormText
          label="TTL security hops"
          type="number"
          value={k.ttlSecurityHops}
          onChange={(v) => set({ ttlSecurityHops: v })}
          info="GTSM (RFC 5082). Blank = off."
          error={errors.ttl_security_hops}
        />
      </div>
      <BFDFields
        tri
        inheritLabel={none}
        on={k.bfd}
        onChange={(v) => set({ bfd: v })}
        profileId={k.bfdProfileId}
        onProfileChange={(v) => set({ bfdProfileId: v })}
        profileNoneLabel={none}
        errors={errors}
      />
      <FormCombobox
        label="Keychain"
        value={k.keychainId}
        onChange={(v) => set({ keychainId: v })}
        options={keychains.map((p) => ({ value: p.id, label: p.label }))}
        noneLabel={none}
        placeholder={none}
        error={errors.keychain_id}
      />
    </>
  )
}

// ─── Peer group ──────────────────────────────────────────────────────────────

export function BGPPeerGroupForm({
  item,
  onSaved,
  onCancel,
}: {
  item?: BGPPeerGroup
  onSaved: (v: BGPPeerGroup) => void
  onCancel: () => void
}) {
  const isEdit = !!item
  const [name, setName] = useState(item?.name ?? "")
  const [description, setDescription] = useState(item?.description ?? "")
  const [remoteMode, setRemoteMode] = useState<string | null>(
    item?.remote_asn_mode ?? "asn"
  )
  const [remoteAsn, setRemoteAsn] = useState(numText(item?.remote_asn))
  const [localAsnId, setLocalAsnId] = useState<string | null>(
    item?.local_asn?.id ?? null
  )
  const [updateSource, setUpdateSource] = useState(item?.update_source ?? "")
  const [k, setK] = useState<KnobState>(knobsFrom(item))
  const [tagIds, setTagIds] = useState<number[]>(
    item?.tags.map((t) => t.id) ?? []
  )
  const [customFields, setCustomFields] = useState<Record<string, unknown>>(
    item?.custom_fields ?? {}
  )
  const asns = useAsns()
  const { mutation, fieldErrors } = useRoutingSave<BGPPeerGroup>({
    objectType: ROUTING_OBJECT_TYPES.bgppeergroup,
    endpoint: "/api/routing/bgp-peer-groups/",
    queryKey: "bgp-peer-groups",
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
          description: description.trim(),
          remote_asn_mode: remoteMode,
          remote_asn: remoteMode === "asn" ? numOrNull(remoteAsn) : null,
          local_asn_id: localAsnId,
          update_source: updateSource.trim(),
          ...knobsPayload(k),
          tag_ids: tagIds,
          custom_fields: customFields,
        })
      }}
      className="@container grid gap-4"
    >
      <FormSection title="Peer group" card>
        <div className="grid gap-3 @md:grid-cols-2">
          <FormText
            label="Name"
            required
            mono
            autoFocus={!isEdit}
            value={name}
            onChange={setName}
            placeholder="SPINES"
            error={fieldErrors.name}
          />
          <FormText
            label="Update source"
            mono
            hint="a hint the template prints"
            value={updateSource}
            onChange={setUpdateSource}
            placeholder="lo0"
            error={fieldErrors.update_source}
          />
        </div>
        <div className="grid gap-3 @md:grid-cols-3">
          <FormSelect
            label="Remote AS"
            value={remoteMode}
            onChange={setRemoteMode}
            options={REMOTE_MODES}
            error={fieldErrors.remote_asn_mode}
          />
          {remoteMode === "asn" && (
            <FormText
              label="Remote AS number"
              type="number"
              value={remoteAsn}
              onChange={setRemoteAsn}
              placeholder="65000"
              error={fieldErrors.remote_asn}
            />
          )}
          <FormCombobox
            label="Local AS"
            hint="blank = the instance's"
            value={localAsnId}
            onChange={setLocalAsnId}
            options={(asns.data?.results ?? []).map((a) => ({
              value: a.id,
              label: `AS${a.asn}`,
            }))}
            noneLabel="Instance's"
            placeholder="Instance's"
            error={fieldErrors.local_asn_id}
          />
        </div>
        <FormTextarea
          label="Description"
          value={description}
          onChange={setDescription}
          error={fieldErrors.description}
        />
      </FormSection>
      <FormSection title="Neighbor settings" card>
        <KnobFields
          k={k}
          set={(p) => setK({ ...k, ...p })}
          errors={fieldErrors}
          inherit={false}
        />
      </FormSection>
      <FormSection title="Notes" card>
        <FormTags value={tagIds} onChange={setTagIds} label="Tags" />
        <CustomFieldInputs
          model="bgppeergroup"
          value={customFields}
          onChange={setCustomFields}
        />
      </FormSection>
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create peer group"}
      />
    </form>
  )
}

// ─── Instance ────────────────────────────────────────────────────────────────

export function BGPInstanceForm({
  item,
  owner,
  onSaved,
  onCancel,
}: {
  item?: BGPInstance | null
  /** The box it runs on, when adding from its Routing tab. */
  owner?: RoutingOwner
  onSaved: (v: BGPInstance) => void
  onCancel: () => void
}) {
  const isEdit = !!item
  const start = (item ? ownerOf(item) : null) ?? owner ?? null
  const [on, setOn] = useState<{ kind: OwnerKind; id: string | null }>({
    kind: start?.kind ?? "device",
    id: start?.id ?? null,
  })
  const [vrfId, setVrfId] = useState<string | null>(item?.vrf?.id ?? null)
  const [asnId, setAsnId] = useState<string | null>(item?.asn.id ?? null)
  const [routerId, setRouterId] = useState(item?.router_id ?? "")
  const [clusterId, setClusterId] = useState(item?.cluster_id ?? "")
  const [gr, setGr] = useState(item?.graceful_restart ?? false)
  const [relax, setRelax] = useState(item?.bestpath_multipath_relax ?? false)
  const [vpnExport, setVpnExport] = useState(item?.vpn_export ?? false)
  const [vpnImport, setVpnImport] = useState(item?.vpn_import ?? false)
  const [vpnLabel, setVpnLabel] = useState(item?.vpn_label_export ?? "")
  const [vpnNexthop, setVpnNexthop] = useState(item?.vpn_nexthop_export ?? "")
  const [distE, setDistE] = useState(numText(item?.distance_ebgp))
  const [distI, setDistI] = useState(numText(item?.distance_ibgp))
  const [distL, setDistL] = useState(numText(item?.distance_local))
  const [bfd, setBfd] = useState<string | null>(item?.bfd ? "on" : "off")
  const [bfdProfileId, setBfdProfileId] = useState<string | null>(
    item?.bfd_profile?.id ?? null
  )
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
  const asns = useAsns()
  const vrfs = useQuery({
    queryKey: ["vrfs-picker"],
    queryFn: () => api<Paginated<VRFOption>>("/api/vrfs/"),
  })
  const statuses = useStatuses("routinginstance")
  useDefaultStatus(
    "routinginstance",
    statuses.data?.results,
    statusId,
    setStatusId,
    isEdit
  )
  const { mutation, fieldErrors } = useRoutingSave<BGPInstance>({
    objectType: ROUTING_OBJECT_TYPES.bgpinstance,
    endpoint: "/api/routing/bgp-instances/",
    queryKey: "bgp-instances",
    id: item?.id,
    label: (v) => `AS${v.asn.asn} on ${ownerName(v)}`,
    onSaved,
  })
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        mutation.mutate({
          ...ownerPayload(on.id ? { ...on, id: on.id, name: "" } : null),
          vrf_id: vrfId,
          asn_id: asnId,
          router_id: routerId.trim(),
          cluster_id: clusterId.trim(),
          graceful_restart: gr,
          bestpath_multipath_relax: relax,
          vpn_export: vrfId ? vpnExport : false,
          vpn_import: vrfId ? vpnImport : false,
          vpn_label_export: vrfId ? vpnLabel.trim() : "",
          vpn_nexthop_export: vrfId ? vpnNexthop.trim() : "",
          distance_ebgp: numOrNull(distE),
          distance_ibgp: numOrNull(distI),
          distance_local: numOrNull(distL),
          bfd: bfd === "on",
          bfd_profile_id: bfd === "on" ? bfdProfileId : null,
          status_id: statusId,
          description: description.trim(),
          tag_ids: tagIds,
          custom_fields: customFields,
        })
      }}
      className="@container grid gap-4"
    >
      <FormSection title="Instance" card>
        <OwnerField
          value={on}
          onChange={setOn}
          locked={!!owner || isEdit}
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
            options={(vrfs.data?.results ?? []).map((v) => ({
              value: v.id,
              label: v.rd ? `${v.name} · ${v.rd}` : v.name,
              color: v.color,
            }))}
            noneLabel="Global"
            placeholder="Global"
            searchPlaceholder="Search VRFs…"
            emptyText="No VRFs."
            error={fieldErrors.vrf_id}
          />
        </div>
        <div className="grid gap-3 @md:grid-cols-3">
          <FormCombobox
            label="AS"
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
            error={fieldErrors.asn_id}
          />
          <FormText
            label="Router ID"
            mono
            value={routerId}
            onChange={setRouterId}
            placeholder="10.0.0.11"
            error={fieldErrors.router_id}
          />
          <FormText
            label="Cluster ID"
            mono
            value={clusterId}
            onChange={setClusterId}
            error={fieldErrors.cluster_id}
          />
        </div>
        <div className="grid gap-3 @md:grid-cols-3">
          <FormStatusSelect
            value={statusId}
            onChange={setStatusId}
            options={statuses.data?.results ?? []}
            error={fieldErrors.status_id}
          />
          <FormCheckbox
            label="Graceful restart"
            checked={gr}
            onChange={setGr}
          />
          <FormCheckbox
            label="Multipath relax"
            hint="bestpath as-path multipath-relax"
            checked={relax}
            onChange={setRelax}
          />
        </div>
        <div className="grid gap-3 @md:grid-cols-3">
          <FormText
            label="Distance eBGP"
            type="number"
            value={distE}
            onChange={setDistE}
            info="distance bgp takes all three values or none."
            error={fieldErrors.distance_ebgp}
          />
          <FormText
            label="Distance iBGP"
            type="number"
            value={distI}
            onChange={setDistI}
            error={fieldErrors.distance_ibgp}
          />
          <FormText
            label="Distance local"
            type="number"
            value={distL}
            onChange={setDistL}
            error={fieldErrors.distance_local}
          />
        </div>
        <BFDFields
          on={bfd}
          onChange={setBfd}
          profileId={bfdProfileId}
          onProfileChange={setBfdProfileId}
          errors={fieldErrors}
        />
        <FormTextarea
          label="Description"
          value={description}
          onChange={setDescription}
          error={fieldErrors.description}
        />
        <FormTags value={tagIds} onChange={setTagIds} label="Tags" />
        <CustomFieldInputs
          model="bgpinstance"
          value={customFields}
          onChange={setCustomFields}
        />
      </FormSection>
      {vrfId && (
        <FormSection title="MPLS L3VPN" card>
          <div className="grid gap-3 @md:grid-cols-2">
            <FormCheckbox
              label="Export to VPN"
              checked={vpnExport}
              onChange={setVpnExport}
              info="The VRF's unicast routes leave for the VPN table with its export route targets."
            />
            <FormCheckbox
              label="Import from VPN"
              checked={vpnImport}
              onChange={setVpnImport}
              info="VPN routes matching the import route targets land in this VRF."
            />
          </div>
          <div className="grid gap-3 @md:grid-cols-2">
            <FormText
              label="Label export"
              mono
              value={vpnLabel}
              onChange={setVpnLabel}
              placeholder="auto"
              info="auto or a label number"
              error={fieldErrors.vpn_label_export}
            />
            <FormText
              label="Next-hop export"
              mono
              value={vpnNexthop}
              onChange={setVpnNexthop}
              placeholder="10.51.255.1"
              info="The next hop the exported VPN routes carry; blank = the platform default."
              error={fieldErrors.vpn_nexthop_export}
            />
          </div>
        </FormSection>
      )}
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create instance"}
      />
    </form>
  )
}

// ─── Address family ──────────────────────────────────────────────────────────

interface RedistDraft {
  sequence: number
  source: string
  policyId: string | null
  metric: string
}

const SOURCES = [
  { value: "connected", label: "connected" },
  { value: "static", label: "static" },
  { value: "bgp", label: "bgp" },
  { value: "ospf", label: "ospf" },
  { value: "isis", label: "isis" },
  { value: "kernel", label: "kernel" },
]

export function BGPAddressFamilyForm({
  item,
  instance,
  onSaved,
  onCancel,
}: {
  item?: BGPAddressFamily | null
  instance: BGPInstance
  onSaved: (v: BGPAddressFamily) => void
  onCancel: () => void
}) {
  const isEdit = !!item
  const [afiSafi, setAfiSafi] = useState<string | null>(
    item?.afi_safi ?? "ipv4-unicast"
  )
  const [networks, setNetworks] = useState(item?.networks.join("\n") ?? "")
  const [maxPaths, setMaxPaths] = useState(numText(item?.maximum_paths))
  const [maxPathsIbgp, setMaxPathsIbgp] = useState(
    numText(item?.maximum_paths_ibgp)
  )
  const [advV4, setAdvV4] = useState(item?.advertise_ipv4_unicast ?? false)
  const [advV6, setAdvV6] = useState(item?.advertise_ipv6_unicast ?? false)
  const [importPolicyId, setImportPolicyId] = useState<string | null>(
    item?.import_policy?.id ?? null
  )
  const [exportPolicyId, setExportPolicyId] = useState<string | null>(
    item?.export_policy?.id ?? null
  )
  const [redist, setRedist] = useState<RedistDraft[]>(
    (item?.redistributions ?? []).map((r, i) => ({
      sequence: (i + 1) * 10,
      source: r.source,
      policyId: r.policy?.id ?? null,
      metric: numText(r.metric),
    }))
  )
  const policies = usePickList<{ id: string; name: string }>(
    "routing-policies",
    "/api/routing/policies/",
    (p) => p.name
  )
  const { mutation, fieldErrors } = useRoutingSave<BGPAddressFamily>({
    objectType: ROUTING_OBJECT_TYPES.bgpaddressfamily,
    endpoint: "/api/routing/bgp-address-families/",
    queryKey: "bgp-instances",
    id: item?.id,
    label: (v) => v.afi_safi,
    onSaved,
  })
  // Radix refuses an empty item value, so "no policy" is a sentinel.
  const policyOptions = [
    { value: NO_POLICY, label: "-" },
    ...policies.map((p) => ({ value: p.id, label: p.label })),
  ]
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        mutation.mutate({
          instance_id: instance.id,
          afi_safi: afiSafi,
          networks: networks
            .split(/[\n,]/)
            .map((n) => n.trim())
            .filter(Boolean),
          maximum_paths: numOrNull(maxPaths),
          maximum_paths_ibgp: numOrNull(maxPathsIbgp),
          advertise_ipv4_unicast: afiSafi === "l2vpn-evpn" && advV4,
          advertise_ipv6_unicast: afiSafi === "l2vpn-evpn" && advV6,
          import_policy_id: importPolicyId,
          export_policy_id: exportPolicyId,
          redistributions: redist.map((r) => ({
            source: r.source,
            policy_id: r.policyId || null,
            metric: numOrNull(r.metric),
          })),
        })
      }}
      className="@container grid gap-4"
    >
      <FormSection title="Address family" card>
        <div className="grid gap-3 @md:grid-cols-3">
          <FormSelect
            label="AFI/SAFI"
            value={afiSafi}
            onChange={setAfiSafi}
            options={AFI_SAFI.map((a) => ({ value: a.id, label: a.label }))}
            error={fieldErrors.afi_safi}
          />
          <FormText
            label="Maximum paths"
            type="number"
            value={maxPaths}
            onChange={setMaxPaths}
            error={fieldErrors.maximum_paths}
          />
          <FormText
            label="Maximum paths (iBGP)"
            type="number"
            value={maxPathsIbgp}
            onChange={setMaxPathsIbgp}
            error={fieldErrors.maximum_paths_ibgp}
          />
        </div>
        {afiSafi === "l2vpn-evpn" && (
          <div className="grid gap-3 @md:grid-cols-2">
            <FormCheckbox
              label="Advertise IPv4 unicast"
              checked={advV4}
              onChange={setAdvV4}
            />
            <FormCheckbox
              label="Advertise IPv6 unicast"
              checked={advV6}
              onChange={setAdvV6}
            />
          </div>
        )}
        <FormTextarea
          label="Networks"
          hint="one per line"
          value={networks}
          onChange={setNetworks}
          placeholder={"10.10.0.0/16\n10.20.0.0/16"}
          error={fieldErrors.networks}
        />
        <div className="grid gap-3 @md:grid-cols-2">
          <FormCombobox
            label="Import policy"
            value={importPolicyId}
            onChange={setImportPolicyId}
            options={policies.map((p) => ({ value: p.id, label: p.label }))}
            noneLabel="None"
            placeholder="None"
            error={fieldErrors.import_policy_id}
          />
          <FormCombobox
            label="Export policy"
            value={exportPolicyId}
            onChange={setExportPolicyId}
            options={policies.map((p) => ({ value: p.id, label: p.label }))}
            noneLabel="None"
            placeholder="None"
            error={fieldErrors.export_policy_id}
          />
        </div>
      </FormSection>
      <FormSection title="Redistribute" card>
        <RulesTable<RedistDraft>
          rows={redist}
          onChange={setRedist}
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
              value={r.policyId ?? NO_POLICY}
              onChange={(v) => update({ policyId: v === NO_POLICY ? null : v })}
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
        {fieldErrors.redistributions && (
          <p className="text-xs text-destructive">
            {fieldErrors.redistributions}
          </p>
        )}
      </FormSection>
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Add address family"}
      />
    </form>
  )
}

// ─── Session ─────────────────────────────────────────────────────────────────

export function BGPSessionForm({
  item,
  instance,
  onSaved,
  onCancel,
}: {
  item?: BGPSession | null
  /** Pre-set instance when adding from a device's or VM's Routing tab. */
  instance?: BGPInstance | BGPSession["instance"]
  onSaved: (v: BGPSession) => void
  onCancel: () => void
}) {
  const isEdit = !!item
  const start = ownerOf(item?.instance ?? instance ?? {})
  const [on, setOn] = useState<{ kind: OwnerKind; id: string | null }>({
    kind: start?.kind ?? "device",
    id: start?.id ?? null,
  })
  const deviceId = on.id
  const box = on.id ? { kind: on.kind, id: on.id } : null
  const pickFirst = on.kind === "vm" ? "Pick a VM first" : "Pick a device first"
  const [instanceId, setInstanceId] = useState<string | null>(
    item?.instance.id ?? instance?.id ?? null
  )
  const [name, setName] = useState(item?.name ?? "")
  const [peerGroupId, setPeerGroupId] = useState<string | null>(
    item?.peer_group?.id ?? null
  )
  const [remoteMode, setRemoteMode] = useState<string | null>(
    item?.remote_asn_mode || null
  )
  const [remoteAsn, setRemoteAsn] = useState(numText(item?.remote_asn))
  const [localAsnId, setLocalAsnId] = useState<string | null>(
    item?.local_asn?.id ?? null
  )
  const [localAddressId, setLocalAddressId] = useState<string | null>(
    item?.local_address?.id ?? null
  )
  const [farKind, setFarKind] = useState<string | null>(
    item && portOf(item) ? "interface" : "address"
  )
  const [remoteAddress, setRemoteAddress] = useState(item?.remote_address ?? "")
  const [interfaceId, setInterfaceId] = useState<string | null>(
    portOf(item ?? {})?.id ?? null
  )
  const [peerDeviceId, setPeerDeviceId] = useState<string | null>(
    item?.peer_device?.id ?? null
  )
  const [k, setK] = useState<KnobState>(knobsFrom(item ?? undefined))
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

  const instances = useQuery({
    queryKey: ["bgp-instances", on.kind, deviceId],
    queryFn: () =>
      api<Paginated<BGPInstance>>(
        `/api/routing/bgp-instances/?${ownerParam({ ...box!, name: "" })}`
      ),
    enabled: !!box,
  })
  const groups = useQuery({
    queryKey: ["bgp-peer-groups-picker"],
    queryFn: () =>
      api<Paginated<BGPPeerGroupMini>>(
        "/api/routing/bgp-peer-groups/?picker=1&page_size=500"
      ),
    staleTime: 60_000,
  })
  const asns = useAsns()
  const ips = useQuery({
    queryKey: [on.kind === "vm" ? "vm-ips" : "device-ips", deviceId],
    queryFn: () =>
      api<{
        results: {
          id: string
          ip_address: string
          assigned_interface: { name: string } | null
          assigned_vm_interface?: { name: string } | null
        }[]
      }>(
        on.kind === "vm"
          ? `/api/ips/?assigned_vm=${deviceId}&page_size=500`
          : `/api/devices/${deviceId}/ips/`
      ),
    enabled: !!box,
  })
  const interfaces = useOwnerPorts(box)
  const statuses = useStatuses("bgpsession")
  useDefaultStatus(
    "bgpsession",
    statuses.data?.results,
    statusId,
    setStatusId,
    isEdit
  )
  const group = (groups.data?.results ?? []).find((g) => g.id === peerGroupId)

  const { mutation, fieldErrors } = useRoutingSave<BGPSession>({
    objectType: ROUTING_OBJECT_TYPES.bgpsession,
    endpoint: "/api/routing/bgp-sessions/",
    queryKey: "bgp-sessions",
    id: item?.id,
    label: (v) => v.remote_address || portOf(v)?.name || v.name,
    onSaved,
  })
  const viaAddress = farKind === "address"
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        mutation.mutate({
          instance_id: instanceId,
          name: name.trim(),
          peer_group_id: peerGroupId,
          remote_asn_mode: remoteMode ?? "",
          remote_asn:
            (remoteMode ?? "asn") === "asn" ? numOrNull(remoteAsn) : null,
          local_asn_id: localAsnId,
          local_address_id: localAddressId,
          remote_address: viaAddress ? remoteAddress.trim() : "",
          ...portPayload(on.kind, viaAddress ? null : interfaceId),
          peer_device_id: peerDeviceId,
          ...knobsPayload(k),
          status_id: statusId,
          description: description.trim(),
          tag_ids: tagIds,
          custom_fields: customFields,
        })
      }}
      className="@container grid gap-4"
    >
      <FormSection title="Session" card>
        <OwnerField
          value={on}
          onChange={(v) => {
            setOn(v)
            setInstanceId(null)
            setLocalAddressId(null)
            setInterfaceId(null)
          }}
          locked={!!instance || isEdit}
        />
        <div className="grid gap-3 @md:grid-cols-2">
          <FormCombobox
            label="Instance"
            required
            value={instanceId}
            onChange={setInstanceId}
            options={(instances.data?.results ?? []).map((i) => ({
              value: i.id,
              label: `AS${i.asn.asn} · ${i.vrf?.name ?? "global"}`,
            }))}
            placeholder={deviceId ? "Pick an instance" : pickFirst}
            disabled={!deviceId || !!instance || isEdit}
            emptyText={`No BGP instance on this ${on.kind === "vm" ? "VM" : "device"} yet.`}
            error={fieldErrors.instance_id}
          />
        </div>
        <div className="grid gap-3 @md:grid-cols-2">
          <FormText
            label="Name"
            hint="optional"
            value={name}
            onChange={setName}
            placeholder="spine1"
            error={fieldErrors.name}
          />
          <FormCombobox
            label="Peer group"
            value={peerGroupId}
            onChange={setPeerGroupId}
            options={(groups.data?.results ?? []).map((g) => ({
              value: g.id,
              label: g.name,
            }))}
            noneLabel="None"
            placeholder="None"
            searchPlaceholder="Search peer groups…"
            emptyText="No peer groups."
            error={fieldErrors.peer_group_id}
          />
        </div>
        <div className="grid gap-3 @md:grid-cols-3">
          <FormSelect
            label="Remote AS"
            value={remoteMode}
            onChange={setRemoteMode}
            options={REMOTE_MODES}
            noneLabel={
              group
                ? `Inherit (${group.remote_asn_mode === "asn" ? group.remote_asn : group.remote_asn_mode})`
                : "Inherit"
            }
            error={fieldErrors.remote_asn_mode}
          />
          {(remoteMode ?? "asn") === "asn" && (
            <FormText
              label="Remote AS number"
              type="number"
              hint={
                group?.remote_asn != null
                  ? `blank = ${group.remote_asn}`
                  : undefined
              }
              value={remoteAsn}
              onChange={setRemoteAsn}
              placeholder="65000"
              error={fieldErrors.remote_asn}
            />
          )}
          <FormCombobox
            label="Local AS"
            hint="blank = inherit"
            value={localAsnId}
            onChange={setLocalAsnId}
            options={(asns.data?.results ?? []).map((a) => ({
              value: a.id,
              label: `AS${a.asn}`,
            }))}
            noneLabel="Inherit"
            placeholder="Inherit"
            error={fieldErrors.local_asn_id}
          />
        </div>
        <FormStatusSelect
          value={statusId}
          onChange={setStatusId}
          options={statuses.data?.results ?? []}
          error={fieldErrors.status_id}
        />
      </FormSection>

      <FormSection title="Ends" card>
        <div className="grid gap-3 @md:grid-cols-2">
          <FormCombobox
            label="Local address"
            value={localAddressId}
            onChange={setLocalAddressId}
            options={(ips.data?.results ?? []).map((ip) => ({
              value: ip.id,
              label:
                (ip.assigned_interface ?? ip.assigned_vm_interface)
                  ? `${ip.ip_address} · ${(ip.assigned_interface ?? ip.assigned_vm_interface)!.name}`
                  : ip.ip_address,
            }))}
            noneLabel="None"
            placeholder={deviceId ? "None" : pickFirst}
            disabled={!deviceId}
            searchPlaceholder="Search addresses…"
            emptyText={`No addresses on this ${on.kind === "vm" ? "VM" : "device"}.`}
            info="The source of the session - its interface is the update source."
            error={fieldErrors.local_address_id}
          />
          <FormSelect
            label="Far end"
            value={farKind}
            onChange={setFarKind}
            options={[
              { value: "address", label: "Address" },
              { value: "interface", label: "Interface (unnumbered)" },
            ]}
          />
        </div>
        <div className="grid gap-3 @md:grid-cols-2">
          {viaAddress ? (
            <FormText
              label="Remote address"
              required
              mono
              value={remoteAddress}
              onChange={setRemoteAddress}
              placeholder="10.0.0.1"
              error={fieldErrors.remote_address}
            />
          ) : (
            <FormCombobox
              label="Interface"
              required
              value={interfaceId}
              onChange={setInterfaceId}
              options={(interfaces.data?.results ?? []).map((i) => ({
                value: i.id,
                label: i.name,
              }))}
              placeholder={deviceId ? "Pick an interface" : pickFirst}
              disabled={!deviceId}
              searchPlaceholder="Search interfaces…"
              emptyText="No interfaces."
              error={firstError(
                fieldErrors,
                "interface_id",
                "vm_interface_id",
                "interface",
                "vm_interface"
              )}
            />
          )}
          <DevicePicker
            label="Peer device"
            hint="optional - filled in when the far address is in IPAM"
            value={peerDeviceId}
            onChange={setPeerDeviceId}
            error={fieldErrors.peer_device_id}
          />
        </div>
      </FormSection>

      <FormSection title="Neighbor settings" card>
        <KnobFields
          k={k}
          set={(p) => setK({ ...k, ...p })}
          errors={fieldErrors}
          inherit
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
          model="bgpsession"
          value={customFields}
          onChange={setCustomFields}
        />
      </FormSection>
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create session"}
      />
    </form>
  )
}
