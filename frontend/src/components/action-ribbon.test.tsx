// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import type { ColumnDef } from "@tanstack/react-table"
import type { ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  CloneMenuItem,
  DeleteButton,
  EditButton,
} from "@/components/action-ribbon"
import { DataTable } from "@/components/data-table"
import { DetailShell, DetailTab } from "@/components/detail-shell"
import { ListPageShell } from "@/components/list-page-shell"
import { DropdownMenuItem } from "@/components/ui/dropdown-menu"

// The action ribbon (#507): one button order on every page header, and a
// list page's search in the same row as its table's Download and Columns.

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  ;(globalThis as unknown as Record<string, unknown>).ResizeObserver =
    ResizeObserverStub
}

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api: apiMock,
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({
    me: { perms: [], permissions: {}, is_superuser: true, datetime: null },
    canDo: () => true,
    humanIds: false,
  }),
  objCan: () => true,
}))

apiMock.mockImplementation((path: string) =>
  path.startsWith("/api/prefs/columns/")
    ? Promise.resolve({ source: "none", is_forced: false, data: null })
    : path.startsWith("/api/io/types/")
      ? Promise.resolve({
          object_types: [
            {
              slug: "vlan",
              can_export: true,
              can_import: true,
              natural_key: [],
            },
          ],
        })
      : new Promise(() => undefined)
)

afterEach(cleanup)

const ID = "11111111-1111-1111-1111-111111111111"

function mount(node: ReactNode, at = "/") {
  const root = createRootRoute({ component: () => <Outlet /> })
  const page = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <>{node}</>,
  })
  const detail = createRoute({
    getParentRoute: () => root,
    path: "/vlans/$id",
    component: () => <>{node}</>,
  })
  const router = createRouter({
    routeTree: root.addChildren([page, detail]),
    history: createMemoryHistory({ initialEntries: [at] }),
  })
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>
  )
}

function openMenu(name: string) {
  fireEvent.pointerDown(
    screen.getByRole("button", { name }),
    new PointerEvent("pointerdown", { bubbles: true, button: 0 })
  )
}

describe("detail header", () => {
  function Page() {
    return (
      <DetailShell
        backTo="/"
        backLabel="VLANs"
        title="VLAN 10"
        // Slots passed out of order: the shell, not the page, orders them.
        remove={<DeleteButton onClick={() => undefined} />}
        more={<CloneMenuItem to="/" search={{}} />}
        exports={<DropdownMenuItem>Spec sheet</DropdownMenuItem>}
        actions={<button type="button">Topology</button>}
        edit={<EditButton onClick={() => undefined} />}
        add={<button type="button">Add IP</button>}
        tabs={[{ value: "overview", label: "Overview" }]}
        tab="overview"
        onTabChange={() => undefined}
      >
        <DetailTab value="overview">body</DetailTab>
      </DetailShell>
    )
  }

  it("lays the buttons out Add, Edit, actions, Export, More, Delete", async () => {
    mount(<Page />, `/vlans/${ID}`)
    await screen.findByRole("button", { name: "Export" })
    const header = screen.getByText("Add IP").closest("header")!
    const names = [...header.querySelectorAll("button, a")]
      .map((el) => el.textContent.trim())
      .filter((t) => t && t !== "VLANs")
    expect(names).toEqual([
      "Add IP",
      "Edit",
      "Topology",
      "Export",
      "More",
      "Delete",
    ])
  })

  it("gives Edit the tinted hue", async () => {
    mount(<Page />, `/vlans/${ID}`)
    const edit = await screen.findByRole("button", { name: "Edit" })
    expect(edit.getAttribute("data-variant")).toBe("tinted")
  })

  it("lists the page's outputs with the route's Import / Export", async () => {
    mount(<Page />, `/vlans/${ID}`)
    await screen.findByRole("button", { name: "Export" })
    openMenu("Export")
    expect(screen.getByRole("menuitem", { name: "Spec sheet" })).toBeTruthy()
    expect(
      await screen.findByRole("menuitem", { name: "CSV (.csv)" })
    ).toBeTruthy()
    expect(screen.getByRole("menuitem", { name: /Import…/ })).toBeTruthy()
  })

  it("keeps the rarer verbs under More", async () => {
    mount(<Page />, `/vlans/${ID}`)
    await screen.findByRole("button", { name: "More" })
    openMenu("More")
    expect(screen.getByRole("menuitem", { name: "Clone" })).toBeTruthy()
  })

  it("draws no menu a page has nothing for", async () => {
    mount(
      <DetailShell
        backTo="/"
        backLabel="Things"
        title="thing"
        edit={<EditButton onClick={() => undefined} />}
        tabs={[{ value: "overview", label: "Overview" }]}
        tab="overview"
        onTabChange={() => undefined}
      >
        <DetailTab value="overview">body</DetailTab>
      </DetailShell>
    )
    await screen.findByRole("button", { name: "Edit" })
    expect(screen.queryByRole("button", { name: "Export" })).toBeNull()
    expect(screen.queryByRole("button", { name: "More" })).toBeNull()
  })
})

describe("list toolbar row", () => {
  type Row = { id: string; name: string }
  const columns: ColumnDef<Row>[] = [{ accessorKey: "name", header: "Name" }]

  it("puts search beside the table's Download and Columns, not in the header", async () => {
    mount(
      <ListPageShell
        title="VLANs"
        count={1}
        search={{ value: "", onChange: () => undefined, placeholder: "Find…" }}
        add={<button type="button">Add VLAN</button>}
      >
        <DataTable
          data={[{ id: "1", name: "ten" }]}
          columns={columns}
          tableId="ribbon-test"
        />
      </ListPageShell>
    )
    const search = await screen.findByPlaceholderText("Find…")
    const download = await screen.findByRole("button", { name: /Download/ })
    expect(search.closest("header")).toBeNull()
    // One row: the search box's wrapper and the table's controls share it.
    const row = search.parentElement!.parentElement!
    expect(row.contains(download)).toBe(true)
    expect(row.className).toContain("flex-wrap")
    // The header keeps the title and Add.
    expect(screen.getByText("Add VLAN").closest("header")).not.toBeNull()
  })

  it("keeps the search row on a page without a table", async () => {
    mount(
      <ListPageShell
        title="Cards"
        search={{ value: "", onChange: () => undefined, placeholder: "Find…" }}
      >
        <p>cards</p>
      </ListPageShell>
    )
    const search = await screen.findByPlaceholderText("Find…")
    expect(search.closest("header")).toBeNull()
  })
})
