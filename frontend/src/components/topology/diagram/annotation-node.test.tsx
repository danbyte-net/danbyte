// @vitest-environment jsdom
import { createRef } from "react"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { ReactFlow, ReactFlowProvider } from "@xyflow/react"
import type { Node, NodeProps } from "@xyflow/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { TopologyViewNote } from "@/lib/api"
import { NOTE } from "@/lib/diagram/geometry"
import { fanoutGraph } from "../__fixtures__/fanout-graph"
import { TopologyCanvas } from "../topology-canvas"
import type { CanvasHandle } from "../topology-canvas"
import {
  AnnotationNode,
  noteToNode,
  notesAt,
  selectedNotes,
} from "./annotation-node"
import type { NoteData } from "./annotation-node"

// A note as the owner's reference draws them: free text in muted ink with
// no box ("NSP1", "MPLS L3VPN"), or a cloud over "Internet · DC02".

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  if (!("ResizeObserver" in globalThis))
    globalThis.ResizeObserver = ResizeObserverStub
})
afterEach(cleanup)

const settle = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0))
  })

const TEXT: TopologyViewNote = {
  id: "n1",
  kind: "text",
  x: 100,
  y: 50,
  text: "MPLS L3VPN",
}
const CLOUD: TopologyViewNote = {
  id: "n2",
  kind: "icon",
  icon: "cloud",
  x: 0,
  y: 0,
  text: "Internet · DC02",
}

function renderNote(
  note: TopologyViewNote,
  more: Partial<NoteData> = {},
  selected = false
) {
  const props = {
    id: `note:${note.id}`,
    data: { note, ...more },
    selected,
  } as unknown as NodeProps
  return render(
    <ReactFlowProvider>
      <AnnotationNode {...props} />
    </ReactFlowProvider>
  )
}

describe("AnnotationNode", () => {
  it("draws text in muted ink, without a box", () => {
    const { container } = renderNote(TEXT)
    const body = container.querySelector(".note-body") as HTMLElement
    expect(body.dataset.note).toBe("text")
    expect(body.className).toContain("text-foreground/75")
    expect(body.className).not.toMatch(/\bborder\b/)
    const line = screen.getByText("MPLS L3VPN")
    expect(line.style.fontSize).toBe(`${NOTE.TEXT.m.size}px`)
    expect(line.style.lineHeight).toBe(`${NOTE.TEXT.m.lh}px`)
    // An annotation, not a status: no dot, no pill.
    expect(container.querySelector(".rounded-full")).toBeNull()
  })

  it("puts an outlined note on a chip with a hairline edge", () => {
    const { container } = renderNote({ ...TEXT, outline: true, size: "l" })
    const body = container.querySelector(".note-body") as HTMLElement
    expect(body.className).toMatch(/border-border/)
    expect(body.className).toMatch(/bg-card/)
    expect(body.style.padding).toBe(`${NOTE.PAD_Y - 1}px ${NOTE.PAD_X - 1}px`)
    expect(screen.getByText("MPLS L3VPN").style.fontSize).toBe(
      `${NOTE.TEXT.l.size}px`
    )
  })

  it("draws an icon with its caption under it", () => {
    const { container } = renderNote({ ...CLOUD, size: "s" })
    const body = container.querySelector(".note-body") as HTMLElement
    expect(body.dataset.note).toBe("icon")
    const svg = body.querySelector("svg") as SVGElement
    expect(svg.getAttribute("class")).toMatch(/lucide-cloud/)
    expect(svg.getAttribute("width")).toBe(String(NOTE.ICON.s.icon))
    const caption = screen.getByText("Internet · DC02")
    expect(caption.style.marginTop).toBe(`${NOTE.GAP}px`)
    expect(caption.style.fontSize).toBe(`${NOTE.ICON.s.size}px`)
    // Lucide's Building2 for a building.
    const { container: b } = renderNote({ ...CLOUD, icon: "building" })
    expect(b.querySelector("svg")!.getAttribute("class")).toMatch(
      /lucide-building-2/
    )
  })

  it("edits in place: Enter keeps, Shift+Enter breaks the line", () => {
    const onChange = vi.fn()
    const { container } = renderNote(TEXT, { onChange })
    fireEvent.doubleClick(container.querySelector(".note-body")!)
    const field = screen.getByRole("textbox", { name: "Text" })
    fireEvent.change(field, { target: { value: "  MPLS\nL3VPN  " } })
    fireEvent.keyDown(field, { key: "Enter", shiftKey: true })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.keyDown(field, { key: "Enter" })
    expect(onChange).toHaveBeenCalledWith({ text: "MPLS\nL3VPN" })
    expect(screen.queryByRole("textbox")).toBeNull()
  })

  it("leaves the text as it was on Escape", () => {
    const onChange = vi.fn()
    const { container } = renderNote(TEXT, { onChange })
    fireEvent.doubleClick(container.querySelector(".note-body")!)
    const field = screen.getByRole("textbox", { name: "Text" })
    fireEvent.change(field, { target: { value: "other" } })
    fireEvent.keyDown(field, { key: "Escape" })
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByText("MPLS L3VPN")).toBeTruthy()
  })

  it("deletes a text note emptied; an icon just loses its caption", () => {
    const onDelete = vi.fn()
    const onChange = vi.fn()
    const { container } = renderNote(TEXT, { onDelete, onChange })
    fireEvent.doubleClick(container.querySelector(".note-body")!)
    const field = screen.getByRole("textbox")
    fireEvent.change(field, { target: { value: "  " } })
    fireEvent.blur(field)
    expect(onDelete).toHaveBeenCalled()
    cleanup()
    const icon = renderNote(CLOUD, { onDelete, onChange, autoEdit: true })
    // A note just added opens in its editor.
    const caption = screen.getByRole("textbox", { name: "Caption" })
    fireEvent.change(caption, { target: { value: "" } })
    fireEvent.keyDown(caption, { key: "Enter" })
    expect(onChange).toHaveBeenCalledWith({ text: undefined })
    expect(onDelete).toHaveBeenCalledTimes(1)
    icon.unmount()
  })

  it("offers edit, size, outline and delete when selected", async () => {
    const data: NoteData = {
      note: { ...TEXT, size: "s" },
      onChange: vi.fn(),
      onDelete: vi.fn(),
    }
    const node: Node = {
      id: "note:n1",
      type: "note",
      position: { x: 100, y: 100 },
      selected: true,
      data,
    }
    render(
      <div style={{ width: 800, height: 600 }}>
        <ReactFlowProvider>
          <ReactFlow nodes={[node]} nodeTypes={{ note: AnnotationNode }} />
        </ReactFlowProvider>
      </div>
    )
    await settle()
    const small = screen.getByRole("button", { name: "Small" })
    expect(small.getAttribute("aria-pressed")).toBe("true")
    fireEvent.click(screen.getByRole("button", { name: "Large" }))
    expect(data.onChange).toHaveBeenCalledWith({ size: "l" })
    fireEvent.click(screen.getByRole("button", { name: "Outline" }))
    expect(data.onChange).toHaveBeenCalledWith({ outline: true })
    fireEvent.click(screen.getByRole("button", { name: "Delete" }))
    expect(data.onDelete).toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Edit" }))
    // (Unmeasured in jsdom, React Flow keeps the node itself hidden.)
    expect(screen.getByLabelText("Text")).toBeTruthy()
  })

  it("offers the icons instead of the outline on an icon note", async () => {
    const data: NoteData = { note: CLOUD, onChange: vi.fn() }
    const node: Node = {
      id: "note:n2",
      type: "note",
      position: { x: 100, y: 100 },
      selected: true,
      data,
    }
    render(
      <div style={{ width: 800, height: 600 }}>
        <ReactFlowProvider>
          <ReactFlow nodes={[node]} nodeTypes={{ note: AnnotationNode }} />
        </ReactFlowProvider>
      </div>
    )
    await settle()
    expect(screen.queryByRole("button", { name: "Outline" })).toBeNull()
    expect(
      screen.getByRole("button", { name: "Cloud" }).getAttribute("aria-pressed")
    ).toBe("true")
    fireEvent.click(screen.getByRole("button", { name: "Building" }))
    expect(data.onChange).toHaveBeenCalledWith({ icon: "building" })
  })
})

