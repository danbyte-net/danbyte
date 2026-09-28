// @vitest-environment jsdom
import { Suspense, useState } from "react"
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"

import type { TopologyCardSettings } from "@/lib/api"
import { Route } from "./settings.topology"

// The page's URL state and identity are mocked (vi.mock is hoisted above
// the imports) so it renders without a router: `url` stands in for the
// query string.
const { apiMock, url } = vi.hoisted(() => {
  const query: Partial<Record<string, string>> = {}
  return {
    apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
    url: query,
  }
})
vi.mock("@/lib/api", () => ({ api: apiMock }))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({
    canManage: true,
    canManageDeployment: true,
    isLoading: false,
  }),
}))
vi.mock("@/lib/use-url-state", () => ({
  useUrlEnum: (key: string, fallback: string) => useState(url[key] ?? fallback),
  useUrlText: (key: string, fallback = "") => useState(url[key] ?? fallback),
  useUrlPatch: () => () => {},
}))

const VOCAB = {
  available: [
    "status",
    "monitor",
    "primary_ip",
    "secondary_ip",
    "oob_ip",
    "loopback",
    "serial",
    "tags",
  ],
  pills: ["status", "monitor"],
  defaults: ["monitor", "primary_ip", "loopback", "serial"],
  max_fields: 8,
}

const DEPLOYMENT: TopologyCardSettings = {
  ...VOCAB,
  card_fields: ["primary_ip", "loopback"],
  is_default: false,
  role_overrides: { "role:spine": ["loopback"] },
}

const TENANT: TopologyCardSettings = {
  ...VOCAB,
  override: false,
  card_fields: ["monitor", "primary_ip", "loopback", "serial"],
  is_default: true,
  role_overrides: {},
  deployment_defaults: {
    card_fields: DEPLOYMENT.card_fields,
    is_default: false,
    role_overrides: DEPLOYMENT.role_overrides,
  },
}

const ROLES = [
  { id: "r1", slug: "spine", name: "Spine", color: "3b82f6" },
  { id: "r2", slug: "leaf", name: "Leaf", color: "10b981" },
]

function puts() {
  return apiMock.mock.calls
    .filter(([, init]) => init?.method === "PUT")
    .map(([path, init]) => ({
      path,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    }))
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const invalidate = vi.spyOn(qc, "invalidateQueries")
  const Page = Route.options.component as React.ComponentType
  render(
    <QueryClientProvider client={qc}>
      <Suspense fallback={null}>
        <Page />
      </Suspense>
    </QueryClientProvider>
  )
  return { invalidate }
}

/** The scope list beside the editor. */
const scopes = () => screen.getByText("Applies to").parentElement as HTMLElement

// The route's component is code-split: load it once up front, so no test
// spends its wait on the import.
beforeAll(async () => {
  const lazy = Route.options.component as { preload?: () => Promise<void> }
  await lazy.preload?.()
})

beforeEach(() => {
  for (const k of Object.keys(url)) delete url[k]
  apiMock.mockReset()
  apiMock.mockImplementation((path: string, init?: RequestInit) => {
    if (path === "/api/device-roles/")
      return Promise.resolve({ results: ROLES })
    if (path.startsWith("/api/custom-fields/"))
      return Promise.resolve({
        results: [
          { key: "rack_unit", label: "Rack unit", hidden: false },
          { key: "secret", label: "Secret", hidden: true },
        ],
      })
    if (init?.method === "PUT") {
      // As the server does: null stores nothing and reads back the default.
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      const reset = body.card_fields === null
      return Promise.resolve({
        ...(path.includes("tenant") ? TENANT : DEPLOYMENT),
        ...body,
        ...(reset ? { card_fields: VOCAB.defaults, is_default: true } : {}),
      })
    }
    if (path === "/api/tenant-settings/topology-card/")
      return Promise.resolve(TENANT)
    if (path === "/api/deployment/topology-card/")
      return Promise.resolve(DEPLOYMENT)
    return Promise.resolve({})
  })
})
afterEach(cleanup)

