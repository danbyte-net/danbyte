import { describe, expect, it } from "vitest"

import { htmlEscape, xmlEscape } from "./xml"

describe("xmlEscape", () => {
  it("escapes the five XML specials", () => {
    expect(xmlEscape(`<a href="x">Tom & Jerry's</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&apos;s&lt;/a&gt;"
    )
  })

  it("escapes & first, so an entity is not double-read", () => {
    expect(xmlEscape("&lt;")).toBe("&amp;lt;")
  })

  it("drops the control characters XML 1.0 forbids but keeps whitespace", () => {
    expect(xmlEscape("a\u0000b\u0008c\u000bd\u001fe")).toBe("abcde")
    expect(xmlEscape("a\tb\nc\rd")).toBe("a\tb\nc\rd")
  })
})

describe("htmlEscape", () => {
  it("escapes text and both attribute quote styles", () => {
    expect(htmlEscape(`<b class="x">it's & </b>`)).toBe(
      "&lt;b class=&quot;x&quot;&gt;it&#39;s &amp; &lt;/b&gt;"
    )
  })

  it("leaves plain text alone", () => {
    expect(htmlEscape("spine-01 Ethernet1/1")).toBe("spine-01 Ethernet1/1")
  })
})
