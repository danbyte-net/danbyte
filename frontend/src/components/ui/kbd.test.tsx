import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { Kbd, KbdGroup } from "./kbd"

describe("Kbd", () => {
  it("renders a kbd the tooltip chip can style", () => {
    const out = renderToStaticMarkup(<Kbd>Ctrl+S</Kbd>)
    expect(out).toMatch(/^<kbd data-slot="kbd"/)
    expect(out).toContain(">Ctrl+S</kbd>")
  })

  it("keeps the dark tooltip's own text colour, not the inverted one", () => {
    const out = renderToStaticMarkup(<Kbd>H</Kbd>)
    expect(out).toContain("in-data-[slot=tooltip-content]:text-background")
    expect(out).toContain(
      "dark:in-data-[slot=tooltip-content]:text-secondary-foreground"
    )
  })

  it("groups keys", () => {
    const out = renderToStaticMarkup(
      <KbdGroup>
        <Kbd>Ctrl</Kbd>
        <Kbd>Shift</Kbd>
      </KbdGroup>
    )
    expect(out).toMatch(/^<kbd data-slot="kbd-group"/)
    expect(out.match(/data-slot="kbd"/g)).toHaveLength(2)
  })
})
