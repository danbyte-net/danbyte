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
  hasPowerData,
  rackPowerDemand,
  rackPowerRatio,
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
