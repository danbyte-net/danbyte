// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { PrtgChange } from "@/lib/api"
import { CONN, mountWithRouter } from "./prtg-test-utils"
import { PrtgChanges, SelectionBar } from "./changes"

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
    status: applicable ? "ready" : "attention",
    destructive: false,
    created_at: "2026-10-26T08:00:00Z",
    updated_at: "2026-10-26T08:00:00Z",
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
    status: "ready",
    destructive: false,
    created_at: "2026-10-26T08:00:00Z",
    updated_at: "2026-10-26T08:00:00Z",
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
      issues: [
        {
          code: "group_gone",
          text: "PRTG has no group Gone any more.",
          policy: "pol1",
        },
      ],
    },
    ignored: false,
    applicable: false,
    planned: true,
    status: "attention",
    destructive: false,
    created_at: "2026-10-26T08:00:00Z",
    updated_at: "2026-10-26T08:00:00Z",
  },
  {
    id: "p3",
    kind: "add_sensor",
    kind_display: "Add sensor in PRTG",
    device: { id: "d3", name: "db-dev01" },
    virtual_machine: null,
    key: "danbyte-def-abc",
    detail: {
      sensor: { name: "HTTPS", kind_label: "HTTP", params: { port: 443 } },
      applicable: true,
      result: { sensors: { "danbyte-def-abc": "2120" }, device: "2081" },
      applied: {
        at: "2026-10-26T09:00:00Z",
        by: "root",
        detail: "Added HTTPS",
      },
      log: [
        {
          at: "2026-10-26T08:59:00Z",
          by: "root",
          ok: false,
          detail: "PRTG API v2 answered 500: boom",
          steps: [],
        },
        {
          at: "2026-10-26T09:00:00Z",
          by: "root",
          ok: true,
          detail: "Added HTTPS (2120) in PRTG.",
          steps: ["Created sensor HTTPS (2120)."],
        },
      ],
    },
    ignored: false,
    applicable: false,
    planned: true,
    status: "applied",
    destructive: false,
    created_at: "2026-10-26T08:00:00Z",
    updated_at: "2026-10-26T09:00:00Z",
  },
  {
    id: "p4",
    kind: "remove_device",
    kind_display: "Remove device from PRTG",
    device: { id: "d4", name: "old-box" },
    virtual_machine: null,
    key: "",
    detail: {
      objid: "2200",
      name: "old-box",
      applicable: true,
      last_error: { at: "2026-10-26T09:00:00Z", detail: "HTTP 500: busy" },
    },
    ignored: false,
    applicable: true,
    planned: true,
    status: "failed",
    destructive: true,
    created_at: "2026-10-26T08:00:00Z",
    updated_at: "2026-10-26T09:00:00Z",
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
    expect(screen.getByRole("button", { name: "Apply" })).toBeTruthy()
  })

  it("offers the defaults for a row that cannot be placed yet", async () => {
    const edit = vi.fn()
    mountWithRouter(() => (
      <PrtgChanges connection={CONN} onEditConnection={edit} />
    ))
    expect(
      (await screen.findAllByText(/No site to adopt into/)).length
    ).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole("button", { name: "Set defaults" }))
    expect(edit).toHaveBeenCalled()
  })
})

