import { afterEach, describe, expect, it, vi } from "vitest"

import { docsUrl } from "./docs"

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("docsUrl", () => {
  it("is same-origin /docs/ in a build, whatever the port (#472)", () => {
    vi.stubEnv("DEV", false)
    vi.stubGlobal("window", { location: new URL("http://server:8080/devices") })
    expect(docsUrl()).toBe("/docs/")
    expect(docsUrl("features/iac-runner/")).toBe("/docs/features/iac-runner/")
  })

  it("points the Vite dev server at Zensical on :8001", () => {
    vi.stubEnv("DEV", true)
    vi.stubGlobal("window", { location: new URL("http://localhost:3000/devices") })
    expect(docsUrl("dcim/devices/")).toBe("http://localhost:8001/dcim/devices/")
  })

  it("adds the directory slash, keeping anchors and files", () => {
    vi.stubEnv("DEV", false)
    expect(docsUrl("/features/iac-runner")).toBe("/docs/features/iac-runner/")
    expect(docsUrl("features/scripts#sandbox")).toBe("/docs/features/scripts/#sandbox")
    expect(docsUrl("stylesheets/extra.css")).toBe("/docs/stylesheets/extra.css")
  })
})
