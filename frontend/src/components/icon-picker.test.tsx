// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { isValidIconName } from "@/components/dynamic-icon"

import { IconPicker, NETWORK_ICONS, matchIcons } from "./icon-picker"

afterEach(cleanup)

describe("matchIcons", () => {
  it("leads with the network group when nothing is typed", () => {
    const { network, rest } = matchIcons("")
    expect(network.map((i) => i.name)).toEqual(NETWORK_ICONS.map((i) => i.name))
    // None twice.
    expect(rest).not.toContain("router")
  })

  it("finds the group by what an icon stands for", () => {
    expect(matchIcons("firewall").network.map((i) => i.name)).toEqual([
      "shield",
      "brick-wall",
    ])
    expect(matchIcons("ups").network.map((i) => i.name)).toEqual([
      "battery-charging",
    ])
    expect(matchIcons("switch").network.map((i) => i.name)).toEqual([
      "network",
      "ethernet-port",
    ])
  })

  it("searches every other icon by name", () => {
    const { network, rest } = matchIcons("calendar")
    expect(network).toHaveLength(0)
    expect(rest).toContain("calendar-days")
  })

  it("names only icons Lucide has", () => {
    for (const i of NETWORK_ICONS) expect(isValidIconName(i.name)).toBe(true)
  })
})

describe("IconPicker", () => {
  it("shows the network group first and sets the picked icon", () => {
    const onChange = vi.fn()
    render(<IconPicker value="" onChange={onChange} />)
    fireEvent.click(screen.getByRole("button", { name: "Open icon picker" }))
    const groups = document.querySelectorAll("[data-group]")
    expect(groups[0].getAttribute("data-group")).toBe("network")
    fireEvent.click(screen.getByRole("button", { name: "Router: router" }))
    expect(onChange).toHaveBeenCalledWith("router")
  })

  it("narrows to a search", () => {
    render(<IconPicker value="" onChange={() => {}} />)
    fireEvent.click(screen.getByRole("button", { name: "Open icon picker" }))
    fireEvent.change(screen.getByPlaceholderText("Search icons…"), {
      target: { value: "firewall" },
    })
    expect(
      screen.getByRole("button", { name: "Firewall: shield" })
    ).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Router: router" })).toBeNull()
  })
})
