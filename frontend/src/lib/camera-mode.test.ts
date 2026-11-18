// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"

import { CAMERA_MODE_KEY, readCameraMode, setCameraMode } from "./camera-mode"

afterEach(() => {
  setCameraMode("orbit")
  vi.restoreAllMocks()
})

describe("camera mode", () => {
  it("orbits by default and keeps a pick in this browser", () => {
    expect(readCameraMode()).toBe("orbit")
    setCameraMode("pan")
    expect(readCameraMode()).toBe("pan")
    expect(window.localStorage.getItem(CAMERA_MODE_KEY)).toBe("pan")
  })

  it("still switches when storage is blocked", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked")
    })
    setCameraMode("pan")
    expect(readCameraMode()).toBe("pan")
  })
})
