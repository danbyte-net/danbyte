// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { mountWithRouter } from "./prtg-test-utils"
import { SensorKindBrowser } from "./sensor-kind-picker"

// The one sensor-kind picker: Danbyte's own kinds pinned under "Standard",
// PRTG's list after, search, sort and keyboard picking.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
Element.prototype.scrollIntoView = () => {}

const DANBYTE = {
  intervals: [60],
  kinds: [
    {
      value: "ping",
      label: "Ping",
      needs: null,
      per: "device",
      default_name: "Ping",
      params: [],
    },
    {
      value: "snmp_traffic",
      label: "SNMP traffic",
      needs: "snmp",
      per: "interface",
      default_name: "{interface} Traffic",
      params: [],
    },
  ],
}

const row = (id: string, name: string, patch: object = {}) => ({
  id,
  name,
  description: "",
  help: "",
  category: "Network services",
  form: "generic",
  danbyte_kind: null,
  scan: false,
  credentials: "",
  manual: "",
  copy_from_seed: false,
  ...patch,
})

const CATALOG = {
  mode: "v2",
  source: "prtg",
  read_at: null,
  danbyte_forms: 1,
  detail: "",
  kinds: [
    row("ping", "Ping", {
      category: "Ping",
      form: "danbyte",
      danbyte_kind: "ping",
    }),
    row("port", "Port", { description: "TCP port reachability" }),
    row("dns", "DNS v2"),
    row("snmpdiskfree", "SNMP Disk Free", {
      category: "SNMP",
      scan: true,
      credentials: "snmpcredentials",
    }),
  ],
}

beforeEach(() => {
  apiMock.mockReset()
  apiMock.mockImplementation((path) =>
    Promise.resolve(
      path.startsWith("/api/prtg/profiles/kinds/") ? DANBYTE : CATALOG
    )
  )
})
afterEach(cleanup)

const names = () =>
  screen
    .getAllByTestId("prtg-kind-option")
    .map((o) => o.querySelector("p")?.textContent)

describe("SensorKindBrowser", () => {
  it("pins Danbyte's kinds under Standard, then PRTG's list", async () => {
    const onPick = vi.fn()
    mountWithRouter(() => (
      <SensorKindBrowser connectionId="c1" mode="profile" onPick={onPick} />
    ))
    expect(await screen.findByRole("group", { name: "Standard" })).toBeTruthy()
    expect(names()).toEqual([
      "Ping",
      "SNMP traffic",
      "DNS v2",
      "Port",
      "SNMP Disk Free",
    ])
    // Sorting by name descending keeps Standard on top.
    fireEvent.click(screen.getByRole("button", { name: "Sort by Name" }))
    expect(names()[0]).toBe("SNMP traffic")
    expect(apiMock.mock.calls.map(([p]) => p)).toContain(
      "/api/prtg/connections/c1/sensor-kinds/"
    )
  })

  it("searches name, description and id, Standard matches first", async () => {
    const onPick = vi.fn()
    mountWithRouter(() => (
      <SensorKindBrowser connectionId="c1" mode="profile" onPick={onPick} />
    ))
    const search = await screen.findByRole("combobox", {
      name: "Search sensor kinds",
    })
    fireEvent.change(search, { target: { value: "snmp" } })
    expect(names()).toEqual(["SNMP traffic", "SNMP Disk Free"])
    fireEvent.change(search, { target: { value: "reachability" } })
    expect(names()).toEqual(["Port"])
    fireEvent.change(search, { target: { value: "snmp" } })
    fireEvent.keyDown(search, { key: "ArrowDown" })
    fireEvent.keyDown(search, { key: "Enter" })
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({ id: "snmpdiskfree", form: "generic" })
    )
  })

  it("narrows by category", async () => {
    mountWithRouter(() => (
      <SensorKindBrowser connectionId="c1" mode="profile" onPick={vi.fn()} />
    ))
    const rail = await screen.findByRole("navigation", { name: "Categories" })
    fireEvent.click(within(rail).getByRole("button", { name: /^SNMP/ }))
    expect(names()).toEqual(["SNMP traffic", "SNMP Disk Free"])
  })

  it("says to test the connection when PRTG's list is missing", async () => {
    apiMock.mockImplementation((path) =>
      path.startsWith("/api/prtg/profiles/kinds/")
        ? Promise.resolve(DANBYTE)
        : Promise.reject(new Error("No device is linked yet."))
    )
    mountWithRouter(() => (
      <SensorKindBrowser
        connectionId="c1"
        linkId="l1"
        mode="add"
        onPick={vi.fn()}
      />
    ))
    expect(
      await screen.findByText("No sensor list from PRTG yet.")
    ).toBeTruthy()
    expect(
      screen.getByRole("link", { name: "Test the connection first" })
    ).toBeTruthy()
  })
})
