import { describe, expect, it } from "vitest"

import type { RackPortInterface } from "@/lib/api"
import { cableState } from "@/lib/cable-state"
import { portHex, portState } from "@/lib/faceplate-colors"
import { portsUsed, rackPortInterfaces } from "./rack-port-state"

// The rack's port state (#248) carries each interface's cable reduced to a
// state; the faceplates read whole `Interface`s. The adapter must hand them
// back the same colours and hover the device page's interface list does.

const row = (patch: Partial<RackPortInterface>): RackPortInterface => ({
  id: "i1",
  name: "Gi1/0/1",
  label: "",
  type: "1000base-t",
  type_display: "1000BASE-T (1GE)",
  speed: "1G",
  enabled: true,
  mode: "",
  mark_connected: false,
  cable_state: "free",
  cable_id: null,
  cable_label: "",
  cable_type: "",
  peer: null,
  hide_label: false,
  label_color: "",
  vlan: null,
  tagged_vlan_count: 0,
  lag: null,
  ip_addresses: [],
  description: "",
  mac_address: "",
  mtu: null,
  tags: [],
  ...patch,
})

const SW = { id: "d1", name: "sw-1" }

describe("rackPortInterfaces", () => {
  it("gives each port the cable state the row says", () => {
    const states = [
      row({ cable_state: "free" }),
      row({ cable_state: "connected", cable_id: "c1" }),
      // A planned cable…
      row({ cable_state: "reserved", cable_id: "c2" }),
      // …and a hold on an uncabled port both read reserved.
      row({ cable_state: "reserved" }),
      row({ cable_state: "marked", mark_connected: true }),
    ]
    expect(rackPortInterfaces(SW, states).map((i) => cableState(i))).toEqual([
      "free",
      "connected",
      "reserved",
      "reserved",
      "marked",
    ])
  })

  it("draws a cabled port in its speed tier and a disabled one neutral", () => {
    const [cabled, off] = rackPortInterfaces(SW, [
      row({ cable_state: "connected", cable_id: "c1", speed: "10G" }),
      row({ enabled: false }),
    ])
    expect(portState(cabled)).toBe("fast")
    expect(portHex(cabled)).toBe("#0ea5e9")
    expect(portState(off)).toBe("disabled")
  })

  it("keeps the cable's label and type, the far end, the trunk and the LAG", () => {
    const [i] = rackPortInterfaces(SW, [
      row({
        cable_state: "connected",
        cable_id: "c1",
        cable_label: "L1",
        cable_type: "cat6",
        peer: { device: "sw-2", port: "Gi1/0/1", port_label: "" },
        mode: "tagged",
        tagged_vlan_count: 3,
        lag: { id: "po1", name: "Po1" },
      }),
    ])
    expect(i.cable).toEqual({
      id: "c1",
      label: "L1",
      type: "cat6",
      color: "",
      status: null,
    })
    expect(i.cable_count).toBe(1)
    expect(i.link_peer).toEqual({
      device: "sw-2",
      port: "Gi1/0/1",
      port_label: "",
    })
    expect(i.tagged_vlans).toHaveLength(3)
    expect(i.lag).toEqual({ id: "po1", name: "Po1", device: SW })
    expect(i.device).toEqual(SW)
    expect(i.virtual).toBe(false)
  })

  it("leaves an uncabled port without a cable or a hold", () => {
    const [i] = rackPortInterfaces(SW, [row({})])
    expect(i.cable).toBeNull()
    expect(i.cable_count).toBe(0)
    expect(i.reservation).toBeNull()
  })
})

describe("portsUsed", () => {
  it("counts connected and reserved, as the Port utilization page does", () => {
    expect(
      portsUsed({ total: 48, connected: 30, reserved: 8, free: 10, marked: 2 })
    ).toBe(38)
  })
})