describe("PrtgChanges planned rows", () => {
  it("shows a status pill per row with Apply beside Dismiss", async () => {
    rows = PLANNED
    mountWithRouter(() => <PrtgChanges connection={CONN} />)
    expect(await screen.findByText("10.0.0.90")).toBeTruthy()
    expect(screen.getByText("in Local Probe / Servers")).toBeTruthy()
    expect(screen.getByText("SNMP lab-v2c")).toBeTruthy()
    expect(screen.getAllByText("Ready").length).toBeGreaterThan(0)
    expect(screen.getAllByText("Needs attention").length).toBeGreaterThan(0)
    expect(screen.getByText("PRTG has no group Gone any more.")).toBeTruthy()
    expect(screen.getByRole("link", { name: "Edit policy" })).toBeTruthy()
    expect(screen.getAllByText("Applied").length).toBeGreaterThan(0)
    expect(screen.queryByText("2081, 2120")).toBeNull()
    expect(screen.getAllByText("Failed").length).toBeGreaterThan(0)
    expect(screen.getByText("HTTP 500: busy")).toBeTruthy()
    // Ready gets Apply, failed gets Retry, the attention row neither.
    expect(screen.getAllByRole("button", { name: "Apply" })).toHaveLength(1)
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1)
    // A failed row offers Skip beside Retry instead of the Dismiss icon.
    expect(screen.getAllByRole("button", { name: "Skip" })).toHaveLength(1)
    expect(screen.getAllByRole("button", { name: "Dismiss" })).toHaveLength(2)
  })

  it("applies a ready row", async () => {
    rows = PLANNED
    mountWithRouter(() => <PrtgChanges connection={CONN} />)
    fireEvent.click(await screen.findByRole("button", { name: "Apply" }))
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        "/api/prtg/changes/p1/apply/",
        expect.objectContaining({ method: "POST" })
      )
    )
  })

  it("confirms a removal before applying it", async () => {
    rows = PLANNED
    mountWithRouter(() => <PrtgChanges connection={CONN} />)
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }))
    expect(
      await screen.findByText(/Deletes PRTG device old-box and its sensors/)
    ).toBeTruthy()
    expect(apiMock).not.toHaveBeenCalledWith(
      "/api/prtg/changes/p4/apply/",
      expect.anything()
    )
  })

  it("confirms Apply all applicable with the count and kinds", async () => {
    rows = PLANNED
    mountWithRouter(() => <PrtgChanges connection={CONN} />)
    fireEvent.click(
      await screen.findByRole("button", { name: "Apply all applicable" })
    )
    expect(await screen.findByText("Apply 1 change?")).toBeTruthy()
    expect(screen.getByText(/1 × Create in PRTG/)).toBeTruthy()
  })

  it("opens the plan and its apply log in a side panel", async () => {
    rows = PLANNED
    mountWithRouter(() => <PrtgChanges connection={CONN} />)
    fireEvent.click(await screen.findByText("HTTPS"))
    const panel = await screen.findByRole("complementary", { name: "Change" })
    expect(within(panel).getByText("port 443")).toBeTruthy()
    expect(within(panel).getAllByTestId("prtg-apply-log")).toHaveLength(2)
    expect(within(panel).getByText("Created sensor HTTPS (2120).")).toBeTruthy()
  })
})

describe("SelectionBar", () => {
  it("offers Apply selected and Dismiss selected", () => {
    const onApply = vi.fn()
    const onDismiss = vi.fn()
    const onClear = vi.fn()
    mountWithRouter(() => (
      <SelectionBar
        count={2}
        busy={false}
        applying={false}
        dismissing={false}
        onApply={onApply}
        onDismiss={onDismiss}
        onClear={onClear}
      />
    ))
    return screen.findByText("2 selected").then(() => {
      fireEvent.click(screen.getByRole("button", { name: "Apply selected" }))
      fireEvent.click(screen.getByRole("button", { name: "Dismiss selected" }))
      fireEvent.click(screen.getByRole("button", { name: "Clear selection" }))
      expect(onApply).toHaveBeenCalled()
      expect(onDismiss).toHaveBeenCalled()
      expect(onClear).toHaveBeenCalled()
    })
  })

  it("applies the selected rows through apply-selected", async () => {
    rows = PLANNED
    apiMock.mockImplementation((path) =>
      Promise.resolve(
        path.startsWith("/api/prtg/changes/?")
          ? { count: rows.length, next: null, previous: null, results: rows }
          : { applied: 1, failed: [], results: [] }
      )
    )
    mountWithRouter(() => <PrtgChanges connection={CONN} />)
    await screen.findByText("10.0.0.90")
    const boxes = screen.getAllByRole("checkbox", { name: /select row/i })
    fireEvent.click(boxes[0])
    fireEvent.click(
      await screen.findByRole("button", { name: "Apply selected" })
    )
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith(
        "/api/prtg/changes/apply-selected/",
        expect.objectContaining({ method: "POST" })
      )
    )
  })
})
