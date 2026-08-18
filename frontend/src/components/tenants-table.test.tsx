// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { Tenant } from "@/lib/api"

/**
 * /tenants crashed into the error boundary while every request returned 200
 * (#30). The boundary hides the cause, so this renders the page's table for
 * real against a payload shaped exactly like the API's.
 */

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis)) {
  ;(globalThis as unknown as Record<string, unknown>).ResizeObserver =
    ResizeObserverStub
}

const TENANT: Tenant = {
  id: "9c9b9d52-5448-4b4d-ab0b-c0431f923852",
  name: "Default",
  slug: "default",
  color: "#3b82f6",
  description: "",
  is_active: true,
  group: null,
  site_count: 0,
  prefix_count: 0,
  vlan_count: 0,
  ip_count: 0,
  created_at: "2026-08-18T10:58:00.436697Z",
  updated_at: "2026-08-18T10:58:00.436710Z",
}

// The route module pulls in the router; stub the pieces a table cell touches.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createFileRoute: () => (opts: unknown) => opts,
  Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a>,
  useNavigate: () => () => {},
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({
    me: { perms: [], permissions: {}, is_superuser: true, datetime: null },
    canDo: () => true,
    humanIds: false,
  }),
  objCan: () => true,
}))

afterEach(cleanup)

describe("tenants table", () => {
  it("renders a tenant row without throwing", async () => {
    const { DataTable } = await import("@/components/data-table")
    const { buildTenantColumns } = await import("@/routes/tenants.index")

    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={qc}>
        <DataTable
          data={[TENANT]}
          columns={buildTenantColumns({
            activeId: null,
            onDelete: () => {},
            onSwitch: () => {},
            canEdit: true,
            canDelete: true,
          })}
          flexColumn="description"
        />
      </QueryClientProvider>
    )
    expect(screen.getByText("Default")).toBeTruthy()
  })
})
