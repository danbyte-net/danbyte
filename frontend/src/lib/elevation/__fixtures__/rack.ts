import type { InlinedPhoto } from "../photos"
import type { ElevationDevice, ElevationRack } from "../rack-svg"

// A 12U rack with gear on every kind of mount: a full-depth switch with a
// rear photo and a full-depth server without one on the front (their other
// sides on the rear), a shallow patch panel with no role (front only, the
// rack role's stripe), two half-width switches sharing a unit, a shallow UPS
// on the rear only, a full-depth device mounted on the rear (its other side
// on the front), a vertical PDU on the left rail with no channel (both
// faces) and one on the right rail in the rear channel - and an unracked
// device, which no face draws.

export const rack: ElevationRack = {
  name: "R12",
  u_height: 12,
  starting_unit: 1,
  desc_units: false,
  width: 19,
  role: { color: "#64748b" },
  site: { name: "AMS" },
  location: { name: "Hall A" },
  used_units: 8,
}

const type = (
  extra: Partial<NonNullable<ElevationDevice["device_type"]>> = {}
): ElevationDevice["device_type"] => ({
  is_full_depth: true,
  front_image: null,
  rear_image: null,
  ...extra,
})

const device = (
  d: Partial<ElevationDevice> & Pick<ElevationDevice, "id" | "name">
): ElevationDevice => ({
  position: null,
  face: "front",
  rack_side: "",
  rack_width: "full",
  mount: "",
  u_height: 1,
  role: null,
  device_type: type(),
  ...d,
})

export const devices: ElevationDevice[] = [
  device({
    id: "d-core",
    name: "core-sw-01",
    position: 11,
    role: { color: "#2563eb" },
    device_type: type({
      front_image: "/media/device-type-images/switch.png",
      rear_image: "/media/device-type-images/switch-rear.png",
    }),
  }),
  device({
    id: "d-srv",
    name: "srv-01",
    position: 8,
    u_height: 2,
    role: { color: "#16a34a" },
    device_type: type({ front_image: "/media/device-type-images/server.png" }),
  }),
  device({
    id: "d-patch",
    name: "patch-01",
    position: 10,
    device_type: type({ is_full_depth: false }),
  }),
  device({
    id: "d-tor-a",
    name: "tor-a",
    position: 6,
    rack_width: "half",
    rack_side: "left",
    role: { color: "#f59e0b" },
    device_type: type({ front_image: "/media/device-type-images/half.png" }),
  }),
  device({
    id: "d-tor-b",
    name: "tor-b with a rather long name",
    position: 6,
    rack_width: "half",
    rack_side: "right",
    role: { color: "#f59e0b" },
    device_type: type({ front_image: "/media/device-type-images/half.png" }),
  }),
  device({
    id: "d-ups",
    name: "ups-01",
    position: 1,
    u_height: 2,
    face: "rear",
    role: { color: "#fde047" },
    device_type: type({ is_full_depth: false }),
  }),
  device({
    id: "d-rear",
    name: "rear-fan",
    position: 4,
    face: "rear",
    role: { color: "#7c3aed" },
  }),
  device({
    id: "d-pdu-a",
    name: "pdu-a",
    face: "",
    mount: "side_left",
    u_height: 0,
  }),
  device({
    id: "d-pdu-b",
    name: "pdu-b",
    face: "rear",
    mount: "side_right",
    u_height: 0,
  }),
  device({ id: "d-loose", name: "loose", position: null }),
]

/** A real 1×1 PNG, standing in for each photo. */
export const PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

/** The switch's front and rear and the half-width switches' photos; the
 * server's would not load. */
export const photos: ReadonlyMap<string, InlinedPhoto> = new Map([
  ["/media/device-type-images/switch.png", { src: PNG_1PX, aspect: 0.1 }],
  ["/media/device-type-images/switch-rear.png", { src: PNG_1PX, aspect: 0.1 }],
  ["/media/device-type-images/half.png", { src: PNG_1PX, aspect: 0.2 }],
])
