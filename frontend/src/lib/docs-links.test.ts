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
      expect(target.endsWith("/"), target).toBe(true)
      expect(target.startsWith("/"), target).toBe(false)
    }
  })
})
