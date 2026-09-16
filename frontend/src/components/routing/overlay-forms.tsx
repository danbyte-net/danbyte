import { useEffect, useState } from "react"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type {
  InterfaceOption,
  L2VPN,
  Paginated,
  Status,
  VLANMini,
  VTEP,
  VTEPMembership,
} from "@/lib/api"
import {
  FormCheckbox,
  FormCombobox,
  FormFooter,
  FormSection,
  FormStatusSelect,
  FormTags,
  FormText,
  FormTextarea,
} from "@/components/forms"
import { CustomFieldInputs } from "@/components/custom-field-inputs"

import { ROUTING_OBJECT_TYPES, useRoutingSave } from "./form-bits"

// The overlay on a device: its VTEP (one per device) and the VNIs it
// carries. Both are edited from the VTEP card on the Routing tab, so the
// device is known and the pickers list its own loopbacks and addresses.

function useDeviceInterfaces(deviceId: string) {
  return useQuery({
    queryKey: ["interfaces-picker", deviceId],
    queryFn: () =>
      api<Paginated<InterfaceOption>>(`/api/interfaces/?device=${deviceId}`),
  })
}

interface DeviceIP {
  id: string
  ip_address: string
  assigned_interface: { name: string } | null
}

function useDeviceIps(deviceId: string) {
  return useQuery({
    queryKey: ["device-ips", deviceId],
    queryFn: () =>
      api<{ results: DeviceIP[] }>(`/api/devices/${deviceId}/ips/`),
  })
}

const ipLabel = (ip: DeviceIP) =>
  ip.assigned_interface
    ? `${ip.ip_address} · ${ip.assigned_interface.name}`
    : ip.ip_address

// ─── VTEP ────────────────────────────────────────────────────────────────────

export function VTEPForm({
  item,
  device,
  onSaved,
  onCancel,
}: {
  item?: VTEP | null
  device: { id: string; name: string }
  onSaved: (v: VTEP) => void
  onCancel: () => void
}) {
  const isEdit = !!item
  const [sourceInterfaceId, setSourceInterfaceId] = useState<string | null>(
    item?.source_interface?.id ?? null
  )
  const [sourceIpId, setSourceIpId] = useState<string | null>(
    item?.source_ip?.id ?? null
  )
  const [anycastIpId, setAnycastIpId] = useState<string | null>(
    item?.anycast_ip?.id ?? null
  )
  const [anycastMac, setAnycastMac] = useState(item?.anycast_gateway_mac ?? "")
  const [arpSuppression, setArpSuppression] = useState(
    item?.arp_suppression ?? true
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
  const interfaces = useDeviceInterfaces(device.id)
  const ips = useDeviceIps(device.id)
  const statuses = useQuery({
    queryKey: ["statuses", "vtep"],
    queryFn: () =>
      api<Paginated<Status>>("/api/statuses/?available_to=vtep&picker=1"),
    staleTime: 5 * 60_000,
  })
  useEffect(() => {
    if (isEdit || statusId || !statuses.data) return
    const d = statuses.data.results.find((st) =>
      st.default_for.includes("vtep")
    )
    if (d) setStatusId(d.id)
  }, [isEdit, statusId, statuses.data])
  const { mutation, fieldErrors } = useRoutingSave<VTEP>({
    objectType: ROUTING_OBJECT_TYPES.vtep,
    endpoint: "/api/routing/vteps/",
    queryKey: "vteps",
    id: item?.id,
    label: (v) => `VTEP on ${v.device.name}`,
    onSaved,
  })
  const ipOptions = (ips.data?.results ?? []).map((ip) => ({
    value: ip.id,
    label: ipLabel(ip),
  }))
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        mutation.mutate({
          device_id: device.id,
          source_interface_id: sourceInterfaceId,
          source_ip_id: sourceIpId,
          anycast_ip_id: anycastIpId,
          anycast_gateway_mac: anycastMac.trim(),
          arp_suppression: arpSuppression,
          status_id: statusId,
          description: description.trim(),
          tag_ids: tagIds,
          custom_fields: customFields,
        })
      }}
      className="@container grid gap-4"
    >
      <FormSection title="Tunnel endpoint" card>
        <div className="grid gap-3 @md:grid-cols-2">
          <FormCombobox
            label="Source interface"
            value={sourceInterfaceId}
            onChange={setSourceInterfaceId}
            options={(interfaces.data?.results ?? []).map((i) => ({
              value: i.id,
              label: i.name,
            }))}
            noneLabel="None"
            placeholder="Pick a loopback"
            searchPlaceholder="Search interfaces…"
            emptyText="No interfaces on this device."
            info="The loopback VXLAN tunnels source from."
            error={fieldErrors.source_interface_id}
          />
          <FormCombobox
            label="Source IP"
            value={sourceIpId}
            onChange={setSourceIpId}
            options={ipOptions}
            noneLabel="None"
            placeholder="Pick an address"
            searchPlaceholder="Search addresses…"
            emptyText="No addresses on this device."
            error={fieldErrors.source_ip_id}
          />
        </div>
        <div className="grid gap-3 @md:grid-cols-2">
          <FormCombobox
            label="Anycast IP"
            value={anycastIpId}
            onChange={setAnycastIpId}
            options={ipOptions}
            noneLabel="None"
            placeholder="None"
            searchPlaceholder="Search addresses…"
            emptyText="No addresses on this device."
            info="A secondary VTEP address shared by an MLAG pair."
            error={fieldErrors.anycast_ip_id}
          />
          <FormText
            label="Anycast gateway MAC"
            mono
            value={anycastMac}
            onChange={setAnycastMac}
            placeholder="00:00:5e:00:01:01"
            info="The gateway MAC every leaf answers on for the anycast SVIs."
            error={fieldErrors.anycast_gateway_mac}
          />
        </div>
        <div className="grid gap-3 @md:grid-cols-2">
          <FormStatusSelect
            value={statusId}
            onChange={setStatusId}
            options={statuses.data?.results ?? []}
            error={fieldErrors.status_id}
          />
          <FormCheckbox
            label="ARP suppression"
            checked={arpSuppression}
            onChange={setArpSuppression}
            className="self-end"
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
          model="vtep"
          value={customFields}
          onChange={setCustomFields}
        />
      </FormSection>
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Create VTEP"}
      />
    </form>
  )
}

