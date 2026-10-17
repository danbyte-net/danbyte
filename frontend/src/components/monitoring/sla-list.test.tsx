// @vitest-environment jsdom
import type { ReactNode } from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"

import { SlaList } from "./sla-list"

// The Overview menu sizes to its labels: a menu as wide as its short
// trigger wrapped "This period, PDF" onto two lines.

vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: () => Promise.resolve({ count: 0, results: [] }),
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({ me: {}, canDo: () => true }),
}))
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<object>()),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
}))
vi.mock("@/components/list-page-shell", () => ({
  ListPageShell: ({ actions }: { actions: ReactNode }) => <div>{actions}</div>,
}))
vi.mock("./holiday-calendars-dialog", () => ({
  HolidayCalendarsButton: () => null,
}))
vi.mock("./sla-follow-up", () => ({ SlaCausesButton: () => null }))
vi.mock("./sla-report-schedules", () => ({
  SlaOverviewSchedulesDialog: () => null,
}))
vi.mock("./sla-templates", () => ({ SlaTemplatesButton: () => null }))

afterEach(cleanup)

describe("SLA list Overview menu", () => {
  it("is as wide as its labels, not its trigger", async () => {
    const qc = new QueryClient()
    render(
      <QueryClientProvider client={qc}>
        <SlaList />
      </QueryClientProvider>
    )
    fireEvent.pointerDown(
      screen.getByRole("button", { name: /overview/i }),
      new PointerEvent("pointerdown", { bubbles: true, button: 0 })
    )
    const item = await screen.findByRole("menuitem", {
      name: "This period, PDF",
    })
    const menu = item.closest("[role=menu]")!
    expect(menu.className).toContain("w-max")
    expect(menu.className).not.toContain("radix-dropdown-menu-trigger-width")
  })
})
