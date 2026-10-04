import type { DinRail } from "@/lib/api"

import type { ElevationCabinet, PlateDevice } from "../cabinet-svg"
import type { InlinedPhoto } from "../photos"
import { PNG_1PX } from "./rack"

// A 500×600 mm plate in a 560×660 box with four rails: R1 holds a PLC with a
// calibrated photo, a switch with an uncalibrated one and a PSU whose photo
// would not load, leaving a stretch free for its label; R2 two narrow
// modules in their roles' colours, tall enough for their names to run down
// them; R3 is bare; R4 is full, so its label sits over its device. One device
// is in the cabinet but on no rail.

const rail = (
  id: string,
  label: string,
  x_mm: number,
  y_mm: number,
  length_mm: number,
  profile: DinRail["profile"] = "ts35"
): DinRail => ({ id, label, profile, x_mm, y_mm, length_mm })

export const cabinet: ElevationCabinet = {
  name: "K1",
  inner_width_mm: 500,
  inner_height_mm: 600,
  outer_width_mm: 560,
  outer_height_mm: 660,
  site: { name: "Plant 1" },
  location: { name: "Hall B" },
  rails: [
    rail("r1", "R1", 0, 100, 500),
    rail("r2", "R2", 20, 300, 460),
    rail("r4", "R4", 300, 420, 50),
    rail("r3", "R3", 0, 520, 200, "ts15"),
  ],
}

type Type = NonNullable<PlateDevice["device_type"]>

const device = (
  id: string,
  name: string,
  on: DinRail | null,
  offset: number | null,
  type: Partial<Type> & Pick<Type, "width_mm" | "height_mm">,
  role: string | null = null
): PlateDevice => ({
  id,
  name,
  din_rail: on && { id: on.id, label: on.label, profile: on.profile },
  din_offset_mm: offset,
  image_ports: null,
  role: role ? { color: role } : null,
  device_type: {
    din_rail_mm: null,
    front_image: null,
    front_cal: null,
    ...type,
  },
})

const [r1, r2, r4] = cabinet.rails

export const devices: PlateDevice[] = [
  device("d-plc", "plc-1", r1, 0, {
    width_mm: 80,
    height_mm: 120,
    din_rail_mm: 50,
    front_image: "/media/device-type-images/plc.png",
    // The photo is 100 mm wide, the guides on the body's edges.
    front_cal: {
      left: 0.1,
      right: 0.9,
      span_mm: 80,
      rail: 0.45,
      photo_mm: 100,
    },
  }),
  device(
    "d-sw",
    "sw-1",
    r1,
    100,
    {
      width_mm: 45,
      height_mm: 90,
      front_image: "/media/device-type-images/sw.png",
    },
    "#2563eb"
  ),
  device(
    "d-psu",
    "psu-1",
    r1,
    440,
    {
      width_mm: 60,
      height_mm: 100,
      front_image: "/media/device-type-images/psu.png",
    },
    "#0f766e"
  ),
  device("d-mcb", "mcb-1", r2, 0, { width_mm: 18, height_mm: 90 }, "#ef4444"),
  device(
    "d-relay",
    "relay with a long name",
    r2,
    18,
    { width_mm: 18, height_mm: 90 },
    "#fde047"
  ),
  device("d-fuse", "fuse-1", r4, 0, { width_mm: 50, height_mm: 60 }),
  device("d-loose", "loose", null, null, { width_mm: 30, height_mm: 30 }),
]

/** The PLC's photo (twice as tall as wide) and the switch's; the PSU's
 * would not load. */
export const photos: ReadonlyMap<string, InlinedPhoto> = new Map([
  ["/media/device-type-images/plc.png", { src: PNG_1PX, aspect: 2 }],
  ["/media/device-type-images/sw.png", { src: PNG_1PX, aspect: 1.5 }],
])
