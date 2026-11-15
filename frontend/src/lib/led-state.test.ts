import { describe, expect, it } from "vitest"

import {
  LED_COLORS,
  blinkPhaseOn,
  ledLook,
  ledStateLabel,
  ledStateOf,
  ledsKey,
} from "./led-state"
import type { DeviceLeds } from "./led-state"

const dev: DeviceLeds = {
  leds: { SYS: "green", BEACON: "blue_blink", "port:Te1/0/1": "neutral" },
  bays: { "PS-1": { PS_OK: "red", FAIL: "red" } },
  locate: null,
}

describe("ledLook", () => {
  it("maps each state to a colour and strength", () => {
    expect(ledLook("green")).toEqual({
      base: "green",
      color: LED_COLORS.green,
      strength: 2.5,
      blink: false,
    })
    expect(ledLook("red").color).toBe(LED_COLORS.red)
    expect(ledLook("neutral").strength).toBeLessThan(1)
  })

  it("blinks blinking states, unless motion is reduced", () => {
    expect(ledLook("amber_blink")).toMatchObject({ base: "amber", blink: true })
    expect(ledLook("blue_blink", true)).toMatchObject({
      base: "blue",
      color: LED_COLORS.blue,
      blink: false,
    })
  })

  it("reads anything unknown as off", () => {
    for (const s of [null, undefined, "", "off", "purple", "neutral_blink"])
      expect(ledLook(s)).toEqual({
        base: "off",
        color: null,
        strength: 0,
        blink: false,
      })
  })
})

describe("ledStateOf", () => {
  it("finds chassis and bay lights; a light not named is off", () => {
    expect(ledStateOf(dev, "SYS")).toBe("green")
    expect(ledStateOf(dev, "led:BEACON")).toBe("blue_blink")
    expect(ledStateOf(dev, "PS_OK", "PS-1")).toBe("red")
    expect(ledStateOf(dev, "PS_OK", "PS-0")).toBe("off")
    expect(ledStateOf(dev, "PS_OK")).toBe("off")
    expect(ledStateOf(null, "SYS")).toBe("off")
  })
})

describe("labels, key and clock", () => {
  it("says what a light shows", () => {
    expect(ledStateLabel("amber_blink")).toBe("Amber, blinking")
    expect(ledStateLabel("off")).toBe("Off")
    expect(ledStateLabel("neutral")).toBe("Not shown to you")
  })

  it("keys a payload entry stably", () => {
    const same: DeviceLeds = {
      leds: { "port:Te1/0/1": "neutral", BEACON: "blue_blink", SYS: "green" },
      bays: { "PS-1": { FAIL: "red", PS_OK: "red" } },
      locate: { until: "x", at: null, by: "a" },
    }
    expect(ledsKey(same)).toBe(ledsKey(dev))
    expect(ledsKey({ ...dev, leds: { SYS: "red" } })).not.toBe(ledsKey(dev))
    expect(ledsKey(null)).toBe("")
  })

  it("is on for the first half of each second", () => {
    expect(blinkPhaseOn(10_000)).toBe(true)
    expect(blinkPhaseOn(10_499)).toBe(true)
    expect(blinkPhaseOn(10_500)).toBe(false)
  })
})
