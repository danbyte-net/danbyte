// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { PrtgSensorProfile } from "@/lib/api"
import { CONN, mountWithRouter } from "./prtg-test-utils"
import { PrtgProfiles } from "./profiles"

// The /prtg Profiles tab: the list, the starter button, and the editor's
// ordered definitions with parameters drawn from the kind.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({ me: {}, canDo: () => true, humanIds: false }),
}))
Element.prototype.scrollIntoView = () => {}
Element.prototype.hasPointerCapture = () => false

const PROFILE: PrtgSensorProfile = {
  id: "pr1",
  connection: "c1",
  name: "Std",
  description: "",
  policy_count: 2,
  created_at: "",
  updated_at: "",
  definitions: [
    {
      id: "d1",
      position: 0,
      kind: "ping",
      kind_label: "Ping",
      name: "",
      params: {},
      interval_seconds: null,
      required: true,
      tags: [],
    },
    {
      id: "d2",
      position: 1,
      kind: "snmp_traffic",
      kind_label: "SNMP traffic",
      name: "",
      params: { interface: "ge-*", connected_only: true },
      interval_seconds: 60,
      required: true,
      tags: ["uplink"],
    },
  ],
}

const KINDS = {
  intervals: [30, 60, 300],
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
      params: [
        {
          name: "interface",
          type: "str",
          label: "Interfaces",
          default: "*",
          required: false,
          choices: [],
          minimum: null,
          maximum: null,
        },
        {
          name: "connected_only",
          type: "bool",
          label: "Connected interfaces only",
          default: false,
          required: false,
          choices: [],
          minimum: null,
          maximum: null,
        },
      ],
    },
  ],
}

const page = (results: unknown[]) =>
  Promise.resolve({
    count: results.length,
    next: null,
    previous: null,
    results,
  })

beforeEach(() => {
  apiMock.mockReset()
  apiMock.mockImplementation((path, init) => {
    if (init?.method)
      return Promise.resolve({ ...PROFILE, name: "Starter profile" })
    if (path.startsWith("/api/prtg/profiles/kinds/"))
      return Promise.resolve(KINDS)
    if (path.startsWith("/api/prtg/profiles/")) return page([PROFILE])
    return page([])
  })
})
afterEach(cleanup)

const writes = (method: string) =>
  apiMock.mock.calls.filter(([, i]) => i?.method === method)

describe("PrtgProfiles", () => {
  it("lists the sensors and how many policies use it", async () => {
    mountWithRouter(() => <PrtgProfiles connection={CONN} canManage />)
    expect(await screen.findByText("Std")).toBeTruthy()
    expect(screen.getByText("Ping")).toBeTruthy()
    expect(screen.getByText("SNMP traffic")).toBeTruthy()
    expect(screen.getByText("2")).toBeTruthy()
  })

  it("makes the starter profile on request", async () => {
    mountWithRouter(() => <PrtgProfiles connection={CONN} canManage />)
    await screen.findByText("Std")
    fireEvent.click(screen.getByRole("button", { name: "Starter profile" }))
    await waitFor(() => expect(writes("POST")).toHaveLength(1))
    const [path, init] = writes("POST")[0]
    expect(path).toBe("/api/prtg/profiles/starter/")
    expect(JSON.parse(String(init?.body))).toEqual({ connection: "c1" })
  })

  it("edits the definitions in order, keeping their ids", async () => {
    mountWithRouter(() => <PrtgProfiles connection={CONN} canManage />)
    await screen.findByText("Std")
    fireEvent.click(screen.getByRole("button", { name: "Edit" }))
    const dialog = await screen.findByRole("dialog")
    expect(await within(dialog).findByDisplayValue("ge-*")).toBeTruthy()
    // Traffic first, then two new sensors at the end, picked at once.
    fireEvent.click(
      within(dialog).getAllByRole("button", { name: "Move up" })[1]
    )
    fireEvent.click(within(dialog).getByRole("button", { name: "Add sensor" }))
    const picker = await screen.findByTestId("prtg-kinds-dialog")
    const options = await within(picker).findAllByTestId("prtg-kind-option")
    fireEvent.click(options.find((o) => o.textContent.includes("Ping"))!)
    fireEvent.click(
      options.find((o) => o.textContent.includes("SNMP traffic"))!
    )
    expect(within(picker).getByTestId("prtg-kind-chosen").textContent).toBe(
      "2 selected"
    )
    fireEvent.click(
      within(picker).getByRole("button", { name: "Add 2 sensors" })
    )
    await waitFor(() =>
      expect(within(dialog).getAllByTestId("prtg-definition").length).toBe(4)
    )
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save profile" })
    )
    await waitFor(() => expect(writes("PATCH")).toHaveLength(1))
    const [path, init] = writes("PATCH")[0]
    expect(path).toBe("/api/prtg/profiles/pr1/")
    const body = JSON.parse(String(init?.body)) as {
      definitions: {
        id?: string
        kind: string
        name: string
        params: object
        interval_seconds: number | null
        required: boolean
      }[]
    }
    expect(body.definitions.map((d) => [d.id, d.kind])).toEqual([
      ["d2", "snmp_traffic"],
      ["d1", "ping"],
      [undefined, "ping"],
      [undefined, "snmp_traffic"],
    ])
    expect(body.definitions[3]).toMatchObject({
      name: "",
      interval_seconds: null,
      required: true,
      params: { interface: "*", connected_only: false },
    })
    expect(body.definitions[0].params).toEqual({
      interface: "ge-*",
      connected_only: true,
    })
  })

  it("keeps a PRTG kind without a form, with settings typed by hand", async () => {
    const kind = "paessler.proxmox.cluster_health_sensor"
    const prox = {
      ...PROFILE,
      definitions: [
        {
          id: "d3",
          position: 0,
          kind,
          kind_label: "Proxmox VE Cluster Health",
          form: "generic" as const,
          name: "",
          params: {},
          interval_seconds: null,
          required: true,
          tags: [],
        },
      ],
    }
    apiMock.mockImplementation((path, init) => {
      if (init?.method) return Promise.resolve(prox)
      if (path.startsWith("/api/prtg/profiles/kinds/"))
        return Promise.resolve(KINDS)
      if (path.includes("/sensor-schema/"))
        return Promise.resolve({
          kind,
          fields: [],
          scan: null,
          note: "PRTG describes this sensor's settings only on a device that can take it.",
        })
      if (path.startsWith("/api/prtg/profiles/")) return page([prox])
      return page([])
    })
    mountWithRouter(() => <PrtgProfiles connection={CONN} canManage />)
    await screen.findByText("Std")
    fireEvent.click(screen.getByRole("button", { name: "Edit" }))
    const dialog = await screen.findByRole("dialog")
    expect(await within(dialog).findByTestId("prtg-defaults-note")).toBeTruthy()
    fireEvent.click(within(dialog).getByRole("button", { name: "Add setting" }))
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Setting" }), {
      target: { value: "basic.priority" },
    })
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Value" }), {
      target: { value: "4" },
    })
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save profile" })
    )
    await waitFor(() => expect(writes("PATCH")).toHaveLength(1))
    const body = JSON.parse(String(writes("PATCH")[0][1]?.body)) as {
      definitions: { kind: string; params: object }[]
    }
    expect(body.definitions[0]).toMatchObject({
      kind,
      params: { "basic.priority": "4" },
    })
  })
})
