import { describe, expect, it } from "vitest"

import { FIBRE_COLOURS as C, NEUTRAL } from "./fibre-colours"
import {
  PLUG_DEFAULT_COLOR,
  RECOLOURED_MATERIALS,
  plugColours,
  pluggedNames,
  plugsKey,
  plugUrls,
  portTransceivers,
  receptacleNames,
} from "./port-plugs"
import type { PortPlug } from "./port-plugs"

const SFP = {
  url: "/api/accessory-types/sfp/model/?v=1",
  kind: "transceiver",
  connector: "lc",
}
const LC = {
  url: "/api/accessory-types/lc/model/?v=1",
  kind: "plug",
  connector: "lc",
  cable: {
    profile: "zipcord" as const,
    jacket_mm: 1.8,
    pitch_mm: 1.84,
    min_bend_mm: 30,
  },
}

const plug = (port: string, over: Partial<PortPlug> = {}): PortPlug => ({
  port,
  bay: null,
  name: port,
  color: null,
  cabled: true,
  cable_type: "",
  port_type: "10gbase-x-sfpp",
  transceiver: null,
  transceiver_part: SFP,
  cord_part: LC,
  ...over,
})

describe("port plugs", () => {
  it("keys the same plugs the same in any order, and a change apart", () => {
    const a = [plug("Te1/0/1"), plug("Te1/0/2", { color: "#00ff00" })]
    expect(plugsKey({ plugs: a })).toBe(plugsKey({ plugs: [...a].reverse() }))
    expect(plugsKey({ plugs: a })).not.toBe(plugsKey({ plugs: a.slice(1) }))
    // The cable leaving the port drops the cord.
    expect(
      plugsKey({ plugs: [plug("Te1/0/1", { cord_part: null })] })
    ).not.toBe(plugsKey({ plugs: [plug("Te1/0/1")] }))
    expect(plugsKey(null)).toBe("")
  })

  it("names the ports a part sits in, not a record drawing nothing", () => {
    const list = [
      plug("Te1/0/1"),
      plug("Te1/{module}/1", { bay: "NM", name: "Te1/1/1", cord_part: null }),
      plug("Te1/0/3", {
        transceiver_part: null,
        cord_part: null,
        transceiver: { part_id: "SFP-H10GB-CU3M", serial: "X" },
      }),
    ]
    expect([...pluggedNames({ plugs: list })].sort()).toEqual([
      "Te1/0/1",
      "Te1/1/1",
    ])
    expect([...portTransceivers({ plugs: list }).keys()]).toEqual(["Te1/0/3"])
    expect(plugUrls(list)).toEqual([SFP.url, LC.url])
  })

  it("colours each channel from the cable and the port", () => {
    expect(plugColours(plug("F1", { cable_type: "smf-os2" }))).toEqual({
      cable: NEUTRAL,
      fibre: C.yellow,
      lc: C.blue,
      band: NEUTRAL,
    })
    expect(plugColours(plug("S1", { end: "a" })).band).toBe(C.yellow)
    expect(plugColours(plug("S2", { end: "b" })).band).toBe(C.green)
    expect(
      plugColours(
        plug("F1", { cable_type: "smf-os2", port_type: "lc-apc-duplex" })
      ).lc
    ).toBe(C.green)
    expect(plugColours(plug("G1", { color: "#FF0000" })).cable).toBe("#ff0000")
    expect(PLUG_DEFAULT_COLOR).toBe(NEUTRAL)
    expect([...RECOLOURED_MATERIALS].sort()).toEqual([
      "CABLE",
      "END_BAND",
      "FIBRE",
      "LC_BODY",
    ])
  })

  it("looks for the cord's connector on the transceiver first", () => {
    expect(receptacleNames(plug("Q1"))).toEqual(["lc"])
    expect(
      receptacleNames(
        plug("Q1", {
          transceiver_part: { ...SFP, connector: "mpo" },
          cord_part: { ...LC, connector: "mpo-12" },
        })
      )
    ).toEqual(["mpo-12", "mpo"])
    expect(receptacleNames(plug("Q1", { cord_part: null }))).toEqual(["lc"])
  })
})
