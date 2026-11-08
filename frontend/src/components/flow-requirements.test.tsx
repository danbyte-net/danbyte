// @vitest-environment jsdom
import type { ReactNode } from "react"
import { cleanup, render, screen, waitFor } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { flexRender } from "@tanstack/react-table"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type * as Api from "@/lib/api"
import type {
  Application,
  ApplicationFlow,
  FlowRequirement,
  FlowRequirementPreview,
} from "@/lib/api"
import { previewText } from "@/lib/flow-requirements"
import { TooltipProvider } from "@/components/ui/tooltip"
import {
  buildFlowRequirementColumns,
  RequirementEndCell,
} from "@/components/columns/flow-requirement-columns"
import { FlowOriginCell } from "@/components/columns/application-flow-columns"
import { FlowRequirementStrip } from "@/components/flow-requirement-strip"
import {
  FlowRequirementsPane,
  requirementEndPayload,
} from "@/components/flow-requirements-pane"

// Application flow requirements: the Requirements tab and its column
// factory, the flows table's Origin column, the device/VM strip and the
// dialog's payload and preview line.

const { apiMock, apiAllMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string) => Promise<unknown>>(),
  apiAllMock: vi.fn<(path: string) => Promise<unknown>>(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: apiMock,
}))
vi.mock("@/lib/api-all", () => ({ apiAll: apiAllMock }))
vi.mock("@tanstack/react-router", async (orig) => ({
  ...(await orig<object>()),
  Link: ({ children }: { children: ReactNode }) => <a>{children}</a>,
  useNavigate: () => () => {},
  useSearch: () => ({}),
  useMatches: () => [],
}))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({ me: {}, canDo: () => true }),
}))

afterEach(cleanup)
beforeEach(() => {
  apiMock.mockReset()
  apiAllMock.mockReset()
  apiMock.mockResolvedValue({})
})

const page = <T,>(results: T[]) => ({ count: results.length, results })

const requirement = {
  id: "r1",
  application: { id: "a1", name: "WMS client", slug: "wms" },
  name: "WMS to Broker",
  description: "",
  source: {
    kind: "self",
    id: null,
    label: "This application",
    application: { id: "a1", name: "WMS client" },
    address: "primary",
    address_role: null,
    hidden: false,
  },
  destination: {
    kind: "app",
    id: null,
    label: "Hosts of Broker",
    application: { id: "a2", name: "Broker" },
    address: "service",
    address_role: null,
    hidden: false,
  },
  source_kind: "self",
  destination_kind: "app",
  source_address: "primary",
  destination_address: "service",
  family: "any",
  pairing: "all",
  protocol: "tcp",
  protocol_display: "TCP",
  ports: "5672",
  direction: "one-way",
  direction_display: "One way",
  status: null,
  state: "partial",
  state_detail: "1 host without a usable address.",
  generated_count: 4,
  gap_count: 1,
  resolved_at: null,
  exclusions: [],
  host: { flows: 0, reason: "no primary address", state: "partial" },
  tags: [],
  custom_fields: {},
  created_at: "",
  updated_at: "",
} as unknown as FlowRequirement

function wrap(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>{node}</TooltipProvider>
    </QueryClientProvider>
  )
}

describe("requirement columns", () => {
  it("keep the canonical order and leave the application out on its page", () => {
    expect(buildFlowRequirementColumns().map((c) => c.id)).toEqual([
      "name",
      "application",
      "source",
      "destination",
      "service",
      "direction",
      "status",
      "state",
      "generated",
      "description",
    ])
    expect(
      buildFlowRequirementColumns({ omit: ["application"] }).map((c) => c.id)
    ).not.toContain("application")
  })

  it("read host ends by application and a hidden fixed end muted", () => {
    render(<RequirementEndCell end={requirement.destination} />)
    expect(screen.getByText("Broker").tagName).toBe("A")
    cleanup()
    render(<RequirementEndCell end={requirement.source} />)
    expect(screen.getByText("This application")).toBeTruthy()
    cleanup()
    const { container } = render(
      <RequirementEndCell
        end={{ ...requirement.destination, kind: "ip", hidden: true }}
      />
    )
    expect(container.textContent).toBe("Hidden")
    expect(container.querySelector("a")).toBeNull()
  })

  it("show the state as a squarish badge", () => {
    const col = buildFlowRequirementColumns().find((c) => c.id === "state")!
    const { container } = render(
      <>{flexRender(col.cell, { row: { original: requirement } } as never)}</>
    )
    expect(container.textContent).toBe("Partial")
    expect(container.querySelector("[data-variant=warning]")).toBeTruthy()
  })
})

