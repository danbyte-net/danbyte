// @vitest-environment jsdom
import type { ReactNode } from "react"
import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { MonitoringAlert } from "@/lib/api"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AlertStateCell } from "./alert-columns"

vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<object>()),
  Link: ({
    children,
    params,
    className,
  }: {
    children: ReactNode
    params?: { id: string }
    className?: string
  }) => (
    <a href={`/root-causes/${params?.id}`} className={className}>
      {children}
    </a>
  ),
}))

afterEach(cleanup)

const BASE: MonitoringAlert = {
  id: "a1",
  target_ip: { id: "ip1", ip_address: "10.0.0.7" },
  template: null,
  rule_name: null,
  kind: "icmp",
  severity: "critical",
  status: "firing",
  check_status: "down",
  opened_at: "2026-11-14T10:00:00Z",
  last_status_at: "2026-11-14T10:00:00Z",
  resolved_at: null,
  detail: {},
  acknowledged: false,
  acknowledged_at: null,
  acknowledged_by_name: null,
  ack_note: "",
  silenced: false,
  flapping: false,
  escalated: false,
  notify_count: 0,
  notify_state: "sent",
  notify_after: null,
  root_cause: null,
}

function cell(a: Partial<MonitoringAlert>) {
  return render(
    <TooltipProvider>
      <AlertStateCell a={{ ...BASE, ...a }} />
    </TooltipProvider>
  )
}

describe("AlertStateCell - root cause (#450)", () => {
  it("links an explained alert to its root cause", () => {
    cell({
      notify_state: "explained",
      root_cause: {
        id: "rc1",
        status: "open",
        device: { id: "d1", name: "core-1" },
      },
    })
    const link = screen.getByRole("link", { name: /Explained by core-1/ })
    expect(link.getAttribute("href")).toBe("/root-causes/rc1")
  })

  it("counts a held alert down", () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-11-14T10:00:00Z"))
    cell({ notify_state: "held", notify_after: "2026-11-14T10:00:42Z" })
    expect(screen.getByText(/Held · 0:42/)).toBeTruthy()
    vi.useRealTimers()
  })

  it("shows neither chip on an ordinary alert", () => {
    cell({})
    expect(screen.queryByText(/Held/)).toBeNull()
    expect(screen.queryByText(/Explained by/)).toBeNull()
  })

  it("does not show Held once the alert has resolved", () => {
    cell({
      status: "resolved",
      notify_state: "held",
      notify_after: "2026-11-14T10:00:42Z",
    })
    expect(screen.queryByText(/Held/)).toBeNull()
  })
})
