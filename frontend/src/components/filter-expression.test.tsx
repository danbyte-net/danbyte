// @vitest-environment jsdom
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  cleanup,
  render,
  screen,
  fireEvent,
  within,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

import { ExpressionBuilder, ExpressionEditor } from "./filter-expression"
import type { FieldSpec } from "./filter-expression"
import { format, fromTree, treeId } from "@/lib/filter-expr"
import type { TreeGroup, TreeRule } from "@/lib/filter-expr"

// One row shape is enough: the builder discovers its fields from the rows it
// is given, exactly as a list page hands it their own.
const ROWS = [
  { id: "1", name: "sw1", device_type: { id: "a", name: "Catalyst 9300-48P" } },
  { id: "2", name: "sw2", device_type: { id: "b", name: "Nexus 93240YC-FX2" } },
  { id: "3", name: "srv1", device_type: { id: "c", name: "PowerEdge R640" } },
]

afterEach(cleanup)

describe("advanced filter value picker", () => {
  it("lists the values present in the rows (#117)", () => {
    render(
      <ExpressionEditor
        initial='device_type != ""'
        rows={ROWS}
        onChange={() => {}}
      />
    )
    // Open the value picker on the rule the expression already describes.
    const box = screen.getByPlaceholderText("Value")
    fireEvent.focus(box)

    // Each device type in the rows is offered, with its name readable.
    for (const wanted of [
      "Catalyst 9300-48P",
      "Nexus 93240YC-FX2",
      "PowerEdge R640",
    ]) {
      const hit = screen.getByRole("button", { name: wanted })
      expect(hit).toBeTruthy()
      expect(hit.textContent?.trim()).toBe(wanted)
    }
  })

  it("gives the option list a block scroll container, not a flex column", () => {
    // PopoverContent is a flex column by default. When it is also the scroll
    // container, its children become flex items and shrink away once the list
    // outgrows max-h - the panel renders empty with a scrollbar (#117). jsdom
    // has no layout, so the guard is on the class that prevents it.
    render(
      <ExpressionEditor
        initial='device_type != ""'
        rows={ROWS}
        onChange={() => {}}
      />
    )
    fireEvent.focus(screen.getByPlaceholderText("Value"))
    const panel = document.querySelector(
      '[data-slot="popover-content"].overflow-y-auto'
    )
    expect(panel).toBeTruthy()
    expect(panel!.classList.contains("block")).toBe(true)
    expect(panel!.classList.contains("flex")).toBe(false)
  })
})

// ─── The generalised builder: nesting, typed values, type markers ───────

const { apiAllMock } = vi.hoisted(() => ({
  apiAllMock: vi.fn<(path: string) => Promise<unknown>>(),
}))
vi.mock("@/lib/api-all", () => ({ apiAll: apiAllMock }))

function withQuery(node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>
}

const STATUS: FieldSpec = {
  key: "status",
  label: "Status",
  kind: "ref",
  ops: ["in", "not_in", "empty", "not_empty"],
  ref: {
    model: "status",
    api: "/api/statuses/",
    badge: "status",
    noun: "status",
  },
  types: ["device", "virtualmachine"],
}
const DEVICE_TYPE: FieldSpec = {
  key: "device_type",
  label: "Device type",
  kind: "ref",
  ops: ["in", "not_in", "empty", "not_empty"],
  ref: {
    model: "devicetype",
    api: "/api/device-types/",
    badge: "",
    noun: "device type",
  },
  types: ["device"],
}
const STATE: FieldSpec = {
  key: "profile_state",
  label: "Profile state",
  kind: "choice",
  ops: ["in", "not_in"],
  choices: [
    { value: "ok", label: "In step" },
    { value: "missing", label: "Missing items" },
  ],
  types: ["device", "virtualmachine"],
}
const WARRANTY: FieldSpec = {
  key: "warranty_end",
  label: "Warranty end",
  kind: "date",
  ops: ["=", "<", ">", "empty"],
  types: ["device"],
}

function rule(patch: Partial<TreeRule>): TreeRule {
  return {
    kind: "rule",
    id: treeId(),
    field: "",
    cmp: "=",
    value: "",
    ...patch,
  }
}

