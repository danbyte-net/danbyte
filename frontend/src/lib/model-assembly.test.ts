import { describe, expect, it } from "vitest"

import type { ModelBay } from "@/lib/api"

import {
  budgetLevel,
  coverVisibility,
  parseAnchor,
  plannedParts,
  substituteModule,
  wantsFarModel,
} from "./model-assembly"

const bay = (
  name: string,
  part: ModelBay["part"] = null,
  installed = !!part,
  position = "1"
): ModelBay => ({ name, position, installed, part })

describe("parseAnchor", () => {
  it("reads the exact glTF names", () => {
    expect(parseAnchor("bay:FAN 1")).toEqual({ kind: "bay", name: "FAN 1" })
    expect(parseAnchor("port:TwentyFiveGigE1/0/1")).toEqual({
      kind: "port",
      name: "TwentyFiveGigE1/0/1",
    })
    expect(parseAnchor("led:port:Te1/0/1")).toEqual({
      kind: "led",
      name: "port:Te1/0/1",
    })
  })
  it("ignores three's rewritten names and other nodes", () => {
    expect(parseAnchor("bayFAN_1")).toBeNull()
    expect(parseAnchor("Shell")).toBeNull()
    expect(parseAnchor("bay:")).toBeNull()
    expect(parseAnchor("mount:x")).toBeNull()
    expect(parseAnchor(undefined)).toBeNull()
  })
})

describe("substituteModule", () => {
  it("puts the bay's position in every {module}", () => {
    expect(substituteModule("port:Te1/{module}/1", "2")).toBe("port:Te1/2/1")
    expect(substituteModule("{module}/{module}", "3")).toBe("3/3")
  })
  it("leaves the token without a position", () => {
    expect(substituteModule("Te1/{module}/1", "")).toBe("Te1/{module}/1")
  })
})

describe("plannedParts", () => {
  const part = { url: "/near", far_url: "/far" }
  it("poses installed modules with a model in bays the chassis has", () => {
    const bays = [
      bay("PS-0", part, true, "0"),
      bay("PS-1"),
      bay("FAN 1", null, true),
      bay("NM", part),
    ]
    expect(plannedParts(bays, new Set(["PS-0", "PS-1", "FAN 1"]))).toEqual([
      { bay: "PS-0", position: "0", url: "/near" },
    ])
  })
  it("takes the far copy from afar, else the full one", () => {
    const bays = [bay("A", part), bay("B", { url: "/b", far_url: null })]
    expect(
      plannedParts(bays, new Set(["A", "B"]), true).map((p) => p.url)
    ).toEqual(["/far", "/b"])
  })
  it("nothing without bays", () => {
    expect(plannedParts(undefined, new Set(["A"]))).toEqual([])
  })
})

describe("coverVisibility", () => {
  const covers = ["PS-0", "PS-1", "FAN 1", "FAN 9"]
  it("shows every cover as authored without bay data", () => {
    const v = coverVisibility(covers, null, new Set())
    expect([...v.values()].every(Boolean)).toBe(true)
  })
  it("hides covers of drawn bays and bays the device lacks", () => {
    const bays = [
      bay("PS-0", { url: "/u", far_url: null }),
      bay("PS-1"),
      bay("FAN 1", null, true),
    ]
    const v = coverVisibility(covers, bays, new Set(["PS-0"]))
    expect(Object.fromEntries(v)).toEqual({
      "PS-0": false, // a module is drawn there
      "PS-1": true, // empty
      "FAN 1": true, // installed, no model: the cover stands in
      "FAN 9": false, // not one of the device's bays
    })
  })
  it("shows none with empty mode nothing", () => {
    const v = coverVisibility(covers, [bay("PS-1")], new Set(), "nothing")
    expect([...v.values()].some(Boolean)).toBe(false)
  })
})

describe("budgetLevel", () => {
  it("assembled, then chassis alone, then the box", () => {
    expect(budgetLevel(100, [20, 20], 1000, 500)).toBe("assembled")
    expect(budgetLevel(100, [20, 20], 130, 500)).toBe("chassis")
    expect(budgetLevel(100, [450], 1000, 500)).toBe("chassis")
    expect(budgetLevel(100, [], 50, 500)).toBe("box")
    expect(budgetLevel(600, [], 1000, 500)).toBe("box")
  })
})

describe("wantsFarModel", () => {
  it("switches with a gap", () => {
    expect(wantsFarModel(12, false)).toBe(false)
    expect(wantsFarModel(15, false)).toBe(true)
    expect(wantsFarModel(12, true)).toBe(true)
    expect(wantsFarModel(10, true)).toBe(false)
  })
})
