// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { FloorPlan } from "@/lib/api"
import { TooltipProvider } from "@/components/ui/tooltip"

import { BackLabelDeleteDialog, OPENS_GROUPS, OpensEditor } from "./opens-field"
import type { AreaShape, LabelShape, PlanShape } from "./shapes"

// The Opens row: the picker grouped as this plan's floors, its snapshots
// and every other plan; "Make a snapshot of this…" makes a live view and
// links to it; the Back button makes, renames and removes the label on the
// target, and waits for a save and for change on the target.

const { apiMock, allMock, perms, navMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  allMock: vi.fn<(path: string) => Promise<unknown>>(),
  perms: { add: true },
  navMock: vi.fn(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
vi.mock("@/lib/api-all", () => ({ apiAll: allMock }))
vi.mock("@/lib/use-me", () => ({
  useMe: () => ({
    canDo: (_t: string, action: string) =>
      action === "add" ? perms.add : true,
  }),
}))
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navMock }))
Element.prototype.scrollIntoView = () => {}
Element.prototype.hasPointerCapture = () => false
if (!("ResizeObserver" in globalThis))
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

const plan = {
  id: "site",
  name: "Site",
  cell_mm: 600,
  grid_width: 20,
  grid_height: 12,
  stack: { id: "st1", name: "Campus" },
  site: { id: "s1", name: "AMS" },
  location: null,
} as unknown as FloorPlan

const area: AreaShape = {
  kind: "area",
  id: "a1",
  shape: "rect",
  x: 1,
  y: 1,
  width: 4,
  height: 3,
  rotation: 0,
  points: [],
  room: null,
  location: null,
  label: "Yard",
  color: "",
  fill_opacity: 15,
  border: "solid",
  show_name: true,
  z: 0,
  locked: false,
  created_at: "",
  updated_at: "",
}

const label: LabelShape = {
  kind: "label",
  id: "l1",
  text: "Go to B1",
  x: 2,
  y: 2,
  width: null,
  height: null,
  rotation: 0,
  font_mm: 300,
  weight: "normal",
  align: "left",
  color: "",
  plate: false,
  z: 0,
  locked: false,
  created_at: "",
  updated_at: "",
}

const b1 = {
  id: "b1",
  name: "B1",
  stack_name: "Campus",
  kind: "plan" as const,
  can_change: true,
}

function editor(shape: PlanShape, shapes: PlanShape[] = [area, label]) {
  const onChange = vi.fn()
  const onBackLabel = vi.fn()
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <OpensEditor
          plan={plan}
          shape={shape}
          shapes={shapes}
          onChange={onChange}
          onBackLabel={onBackLabel}
        />
      </TooltipProvider>
    </QueryClientProvider>
  )
  return { onChange, onBackLabel }
}

beforeEach(() => {
  perms.add = true
  apiMock.mockImplementation(async (path: string) => {
    if (path === "/api/floor-plan-stacks/st1/")
      return {
        id: "st1",
        name: "Campus",
        floors: [
          { id: "site", name: "Site", floor_order: 0, location_id: null },
          { id: "b1", name: "B1", floor_order: -1, location_id: null },
        ],
      }
    return {}
  })
  allMock.mockImplementation(async (path: string) => {
    if (path.includes("source=site"))
      return {
        results: [
          { id: "v1", name: "Yard view", stack_name: null, kind: "view" },
        ],
      }
    return {
      results: [
        { id: "site", name: "Site", stack_name: "Campus", kind: "plan" },
        { id: "b1", name: "B1", stack_name: "Campus", kind: "plan" },
        { id: "v1", name: "Yard view", stack_name: null, kind: "view" },
        { id: "h1", name: "Ground", stack_name: "Hall A", kind: "plan" },
      ],
    }
  })
})
afterEach(() => {
  cleanup()
  apiMock.mockReset()
  allMock.mockReset()
  navMock.mockReset()
})

async function openPicker() {
  fireEvent.click(screen.getByRole("combobox"))
  return screen.findByRole("dialog")
}

