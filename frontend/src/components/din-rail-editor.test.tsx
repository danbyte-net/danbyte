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

import type { CabinetSizes, DinRail } from "@/lib/api"
import { DinRailEditor } from "./din-rail-editor"
import type { DinRailEditorProps } from "./din-rail-editor"

// The rail builder writes a cabinet's rails as one set: kept rails by id, new
// ones without, the rest removed. It answers in the server's words before a
// save, and maps the server's own answer back onto the rows it was sent as.

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

// The profile picker's primitive probes these; jsdom has neither.
Element.prototype.scrollIntoView = () => {}
Element.prototype.hasPointerCapture = () => false

const SIZES: CabinetSizes = {
  inner_width_mm: 525,
  inner_height_mm: 625,
  outer_width_mm: 600,
  outer_height_mm: 700,
  outer_depth_mm: 210,
}
const R1: DinRail = {
  id: "r1",
  label: "R1",
  profile: "ts35",
  x_mm: 0,
  y_mm: 75,
  length_mm: 525,
}
const R2: DinRail = {
  id: "r2",
  label: "R2",
  profile: "ts15",
  x_mm: 0,
  y_mm: 200,
  length_mm: 300,
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })

let calls: { url: string; init: RequestInit }[] = []
let answer: () => Response = () => json(200, { id: "c1" })

beforeEach(() => {
  calls = []
  answer = () => json(200, { id: "c1" })
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit) => {
      calls.push({ url, init })
      return Promise.resolve(answer())
    })
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderEditor(props: Partial<DinRailEditorProps> = {}) {
  const onOpenChange = vi.fn()
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={qc}>
      <DinRailEditor
        open
        onOpenChange={onOpenChange}
        endpoint="/api/cabinets/c1/"
        railKey="rails"
        title="Rails · K1"
        sizes={SIZES}
        rails={[R1]}
        {...props}
      />
    </QueryClientProvider>
  )
  return { onOpenChange }
}

const num = (n: number, name: "left end" | "centreline" | "length") =>
  screen.getByRole<HTMLInputElement>("spinbutton", {
    name: `Rail ${n} ${name}`,
  })
const label = (n: number) =>
  screen.getByRole<HTMLInputElement>("textbox", { name: `Rail ${n} label` })
const row = (n: number) => {
  const el = label(n).closest<HTMLElement>("[data-row]")
  if (!el) throw new Error(`no row ${n}`)
  return el
}
const type = (el: HTMLInputElement, value: string) =>
  fireEvent.change(el, { target: { value } })
const saveButton = () =>
  screen.getByRole<HTMLButtonElement>("button", { name: /Save changes|Saving/ })
const save = () => fireEvent.click(saveButton())
const sent = () => {
  expect(calls).toHaveLength(1)
  return JSON.parse(String(calls[0].init.body)) as Record<string, unknown>
}

