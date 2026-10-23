import { afterEach, describe, expect, it } from "vitest"

import {
  CAPACITY_HEX,
  capacityBandLabel,
  capacityThresholds,
  powerSupplyNote,
  setCapacityThresholds,
  CAPACITY_NONE_HEX,
  capacityColor,
  capacityLevel,
  capacityRatio,
  formatWatts,
  hasCoolingData,
  hasPowerData,
  kwToWatts,
  rackCoolingDemand,
  rackCoolingRatio,
  rackPowerDemand,
  rackPowerRatio,
  wattsToKw,
} from "./rack-capacity"

const power = (
  available_w: number,
  allocated_w: number,
  maximum_w: number
) => ({
  available_w,
  allocated_w,
  maximum_w,
})

describe("capacity scale", () => {
  it("warns above 80 % and is critical above 95 %, as documented", () => {
    expect(capacityLevel(0)).toBe("good")
    expect(capacityLevel(0.8)).toBe("good")
    expect(capacityLevel(0.81)).toBe("warn")
    expect(capacityLevel(0.95)).toBe("warn")
    expect(capacityLevel(0.951)).toBe("critical")
    expect(capacityLevel(1.4)).toBe("critical")
  })

  it("colours by status, never the accent", () => {
    expect(capacityColor(0.5)).toBe(CAPACITY_HEX.good)
    expect(capacityColor(0.9)).toBe(CAPACITY_HEX.warn)
    expect(capacityColor(1)).toBe(CAPACITY_HEX.critical)
    expect(Object.values(CAPACITY_HEX)).toEqual([
      "#10b981",
      "#f59e0b",
      "#ef4444",
    ])
    // Nothing to measure against: the neutral grey, not green.
    expect(capacityColor(null)).toBe(CAPACITY_NONE_HEX)
    expect(capacityColor(Number.NaN)).toBe(CAPACITY_NONE_HEX)
  })

  it("has no ratio without a total", () => {
    expect(capacityRatio(30, 42)).toBeCloseTo(0.714, 3)
    expect(capacityRatio(5, 0)).toBeNull()
    expect(capacityRatio(5, -1)).toBeNull()
    // A 42U rack with 40U used is past 95 % - the old rounded-percent cell
    // called it 95 % and amber, the floor plan red. One rule now.
    expect(capacityLevel(capacityRatio(40, 42)!)).toBe("critical")
  })
})

describe("formatWatts", () => {
  it("keeps three significant figures", () => {
    expect(formatWatts(0)).toBe("0 W")
    expect(formatWatts(850)).toBe("850 W")
    expect(formatWatts(999.4)).toBe("999 W")
    expect(formatWatts(999.6)).toBe("1 kW")
    expect(formatWatts(1_000)).toBe("1 kW")
    expect(formatWatts(3_600)).toBe("3.6 kW")
    expect(formatWatts(12_345)).toBe("12.3 kW")
    expect(formatWatts(123_456)).toBe("123 kW")
    expect(formatWatts(999_600)).toBe("1 MW")
    expect(formatWatts(1_250_000)).toBe("1.25 MW")
    expect(formatWatts(Number.NaN)).toBe("")
  })
})

describe("rack power", () => {
  it("takes the allocated draw as demand, else the nameplate sum", () => {
    expect(rackPowerDemand(power(3_600, 1_200, 2_000))).toEqual({
      watts: 1_200,
      nameplate: false,
    })
    expect(rackPowerDemand(power(3_600, 0, 2_000))).toEqual({
      watts: 2_000,
      nameplate: true,
    })
    expect(rackPowerDemand(power(3_600, 0, 0))).toEqual({
      watts: 0,
      nameplate: false,
    })
  })

  it("measures demand against the feeds, and nothing without one", () => {
    expect(rackPowerRatio(power(4_000, 1_000, 0))).toBe(0.25)
    expect(rackPowerRatio(power(4_000, 0, 5_000))).toBe(1.25)
    expect(rackPowerRatio(power(0, 1_000, 2_000))).toBeNull()
  })

  it("has data when anything is known", () => {
    expect(hasPowerData(power(0, 0, 0))).toBe(false)
    expect(hasPowerData(null)).toBe(false)
    expect(hasPowerData(undefined)).toBe(false)
    expect(hasPowerData(power(3_600, 0, 0))).toBe(true)
    expect(hasPowerData(power(0, 0, 500))).toBe(true)
  })
})

