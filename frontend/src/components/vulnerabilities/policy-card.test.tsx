// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type * as Api from "@/lib/api"
import type { VulnPolicy } from "@/lib/api"
import { VulnerabilityPolicyCard, notifyPatch } from "./policy-card"

// The tenant's vulnerability policy (#451): thresholds, and which new
// matches are sent to the notification channels - a save sends only what
// changed.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: apiMock,
}))

const POLICY: VulnPolicy = {
  kev_is_fix_first: true,
  fix_first_epss: "0.5",
  fix_first_cvss: "9.0",
  high_cvss: "9.0",
  high_epss: "0.1",
  high_epss_cvss: "7.0",
  medium_cvss: "4.0",
  notify_on: ["fix_first", "critical", "kev"],
  notify_enabled: true,
  updated_at: "2026-11-10T00:00:00Z",
  can_change: true,
}

afterEach(cleanup)

describe("notifyPatch", () => {
  it("sends only what changed, in a fixed order", () => {
    expect(
      notifyPatch(POLICY, {
        notify_enabled: true,
        notify_on: ["kev", "critical", "fix_first"],
      })
    ).toEqual({})
    expect(
      notifyPatch(POLICY, {
        notify_enabled: false,
        notify_on: ["kev", "fix_first"],
      })
    ).toEqual({ notify_enabled: false, notify_on: ["fix_first", "kev"] })
  })
})

describe("VulnerabilityPolicyCard", () => {
  beforeEach(() => {
    apiMock.mockReset()
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/vulnerabilities/settings/") return { enabled: true }
      if (path === "/api/vulnerabilities/policy/" && init?.method === "PATCH")
        return { ...POLICY, ...JSON.parse(String(init.body)) }
      if (path === "/api/vulnerabilities/policy/") return POLICY
      throw new Error(`unexpected ${path}`)
    })
  })

  it("saves the notification choices", async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={qc}>
        <VulnerabilityPolicyCard />
      </QueryClientProvider>
    )
    expect(await screen.findByText("Vulnerability notifications")).toBeTruthy()
    expect(screen.getByText("Vulnerability priority")).toBeTruthy()
    fireEvent.click(screen.getByRole("checkbox", { name: "Critical CVSS" }))
    fireEvent.click(screen.getByRole("button", { name: "Save notifications" }))
    await waitFor(() =>
      expect(apiMock.mock.calls.some(([, i]) => i?.method === "PATCH")).toBe(
        true
      )
    )
    const [, init] = apiMock.mock.calls.find(([, i]) => i?.method === "PATCH")!
    expect(JSON.parse(String(init!.body))).toEqual({
      notify_on: ["fix_first", "kev"],
    })
  })

  it("hides while the feature is off", async () => {
    apiMock.mockImplementation(async () => ({ enabled: false }))
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const { container } = render(
      <QueryClientProvider client={qc}>
        <VulnerabilityPolicyCard />
      </QueryClientProvider>
    )
    await waitFor(() => expect(apiMock).toHaveBeenCalled())
    expect(container.textContent).toBe("")
  })
})
