// @vitest-environment jsdom
import type { ReactNode } from "react"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { flexRender } from "@tanstack/react-table"
import type { CellContext } from "@tanstack/react-table"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { InventoryProfile, InventoryScopeHost } from "@/lib/api"
import { objCan } from "@/lib/use-me"
import {
  buildInventoryProfileColumns,
  buildInventoryScopeHostColumns,
} from "@/components/columns/inventory-columns"
import { ExemptActions } from "./scope-hosts-panel"
import { profileDeleteText } from "./profile-delete-dialog"

// Discovery row and bulk actions (#451): Edit/Delete on a profile row as the
// caller's rights on that profile allow, and Exempt N / Include N for the
// hosts ticked on a profile's Hosts tab.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => (
    <a href={to}>{children}</a>
  ),
}))

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

const profile = (over: Partial<InventoryProfile>) =>
  ({ id: "p1", name: "Linux", kind: "inventory", ...over }) as InventoryProfile

function actionsCell(p: InventoryProfile, canChange: boolean, canDel: boolean) {
  const onEdit = vi.fn()
  const onDelete = vi.fn()
  const col = buildInventoryProfileColumns({
    actions: {
      onEdit,
      canEdit: (r) => objCan(r, "change", canChange),
      onDelete,
      canDelete: (r) => objCan(r, "delete", canDel),
    },
  }).find((c) => c.id === "actions")!
  const ctx = { row: { original: p } } as unknown as CellContext<
    InventoryProfile,
    unknown
  >
  render(<div>{flexRender(col.cell, ctx)}</div>)
  return { onEdit, onDelete }
}

function host(id: string, over: Partial<InventoryScopeHost> = {}) {
  return {
    kind: "device",
    id,
    name: id,
    address: "10.0.0.1",
    status: "ready",
    message: "",
    credential: null,
    credential_source: "",
    scan_exempt: false,
    permissions: { change: true },
    ...over,
  } as InventoryScopeHost
}

const canChange = (h: InventoryScopeHost) => !!h.permissions?.change

beforeEach(() => {
  apiMock.mockReset()
})
afterEach(cleanup)

describe("profile row actions", () => {
  it("are optional: the embedded uses keep their columns", () => {
    const ids = buildInventoryProfileColumns().map((c) => c.id)
    expect(ids).not.toContain("actions")
    expect(ids).not.toContain("select")
    const all = buildInventoryProfileColumns({
      selection: true,
      actions: { onDelete: () => {} },
    }).map((c) => c.id)
    expect(all[0]).toBe("select")
    expect(all.at(-1)).toBe("actions")
  })

  it("show Edit and Delete by the row's own rights", () => {
    const { onEdit, onDelete } = actionsCell(
      profile({ permissions: { change: true, delete: true } }),
      false,
      false
    )
    fireEvent.click(screen.getByRole("button", { name: "Edit" }))
    fireEvent.click(screen.getByRole("button", { name: "Delete" }))
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: "p1" }))
    expect(onDelete).toHaveBeenCalledTimes(1)
  })

  it("hide what the row does not allow (a site-limited grant)", () => {
    actionsCell(
      profile({ permissions: { change: true, delete: false } }),
      true,
      true
    )
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Delete" })).toBeNull()
    cleanup()
    actionsCell(profile({}), false, false)
    expect(screen.queryByRole("button")).toBeNull()
  })

  it("say what a delete takes", () => {
    expect(profileDeleteText("inventory")).toMatch(/runs go.*Packages/)
    expect(profileDeleteText("service_scan")).toMatch(/runs go.*Open ports/)
  })
})

describe("the Hosts tab bulk bar", () => {
  it("adds a checkbox column only when asked", () => {
    expect(buildInventoryScopeHostColumns().map((c) => c.id)).not.toContain(
      "select"
    )
    expect(buildInventoryScopeHostColumns({ selection: true })[0].id).toBe(
      "select"
    )
  })

  it("sends only the rows the caller may change, and says N of M", async () => {
    apiMock.mockResolvedValue({
      updated: [
        { kind: "device", id: "a" },
        { kind: "virtual_machine", id: "v" },
      ],
      scan_exempt: true,
      not_found: 0,
    })
    const onDone = vi.fn()
    const selected = [
      host("a"),
      host("v", { kind: "virtual_machine" }),
      host("b", { permissions: { change: false } }),
    ]
    render(
      <ExemptActions
        selected={selected}
        canChange={canChange}
        onDone={onDone}
      />,
      { wrapper }
    )
    expect(screen.getByRole("button", { name: "Include 2 of 3" })).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Exempt 2 of 3" }))
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1))
    expect(apiMock).toHaveBeenCalledTimes(1)
    const [url, init] = apiMock.mock.calls[0]
    expect(url).toBe("/api/discovery/exempt/")
    expect(JSON.parse(String(init?.body))).toEqual({
      objects: [
        { kind: "device", id: "a" },
        { kind: "virtual_machine", id: "v" },
      ],
      exempt: true,
    })
  })

  it("says N alone when every row can change, and Include sends false", async () => {
    apiMock.mockResolvedValue({ updated: [], scan_exempt: false, not_found: 0 })
    const onDone = vi.fn()
    render(
      <ExemptActions
        selected={[host("a"), host("b")]}
        canChange={canChange}
        onDone={onDone}
      />,
      { wrapper }
    )
    fireEvent.click(screen.getByRole("button", { name: "Include 2" }))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(JSON.parse(String(apiMock.mock.calls[0][1]?.body)).exempt).toBe(
      false
    )
  })

  it("is disabled when nothing selected may change", () => {
    render(
      <ExemptActions
        selected={[host("b", { permissions: { change: false } })]}
        canChange={canChange}
        onDone={() => {}}
      />,
      { wrapper }
    )
    const b = screen.getByRole<HTMLButtonElement>("button", {
      name: "Exempt 0 of 1",
    })
    expect(b.disabled).toBe(true)
  })

  it("sends more than one call takes in batches of 500", async () => {
    apiMock.mockImplementation((url, init) => {
      if (!init?.body) throw new Error(`unexpected call ${url}`)
      const n = JSON.parse(String(init.body)).objects.length
      return Promise.resolve({
        updated: Array.from({ length: n }, () => ({})),
        scan_exempt: true,
        not_found: 0,
      })
    })
    const onDone = vi.fn()
    const many = Array.from({ length: 501 }, (_, i) => host(`h${i}`))
    render(
      <ExemptActions selected={many} canChange={canChange} onDone={onDone} />,
      { wrapper }
    )
    fireEvent.click(screen.getByRole("button", { name: "Exempt 501" }))
    await waitFor(() => expect(onDone).toHaveBeenCalled())
    expect(apiMock).toHaveBeenCalledTimes(2)
    expect(
      JSON.parse(String(apiMock.mock.calls[0][1]?.body)).objects
    ).toHaveLength(500)
  })
})
