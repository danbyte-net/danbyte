import { describe, expect, it } from "vitest"

import {
  LOOK_DEFAULTS,
  colourHex,
  lookDraft,
  lookLabel,
  lookPayload,
  resolveLook,
} from "./rack-look"

const kit = {
  id: "k1",
  vendor: "Generic",
  name: "CABINET",
  frame: "cabinet" as const,
}

describe("resolveLook", () => {
  it("takes the rack's own value, else its type's, else the default", () => {
    const look = resolveLook(
      { rear_door: "solid", colour: null, kit: null, side_panels: false },
      { front_door: "glass", colour: "grey", kit, rail_depth_mm: 740 }
    )
    expect(look.rear_door).toBe("solid")
    expect(look.front_door).toBe("glass")
    expect(look.colour).toBe("grey")
    expect(look.kit).toBe(kit)
    expect(look.side_panels).toBe(false)
    expect(look.rail_depth_mm).toBe(740)
    expect(look.top).toBe(LOOK_DEFAULTS.top)
    expect(look.inherited).toContain("front_door")
    expect(look.inherited).not.toContain("rear_door")
    expect(look.inherited).not.toContain("side_panels")
  })

  it("draws a rack without a type from the defaults", () => {
    const look = resolveLook(null, null)
    expect(look.frame).toBe("cabinet")
    expect(look.inherited).toHaveLength(11)
  })
})

describe("drafts and payloads", () => {
  it("round-trips a rack's overrides, blanks inheriting", () => {
    const d = lookDraft({
      frame: "4-post",
      side_panels: false,
      kit,
      rail_depth_mm: 700,
    })
    expect(d.side_panels).toBe("no")
    expect(d.kit_id).toBe("k1")
    const p = lookPayload(d)
    expect(p).toMatchObject({
      frame: "4-post",
      side_panels: false,
      kit_id: "k1",
      rail_depth_mm: 700,
      front_door: null,
      blanking_fill: null,
    })
  })
})

describe("labels", () => {
  it("names values for cards and inherit options", () => {
    expect(lookLabel("front_door", "split-perforated")).toBe("Split perforated")
    expect(lookLabel("colour", "grey")).toBe("Grey")
    expect(lookLabel("colour", "#aabbcc")).toBe("#aabbcc")
    expect(lookLabel("kit", kit)).toBe("Generic CABINET")
    expect(lookLabel("blanking_fill", true)).toBe("Yes")
    expect(colourHex("white")).toBe("#f2f2f0")
    expect(colourHex("#123456")).toBe("#123456")
  })
})
