import { describe, expect, it } from "vitest"

import { watchScope } from "./notify-me-button"

describe("watchScope", () => {
  it("names the one scope the server accepts", () => {
    expect(watchScope("p1")).toEqual({ prefix: "p1" })
    expect(watchScope(undefined, "ip1")).toEqual({ ip: "ip1" })
    // A device page used to send an empty ip and be refused.
    expect(watchScope(undefined, undefined, "d1")).toEqual({ device: "d1" })
  })

  it("is null with nothing to watch", () => {
    expect(watchScope()).toBeNull()
  })
})