describe("expression builder", () => {
  beforeEach(() => {
    apiAllMock.mockReset()
    apiAllMock.mockImplementation(async (path: string) => ({
      count: 2,
      next: null,
      previous: null,
      results: path.startsWith("/api/statuses/")
        ? [
            { id: "s1", name: "Active", color: "10b981" },
            { id: "s2", name: "Planned", color: "" },
          ]
        : [{ id: "t1", name: "C9300" }],
    }))
  })

  it("draws catalog values as their pills and choices by label", async () => {
    const tree: TreeGroup = {
      kind: "group",
      id: treeId(),
      op: "and",
      items: [
        rule({ field: "status", cmp: "in", values: ["s1"] }),
        rule({ field: "profile_state", cmp: "in", values: ["missing"] }),
        rule({ field: "warranty_end", cmp: "<", value: "2027-01-01" }),
      ],
    }
    render(
      withQuery(
        <ExpressionBuilder
          fields={[STATUS, STATE, WARRANTY]}
          value={tree}
          onChange={() => {}}
        />
      )
    )
    // The picked status is its pill, coloured from the catalog row.
    const active = await screen.findByText("Active")
    expect(active.closest("[data-slot=badge]")?.getAttribute("style")).toMatch(
      /background-color/
    )
    expect(screen.getByText("Missing items")).toBeTruthy()
    const date = screen.getByLabelText<HTMLInputElement>("Date")
    expect(date.type).toBe("date")
    expect(date.value).toBe("2027-01-01")
  })

  it("names a hidden or deleted value from the rule's refs", () => {
    const tree: TreeGroup = {
      kind: "group",
      id: treeId(),
      op: "and",
      items: [rule({ field: "status", cmp: "in", values: ["gone", "secret"] })],
    }
    apiAllMock.mockResolvedValue({
      count: 0,
      next: null,
      previous: null,
      results: [],
    })
    render(
      withQuery(
        <ExpressionBuilder
          fields={[STATUS]}
          value={tree}
          onChange={() => {}}
          refs={{
            gone: { name: null, missing: true },
            secret: { name: null, hidden: true },
          }}
        />
      )
    )
    expect(screen.getByText("Deleted")).toBeTruthy()
    expect(screen.getByText("Hidden")).toBeTruthy()
  })

  it("marks a field only some of the chosen types have", () => {
    const tree: TreeGroup = {
      kind: "group",
      id: treeId(),
      op: "and",
      items: [
        rule({ field: "device_type", cmp: "empty" }),
        rule({ field: "status", cmp: "empty" }),
      ],
    }
    const { rerender } = render(
      withQuery(
        <ExpressionBuilder
          fields={[DEVICE_TYPE, STATUS]}
          value={tree}
          onChange={() => {}}
          types={["device", "virtualmachine"]}
        />
      )
    )
    expect(screen.getAllByText("Devices only")).toHaveLength(1)
    rerender(
      withQuery(
        <ExpressionBuilder
          fields={[DEVICE_TYPE, STATUS]}
          value={tree}
          onChange={() => {}}
          types={["device"]}
        />
      )
    )
    expect(screen.queryByText("Devices only")).toBeNull()
  })

  it("nests groups three deep and no further", () => {
    let tree: TreeGroup = {
      kind: "group",
      id: treeId(),
      op: "and",
      items: [rule({ field: "a", value: "1" })],
    }
    const onChange = (next: TreeGroup) => {
      tree = next
    }
    const { rerender } = render(
      <ExpressionBuilder fields={[]} value={tree} onChange={onChange} />
    )
    const addGroup = (n: number) => {
      fireEvent.click(screen.getAllByRole("button", { name: /Group/ })[n])
      rerender(
        <ExpressionBuilder fields={[]} value={tree} onChange={onChange} />
      )
    }
    addGroup(0)
    expect(screen.getAllByTestId("expr-group-2")).toHaveLength(1)
    // The nested group offers one more level; that one offers none.
    const groupButtons = screen.getAllByRole("button", { name: /^Group$/ })
    expect(groupButtons).toHaveLength(2)
    addGroup(0)
    expect(screen.getAllByTestId("expr-group-3")).toHaveLength(1)
    expect(
      within(screen.getByTestId("expr-group-3")).queryByRole("button", {
        name: /^Group$/,
      })
    ).toBeNull()
    expect(format(fromTree(tree))).toBe("a = 1")
  })

  it("keeps the list filter's text in step with the builder", () => {
    const seen: string[] = []
    render(
      <ExpressionEditor
        initial="name = sw1 or (name = sw2 and device_type in (x, y))"
        rows={ROWS}
        onChange={(t) => seen.push(t)}
      />
    )
    // The nested group shows as its own group, not as text only.
    expect(screen.getAllByTestId("expr-group-2")).toHaveLength(1)
    const values = screen.getByPlaceholderText<HTMLInputElement>(
      "Values, comma-separated"
    )
    expect(values.value).toBe("x, y")
    fireEvent.change(values, { target: { value: "x, y, z" } })
    expect(seen.at(-1)).toBe(
      "name = sw1 or name = sw2 and device_type in (x, y, z)"
    )
  })
})
