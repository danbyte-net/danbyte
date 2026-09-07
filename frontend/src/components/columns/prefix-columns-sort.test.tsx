// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"

// The columns render router Links; a plain anchor is enough to read the order.
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children: React.ReactNode }) => <a href="#">{children}</a>,
  useNavigate: () => () => {},
}))

import { DataTable } from "@/components/data-table"
import type { NestedPrefix } from "@/lib/prefix-tree"
import { buildPrefixColumns } from "./prefix-columns"

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) globalThis.ResizeObserver = ResizeObserverStub

function pfx(cidr: string, status: string | null): NestedPrefix {
  return {
    id: cidr,
    cidr,
    vrf: null,
    vrfName: "GLOBAL",
    status: status ? { id: status, name: status, slug: status.toLowerCase(), color: "#10b981" } : null,
    vlan: null,
    site: null,
    gateway: null,
    description: "",
    tags: [],
    family: 4,
    _depth: 0,
  } as unknown as NestedPrefix
}
const rows = [pfx("10.0.0.0/24", "Active"), pfx("10.150.0.0/24", null), pfx("10.10.0.0/24", "Reserved")]

afterEach(cleanup)

describe("prefix list status sorting (grouped by VRF, nested columns)", () => {
  it("reorders rows on Status header click", () => {
    const columns = buildPrefixColumns<NestedPrefix>({
      omit: ["vrf"],
      selection: true,
      nested: true,
      vrfGroupColumn: true,
    })
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <DataTable
          data={rows}
          columns={columns}
          groupBy="vrfName"
          initialColumnVisibility={{ vrfName: false }}
          tableId="prefixes"
        />
      </QueryClientProvider>
    )
    const order = () =>
      screen.getAllByRole("link").map((a) => a.textContent).filter((t) => t?.includes("/24"))
    expect(order()).toEqual(["10.0.0.0/24", "10.150.0.0/24", "10.10.0.0/24"])
    fireEvent.click(screen.getByRole("button", { name: /^status/i }))
    expect(order()).toEqual(["10.150.0.0/24", "10.0.0.0/24", "10.10.0.0/24"])
  })
})
