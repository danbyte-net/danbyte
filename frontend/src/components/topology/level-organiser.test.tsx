// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { LevelOrganiser } from "./level-organiser"

afterEach(cleanup)

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver = ResizeObserverStub
}

const roles = [
  { name: "Core", color: "#2563eb" },
  { name: "Distribution", color: "#16a34a" },
  { name: "Access" },
]

function open(props: Partial<Parameters<typeof LevelOrganiser>[0]> = {}) {
  const onBonds = vi.fn()
  const onDistance = vi.fn()
  render(
    <LevelOrganiser
      roles={roles}
      order={[]}
      onChange={vi.fn()}
      bonds={[]}
      onBonds={onBonds}
      distance={{}}
      onDistance={onDistance}
      {...props}
    />
  )
  fireEvent.click(screen.getByRole("button", { name: "Levels" }))
  return { onBonds, onDistance }
}

/** Radix opens a tooltip on keyboard focus; that is enough to read it. */
async function tipOf(el: HTMLElement) {
  fireEvent.focus(el)
  return (await screen.findByRole("tooltip")).textContent
}

describe("LevelOrganiser", () => {
  it("opens from a bar menu trigger", () => {
    render(
      <LevelOrganiser
        roles={roles}
        order={[]}
        onChange={vi.fn()}
        bonds={[]}
        onBonds={vi.fn()}
        distance={{}}
        onDistance={vi.fn()}
      />
    )
    const trigger = screen.getByRole("button", { name: "Levels" })
    expect(trigger.className).toContain("h-7")
    expect(trigger.querySelector("svg.lucide-chevron-down")).not.toBeNull()
  })

  it("names each role with its badge, never a dot", () => {
    open()
    const core = screen.getByText("Core")
    expect(core.closest("[data-slot=badge]")).not.toBeNull()
    // No colored dot beside a name anywhere in the popover.
    expect(document.querySelector(".rounded-full[style]")).toBeNull()
  })

  it("has no native title tooltips", () => {
    open()
    expect(document.querySelector("[title]")).toBeNull()
  })

  it("links a row to the level above with a pressed-state icon button", async () => {
    const { onBonds } = open()
    const link = screen.getByRole("button", {
      name: "Same level as Core",
    })
    expect(link.getAttribute("aria-pressed")).toBe("false")
    expect(link.dataset.size).toBe("icon-xs")
    expect(await tipOf(link)).toBe("Same level as Core")
    fireEvent.click(link)
    expect(onBonds).toHaveBeenCalledWith(["Distribution"])
  })

  it("says a bonded row can go back to its own level", () => {
    open({ bonds: ["Distribution"] })
    const link = screen.getByRole("button", { name: "Own level" })
    expect(link.getAttribute("aria-pressed")).toBe("true")
    expect(screen.getByText("Same level")).toBeTruthy()
  })

  it("keeps the gap dots under one Gap above tooltip", async () => {
    const { onDistance } = open()
    const dots = screen.getAllByRole("button", { name: /^Gap above \d$/ })
    // Two rows below the first, five steps each.
    expect(dots).toHaveLength(10)
    expect(await tipOf(dots[0].parentElement!)).toBe("Gap above")
    fireEvent.click(dots[3])
    expect(onDistance).toHaveBeenCalledWith("Distribution", 3)
  })

  it("resets the order only once there is one", () => {
    open()
    expect(screen.queryByRole("button", { name: "Reset levels" })).toBeNull()
    cleanup()
    const onChange = vi.fn()
    const onBonds = vi.fn()
    render(
      <LevelOrganiser
        roles={roles}
        order={["Access", "Core"]}
        onChange={onChange}
        bonds={["Core"]}
        onBonds={onBonds}
        distance={{}}
        onDistance={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: "Levels" }))
    fireEvent.click(screen.getByRole("button", { name: "Reset levels" }))
    expect(onChange).toHaveBeenCalledWith([])
    expect(onBonds).toHaveBeenCalledWith([])
  })

  it("says so when the map has no roles", () => {
    open({ roles: [] })
    expect(screen.getByText("No roles on this map.")).toBeTruthy()
  })
})
