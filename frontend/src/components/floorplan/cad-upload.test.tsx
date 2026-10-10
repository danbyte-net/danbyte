// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
} from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ReactElement } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { FloorPlanDrawingSupport } from "@/lib/api"
import { DrawingUpload } from "./cad-upload"
import type { CadDrawingState } from "./use-cad-drawing"
import { drawingAccept, drawingFileProblem } from "./use-cad-drawing"

// The drawing upload takes DXF always and DWG only when the server has a
// converter; without one it says so (the server's message) and refuses a
// DWG before sending it.

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))
vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }))

const render = (ui: ReactElement) =>
  rtlRender(
    <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>
  )

afterEach(() => {
  cleanup()
  toastError.mockReset()
})

const NO_DWG: FloorPlanDrawingSupport = {
  dxf: true,
  dwg: false,
  converter: null,
  message: "DWG files need a converter on the server. Save as DXF.",
  max_upload_bytes: 52428800,
}
const DWG: FloorPlanDrawingSupport = {
  ...NO_DWG,
  dwg: true,
  converter: "dwg2dxf",
  message: "",
}

const file = (name: string, size = 10) => {
  const f = new File(["x"], name)
  Object.defineProperty(f, "size", { value: size })
  return f
}

const mut = () => ({ mutate: vi.fn(), isPending: false })
const cadState = (patch: Partial<CadDrawingState> = {}) =>
  ({
    summary: null,
    drawing: null,
    upload: mut(),
    remove: mut(),
    reprocess: mut(),
    ...patch,
  }) as unknown as CadDrawingState

describe("support gating", () => {
  it("accepts DWG only with a converter", () => {
    expect(drawingAccept(NO_DWG)).toBe(".dxf")
    expect(drawingAccept(DWG)).toBe(".dxf,.dwg")
    expect(drawingAccept(undefined)).toBe(".dxf")
  })

  it("names what is wrong with a file before it is sent", () => {
    expect(drawingFileProblem(file("a.dxf"), NO_DWG)).toBeNull()
    expect(drawingFileProblem(file("a.DWG"), NO_DWG)).toBe(NO_DWG.message)
    expect(drawingFileProblem(file("a.dwg"), DWG)).toBeNull()
    expect(drawingFileProblem(file("a.pdf"), DWG)).toBe(
      "Choose a DXF or DWG file."
    )
    expect(drawingFileProblem(file("a.dxf", 60 * 1048576), DWG)).toBe(
      "The file is over the 50 MB limit."
    )
  })
})

describe("DrawingUpload", () => {
  it("shows the converter message and refuses a DWG", () => {
    const cad = cadState()
    const { container } = render(
      <DrawingUpload cad={cad} hasImage={false} support={NO_DWG} />
    )
    expect(screen.getByText(NO_DWG.message)).toBeTruthy()
    const input = screen.getByTestId<HTMLInputElement>("drawing-file")
    expect(input.accept).toBe(".dxf")
    fireEvent.change(input, { target: { files: [file("plan.dwg")] } })
    expect(cad.upload.mutate).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledWith(NO_DWG.message)
    expect(container.querySelector('[data-part="dwg-note"]')).toBeTruthy()
  })

  it("uploads a DXF straight away on a plan without an image", () => {
    const cad = cadState()
    render(<DrawingUpload cad={cad} hasImage={false} support={DWG} />)
    expect(screen.queryByText(NO_DWG.message)).toBeNull()
    const input = screen.getByTestId<HTMLInputElement>("drawing-file")
    expect(input.accept).toBe(".dxf,.dwg")
    const f = file("plan.dxf")
    fireEvent.change(input, { target: { files: [f] } })
    expect(cad.upload.mutate).toHaveBeenCalledWith(f)
  })

  it("confirms before a drawing replaces the image", () => {
    const cad = cadState()
    render(<DrawingUpload cad={cad} hasImage support={DWG} />)
    const f = file("plan.dxf")
    fireEvent.change(screen.getByTestId("drawing-file"), {
      target: { files: [f] },
    })
    expect(cad.upload.mutate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole("button", { name: "Replace" }))
    expect(cad.upload.mutate).toHaveBeenCalledWith(f, expect.anything())
  })

  it("shows a failed drawing's reason and offers Reprocess", () => {
    const cad = cadState({
      summary: {
        id: "d1",
        status: "failed",
        source_kind: "dxf",
        source_name: "hall.dxf",
        rendered_url: null,
        updated_at: null,
      },
      drawing: {
        status: "failed",
        error: "Not a readable DXF.",
        simplified: [],
      } as unknown as CadDrawingState["drawing"],
    })
    render(<DrawingUpload cad={cad} hasImage={false} support={DWG} />)
    expect(screen.getByText("Not a readable DXF.")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Reprocess" }))
    expect(cad.reprocess.mutate).toHaveBeenCalled()
  })

  it("shows the loading state while queued", () => {
    const cad = cadState({
      summary: {
        id: "d1",
        status: "queued",
        source_kind: "dxf",
        source_name: "hall.dxf",
        rendered_url: null,
        updated_at: null,
      },
    })
    render(<DrawingUpload cad={cad} hasImage={false} support={DWG} />)
    expect(screen.getByRole("status")).toBeTruthy()
  })
})