describe("note nodes", () => {
  it("stand on their centre and read back where they were dragged", () => {
    const cb = { onChange: vi.fn(), onDelete: vi.fn() }
    const node = noteToNode(TEXT, cb)
    expect(node).toMatchObject({
      id: "note:n1",
      type: "note",
      position: { x: 100, y: 50 },
      origin: [0.5, 0.5],
      draggable: true,
    })
    ;(node.data as NoteData).onChange!({ size: "l" })
    expect(cb.onChange).toHaveBeenCalledWith("n1", { size: "l" })
    const moved = { ...node, position: { x: 140.4, y: 80 }, selected: true }
    expect(notesAt([moved], [TEXT])).toEqual([{ ...TEXT, x: 140, y: 80 }])
    expect(notesAt([node], [TEXT])).toBeNull()
    expect(selectedNotes([moved, noteToNode(CLOUD, cb)])).toEqual(["n1"])
  })
})

describe("notes on the canvas", () => {
  it("paint over the cards, stay out of the arrangement, open the new one", async () => {
    const onSelectNode = vi.fn()
    const ref = createRef<CanvasHandle>()
    const { container } = render(
      <div style={{ width: 800, height: 600 }}>
        <TopologyCanvas
          ref={ref}
          graph={fanoutGraph}
          nodeStyle="diagram"
          notes={[TEXT, CLOUD]}
          onNotesChange={vi.fn()}
          editNoteId="n2"
          onSelectNode={onSelectNode}
        />
      </div>
    )
    await settle()
    const order = [...container.querySelectorAll(".react-flow__node")].map(
      (n) => n.getAttribute("data-id")
    )
    // Last: over the cards.
    expect(order.slice(-2)).toEqual(["note:n1", "note:n2"])
    expect(order.length).toBeGreaterThan(2)
    expect(Object.keys(ref.current!.positions())).not.toContain("note:n1")
    expect(Object.keys(ref.current!.boxes())).not.toContain("note:n1")
    // The note just added is selected, in its editor.
    expect(ref.current!.selectedNotes()).toEqual(["n2"])
    expect(screen.getByLabelText("Caption")).toBeTruthy()
    // A click on a note is not a click on a device.
    fireEvent.click(container.querySelector('[data-id="note:n1"]')!)
    expect(onSelectNode).not.toHaveBeenCalled()
  })
})