describe("the Opens picker", () => {
  it("groups this plan's floors, its snapshots and the others", async () => {
    editor(area)
    const list = await openPicker()
    await within(list).findByText("Hall A · Ground")
    for (const g of Object.values(OPENS_GROUPS))
      expect(within(list).getByText(g)).toBeTruthy()
    // Never the plan itself; each plan once.
    expect(within(list).queryByText("Site")).toBeNull()
    expect(within(list).getAllByText("Yard view")).toHaveLength(1)
    expect(within(list).getByText("Hall A · Ground")).toBeTruthy()
    expect(within(list).getByText("Make a snapshot of this…")).toBeTruthy()
  })

  it("links the shape to the plan picked", async () => {
    const { onChange } = editor(area)
    const list = await openPicker()
    fireEvent.click(await within(list).findByText("B1"))
    expect(onChange).toHaveBeenCalledWith({
      opens: expect.objectContaining({ id: "b1", name: "B1" }),
      opens_hidden: false,
    })
  })

  it("makes a snapshot of the area and links to it in one step", async () => {
    apiMock.mockImplementation(async (path: string) =>
      path === "/api/floor-plans/site/snapshot/"
        ? { id: "v9", name: "Yard", kind: "view", stack: null, crossing: [] }
        : {}
    )
    const { onChange } = editor(area)
    const list = await openPicker()
    fireEvent.click(within(list).getByText("Make a snapshot of this…"))
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        opens: expect.objectContaining({ id: "v9", kind: "view" }),
        opens_hidden: false,
      })
    )
    const call = apiMock.mock.calls.find(
      ([p]) => p === "/api/floor-plans/site/snapshot/"
    )!
    expect(JSON.parse(String(call[1]?.body))).toMatchObject({
      area_id: "a1",
      mode: "view",
      name: "Yard",
    })
  })

  it("offers a snapshot for a label in a saved area, not one on its own", async () => {
    editor(label, [label])
    const list = await openPicker()
    await within(list).findByText("Hall A · Ground")
    expect(within(list).queryByText("Make a snapshot of this…")).toBeNull()
  })

  it("says so of a hidden target", () => {
    editor({ ...area, opens: null, opens_hidden: true })
    expect(screen.getByRole("combobox").textContent).toContain("Hidden plan")
  })
})

describe("the Back button", () => {
  it("makes the back label on the target", async () => {
    apiMock.mockResolvedValue({
      back_label: {
        id: "bl1",
        floor_plan_id: "b1",
        floor_plan_name: "B1",
        text: "Back to Campus · Site",
      },
    })
    const { onBackLabel } = editor({ ...label, opens: b1 })
    fireEvent.click(screen.getByRole("switch"))
    await waitFor(() =>
      expect(onBackLabel).toHaveBeenCalledWith(
        expect.objectContaining({ id: "bl1" })
      )
    )
    const call = apiMock.mock.calls.find(([p]) => p.endsWith("/back-link/"))!
    expect(call[0]).toBe("/api/floor-plans/site/back-link/")
    expect(JSON.parse(String(call[1]?.body))).toEqual({
      kind: "label",
      id: "l1",
      on: true,
      target_id: "b1",
    })
  })

  it("renames only its own text, and removes it after a confirm", async () => {
    apiMock.mockResolvedValue({ back_label: null })
    const bl = {
      id: "bl1",
      floor_plan_id: "b1",
      floor_plan_name: "B1",
      text: "Go back",
    }
    const { onChange } = editor({ ...label, opens: b1, back_label: bl })
    const input = screen.getByLabelText("Back button text")
    fireEvent.change(input, { target: { value: "Back to the site" } })
    fireEvent.blur(input)
    await waitFor(() => expect(apiMock).toHaveBeenCalled())
    expect(JSON.parse(String(apiMock.mock.calls.at(-1)![1]?.body))).toEqual({
      kind: "label",
      id: "l1",
      on: true,
      target_id: "b1",
      text: "Back to the site",
    })
    expect(onChange).not.toHaveBeenCalled()
    apiMock.mockClear()
    fireEvent.click(screen.getByRole("switch"))
    const dialog = await screen.findByRole("alertdialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }))
    await waitFor(() => expect(apiMock).toHaveBeenCalled())
    expect(JSON.parse(String(apiMock.mock.calls[0][1]?.body))).toMatchObject({
      on: false,
    })
  })

  it("waits for a save and for change on the target", () => {
    editor({ ...label, id: "new-3", opens: b1 })
    expect(screen.getByRole("switch").hasAttribute("disabled")).toBe(true)
    cleanup()
    editor({ ...label, opens: { ...b1, can_change: false } })
    expect(screen.getByRole("switch").hasAttribute("disabled")).toBe(true)
  })

  it("deleting the shape asks about its back label", async () => {
    apiMock.mockResolvedValue({ back_label: null })
    const onDelete = vi.fn()
    const onClose = vi.fn()
    render(
      <QueryClientProvider client={new QueryClient()}>
        <BackLabelDeleteDialog
          plan={plan}
          shape={{
            ...label,
            opens: b1,
            back_label: {
              id: "bl1",
              floor_plan_id: "b1",
              floor_plan_name: "B1",
              text: "Go back",
            },
          }}
          onClose={onClose}
          onDelete={onDelete}
        />
      </QueryClientProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: "Delete both" }))
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith("l1"))
    expect(JSON.parse(String(apiMock.mock.calls[0][1]?.body))).toEqual({
      kind: "label",
      id: "l1",
      on: false,
    })
  })
})
