import { describe, expect, it } from "vitest"

import type { FloorPlanTile } from "@/lib/api"

import { KIND_ICON, firstIcon, sceneTileIcon, tileIcon } from "./object-icon"

// The icon a placed object draws with: the device's own, its type's (both
// resolved by the server into linked.icon), the tile's own type, the role,
// then its kind's default - in code, nothing seeded.

const tile = (over: Partial<FloorPlanTile> = {}) =>
  ({
    tile_type: null,
    role_type: null,
    linked: {
      kind: "device",
      id: "d1",
      name: "sw1",
      icon: "",
      role: { id: "r", name: "Access", color: "#0ea5e9", icon: "" },
    },
    ...over,
  }) as unknown as FloorPlanTile

const linked = (icon: string, roleIcon: string, kind = "device") =>
  ({
    kind,
    id: "x",
    name: "x",
    icon,
    role: { id: "r", name: "R", color: "#000", icon: roleIcon },
  }) as FloorPlanTile["linked"]

describe("tileIcon", () => {
  it("falls back to the kind's default", () => {
    expect(tileIcon(tile())).toBe("server")
    expect(tileIcon(tile({ linked: linked("", "", "rack") }))).toBe(
      KIND_ICON.rack
    )
    expect(tileIcon(tile({ linked: linked("", "", "cabinet") }))).toBe(
      KIND_ICON.cabinet
    )
  })

  it("takes the role's over the default", () => {
    expect(tileIcon(tile({ linked: linked("", "router") }))).toBe("router")
  })

  it("takes the tile's own type over the role", () => {
    expect(
      tileIcon(
        tile({
          linked: linked("", "router"),
          tile_type: { icon: "cctv" } as FloorPlanTile["tile_type"],
        })
      )
    ).toBe("cctv")
  })

  it("takes the device's (or its type's) over everything", () => {
    expect(
      tileIcon(
        tile({
          linked: linked("shield", "router"),
          tile_type: { icon: "cctv" } as FloorPlanTile["tile_type"],
        })
      )
    ).toBe("shield")
  })

  it("skips a name Lucide does not know", () => {
    expect(tileIcon(tile({ linked: linked("no-such-icon", "router") }))).toBe(
      "router"
    )
    expect(firstIcon(["nope", " wifi "])).toBe("wifi")
  })

  it("has no default for a tile linked to nothing", () => {
    expect(tileIcon(tile({ linked: null }))).toBe("")
  })
})

describe("sceneTileIcon", () => {
  it("keeps the server's pick, else the kind's default", () => {
    expect(sceneTileIcon({ icon: "router", kind: "device" })).toBe("router")
    expect(sceneTileIcon({ icon: "", kind: "rack" })).toBe(KIND_ICON.rack)
    expect(sceneTileIcon({ kind: "other" })).toBe("")
  })
})
