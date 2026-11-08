// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { mountWithRouter } from "./prtg-test-utils"
import { AddSensorDialog } from "./add-sensor"

// Adding several kinds to a device at once: the ones with nothing to fill
// in are created straight away, the rest are steps, and a list ends it.

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
    row("port", "Port"),
    row("dns", "DNS v2"),
  ],
}

beforeEach(() => {
  apiMock.mockReset()
  apiMock.mockImplementation((path, init) => {
    if (path.startsWith("/api/prtg/profiles/kinds/"))
      return Promise.resolve(DANBYTE)
    if (path.includes("/sensor-kinds/")) return Promise.resolve(CATALOG)
    if (path.includes("/sensor-schema/"))
      return Promise.resolve({ kind: "port", fields: [], scan: null })
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { kind: string }
      if (body.kind === "dns")
        return Promise.reject(new Error("PRTG refused: no DNS server."))
      return Promise.resolve({
        detail: `Added ${body.kind} in PRTG by hand.`,
        objids: ["9"],
        failed: [],
        sensors: [],
      })
    }
    return Promise.resolve({})
  })
})
afterEach(cleanup)

const posts = () =>
  apiMock.mock.calls
    .filter(([, i]) => i?.method === "POST")
    .map(([, i]) => (JSON.parse(String(i?.body)) as { kind: string }).kind)

describe("AddSensorDialog, several kinds", () => {
  it("creates the plain ones, steps through the rest, lists the results", async () => {
    const onAdded = vi.fn()
    mountWithRouter(() => (
      <AddSensorDialog
        target={{
          linkId: "l1",
          connectionId: "c1",
          name: "edge",
          writeMode: "v2",
        }}
        onOpenChange={() => {}}
        onAdded={onAdded}
      />
    ))
    const options = await screen.findAllByTestId("prtg-kind-option")
    for (const name of ["Ping", "Port", "DNS v2"])
      fireEvent.click(options.find((o) => o.textContent.includes(name))!)
    fireEvent.click(screen.getByRole("button", { name: "Add 3 sensors" }))

    // Ping had nothing to fill in; Port is step 2 of 3.
    expect((await screen.findByTestId("prtg-add-stepper")).textContent).toBe(
      "2 of 3"
    )
    expect(posts()).toEqual(["ping"])
    fireEvent.click(screen.getByRole("button", { name: "Skip" }))

    // DNS is refused by PRTG, then skipped: it ends as failed.
    await waitFor(() =>
      expect(screen.getByTestId("prtg-add-stepper").textContent).toBe("3 of 3")
    )
    fireEvent.click(await screen.findByRole("button", { name: "Add sensor" }))
    await waitFor(() => expect(posts()).toEqual(["ping", "dns"]))
    fireEvent.click(screen.getByRole("button", { name: "Skip" }))

    const list = await screen.findByTestId("prtg-add-results")
    const badges = within(list)
      .getAllByText(/^(Created|Skipped|Failed)$/)
      .map((b) => b.textContent)
    expect(badges).toEqual(["Created", "Skipped", "Failed"])
    expect(within(list).getByText("PRTG refused: no DNS server.")).toBeTruthy()
    expect(onAdded).toHaveBeenCalledWith(["9"])
  })
})
