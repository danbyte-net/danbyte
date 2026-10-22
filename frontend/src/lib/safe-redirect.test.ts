import { describe, expect, it } from "vitest"

import { isServerPath, safeRedirect } from "./safe-redirect"

describe("safeRedirect", () => {
  it("keeps a path on this site", () => {
    expect(safeRedirect("/devices?site=a")).toBe("/devices?site=a")
    expect(safeRedirect("/admin/auth/user/")).toBe("/admin/auth/user/")
  })

  it("refuses anything that leaves the site", () => {
    for (const bad of [
      "https://evil.example/",
      "//evil.example/",
      "/\\evil.example/",
      "javascript:alert(1)",
      "admin/",
    ])
      expect(safeRedirect(bad)).toBe("/")
    expect(safeRedirect(undefined)).toBe("/")
  })
})

describe("isServerPath", () => {
  it("knows the pages Django serves", () => {
    expect(isServerPath("/admin/")).toBe(true)
    expect(isServerPath("/django-rq/")).toBe(true)
    expect(isServerPath("/devices")).toBe(false)
  })
})
