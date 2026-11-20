import { describe, expect, it } from "vitest"

import { plainDescription } from "./description-links"

describe("plainDescription", () => {
  it("empties a description that is only links", () => {
    expect(
      plainDescription(
        "[Cisco Catalyst 9200 Series Switches Data Sheet](https://www.cisco.com/c/x.html)"
      )
    ).toBe("")
    expect(
      plainDescription(
        '- [A](https://a.example.com/1)\n- [B](https://b.example.com/2 "B")'
      )
    ).toBe("")
    expect(
      plainDescription(
        "1. [A](https://a.example.com) | <https://b.example.com>"
      )
    ).toBe("")
  })

  it("keeps the label of a link mid-sentence", () => {
    expect(
      plainDescription(
        "See the [data   sheet](https://a.example.com/x)  for  the  PSU."
      )
    ).toBe("See the data sheet for the PSU.")
  })

  it("reads parentheses inside a URL", () => {
    expect(
      plainDescription("Read [this](https://en.example.org/wiki/A_(b)) first.")
    ).toBe("Read this first.")
  })

  it("shows an autolink as its URL", () => {
    expect(plainDescription("Docs: <https://a.example.com/d>")).toBe(
      "Docs: https://a.example.com/d"
    )
  })

  it("leaves plain text, images and other schemes alone", () => {
    expect(plainDescription("48-port  switch")).toBe("48-port  switch")
    expect(plainDescription("![front](https://a.example.com/f.png)")).toBe(
      "![front](https://a.example.com/f.png)"
    )
    expect(plainDescription("[mail](mailto:a@example.com)")).toBe(
      "[mail](mailto:a@example.com)"
    )
    expect(plainDescription("a [b] c (d)")).toBe("a [b] c (d)")
    expect(plainDescription(null)).toBe("")
    expect(plainDescription(undefined)).toBe("")
  })
})
