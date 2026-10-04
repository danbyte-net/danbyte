import { afterEach, describe, expect, it, vi } from "vitest"

import { isApplePlatform, modKey } from "./mod-key"

const as = (nav: Record<string, unknown>) => vi.stubGlobal("navigator", nav)

describe("modKey", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("is the Command key on a Mac", () => {
    as({ platform: "MacIntel", userAgent: "" })
    expect(isApplePlatform()).toBe(true)
    expect(modKey()).toBe("⌘")
    expect(`${modKey()}S`).toBe("⌘S")
  })

  it("is Ctrl+ on Windows and Linux", () => {
    as({ platform: "Win32", userAgent: "" })
    expect(modKey()).toBe("Ctrl+")
    as({ platform: "Linux x86_64", userAgent: "" })
    expect(`${modKey()}S`).toBe("Ctrl+S")
  })

  it("covers iPad and iPhone keyboards", () => {
    as({ platform: "iPad", userAgent: "" })
    expect(modKey()).toBe("⌘")
    as({ platform: "iPhone", userAgent: "" })
    expect(modKey()).toBe("⌘")
  })

  it("prefers userAgentData, then platform, then the UA string", () => {
    as({ userAgentData: { platform: "macOS" }, platform: "Win32" })
    expect(modKey()).toBe("⌘")
    as({ platform: "", userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X)" })
    expect(modKey()).toBe("⌘")
    as({ platform: "", userAgent: "Mozilla/5.0 (X11; Linux x86_64)" })
    expect(modKey()).toBe("Ctrl+")
  })

  it("falls back to Ctrl+ with no navigator (server render)", () => {
    vi.stubGlobal("navigator", undefined)
    expect(isApplePlatform()).toBe(false)
    expect(modKey()).toBe("Ctrl+")
  })
})