// ─── VNI membership ──────────────────────────────────────────────────────────

export function VTEPMembershipForm({
  item,
  vtep,
  onSaved,
  onCancel,
}: {
  item?: VTEPMembership | null
  vtep: VTEP
  onSaved: (v: VTEPMembership) => void
  onCancel: () => void
}) {
  const isEdit = !!item
  const [l2vpnId, setL2vpnId] = useState<string | null>(item?.l2vpn.id ?? null)
  const [vlanId, setVlanId] = useState<string | null>(item?.vlan?.id ?? null)
  const [rd, setRd] = useState(item?.rd ?? "")
  const [ingress, setIngress] = useState(item?.ingress_replication ?? true)
  const [mcast, setMcast] = useState(item?.mcast_group ?? "")
  const l2vpns = useQuery({
    queryKey: ["l2vpns-picker", "vxlan"],
    queryFn: () => api<Paginated<L2VPN>>("/api/l2vpns/?vxlan=1&page_size=500"),
    staleTime: 60_000,
  })
  const vlans = useQuery({
    queryKey: ["vlans-picker", "site", vtep.site?.id ?? ""],
    queryFn: () =>
      api<Paginated<VLANMini>>(
        `/api/vlans/?picker=1&page_size=500${vtep.site ? `&site=${vtep.site.id}` : ""}`
      ),
    staleTime: 60_000,
  })
  const used = new Set(vtep.memberships.map((m) => m.l2vpn.id))
  const { mutation, fieldErrors } = useRoutingSave<VTEPMembership>({
    objectType: ROUTING_OBJECT_TYPES.vtepmembership,
    endpoint: "/api/routing/vtep-memberships/",
    queryKey: "vteps",
    id: item?.id,
    label: (v) => `VNI ${v.l2vpn.identifier ?? v.l2vpn.name}`,
    onSaved,
  })
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        mutation.mutate({
          vtep_id: vtep.id,
          l2vpn_id: l2vpnId,
          vlan_id: vlanId,
          rd: rd.trim(),
          ingress_replication: ingress,
          mcast_group: mcast.trim(),
        })
      }}
      className="@container grid gap-4"
    >
      <FormSection title="VNI" card>
        <div className="grid gap-3 @md:grid-cols-2">
          <FormCombobox
            label="L2VPN"
            required
            value={l2vpnId}
            onChange={setL2vpnId}
            options={(l2vpns.data?.results ?? [])
              .filter((v) => isEdit || !used.has(v.id))
              .map((v) => ({
                value: v.id,
                label:
                  v.identifier != null
                    ? `${v.identifier} · ${v.name}${v.vrf ? ` · L3 ${v.vrf.name}` : ""}`
                    : v.name,
              }))}
            placeholder="Pick a VNI"
            searchPlaceholder="Search L2VPNs…"
            emptyText="No VXLAN L2VPNs left to add."
            disabled={isEdit}
            error={fieldErrors.l2vpn_id}
          />
          <FormCombobox
            label="VLAN"
            value={vlanId}
            onChange={setVlanId}
            options={(vlans.data?.results ?? []).map((v) => ({
              value: v.id,
              label: `${v.vlan_id} · ${v.name}`,
              color: v.color || undefined,
            }))}
            noneLabel="From the site's termination"
            placeholder="From the site's termination"
            searchPlaceholder="Search VLANs…"
            emptyText="No VLANs at this site."
            info="Only when the leaf maps the VNI to a VLAN the L2VPN's terminations don't name - an L3VNI's device-local VLAN, say."
            error={fieldErrors.vlan_id}
          />
        </div>
        <div className="grid gap-3 @md:grid-cols-2">
          <FormText
            label="RD"
            mono
            value={rd}
            onChange={setRd}
            placeholder="auto"
            info="A per-leaf route distinguisher, when the L2VPN's own doesn't apply."
            error={fieldErrors.rd}
          />
          <FormText
            label="Multicast group"
            mono
            value={mcast}
            onChange={setMcast}
            placeholder="239.1.1.1"
            disabled={ingress}
            error={fieldErrors.mcast_group}
          />
        </div>
        <FormCheckbox
          label="Ingress replication"
          checked={ingress}
          onChange={setIngress}
          info="Head-end replication of BUM traffic; off means the multicast group carries it."
        />
      </FormSection>
      <FormFooter
        onCancel={onCancel}
        submitting={mutation.isPending}
        submitLabel={isEdit ? "Save changes" : "Add VNI"}
      />
    </form>
  )
}
