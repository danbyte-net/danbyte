// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  IntegrationGate,
  integrationKeysFor,
  integrationOffTitle,
} from "./integration-gate"

// An integration's pages while it is switched off show an empty state, not
// the API's raw "404 Integration not enabled." with a live Add button (#429).

const { apiMock, meState } = vi.hoisted(() => ({
  apiMock: vi.fn(),
  meState: { canManage: false },
}))

vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
vi.mock("@/lib/use-me", () => ({ useMe: () => meState }))
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<object>()),
  Link: ({ to, children }: { to: string; children: ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}))

let toggles: Record<string, boolean>
beforeEach(() => {
  toggles = {}
  meState.canManage = false
  apiMock.mockReset()
  apiMock.mockImplementation(async (path: string) => {
    if (path === "/api/integrations/enabled/") return toggles
    throw new Error(`unexpected ${path}`)
  })
})
afterEach(cleanup)

function gate(pathname: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <IntegrationGate pathname={pathname}>
        <p>the page</p>
      </IntegrationGate>
    </QueryClientProvider>
  )
}

describe("integrationKeysFor", () => {
  it.each([
    ["/zabbix", ["zabbix"]],
    ["/oxidized", ["oxidized"]],
    ["/dhcp-leases", ["dhcp"]],
    ["/windows-servers", ["dhcp", "dns"]],
    ["/windows-servers/5f1c", ["dhcp", "dns"]],
    ["/virtualization-sources", ["virtualization"]],
    ["/virtualization-sources/5f1c", ["virtualization"]],
    ["/agent-access", ["ai"]],
  ])("%s needs %j", (path, keys) => {
    expect(integrationKeysFor(path)).toEqual(keys)
  })

  it.each(["/devices", "/dhcp-reservations", "/zabbixish", "/settings"])(
    "%s needs none",
    (path) => {
      expect(integrationKeysFor(path)).toBeNull()
    }
  )
})

describe("integrationOffTitle", () => {
  it("names one or several", () => {
    expect(integrationOffTitle(["zabbix"])).toBe("Zabbix is off.")
    expect(integrationOffTitle(["dhcp", "dns"])).toBe(
      "DHCP sync and DNS sync are off."
    )
  })
})

describe("IntegrationGate", () => {
  it("shows an empty state instead of mounting the page when off", async () => {
    gate("/zabbix")
    expect(await screen.findByText("Zabbix is off.")).toBeTruthy()
    expect(screen.queryByText("the page")).toBeNull()
    expect(screen.getByText(/administrator can turn it on/)).toBeTruthy()
    expect(screen.queryByRole("link")).toBeNull()
  })

  it("gives an admin the link to the switch", async () => {
    meState.canManage = true
    gate("/dhcp-leases")
    expect(await screen.findByText("DHCP sync is off.")).toBeTruthy()
    const link = screen.getByRole("link", { name: "Settings → Integrations" })
    expect(link.getAttribute("href")).toBe("/settings/integrations")
  })

  it("covers an integration's detail pages too", async () => {
    gate("/virtualization-sources/abc")
    expect(await screen.findByText("Virtualization sync is off.")).toBeTruthy()
  })

  it("renders the page when the integration is on", async () => {
    toggles = { zabbix: true }
    gate("/zabbix")
    expect(await screen.findByText("the page")).toBeTruthy()
  })

  it("opens on any one of several toggles", async () => {
    toggles = { dhcp: false, dns: true }
    gate("/windows-servers")
    expect(await screen.findByText("the page")).toBeTruthy()
  })

  it("leaves other pages alone without asking", () => {
    gate("/devices")
    expect(screen.getByText("the page")).toBeTruthy()
    expect(apiMock).not.toHaveBeenCalled()
  })

  it("renders the page when the toggles cannot be read", async () => {
    apiMock.mockRejectedValue(new Error("boom"))
    gate("/oxidized")
    expect(await screen.findByText("the page")).toBeTruthy()
  })
})
