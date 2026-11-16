import { describe, expect, it } from "vitest"

import {
  PLUG_DEFAULT_COLOR,
  pluggedNames,
  plugColor,
  plugsByUrl,
  plugsKey,
} from "./port-plugs"
import type { PortPlug } from "./port-plugs"

const plug = (port: string, over: Partial<PortPlug> = {}): PortPlug => ({
  port,
  bay: null,
  name: port,
  url: "/api/accessory-types/a/model/?v=1",
  color: null,
  ...over,
})

describe("port plugs", () => {
  it("colours a plug from its cable, grey without one", () => {
    expect(plugColor("#FF0000")).toBe("#ff0000")
    expect(plugColor(null)).toBe(PLUG_DEFAULT_COLOR)
    expect(plugColor("red")).toBe(PLUG_DEFAULT_COLOR)
  })

  it("keys the same plugs the same in any order", () => {
    const a = [plug("Gi1/0/1"), plug("Gi1/0/2", { color: "#00ff00" })]
    expect(plugsKey({ plugs: a })).toBe(plugsKey({ plugs: [...a].reverse() }))
    expect(plugsKey({ plugs: a })).not.toBe(plugsKey({ plugs: a.slice(1) }))
    expect(plugsKey(null)).toBe("")
  })

  it("names the plugged ports and groups plugs by part", () => {
    const sfp = "/api/accessory-types/b/model/?v=1"
    const list = [
      plug("Gi1/0/1"),
      plug("Te1/{module}/1", { bay: "NM", name: "Te1/1/1", url: sfp }),
      plug("Gi1/0/2"),
    ]
    expect([...pluggedNames({ plugs: list })].sort()).toEqual([
      "Gi1/0/1",
      "Gi1/0/2",
      "Te1/1/1",
    ])
    const groups = plugsByUrl(list)
    expect([...groups.keys()]).toEqual([list[0].url, sfp])
    expect(groups.get(list[0].url)!.map((p) => p.port)).toEqual([
      "Gi1/0/1",
      "Gi1/0/2",
    ])
  })
})
