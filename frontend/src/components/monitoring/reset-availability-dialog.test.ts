import { describe, expect, it } from "vitest"

import {
  canSubmitReset,
  REASON_MAX,
  resetPayload,
} from "./reset-availability-dialog"

describe("resetPayload", () => {
  it("sends only the reason for from now", () => {
    expect(
      resetPayload({
        mode: "reset",
        from: "now",
        day: "",
        reason: " New host ",
      })
    ).toEqual({ reason: "New host" })
  })

  it("sends the day for from a date", () => {
    expect(
      resetPayload({
        mode: "reset",
        from: "date",
        day: "2026-09-01",
        reason: "Reused",
      })
    ).toEqual({ since: "2026-09-01", reason: "Reused" })
  })

  it("clears with a reason, and never a day", () => {
    expect(
      resetPayload({
        mode: "clear",
        from: "date",
        day: "2026-09-01",
        reason: "Wrong address",
      })
    ).toEqual({ clear: true, reason: "Wrong address" })
  })

  it("caps the reason at the column's length", () => {
    const body = resetPayload({
      mode: "reset",
      from: "now",
      day: "",
      reason: "x".repeat(REASON_MAX + 20),
    })
    expect(body.reason).toHaveLength(REASON_MAX)
  })
})

describe("canSubmitReset", () => {
  it("needs a reason", () => {
    expect(canSubmitReset("reset", "now", "", "")).toBe(false)
    expect(canSubmitReset("reset", "now", "", "   ")).toBe(false)
    expect(canSubmitReset("clear", "now", "", "")).toBe(false)
    expect(canSubmitReset("reset", "now", "", "why")).toBe(true)
  })

  it("needs a day when one is asked for", () => {
    expect(canSubmitReset("reset", "date", "", "why")).toBe(false)
    expect(canSubmitReset("reset", "date", "2026-09-01", "why")).toBe(true)
  })
})
