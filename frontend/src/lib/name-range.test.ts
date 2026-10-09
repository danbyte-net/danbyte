import { describe, expect, it } from "vitest"

import { expandNameRange, hasNameRange } from "./name-range"

describe("expandNameRange", () => {
  it("expands a plain range", () => {
    expect(expandNameRange("Disk[1-3]")).toEqual(["Disk1", "Disk2", "Disk3"])
  })

  it("keeps the start bound's zero padding (#335)", () => {
    expect(expandNameRange("Eth[01-04]")).toEqual([
      "Eth01",
      "Eth02",
      "Eth03",
      "Eth04",
    ])
    expect(expandNameRange("p[08-11]")).toEqual(["p08", "p09", "p10", "p11"])
    expect(expandNameRange("x[0-2]")).toEqual(["x0", "x1", "x2"])
    expect(expandNameRange("Eth[1-10]")).toHaveLength(10)
    expect(expandNameRange("Eth[1-10]")[0]).toBe("Eth1")
  })

  it("treats [n-n] as a range of one (#335)", () => {
    expect(expandNameRange("Eth[5-5]")).toEqual(["Eth5"])
    expect(hasNameRange("Eth[5-5]")).toBe(false)
  })

  it("leaves unusable ranges and plain names alone", () => {
    expect(expandNameRange("a[2-1]")).toEqual(["a[2-1]"])
    expect(expandNameRange("p[1-9999]")).toEqual(["p[1-9999]"])
    expect(expandNameRange("eth0")).toEqual(["eth0"])
  })

  it("keeps text around the range", () => {
    expect(expandNameRange("Te1/{module}/[1-2]")).toEqual([
      "Te1/{module}/1",
      "Te1/{module}/2",
    ])
  })
})
