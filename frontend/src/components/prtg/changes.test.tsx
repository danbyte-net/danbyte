// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { PrtgChange } from "@/lib/api"
import { CONN, mountWithRouter } from "./prtg-test-utils"
import { PrtgChanges } from "./changes"

// The /prtg review queue's adoption rows: what applying makes and where, the
// Adopt button when the placement is complete, Set defaults when it is not.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({ me: {}, canDo: () => true, humanIds: false }),
}))

function change(
  id: string,
  detail: Record<string, unknown>,
  applicable: boolean
) {
  return {
    id,
    kind: "adopt",
    kind_display: "Adopt into Danbyte",
    device: null,
    virtual_machine: null,
    key: String(detail.objid),
    detail,
    ignored: false,
    applicable,
    planned: false,
    created_at: "2026-10-26T08:00:00Z",
  } satisfies PrtgChange
}

const PLANNED: PrtgChange[] = [
  {
    id: "p1",
    kind: "create_device",
    kind_display: "Create in PRTG",
    device: { id: "d1", name: "edge" },
    virtual_machine: null,
    key: "",
    detail: {
      host: "10.0.0.90",
      group: { objid: "64", path: "Local Probe / Servers" },
      sensors: [{ name: "Ping", kind_label: "Ping" }],
      templates: [],
      credentials: [{ kind: "snmp", name: "lab-v2c" }],
      applicable: true,
    },
    ignored: false,
    applicable: true,
    planned: true,
    created_at: "2026-10-26T08:00:00Z",
  },
  {
    id: "p2",
    kind: "move_device",
    kind_display: "Move in PRTG",
    device: { id: "d2", name: "db-zabbix" },
    virtual_machine: null,
    key: "",
    detail: {
      from: { objid: "1", path: "Local Probe" },
      to: { objid: "999", path: "Gone" },
      applicable: false,
      reason: "PRTG has no group Gone any more.",
    },
    ignored: false,
    applicable: false,
    planned: true,
    created_at: "2026-10-26T08:00:00Z",
  },
]

const ROWS = [
  change(
    "a1",
    {
      objid: "2080",
      name: "sw-01",
      address: "10.0.0.2",
      site: "Lab",
      role: "Switch",
      device_type: "EX2300",
      rule: "sw-*",
    },
    true
  ),
  change(
    "a2",
    {
      objid: "46",
      name: "Internet",
      reason:
        "No site to adopt into - set the defaults on the connection, or place it with an adoption rule.",
    },
    false
  ),
]

let rows: PrtgChange[] = ROWS

beforeEach(() => {
  rows = ROWS
  apiMock.mockReset()
  apiMock.mockImplementation((path) =>
    Promise.resolve(
      path.startsWith("/api/prtg/changes/")
        ? { count: rows.length, next: null, previous: null, results: rows }
        : {}
    )
  )
})
afterEach(cleanup)

describe("PrtgChanges adoption rows", () => {
  it("says what adopting makes and where", async () => {
    mountWithRouter(() => <PrtgChanges connection={CONN} />)
    expect(
      await screen.findByText(
        /a EX2300, Switch, at Lab \(rule sw-\*\), on 10\.0\.0\.2/
      )
    ).toBeTruthy()
    expect(screen.getByRole("button", { name: "Adopt" })).toBeTruthy()
  })

  it("offers the defaults for a row that cannot be placed yet", async () => {
    const edit = vi.fn()
    mountWithRouter(() => (
      <PrtgChanges connection={CONN} onEditConnection={edit} />
    ))
    expect(await screen.findByText(/No site to adopt into/)).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Set defaults" }))
    expect(edit).toHaveBeenCalled()
  })
})

describe("PrtgChanges planned rows", () => {
  it("shows what PRTG would get, marked planned, with no apply", async () => {
    rows = PLANNED
    mountWithRouter(() => <PrtgChanges connection={CONN} />)
    expect(await screen.findByText("10.0.0.90")).toBeTruthy()
    expect(screen.getByText("in Local Probe / Servers")).toBeTruthy()
    expect(screen.getByText("SNMP lab-v2c")).toBeTruthy()
    expect(screen.getAllByText("Planned")).toHaveLength(2)
    expect(screen.getByText("PRTG has no group Gone any more.")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Link" })).toBeNull()
    expect(screen.queryByRole("button", { name: /^Apply/ })).toBeNull()
    expect(screen.getAllByRole("button", { name: "Dismiss" })).toHaveLength(2)
  })
})
