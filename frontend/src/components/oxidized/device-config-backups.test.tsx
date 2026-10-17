import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { ConfigText } from "./device-config-backups"

// A config is whatever the device says, banners included (#35).
describe("ConfigText", () => {
  it("renders markup in a config as text, never as elements", () => {
    const evil =
      'banner motd ^<script>alert(1)</script><img src=x onerror="alert(2)">^'
    const out = renderToStaticMarkup(
      <ConfigText text={evil} fileName="sw1.cfg" />
    )
    expect(out).not.toContain("<script>")
    expect(out).not.toContain("<img")
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
  })

  it("keeps a large config whole", () => {
    const big = Array.from({ length: 20000 }, (_, i) => `line ${i}`).join("\n")
    const out = renderToStaticMarkup(
      <ConfigText text={big} fileName="sw1.cfg" />
    )
    expect(out).toContain("line 0\nline 1")
    expect(out).toContain("line 19999")
  })
})
