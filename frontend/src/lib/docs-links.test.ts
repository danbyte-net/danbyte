import { describe, expect, it } from "vitest"

import { DOCS_LINKS, docsUrlFor, hasDocsPage } from "./docs-links"

describe("docsUrlFor", () => {
  it("matches a page and its sub-routes by longest prefix", () => {
    expect(docsUrlFor("/devices")).toBe("/docs/dcim/devices/")
    expect(docsUrlFor("/devices/123/edit")).toBe("/docs/dcim/devices/")
    expect(docsUrlFor("/devices/compliance")).toBe("/docs/features/compliance/")
    expect(docsUrlFor("/settings/sso")).toBe("/docs/features/sso/")
    expect(docsUrlFor("/settings/whatever")).toBe("/docs/access/")
  })

  it("maps the dashboard root without swallowing other routes", () => {
    expect(docsUrlFor("/")).toBe("/docs/features/dashboard/")
    expect(docsUrlFor("/login")).toBe("/docs/")
    expect(hasDocsPage("/login")).toBe(false)
  })

  it("every registry target is a normalized docs path", () => {
    for (const [route, target] of Object.entries(DOCS_LINKS)) {
      expect(route.startsWith("/"), route).toBe(true)
      // A page, or a section of one: "page/" or "page/#anchor".
      expect(target, target).toMatch(/\/(#[a-z0-9-]+)?$/)
      expect(target.startsWith("/"), target).toBe(false)
    }
  })

  it("deep-links a page's section", () => {
    expect(docsUrlFor("/virtual-topology")).toBe(
      "/docs/features/virtual-switches/#network-topology"
    )
    expect(docsUrlFor("/virtual-switches")).toBe(
      "/docs/features/virtual-switches/"
    )
  })
})
