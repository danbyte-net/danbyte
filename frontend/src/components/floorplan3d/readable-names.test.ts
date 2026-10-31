import { describe, expect, it } from "vitest"

import { NAME_PX_3D, sceneTileName, screenScale } from "./readable-names"
import type { SceneTile } from "./world"

// Readable in the room: a name's sprite is one size on screen whatever its
// distance (sizeAttenuation off), so its scale depends on the camera's
// field of view and the view's height alone.

describe("screenScale", () => {
  it("is the size at 1 m that projects to the wanted pixels", () => {
    // fov 90: 1 m at 1 m spans half the view height.
    expect(screenScale(500, 90, 1000)).toBeCloseTo(1)
    const s = screenScale(NAME_PX_3D, 50, 900)
    const px = (s * 900) / (2 * Math.tan((50 * Math.PI) / 360))
    expect(px).toBeCloseTo(NAME_PX_3D)
  })

  it("is nothing before the view is measured", () => {
    expect(screenScale(18, 50, 0)).toBe(0)
  })
})

describe("sceneTileName", () => {
  const base = {
    id: "t",
    x: 0,
    y: 0,
    w: 1,
    h: 1,
    orientation: 0,
    status: "",
    label: "",
    kind: "rack",
    color: "",
    is_zone: false,
    rack: null,
  } as SceneTile
  it("names a tile as the plan does: label, then its object, then type", () => {
    expect(sceneTileName({ ...base, label: "North" })).toBe("North")
    expect(
      sceneTileName({
        ...base,
        rack: { name: "R1" } as SceneTile["rack"],
      })
    ).toBe("R1")
    expect(sceneTileName({ ...base, device_name: "sw1" })).toBe("sw1")
    expect(sceneTileName({ ...base, type_name: "Cooling" })).toBe("Cooling")
  })
})
