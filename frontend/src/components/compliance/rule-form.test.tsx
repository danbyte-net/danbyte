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
import type { ComplianceField, ComplianceRule } from "@/lib/api"
import { ComplianceRuleForm, suits, vulnFields } from "./rule-form"
import { splitSpaPath, ruleSummary } from "./compliance-shared"

// The rule form: object-type toggles re-read the fields and mark the rows a
// chosen type lacks, the preview counts per type, and an error the server
// reports against a path lands on that row.

const { apiMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: apiMock,
}))
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<object>()),
  useNavigate: () => () => {},
  useRouterState: (opts: {
    select: (s: { location: { search: object } }) => unknown
  }) => opts.select({ location: { search: {} } }),
}))
vi.mock("@/lib/api-all", () => ({
  apiAll: async () => ({ count: 0, next: null, previous: null, results: [] }),
}))

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub)
// A field error is scrolled into view; jsdom has no layout.
Element.prototype.scrollIntoView = () => {}

const ROLE_ID = "11111111-1111-1111-1111-111111111111"
const TAG_ID = "7"

function field(
  key: string,
  label: string,
  kind: ComplianceField["kind"],
  types: string[],
  ref: ComplianceField["ref"] = null
): ComplianceField {
  return {
    key,
    label,
    kind,
    types,
    ops:
      kind === "ref" || kind === "tags"
        ? ["in", "not_in", "empty", "not_empty"]
        : ["=", "!=", "empty", "not_empty"],
    ref,
    choices: [],
  }
}

function fieldsFor(types: string[]): ComplianceField[] {
  const both = ["device", "virtualmachine"].filter((t) => types.includes(t))
  return [
    field("role", "Device role", "ref", both, {
      model: "devicerole",
      api: "/api/device-roles/",
      badge: "color",
      noun: "device role",
    }),
    field("tags", "Tags", "tags", both, {
      model: "tag",
      api: "/api/tags/?picker=1",
      badge: "color",
      noun: "tag",
    }),
    ...(types.includes("device")
      ? [field("serial_number", "Serial number", "string", ["device"])]
      : []),
  ]
}

const RULE: ComplianceRule = {
  id: "r1",
  name: "Servers",
  description: "",
  remediation: "",
  enabled: true,
  severity: "warning",
  object_type: "device",
  object_types: ["device"],
  object_type_label: "Device",
  scope: { kind: "cmp", field: "role", cmp: "in", values: [ROLE_ID] },
  condition: {
    kind: "group",
    op: "and",
    terms: [
      { kind: "empty", field: "serial_number", negated: true },
      { kind: "cmp", field: "tags", cmp: "in", values: [TAG_ID] },
    ],
  },
  refs: {
    [ROLE_ID]: { name: "Server", color: "2f6fdd" },
    [TAG_ID]: { name: "pci", color: "" },
  },
  check_type: "expression",
  check_type_display: "Conditions",
  field: "",
  pattern: "",
  tag: "",
  cf_key: "",
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
}

function renderForm(rule?: ComplianceRule) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <ComplianceRuleForm rule={rule} onSaved={() => {}} onCancel={() => {}} />
    </QueryClientProvider>
  )
}

afterEach(cleanup)

describe("known vulnerabilities check", () => {
  it("suits devices and VMs only", () => {
    expect(suits("vulnerabilities", ["device", "virtualmachine"])).toBe(true)
    expect(suits("vulnerabilities", ["device", "prefix"])).toBe(false)
  })

  it("sends the score only when it fails on CVSS", () => {
    expect(vulnFields("vulnerabilities", "cvss", "9.8")).toEqual({
      vuln_fail_on: "cvss",
      cvss_min: 9.8,
    })
    expect(vulnFields("vulnerabilities", "kev", "9.8")).toEqual({
      vuln_fail_on: "kev",
      cvss_min: null,
    })
    expect(vulnFields("expression", "kev", "9")).toEqual({
      vuln_fail_on: "",
      cvss_min: null,
    })
  })

  it("reads as words and links its violations", () => {
    const base = { field: "", pattern: "", tag: "", cf_key: "" }
    expect(
      ruleSummary({
        ...base,
        check_type: "vulnerabilities",
        vuln_fail_on: "cvss",
        cvss_min: "9.0",
      })
    ).toBe("no open vulnerability of CVSS 9.0 or over")
    expect(
      ruleSummary({
        ...base,
        check_type: "vulnerabilities",
        vuln_fail_on: "kev",
      })
    ).toBe("no open vulnerability in CISA KEV")
    expect(splitSpaPath("/devices/d1?tab=vulnerabilities")).toEqual({
      to: "/devices/d1",
      search: { tab: "vulnerabilities" },
    })
    expect(splitSpaPath("https://evil.example/")).toBeNull()
    expect(splitSpaPath("//evil.example/")).toBeNull()
  })
})