describe("flow origin", () => {
  const flow = {
    generated: false,
    overridden_fields: [],
    requirement: null,
    source_install: null,
    destination_install: null,
  } as unknown as ApplicationFlow

  it("reads Manual for a hand-made flow", () => {
    const { container } = wrap(<FlowOriginCell flow={flow} />)
    expect(container.textContent).toBe("Manual")
  })

  it("reads Generated, and Edited when a field was overridden", () => {
    const { container } = wrap(
      <FlowOriginCell
        flow={{
          ...flow,
          generated: true,
          requirement: { id: "r1", name: "WMS to Broker" },
          overridden_fields: ["ports"],
        }}
      />
    )
    expect(container.textContent).toBe("GeneratedEdited")
    expect(container.querySelector("[data-variant=warning]")).toBeTruthy()
  })
})

describe("the device strip", () => {
  it("lists the host's requirements with what is missing", async () => {
    apiAllMock.mockResolvedValue(page([requirement]))
    wrap(<FlowRequirementStrip host={{ kind: "device", id: "d1" }} />)
    await waitFor(() => expect(screen.getByText("WMS to Broker")).toBeTruthy())
    expect(apiAllMock).toHaveBeenCalledWith(
      "/api/application-flow-requirements/?device=d1"
    )
    expect(screen.getByText("WMS client → Broker")).toBeTruthy()
    expect(screen.getByText("TCP 5672")).toBeTruthy()
    expect(screen.getByText("0 flows")).toBeTruthy()
    expect(screen.getByText("no primary address")).toBeTruthy()
  })

  it("renders nothing when no requirement applies", async () => {
    apiAllMock.mockResolvedValue(page([]))
    const { container } = wrap(
      <FlowRequirementStrip host={{ kind: "vm", id: "v1" }} />
    )
    await waitFor(() => expect(apiAllMock).toHaveBeenCalled())
    expect(container.textContent).toBe("")
  })
})

describe("the Requirements tab", () => {
  it("lists the application's requirements with their state", async () => {
    apiAllMock.mockResolvedValue(page([requirement]))
    wrap(
      <FlowRequirementsPane
        app={{ id: "a1", name: "WMS client" } as unknown as Application}
      />
    )
    await waitFor(() => expect(screen.getByText("WMS to Broker")).toBeTruthy())
    expect(apiAllMock).toHaveBeenCalledWith(
      "/api/application-flow-requirements/?application=a1"
    )
    expect(screen.getByText("Partial")).toBeTruthy()
    expect(screen.getByText("Add requirement")).toBeTruthy()
  })

  it("shows an empty state", async () => {
    apiAllMock.mockResolvedValue(page([]))
    wrap(
      <FlowRequirementsPane
        app={{ id: "a1", name: "WMS client" } as unknown as Application}
      />
    )
    await waitFor(() =>
      expect(screen.getByText("No requirements.")).toBeTruthy()
    )
  })
})

describe("the requirement dialog", () => {
  it("sends the chosen end and its address, the others cleared", () => {
    expect(
      requirementEndPayload("destination", {
        kind: "app",
        id: "a2",
        address: "role",
        roleId: "vip",
      })
    ).toEqual({
      destination_kind: "app",
      destination_application_id: "a2",
      destination_ip_id: null,
      destination_range_id: null,
      destination_prefix_id: null,
      destination_address: "role",
      destination_address_role_id: "vip",
    })
    expect(
      requirementEndPayload("source", {
        kind: "prefix",
        id: "p1",
        address: "primary",
        roleId: null,
      })
    ).toEqual({
      source_kind: "prefix",
      source_application_id: null,
      source_ip_id: null,
      source_range_id: null,
      source_prefix_id: "p1",
    })
    expect(
      requirementEndPayload("destination", {
        kind: "ip",
        id: null,
        address: "primary",
        roleId: null,
        hidden: true,
      })
    ).toEqual({ destination_kind: "ip" })
  })

  it("reads the preview as one line", () => {
    const p: FlowRequirementPreview = {
      pairs: 96,
      hosts: 48,
      state: "partial",
      detail: "",
      warn: false,
      refused: false,
      warn_at: 500,
      max: 5000,
      gaps: [
        {
          side: "source",
          host: { kind: "device", id: "d", name: "wms-7" },
          reason: "no address",
        },
      ],
      hidden: 1,
    }
    expect(previewText(p)).toBe(
      "Documents 96 flows on 48 hosts; 2 hosts have no usable address"
    )
    expect(previewText({ ...p, refused: true })).toMatch(/^Too many flows/)
  })
})
