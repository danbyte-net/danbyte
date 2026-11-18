import { describe, expect, it } from "vitest"

import { doorKey, isDoorOpen, shutAllDoors, toggleDoor } from "./door-state"

describe("door state", () => {
  it("opens and shuts a viewer's doors by rack, side and leaf", () => {
    shutAllDoors()
    const k = doorKey("r1", "front", 1)
    expect(k).toBe("r1:front:1")
    toggleDoor(k)
    expect(isDoorOpen(k)).toBe(true)
    expect(isDoorOpen(doorKey("r1", "front", 0))).toBe(false)
    toggleDoor(k)
    expect(isDoorOpen(k)).toBe(false)
    toggleDoor(k)
    shutAllDoors()
    expect(isDoorOpen(k)).toBe(false)
  })
})