describe("topology card-line settings", () => {
  it("shows the deployment's lines while the tenant inherits", async () => {
    renderPage()
    await screen.findByText("IP · Loopback")
    // The role's own list, under its colour badge.
    expect(screen.getByText("Spine")).toBeTruthy()
    expect(screen.getByText("Loopback")).toBeTruthy()
    // No editor while inheriting.
    expect(screen.queryByText("Applies to")).toBeNull()
  })

  it("seeds a new tenant override from the deployment", async () => {
    renderPage()
    await screen.findByText("IP · Loopback")
    fireEvent.click(screen.getByRole("switch"))
    await screen.findByText("Applies to")
    expect(
      within(scopes()).getByText("Spine").closest("button")?.textContent
    ).toBe("SpineCustom")
    fireEvent.click(screen.getByRole("button", { name: "Save card lines" }))
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0]).toEqual({
      path: "/api/tenant-settings/topology-card/",
      body: {
        card_fields: ["primary_ip", "loopback"],
        role_overrides: { "role:spine": ["loopback"] },
        override: true,
      },
    })
  })

  it("overrides a role with name only, and saves it as an empty list", async () => {
    url.scope = "deployment"
    const { invalidate } = renderPage()
    await screen.findByText("Applies to")
    await within(scopes()).findByText("Leaf")
    fireEvent.click(within(scopes()).getByText("Leaf"))
    expect(screen.getByText("From All devices")).toBeTruthy()
    expect(
      screen
        .getByRole("button", { name: "Inherit" })
        .getAttribute("aria-current")
    ).toBe("page")
    fireEvent.click(screen.getByRole("button", { name: "Custom" }))
    expect(screen.queryByText("From All devices")).toBeNull()
    expect(screen.getByText("2 of 8")).toBeTruthy()

    fireEvent.click(screen.getByRole("switch", { name: "Name only" }))
    expect(
      screen.getByText("The card shows just the device name.")
    ).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Save card lines" }))
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0].body).toEqual({
      card_fields: ["primary_ip", "loopback"],
      role_overrides: { "role:spine": ["loopback"], "role:leaf": [] },
    })
    const keys = invalidate.mock.calls.map(([f]) => f?.queryKey)
    expect(keys).toContainEqual(["topology"])
    expect(keys).toContainEqual(["topology-card"])
  })

  it("puts the list back when name only goes off", async () => {
    url.scope = "deployment"
    renderPage()
    await screen.findByText("Applies to")
    const toggle = screen.getByRole("switch", { name: "Name only" })
    fireEvent.click(toggle)
    expect(screen.getByText("0 of 8")).toBeTruthy()
    fireEvent.click(toggle)
    expect(screen.getByText("2 of 8")).toBeTruthy()
    expect(screen.getByLabelText("Remove IP")).toBeTruthy()
  })

  it("lets a role inherit again", async () => {
    url.scope = "deployment"
    url.role = "spine"
    renderPage()
    await screen.findByText("1 of 8")
    fireEvent.click(screen.getByRole("button", { name: "Inherit" }))
    expect(screen.getByText("From All devices")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Save card lines" }))
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0].body.role_overrides).toEqual({})
  })

  it("gives a role its own list back when it goes Custom again", async () => {
    url.scope = "deployment"
    url.role = "spine"
    renderPage()
    await screen.findByText("1 of 8")
    fireEvent.click(screen.getByRole("button", { name: "Inherit" }))
    fireEvent.click(screen.getByRole("button", { name: "Custom" }))
    // Its own one line, not a copy of All devices' two.
    expect(screen.getByText("1 of 8")).toBeTruthy()
    expect(
      screen.getByRole("button", { name: "Discard" }).hasAttribute("disabled")
    ).toBe(true)
  })

  it("discards unsaved edits", async () => {
    url.scope = "deployment"
    renderPage()
    await screen.findByText("Applies to")
    const discard = screen.getByRole("button", { name: "Discard" })
    expect(discard.hasAttribute("disabled")).toBe(true)
    fireEvent.click(screen.getByRole("switch", { name: "Name only" }))
    expect(screen.getByText("0 of 8")).toBeTruthy()
    fireEvent.click(discard)
    expect(screen.getByText("2 of 8")).toBeTruthy()
    expect(puts()).toHaveLength(0)
  })

  it("restores the built-in default as a reset, not a copy", async () => {
    url.scope = "deployment"
    renderPage()
    await screen.findByText("Applies to")
    fireEvent.click(screen.getByRole("button", { name: "Restore defaults" }))
    fireEvent.click(screen.getByRole("button", { name: "Save card lines" }))
    await waitFor(() => expect(puts()).toHaveLength(1))
    expect(puts()[0].body.card_fields).toBeNull()
  })

  it("offers visible device custom fields only", async () => {
    url.scope = "deployment"
    renderPage()
    await screen.findByRole("button", { name: "Rack unit" })
    expect(screen.queryByRole("button", { name: "Secret" })).toBeNull()
  })
})
