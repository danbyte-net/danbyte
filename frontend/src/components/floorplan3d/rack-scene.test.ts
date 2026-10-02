import { describe, expect, it } from "vitest"

import { isReserved } from "./device-mesh"
import {
  OBJECT_VIEWS,
  SOLO_PLAN,
  fitDistance,
  objectViewpoint,
  soloTile,
} from "./object-view"
import {
  cellToWorld,
  deviceBoxM,
  rackFootprintM,
  rackViewpoint,
  sideStripBoxM,
  syntheticPortMarkers,
} from "./world"
import type { SceneDevice, SceneRack } from "./world"

// One rack in 3D on its page. GET /api/racks/{id}/scene/ answers the same
// object a rack tile carries in a floor plan's scene (`rack_geo` with its
// `device_geo` list); the fixture below is that shape, key for key.

const device = (patch: Partial<SceneDevice>): SceneDevice => ({
  id: "d",
  name: "dev",
  position: 1,
  vc_position: null,
  face: "front",
  rack_side: "",
  mount: "",
  mount_offset_mm: null,
  mount_span_u: null,
  u_height: 1,
  rack_width: "full",
  is_full_depth: true,
  port_labels: "",
  airflow: "front-to-rear",
  role_color: "#2563eb",
  role_name: "Access",
  device_type: "Switch 48",
  status: { name: "Active", color: "#10b981" },
  primary_ip: null,
  serial_number: "",
  front_image: "/media/devicetype-images/switch-front.png",
  rear_image: null,
  has_faceplate: true,
  image_ports: {
    front: [
      { kind: "interface", name: "Gi1/0/1", x: 0.1, y: 0.5, w: 0.02, h: 0.3 },
    ],
    rear: [],
  },
  power_ports: ["PSU1"],
  power_outlets: [],
  power_legs: {},
  power_feed_type: "",
  ...patch,
})

/** DCT-B03-like: 42U, a switch at the top, a server, and a PDU on the rear
 * left rail. */
const rack: SceneRack = {
  id: "016871d8-dc59-45ed-b09e-4cd80485b61c",
  name: "DCT-B03",
  u_height: 42,
  starting_unit: 1,
  desc_units: false,
  width: 19,
  outer_width_mm: 800,
  outer_depth_mm: 1200,
  devices: [
    device({ id: "sw", name: "dct-b03-sw1", position: 42 }),
    device({
      id: "srv",
      name: "dct-b03-srv1",
      position: 20,
      u_height: 2,
      device_type: "Server 2U",
      image_ports: null,
    }),
    device({
      id: "pdu",
      name: "dct-b03-pdu-a",
      position: null,
      face: "rear",
      mount: "side_left",
      mount_offset_mm: 100,
      mount_span_u: 36,
      u_height: 0,
      role_color: "#f59e0b",
      role_name: "PDU",
      image_ports: null,
      power_ports: ["Inlet"],
      power_outlets: ["Outlet 1", "Outlet 2"],
      power_legs: { "Outlet 1": "A", "Outlet 2": "B" },
      power_feed_type: "primary",
    }),
  ],
}

describe("a rack on its own", () => {
  const tile = soloTile(rack.id, { rack })
  const { width, height, depth } = rackFootprintM(rack)

  it("stands on the origin, its front to −Z, at its own size", () => {
    expect(
      cellToWorld(SOLO_PLAN, tile.x + tile.w / 2, tile.y + tile.h / 2)
    ).toEqual([0, 0])
    expect(tile.kind).toBe("rack")
    expect(width).toBeCloseTo(0.8)
    expect(depth).toBeCloseTo(1.2)
    expect(height).toBeGreaterThan(42 * 0.04445)
  })

  it("opens framed whole, from the front-right and above", () => {
    const dist = fitDistance({ width, height, depth })
    const { angle } = OBJECT_VIEWS
    const { position } = objectViewpoint(height, dist, angle.yaw, angle.pitch)
    expect(position[2]).toBeLessThan(-depth / 2)
    expect(position[0]).toBeLessThan(0)
    // Close enough that every device keeps the room's near tier, which
    // starts 10 m off the cabinet's surface.
    expect(dist * 2).toBeLessThan(10 + Math.hypot(width, height, depth) / 2)
  })

  it("looks at the front from where a double-click on it flies to", () => {
    const dist = fitDistance({ width, height, depth })
    const front = objectViewpoint(height, dist, 0, 0.08)
    const fly = rackViewpoint(SOLO_PLAN, tile, height, "front")
    expect(Math.sign(front.position[2])).toBe(Math.sign(fly.position[2]))
    const rear = rackViewpoint(SOLO_PLAN, tile, height, "rear")
    expect(rear.position[2]).toBeGreaterThan(0)
  })

  it("places its gear as the room does", () => {
    const sw = deviceBoxM(rack, rack.devices[0], width, depth)
    // U42 of 42 sits at the top of the rail space.
    expect(sw.y + sw.h).toBeCloseTo(height - 0.03, 2)
    // The PDU hangs on its rail for its 36 U span.
    const pdu = sideStripBoxM(rack, rack.devices[2], width, depth)
    expect(pdu.h).toBeCloseTo(36 * 0.04445)
    // Its outlets are clickable quads even with no photo to mark them.
    expect(syntheticPortMarkers(rack.devices[2]).map((m) => m.name)).toEqual([
      "Inlet",
      "Outlet 1",
      "Outlet 2",
    ])
  })
})

describe("isReserved", () => {
  it("marks a port held for a cable that is not there yet", () => {
    expect(isReserved({ connected: false, cable_state: "reserved" })).toBe(true)
  })

  it("leaves a planned cable on the port to draw as cabled, as in 2D", () => {
    expect(isReserved({ connected: true, cable_state: "reserved" })).toBe(false)
  })

  it("is false for a free or a marked port, and for no port", () => {
    expect(isReserved({ connected: false, cable_state: "free" })).toBe(false)
    expect(isReserved({ connected: false, cable_state: "marked" })).toBe(false)
    expect(isReserved(null)).toBe(false)
    expect(isReserved(undefined)).toBe(false)
  })
})
