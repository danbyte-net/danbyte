import { describe, expect, it } from "vitest"

import { truncationNotice } from "./data-table"

describe("truncationNotice", () => {
  it("says nothing when the table holds the whole list", () => {
    expect(truncationNotice(500, 500)).toBeNull()
    expect(truncationNotice(3, 3)).toBeNull()
    expect(truncationNotice(0, 0)).toBeNull()
  })

  it("names both figures when a page is capped", () => {
    // The reported case: a site with 600 prefixes showed exactly 500 rows
    // and looked complete.
    const msg = truncationNotice(600, 500)
    expect(msg).toContain("500")
    expect(msg).toContain("600")
  })

  it("says nothing when the count is unknown", () => {
    expect(truncationNotice(undefined, 500)).toBeNull()
    expect(truncationNotice(NaN, 500)).toBeNull()
  })
})
