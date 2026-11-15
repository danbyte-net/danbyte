import { describe, expect, it } from "vitest"

import { bayMenuItems, portMenuItems } from "./model-viewer-menus"
import type { BayPerms, PortPerms } from "./model-viewer-menus"

// The 3D viewer's right-click menus: what each port and bay state offers,
// and what each permission takes away.

const ALL: PortPerms = {
  connect: true,
  disconnect: true,
  reserve: true,
  editPort: true,
}
const NONE: PortPerms = {
  connect: false,
  disconnect: false,
  reserve: false,
  editPort: false,
}

const iface = (over: Record<string, unknown> = {}) => ({
  id: "i1",
  kind: "interface" as const,
  connected: false,
  cable_id: null as string | null,
  cable_state: "free",
  ...over,
})

const actions = (items: { action: string }[]) => items.map((i) => i.action)

describe("portMenuItems", () => {
  it("offers a free port connect, reserve, mark and edit", () => {
    expect(actions(portMenuItems(iface(), ALL))).toEqual([
      "open",
      "connect",
      "reserve",
      "mark",
      "edit",
    ])
  })

  it("offers a cabled port trace and disconnect", () => {
    const items = portMenuItems(
      iface({ connected: true, cable_id: "c1", cable_state: "connected" }),
      ALL
    )
    expect(actions(items)).toEqual(["open", "trace", "disconnect", "edit"])
    expect(items.find((i) => i.action === "disconnect")?.destructive).toBe(true)
  })

  it("names a held port's reservation and a marked port's mark", () => {
    const held = portMenuItems(iface({ cable_state: "reserved" }), ALL)
    expect(held.find((i) => i.action === "reserve")?.label).toBe("Reservation…")
    const marked = portMenuItems(iface({ cable_state: "marked" }), ALL)
    expect(actions(marked)).toEqual(["open", "mark", "edit"])
    expect(marked.find((i) => i.action === "mark")?.label).toBe("Clear mark")
  })

  it("shows only what the user may do", () => {
    expect(actions(portMenuItems(iface(), NONE))).toEqual(["open"])
    const cabled = iface({ connected: true, cable_id: "c1" })
    expect(actions(portMenuItems(cabled, NONE))).toEqual(["open", "trace"])
    // A held port still shows its hold to someone who can't add one.
    expect(
      actions(portMenuItems(iface({ cable_state: "reserved" }), NONE))
    ).toEqual(["open", "reserve"])
  })

  it("keeps edit and mark to the kinds that have them", () => {
    const power = iface({ kind: "power_port" })
    expect(actions(portMenuItems(power, ALL))).toEqual([
      "open",
      "connect",
      "reserve",
    ])
    expect(portMenuItems(power, ALL)[0].label).toBe("Open on device")
  })

  it("offers nothing on a marker with no port", () => {
    expect(portMenuItems(iface({ id: null }), ALL)).toEqual([])
  })
})

const BAY_ALL: BayPerms = { install: true, change: true, remove: true }
const BAY_NONE: BayPerms = { install: false, change: false, remove: false }
const seated = {
  module: {
    id: "m1",
    module_type: { id: "t1", name: "C9K-PWR-650WAC-R" },
    status: null,
    serial_number: "ABC",
  },
}

describe("bayMenuItems", () => {
  it("offers an installed module open, edit, replace and remove", () => {
    const items = bayMenuItems(seated, BAY_ALL)
    expect(actions(items)).toEqual(["open", "edit", "replace", "remove"])
    expect(items.at(-1)?.destructive).toBe(true)
  })

  it("offers an empty bay install", () => {
    expect(actions(bayMenuItems({ module: null }, BAY_ALL))).toEqual([
      "install",
    ])
  })

  it("follows module add / change / delete", () => {
    expect(actions(bayMenuItems(seated, BAY_NONE))).toEqual(["open"])
    expect(
      actions(bayMenuItems(seated, { ...BAY_NONE, remove: true }))
    ).toEqual(["open", "remove"])
    expect(
      actions(bayMenuItems(seated, { ...BAY_NONE, change: true }))
    ).toEqual(["open", "edit", "replace"])
    expect(bayMenuItems({ module: null }, BAY_NONE)).toEqual([])
    // A bay the device doesn't list.
    expect(bayMenuItems(null, BAY_ALL)).toEqual([])
  })
})