describe("compliance rule form", () => {
  beforeEach(() => {
    apiMock.mockReset()
    apiMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/compliance/fields/")) {
        const types = new URL(path, "http://x").searchParams
          .get("object_types")!
          .split(",")
        return { fields: fieldsFor(types) }
      }
      if (path === "/api/compliance-rules/preview/")
        return {
          by_type: {
            device: {
              in_scope: 214,
              failing: 12,
              sample: [{ id: "d1", repr: "srv1", site_name: "AMS" }],
            },
            virtualmachine: { in_scope: 38, failing: 3, sample: [] },
          },
          error: null,
        }
      throw new Error(`unexpected ${path}`)
    })
  })

  it("marks a row the added type lacks", async () => {
    renderForm(RULE)
    await screen.findByText("Server")
    expect(screen.queryByText("Devices only")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Virtual machine" }))
    expect(await screen.findByText("Devices only")).toBeTruthy()
    await waitFor(() =>
      expect(
        apiMock.mock.calls.some(
          ([p]) =>
            p === "/api/compliance/fields/?object_types=device,virtualmachine"
        )
      ).toBe(true)
    )
  })

  it("previews counts per type", async () => {
    renderForm(RULE)
    expect(
      await screen.findByText(/In scope 214 devices/, {}, { timeout: 3000 })
    ).toBeTruthy()
    expect(screen.getByText(/failing 12 · 3/)).toBeTruthy()
    const [, init] = apiMock.mock.calls.find(
      ([p]) => p === "/api/compliance-rules/preview/"
    )!
    const sent = JSON.parse(String(init!.body))
    expect(sent.object_types).toEqual(["device"])
    expect(sent.scope).toEqual(RULE.scope)
  })

  it("sends a known vulnerabilities check with its CVSS score", async () => {
    let sent: Record<string, unknown> | null = null
    const { ApiError } = await vi.importActual<typeof Api>("@/lib/api")
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith("/api/compliance/fields/"))
        return { fields: fieldsFor(["device"]) }
      if (path === "/api/compliance-rules/preview/")
        return { by_type: {}, error: null }
      if (path === "/api/compliance-rules/r1/" && init?.method === "PATCH") {
        sent = JSON.parse(String(init.body))
        throw new ApiError(400, { cvss_min: ["A CVSS score from 0.1 to 10."] })
      }
      throw new Error(`unexpected ${path}`)
    })
    renderForm({
      ...RULE,
      check_type: "vulnerabilities",
      condition: null,
      vuln_fail_on: "cvss",
      cvss_min: "9.0",
    })
    expect(
      (await screen.findAllByText("CVSS at or over")).length
    ).toBeGreaterThan(0)
    const score = screen.getByRole("spinbutton") as HTMLInputElement
    expect(score.value).toBe("9")
    fireEvent.change(score, { target: { value: "7.5" } })
    fireEvent.click(screen.getByRole("button", { name: "Save rule" }))
    expect(await screen.findByText("A CVSS score from 0.1 to 10.")).toBeTruthy()
    expect(sent).toMatchObject({
      check_type: "vulnerabilities",
      vuln_fail_on: "cvss",
      cvss_min: 7.5,
      condition: null,
    })
  })

  it("puts a server error on the row its path names", async () => {
    const { ApiError } = await vi.importActual<typeof Api>("@/lib/api")
    apiMock.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith("/api/compliance/fields/"))
        return { fields: fieldsFor(["device"]) }
      if (path === "/api/compliance-rules/preview/")
        return { by_type: {}, error: null }
      if (path === "/api/compliance-rules/r1/" && init?.method === "PATCH")
        throw new ApiError(400, {
          condition: [
            {
              path: "terms.1.values.0",
              detail: "Not one of this tenant's tags.",
            },
          ],
        })
      throw new Error(`unexpected ${path}`)
    })
    renderForm(RULE)
    await screen.findByText("pci")
    fireEvent.click(screen.getByRole("button", { name: "Save rule" }))
    const msg = await screen.findByText("Not one of this tenant's tags.")
    // On the tags row, not the serial number row.
    const row = msg.closest("[data-testid=expr-row]")!
    expect(row.textContent).toContain("pci")
    expect(row.className).toContain("ring-destructive")
  })
})