describe("tenant capacity levels", () => {
  afterEach(() => setCapacityThresholds(null))

  it("defaults to 80 / 95", () => {
    expect(capacityThresholds()).toEqual({ warn: 0.8, critical: 0.95 })
    expect(capacityBandLabel("warn")).toBe("80–95%")
  })

  it("moves every level to the tenant's percentages", () => {
    setCapacityThresholds({ warn: 60, critical: 85 })
    expect(capacityLevel(0.6)).toBe("good")
    expect(capacityLevel(0.61)).toBe("warn")
    expect(capacityLevel(0.86)).toBe("critical")
    expect(capacityColor(0.7)).toBe(CAPACITY_HEX.warn)
    expect(capacityBandLabel("good")).toBe("≤ 60%")
    expect(capacityBandLabel("warn")).toBe("60–85%")
    expect(capacityBandLabel("critical")).toBe("> 85%")
  })

  it("keeps the defaults for levels out of order", () => {
    setCapacityThresholds({ warn: 90, critical: 90 })
    expect(capacityThresholds()).toEqual({ warn: 0.8, critical: 0.95 })
  })
})

describe("power budget", () => {
  it("names a budget as the supply", () => {
    expect(
      powerSupplyNote({ ...power(5_000, 1_000, 0), supply: "budget" })
    ).toBe("budget")
    expect(
      powerSupplyNote({ ...power(5_000, 1_000, 0), supply: "pdu_rating" })
    ).toBe("PDU rating")
    expect(powerSupplyNote({ ...power(5_000, 1_000, 0), supply: "feed" })).toBe(
      ""
    )
  })

  it("measures demand against the budget", () => {
    expect(
      rackPowerRatio({ ...power(2_000, 1_500, 0), supply: "budget" })
    ).toBe(0.75)
  })
})

describe("kW in a form", () => {
  it("shows watts as kW exactly, so an unchanged save writes the same", () => {
    expect(wattsToKw(12_500)).toBe("12.5")
    expect(wattsToKw(40_000)).toBe("40")
    expect(wattsToKw(12_345)).toBe("12.345")
    expect(wattsToKw(null)).toBe("")
    expect(wattsToKw(undefined)).toBe("")
    for (const w of [1, 999, 12_345, 40_000, 1_234_567])
      expect(kwToWatts(wattsToKw(w))).toBe(w)
  })

  it("reads kW back as whole watts", () => {
    expect(kwToWatts("12.5")).toBe(12_500)
    expect(kwToWatts(" 7,4 ")).toBe(7_400)
    expect(kwToWatts("0.0004")).toBe(0)
    expect(kwToWatts("")).toBeNull()
    expect(kwToWatts("lots")).toBeNull()
  })

  it("formats a cooling figure as power's, in kW from 1 kW up", () => {
    expect(formatWatts(9_999)).toBe("10 kW")
    expect(formatWatts(12_500)).toBe("12.5 kW")
  })
})

describe("rack cooling (#434)", () => {
  const heat = (
    available_w: number,
    heat_allocated_w: number,
    heat_maximum_w: number
  ) => ({
    available_w,
    heat_allocated_w,
    heat_maximum_w,
    supply: available_w > 0 ? ("budget" as const) : null,
    mismatched: 0,
  })

  it("takes the allocated heat, else the nameplate sum", () => {
    expect(rackCoolingDemand(heat(10_000, 3_000, 5_000))).toEqual({
      watts: 3_000,
      nameplate: false,
    })
    expect(rackCoolingDemand(heat(10_000, 0, 5_000))).toEqual({
      watts: 5_000,
      nameplate: true,
    })
  })

  it("measures heat against the capacity, and nothing without one", () => {
    expect(rackCoolingRatio(heat(10_000, 9_000, 0))).toBe(0.9)
    expect(rackCoolingRatio(heat(0, 9_000, 0))).toBeNull()
    expect(capacityLevel(rackCoolingRatio(heat(10_000, 9_600, 0))!)).toBe(
      "critical"
    )
  })

  it("has data when anything is known", () => {
    expect(hasCoolingData(heat(0, 0, 0))).toBe(false)
    expect(hasCoolingData(undefined)).toBe(false)
    expect(hasCoolingData(heat(10_000, 0, 0))).toBe(true)
    expect(hasCoolingData(heat(0, 0, 300))).toBe(true)
  })
})
