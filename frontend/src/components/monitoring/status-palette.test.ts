import { describe, expect, it } from "vitest"

import { STATUS_COLOR, STATUS_LABEL, STATUS_TEXT } from "./charts"
import { statusColor, statusLabel, statusTextColor } from "./status-palette"

const CRITICAL = {
  down: {
    id: "1",
    name: "Critical",
    color: "#dc2626",
    text_color: "#fff",
  },
}

describe("status palette", () => {
  it("uses the shipped name and colour when nothing is claimed", () => {
    expect(statusLabel("down", {})).toBe(STATUS_LABEL.down)
    expect(statusColor("down", {})).toBe(STATUS_COLOR.down)
    expect(statusTextColor("down", {})).toBe(STATUS_TEXT.down)
  })

  it("uses the tenant's name and colour for a claimed state", () => {
    expect(statusLabel("down", CRITICAL)).toBe("Critical")
    expect(statusColor("down", CRITICAL)).toBe("#dc2626")
    expect(statusTextColor("down", CRITICAL)).toBe("#fff")
  })

  it("leaves the states nobody claimed alone", () => {
    expect(statusLabel("up", CRITICAL)).toBe(STATUS_LABEL.up)
    expect(statusColor("up", CRITICAL)).toBe(STATUS_COLOR.up)
  })

  it("keeps the shipped colour for a status that has none", () => {
    const named = {
      degraded: { id: "2", name: "Warning", color: "", text_color: "" },
    }
    expect(statusLabel("degraded", named)).toBe("Warning")
    // A status with no colour of its own is a rename, not a repaint - and
    // taking its empty text colour would put white on white.
    expect(statusColor("degraded", named)).toBe(STATUS_COLOR.degraded)
    expect(statusTextColor("degraded", named)).toBe(STATUS_TEXT.degraded)
  })
})
