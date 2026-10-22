// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { CapacityBar } from "./capacity-bar"
import { CoolingFigure, PowerFigure } from "./power-figure"

afterEach(cleanup)

const power = (
  available_w: number,
  allocated_w: number,
  maximum_w: number
) => ({
  available_w,
  allocated_w,
  maximum_w,
})

const fill = (root: ParentNode) =>
  root.querySelector<HTMLElement>("[data-slot=capacity-bar] > span")

describe("PowerFigure", () => {
  it("reads demand over supply", () => {
    const { container } = render(
      <PowerFigure power={power(3_600, 1_200, 2_000)} />
    )
    expect(container.textContent).toBe("1.2 kW / 3.6 kW")
    expect(container.querySelector(".text-destructive")).toBeNull()
    // Inline: no bar unless asked for.
    expect(container.querySelector("[data-slot=capacity-bar]")).toBeNull()
  })

  it("marks a nameplate demand, and a rack with no feed", () => {
    const np = render(<PowerFigure power={power(3_600, 0, 2_000)} />)
    expect(np.container.textContent).toBe("2 kW / 3.6 kWnameplate")
    np.unmount()
    const noFeed = render(<PowerFigure power={power(0, 900, 2_000)} />)
    expect(noFeed.container.textContent).toBe("900 WNo feed")
    noFeed.unmount()
    const both = render(<PowerFigure power={power(0, 0, 2_000)} />)
    expect(both.container.textContent).toBe("2 kWnameplate · No feed")
  })

  it("marks a supply read from the PDUs' rating", () => {
    const { container } = render(
      <PowerFigure
        power={{ ...power(3_680, 400, 800), supply: "pdu_rating" }}
      />
    )
    expect(container.textContent).toBe("400 W / 3.68 kWPDU rating")
  })

  it("turns red when demand is over supply", () => {
    const { container } = render(<PowerFigure power={power(1_000, 1_200, 0)} />)
    expect(container.querySelector(".text-destructive")?.textContent).toBe(
      "1.2 kW / 1 kW"
    )
  })

  it("is a dash with nothing to say", () => {
    for (const p of [power(0, 0, 0), null, undefined]) {
      const { container, unmount } = render(<PowerFigure power={p} />)
      expect(container.textContent).toBe("-")
      unmount()
    }
  })

  it("leads with the bar on the shared scale when asked", () => {
    const warn = render(<PowerFigure power={power(1_000, 900, 0)} bar />)
    expect(fill(warn.container)?.dataset.level).toBe("warn")
    expect(fill(warn.container)?.style.width).toBe("90%")
    warn.unmount()
    // No feed: an empty track, never a guess at a level.
    const none = render(<PowerFigure power={power(0, 900, 0)} bar />)
    expect(
      none.container.querySelector("[data-slot=capacity-bar]")
    ).not.toBeNull()
    expect(fill(none.container)).toBeNull()
  })
})

describe("CoolingFigure (#434)", () => {
  const heat = (
    available_w: number,
    heat_allocated_w: number,
    heat_maximum_w: number
  ) => ({
    available_w,
    heat_allocated_w,
    heat_maximum_w,
    supply: available_w > 0 ? ("budget" as const) : null,
    mismatched: 0,
  })

  it("reads heat over capacity, as power reads demand over supply", () => {
    const { container } = render(
      <CoolingFigure cooling={heat(10_000, 3_200, 5_000)} />
    )
    expect(container.textContent).toBe("3.2 kW / 10 kW")
    // A capacity is the rack's own figure: no note, unlike a power budget.
    expect(container.querySelector("[data-slot=cooling-figure]")).not.toBeNull()
  })

  it("marks a nameplate heat, and heat with no capacity", () => {
    const np = render(<CoolingFigure cooling={heat(10_000, 0, 4_000)} />)
    expect(np.container.textContent).toBe("4 kW / 10 kWnameplate")
    np.unmount()
    const none = render(<CoolingFigure cooling={heat(0, 900, 900)} />)
    expect(none.container.textContent).toBe("900 WNo capacity")
  })

  it("turns red over capacity and leads with the bar when asked", () => {
    const over = render(<CoolingFigure cooling={heat(1_000, 1_200, 0)} bar />)
    expect(over.container.querySelector(".text-destructive")).not.toBeNull()
    expect(fill(over.container)?.dataset.level).toBe("critical")
  })

  it("is a dash with nothing to say", () => {
    for (const c of [heat(0, 0, 0), null, undefined]) {
      const { container, unmount } = render(<CoolingFigure cooling={c} />)
      expect(container.textContent).toBe("-")
      unmount()
    }
  })
})

describe("CapacityBar", () => {
  it("fills to the ratio in its level's status colour, capped at full", () => {
    const { container, rerender } = render(<CapacityBar ratio={0.5} />)
    expect(fill(container)?.className).toContain("bg-emerald-500")
    expect(fill(container)?.style.width).toBe("50%")
    rerender(<CapacityBar ratio={0.97} />)
    expect(fill(container)?.className).toContain("bg-red-500")
    rerender(<CapacityBar ratio={1.4} />)
    expect(fill(container)?.style.width).toBe("100%")
    // Never the accent.
    expect(container.innerHTML).not.toMatch(/bg-primary/)
  })
})
