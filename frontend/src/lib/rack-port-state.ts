import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import type {
  CableMini,
  Interface,
  PortCountRow,
  PortReservationMini,
  RackPortInterface,
  RackPortState,
  VLANMini,
} from "@/lib/api"

/**
 * The rack page's port state (#248): `GET /api/racks/{id}/port-state/`, one
 * request for every port in the rack. The elevation and the Capacity card
 * read the same query; `PORT_COUNT_QUERY_KEYS` holds its key, so anything
 * that moves a port count refreshes it.
 */
export function rackPortStateKey(rackId: string) {
  return ["rack-port-state", rackId] as const
}

export function useRackPortState(rackId: string) {
  return useQuery({
    queryKey: rackPortStateKey(rackId),
    queryFn: () => api<RackPortState>(`/api/racks/${rackId}/port-state/`),
  })
}

/** Ports in use: connected plus reserved, as the Port utilization page
 * counts them. */
export function portsUsed(row: PortCountRow): number {
  return row.connected + row.reserved
}

// Placeholders for what a port-state row reduces to a state or a count. The
// faceplates only ever read a planned cable's status slug, whether a hold
// exists, and how many VLANs a trunk tags.
const PLANNED: NonNullable<CableMini["status"]> = {
  id: "",
  name: "Planned",
  slug: "planned",
  color: "",
  text_color: "",
}
const HELD: PortReservationMini = {
  id: "",
  claimed_by: "",
  note: "",
  created_at: "",
}
const TAGGED: VLANMini = { id: "", vlan_id: 0, name: "" }

/**
 * The `Interface`s the device page's faceplates read, from one device's
 * port-state rows: the same colours (cable state, speed, reserved,
 * disabled), VLAN and trunk marks, labels and hover card as the device
 * page's own interface list gives them. A cable is its id, label and type,
 * with a planned status when the row is reserved; a hold without a cable is
 * a placeholder reservation; the far end is `link_peer`. What the faceplates
 * never read (SNMP links, PoE, LAG settings…) is left empty.
 */
export function rackPortInterfaces(
  device: { id: string; name: string },
  rows: readonly RackPortInterface[]
): Interface[] {
  const owner = { id: device.id, name: device.name }
  return rows.map((r) => ({
    id: r.id,
    device: owner,
    name: r.name,
    label: r.label,
    snmp_name: "",
    snmp_ignore: false,
    type: r.type,
    type_display: r.type_display,
    speed: r.speed,
    mtu: r.mtu,
    enabled: r.enabled,
    status: null,
    mgmt_only: false,
    mark_connected: r.mark_connected,
    combo_group: "",
    custom_fields: {},
    duplex: "",
    poe_mode: "",
    poe_type: "",
    wwn: "",
    mac_address: r.mac_address,
    mac_addresses: [],
    description: r.description,
    mode: r.mode,
    mode_display: "",
    vlan: r.vlan,
    tagged_vlans: Array.from({ length: r.tagged_vlan_count }, () => TAGGED),
    vrf: null,
    tags: r.tags,
    cable: r.cable_id
      ? {
          id: r.cable_id,
          label: r.cable_label,
          type: r.cable_type,
          color: "",
          status: r.cable_state === "reserved" ? PLANNED : null,
        }
      : null,
    cable_count: r.cable_id ? 1 : 0,
    link_peer: r.peer,
    hide_label: r.hide_label,
    label_color: r.label_color,
    reservation: !r.cable_id && r.cable_state === "reserved" ? HELD : null,
    ip_addresses: r.ip_addresses,
    tunnel_terminations: [],
    virtual: false,
    parent: null,
    child_count: 0,
    lag: r.lag ? { ...r.lag, device: owner } : null,
    lag_member_count: 0,
    bridge: null,
    lag_protocol: "",
    lag_protocol_display: "",
    lacp_mode: "",
    lacp_rate: "",
    lag_min_links: null,
    created_at: "",
    updated_at: "",
  }))
}
