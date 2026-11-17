import { describe, expect, it } from "vitest"

import type { AccessoryType } from "@/lib/api"
import { pluggableFacts, pluggableGroups } from "./transceiver-dialog"

function part(over: Partial<AccessoryType>): AccessoryType {
  return {
    id: "a",
    vendor: "Cisco",
    name: "SFP-10G-SR",
    kind: "transceiver",
    connector: "lc",
    fits: ["10gbase-x-sfpp"],
    parts: ["SFP-10G-SR", "SFP-10G-SR-S"],
    standard: "10GBASE-SR",
    wavelength_nm: 850,
    reach_m: 300,
    cable: null,
    model_url: null,
    pack_import: null,
    hand_edited: [],
    in_use: 0,
    ...over,
  }
}

describe("pluggableFacts", () => {
  it("names the record by the first part number and copies the facts", () => {
    expect(pluggableFacts(part({}))).toEqual({
      partId: "SFP-10G-SR",
      facts: {
        standard: "10GBASE-SR",
        connector: "lc",
        wavelength: "850",
        reach: "300",
      },
    })
  })

  it("maps an MPO receptacle and falls back to the name", () => {
    const f = pluggableFacts(
      part({ connector: "mpo", parts: [], wavelength_nm: null, reach_m: null })
    )
    expect(f.partId).toBe("SFP-10G-SR")
    expect(f.facts).toMatchObject({ connector: "mpo-12", wavelength: "" })
    expect(pluggableFacts(part({ connector: "xyz" })).facts.connector).toBe(
      "other"
    )
  })
})

describe("pluggableGroups", () => {
  it("lists the parts that fit the port first", () => {
    const groups = pluggableGroups(
      [
        part({ id: "lr", name: "SFP-10G-LR" }),
        part({ id: "sx", name: "GLC-SX-MMD", fits: ["1000base-x-sfp"] }),
      ],
      "1000base-x-sfp"
    )
    expect(groups.map((g) => g.label)).toEqual(["Fits this port", "Other"])
    expect(groups[0].options).toEqual([{ value: "sx", label: "GLC-SX-MMD" }])
  })

  it("drops an empty group", () => {
    expect(pluggableGroups([part({})], "10gbase-x-sfpp")).toHaveLength(1)
  })
})
