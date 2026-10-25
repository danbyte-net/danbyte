// @vitest-environment jsdom
import type { ReactNode } from "react"
import { cleanup, render, screen, within } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { UseQueryResult } from "@tanstack/react-query"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { ComplianceSummary } from "@/lib/api"

import { ComplianceOverview } from "./compliance-overview"

const search: Record<string, string | undefined> = {}

vi.mock("@/lib/use-me", () => ({
  useMe: () => ({ me: {}, canDo: () => true }),
}))
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<object>()),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useSearch: () => ({ tab: "overview", ...search }),
  useNavigate: () => () => undefined,
}))
vi.mock("@/components/data-table", async (orig) => ({
  ...(await orig<object>()),
  DataTable: ({ data }: { data: { object_repr: string }[] }) => (
    <ul aria-label="offenders">
      {data.map((o) => (
        <li key={o.object_repr}>{o.object_repr}</li>
      ))}
    </ul>
  ),
}))

afterEach(cleanup)

const base = {
  check_type: "required" as const,
  field: "serial_number",
  pattern: "",
  tag: "",
  cf_key: "",
  eol_fail_on: "" as const,
  coverage_fail_on: "" as const,
  fail_on_unknown: false,
  object_type: "device",
  object_type_label: "Device",
  acknowledged: 0,
  snoozed: 0,
}

const summary: ComplianceSummary = {
  evaluated_at: "2026-10-25T10:00:00Z",
  totals: {
    rules: 3,
    disabled_rules: 0,
    passing: 1,
    failing: 2,
    violations: 5,
    open: 4,
    acknowledged: 1,
    snoozed: 0,
    objects_in_violation: 3,
  },
  by_severity: {
    critical: { rules: 1, failing_rules: 1, violations: 3, open: 3 },
    warning: { rules: 1, failing_rules: 1, violations: 2, open: 1 },
    info: { rules: 1, failing_rules: 0, violations: 0, open: 0 },
  },
  rules: [
    {
      ...base,
      id: "ok",
      name: "Names set",
      severity: "info",
      violations: 0,
      open: 0,
    },
    {
      ...base,
      id: "w",
      name: "Asset tag",
      severity: "warning",
      violations: 2,
      open: 1,
      acknowledged: 1,
    },
    {
      ...base,
      id: "c",
      name: "Serial",
      severity: "critical",
      violations: 3,
      open: 3,
    },
  ],
  top_offenders: [
    {
      object_type: "device",
      object_type_label: "Device",
      object_id: "d1",
      object_repr: "sw1",
      site_name: "AMS",
      violations: 2,
      open: 2,
      worst_severity: "critical",
      rules: ["Serial", "Asset tag"],
    },
  ],
}

function show() {
  const qc = new QueryClient()
  const query = {
    data: summary,
    isError: false,
  } as unknown as UseQueryResult<ComplianceSummary>
  render(
    <QueryClientProvider client={qc}>
      <ComplianceOverview query={query} />
    </QueryClientProvider>
  )
}

describe("the compliance overview", () => {
  it("shows one card per rule, worst first, with its result", () => {
    show()
    const names = screen
      .getAllByText(/^(Serial|Asset tag|Names set)$/)
      .map((n) => n.textContent)
    expect(names).toEqual(["Serial", "Asset tag", "Names set"])
    expect(screen.getByText("3 devices")).toBeTruthy()
    expect(screen.getByText("1 device")).toBeTruthy()
    expect(screen.getByText("1 triaged")).toBeTruthy()
    expect(screen.getByText("OK")).toBeTruthy()
  })

  it("hides passing rules on request", () => {
    search.failing = "1"
    show()
    expect(screen.queryByText("Names set")).toBeNull()
    delete search.failing
  })

  it("lists the top offenders", () => {
    show()
    const list = screen.getByRole("list", { name: "offenders" })
    expect(within(list).getByText("sw1")).toBeTruthy()
  })
})
