// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { PowerBadge } from "./power-badge"

afterEach(cleanup)

const badge = (state: string | null) => {
  const { container } = render(<PowerBadge state={state} />)
  return container.querySelector<HTMLElement>("[data-slot=badge]")
}

describe("PowerBadge (#514)", () => {
  it.each([
    ["running", "success", "Powered on"],
    ["suspended", "warning", "Suspended"],
    ["paused", "warning", "Paused"],
    ["stopped", "outline", "Powered off"],
    ["unknown", "outline", "Unknown"],
  ])("colours %s as %s", (state, variant, label) => {
    const el = badge(state)
    expect(el?.dataset.variant).toBe(variant)
    expect(el?.textContent).toBe(label)
  })

  it("renders nothing for a VM no sync tracks", () => {
    expect(badge(null)).toBeNull()
  })
})
