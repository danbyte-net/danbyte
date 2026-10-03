import { expect } from "vitest"

// What every elevation drawing must be, whatever it draws: well-formed, its
// ids once each and every reference landing, nothing to fetch from outside -
// so the file stands alone - and none of what the PDF's sanitizer drops or a
// printer chokes on.

export function parseSvg(svg: string): Document {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml")
  expect(doc.getElementsByTagName("parsererror")).toHaveLength(0)
  return doc
}

export function expectSelfContained(svg: string) {
  const doc = parseSvg(svg)
  const ids = [...doc.querySelectorAll("[id]")].map((e) => e.id)
  expect(new Set(ids).size).toBe(ids.length)
  for (const ref of svg.matchAll(/(?:href="#|url\(#)([^")]+)/g))
    expect(ids).toContain(ref[1])
  for (const href of svg.matchAll(/href="([^"]*)"/g))
    expect(href[1]).toMatch(/^(#|data:image\/(png|jpeg|webp);base64,)/)
  for (const banned of [
    "style=",
    "class=",
    "<pattern",
    "Gradient",
    "opacity",
    "foreignObject",
    "dominant-baseline",
    "<script",
  ])
    expect(svg).not.toContain(banned)
}

export const texts = (root: Element) =>
  [...root.getElementsByTagName("text")].map((t) => t.textContent)