describe("DinRailEditor", () => {
  it("adds a rail across the plate, 125 mm below the lowest", () => {
    renderEditor()
    fireEvent.click(screen.getByRole("button", { name: "Add rail" }))
    expect(label(2).value).toBe("R2")
    expect(num(2, "left end").value).toBe("0")
    expect(num(2, "centreline").value).toBe("200")
    expect(num(2, "length").value).toBe("525")
    // ...and it is on the drawing.
    expect(document.querySelector('[data-rail="R2"]')).not.toBeNull()
  })

  it("says what the server would refuse before saving", () => {
    renderEditor()
    type(num(1, "length"), "600")
    expect(
      within(row(1)).getByText("Runs past the plate's right edge (525 mm).")
    ).toBeTruthy()
    expect(num(1, "length").getAttribute("aria-invalid")).toBe("true")
    expect(saveButton().disabled).toBe(true)

    type(num(1, "length"), "525")
    fireEvent.click(screen.getByRole("button", { name: "Add rail" }))
    type(label(2), "R1")
    type(num(2, "centreline"), "90")
    expect(
      within(row(2)).getByText("Another rail has this label.")
    ).toBeTruthy()
    expect(within(row(2)).getByText("Overlaps rail R1.")).toBeTruthy()
    expect(within(row(1)).queryByText(/./, { selector: "p" })).toBeNull()
    // Only the later of the two R1s is drawn as refused.
    expect(document.querySelectorAll('[data-rail="R1"]')).toHaveLength(2)
    expect(
      document.querySelectorAll('[data-rail="R1"][data-invalid]')
    ).toHaveLength(1)
  })

  it("sends the set: kept rails by id, a new one without", async () => {
    const { onOpenChange } = renderEditor({ rails: [R1, R2] })
    type(num(1, "centreline"), "80")
    fireEvent.click(screen.getByRole("button", { name: "Remove rail 2" }))
    fireEvent.click(screen.getByRole("button", { name: "Add rail" }))
    save()
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(calls[0].url).toBe("/api/cabinets/c1/")
    expect(calls[0].init.method).toBe("PATCH")
    expect(sent()).toEqual({
      rails: [
        {
          id: "r1",
          label: "R1",
          profile: "ts35",
          x_mm: 0,
          y_mm: 80,
          length_mm: 525,
        },
        // R2 was removed, so the new rail takes its label.
        { label: "R2", profile: "ts35", x_mm: 0, y_mm: 205, length_mm: 525 },
      ],
    })
  })

  it("writes a type's templates under its own key", async () => {
    const { onOpenChange } = renderEditor({
      endpoint: "/api/cabinet-types/t1/",
      railKey: "rail_templates",
      rails: [],
    })
    expect(screen.getByText("No rails yet.")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Add rail" }))
    save()
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
    expect(calls[0].url).toBe("/api/cabinet-types/t1/")
    expect(sent()).toEqual({
      rail_templates: [
        { label: "R1", profile: "ts35", x_mm: 0, y_mm: 75, length_mm: 525 },
      ],
    })
  })

  it("puts the server's per-rail errors on the rows they were sent as", async () => {
    answer = () =>
      json(400, { rails: [{}, { y_mm: ["Overlaps rail R1."] }, {}] })
    const { onOpenChange } = renderEditor({ rails: [R1, R2] })
    fireEvent.click(screen.getByRole("button", { name: "Add rail" }))
    save()
    await waitFor(() =>
      expect(within(row(2)).getByText("Overlaps rail R1.")).toBeTruthy()
    )
    expect(num(2, "centreline").getAttribute("aria-invalid")).toBe("true")
    expect(within(row(1)).queryByText("Overlaps rail R1.")).toBeNull()
    expect(within(row(3)).queryByText("Overlaps rail R1.")).toBeNull()
    expect(onOpenChange).not.toHaveBeenCalled()
    // Still savable - and editing the row clears the stale answer.
    expect(saveButton().disabled).toBe(false)
    type(num(2, "centreline"), "250")
    expect(within(row(2)).queryByText("Overlaps rail R1.")).toBeNull()
  })

  it("shows a refusal of the whole set above the rows", async () => {
    answer = () =>
      json(400, {
        rails: ["R1 carries 2 devices (plc-01, io-02) - move them first."],
        inner_width_mm: ["Rail R2: Runs past the plate's right edge (400 mm)."],
      })
    renderEditor({ rails: [R1, R2] })
    fireEvent.click(screen.getByRole("button", { name: "Remove rail 1" }))
    save()
    const set = await screen.findByTestId("rail-set-errors")
    expect(set.textContent).toContain(
      "R1 carries 2 devices (plc-01, io-02) - move them first."
    )
    expect(set.textContent).toContain(
      "Rail R2: Runs past the plate's right edge (400 mm)."
    )
    expect(sent()).toEqual({
      rails: [
        {
          id: "r2",
          label: "R2",
          profile: "ts15",
          x_mm: 0,
          y_mm: 200,
          length_mm: 300,
        },
      ],
    })
  })

  it("moves a rail nudged on the drawing", () => {
    renderEditor()
    const r1 = screen.getByRole("button", { name: "Rail R1" })
    fireEvent.focus(r1)
    fireEvent.keyDown(r1, { key: "ArrowDown", shiftKey: true })
    expect(num(1, "centreline").value).toBe("85")
    expect(row(1).getAttribute("data-selected")).toBe("true")
  })

  it("closes without writing when nothing changed, and Cancel discards", () => {
    const first = renderEditor()
    save()
    expect(first.onOpenChange).toHaveBeenCalledWith(false)
    cleanup()

    const second = renderEditor()
    type(num(1, "centreline"), "90")
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(second.onOpenChange).toHaveBeenCalledWith(false)
    expect(calls).toHaveLength(0)
  })
})
