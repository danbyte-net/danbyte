import { describe, expect, it } from "vitest"

import {
  PLUG_DEFAULT_COLOR,
  PLUG_NODE,
  pluggedNames,
  plugColor,
  plugGroups,
  plugsByUrl,
  plugsKey,
  portTransceivers,
  shownMeshes,
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

  it("keys a port that lost its cable apart", () => {
    const a = [plug("Te1/0/1")]
    expect(plugsKey({ plugs: a })).not.toBe(
      plugsKey({ plugs: [plug("Te1/0/1", { cabled: false })] })
    )
    // An older payload without `cabled` reads as cabled.
    expect(plugsKey({ plugs: a })).toBe(
      plugsKey({ plugs: [plug("Te1/0/1", { cabled: true })] })
    )
  })

  it("groups by part and cabled-ness", () => {
    const list = [
      plug("Te1/0/1"),
      plug("Te1/0/2", { cabled: false }),
      plug("Te1/0/3", { cabled: true }),
    ]
    expect(
      plugGroups(list).map((g) => [g.cabled, g.plugs.map((p) => p.port)])
    ).toEqual([
      [true, ["Te1/0/1", "Te1/0/3"]],
      [false, ["Te1/0/2"]],
    ])
  })

  it("draws a transceiver body without its plug while uncabled", () => {
    const body = { name: "Body", inPlug: false }
    const lc = { name: "LC", inPlug: true }
    expect(shownMeshes([body, lc], true)).toEqual([body, lc])
    expect(shownMeshes([body, lc], false)).toEqual([body])
    // One piece (a DAC, a generic plug): nothing without a cable.
    expect(shownMeshes([body], false)).toEqual([])
    expect(["plug", "Plug", "plug.001"].every((n) => PLUG_NODE.test(n))).toBe(
      true
    )
    expect(PLUG_NODE.test("plugin")).toBe(false)
  })

  it("names the recorded transceivers by port", () => {
    const t = { part_id: "SFP-10G-SR", serial: "FNS1" }
    const map = portTransceivers({
      plugs: [plug("Te1/0/1", { transceiver: t }), plug("Te1/0/2")],
    })
    expect([...map]).toEqual([["Te1/0/1", t]])
  })
})
