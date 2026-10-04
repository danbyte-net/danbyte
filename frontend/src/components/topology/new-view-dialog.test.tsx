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
import type { TopologyViewState } from "@/lib/api"
import { MAX_VIEW_DEVICES, NewViewDialog } from "./new-view-dialog"
import type { NewViewDialogProps } from "./new-view-dialog"

const { apiMock, toastMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  toastMock: vi.fn(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: apiMock,
}))
vi.mock("@/lib/api-toast", () => ({ apiErrorToast: toastMock }))
// The write goes through useSaveObject, which reads the location for plan
// mode; outside a plan it is a plain POST.
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => () => {},
  useRouterState: (opts: {
    select: (s: { location: { search: object } }) => unknown
  }) => opts.select({ location: { search: {} } }),
}))

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (!("ResizeObserver" in globalThis))
  (globalThis as unknown as Record<string, unknown>).ResizeObserver =
    ResizeObserverStub

const BLANK: TopologyViewState = {
  filters: { viewStyle: "diagram", devices: [] },
}
const MAP: TopologyViewState = {
  filters: { viewStyle: "diagram", devices: ["a", "b"] },
  positions_by_style: { diagram: { "dev:a": [0, 0], "dev:b": [200, 0] } },
}

function renderDialog(over: Partial<NewViewDialogProps> = {}) {
  const props: NewViewDialogProps = {
    open: true,
    onOpenChange: vi.fn(),
    mapCount: 2,
    stateFor: vi.fn((start) => (start === "map" ? MAP : BLANK)),
    taken: ["Core row"],
    onCreated: vi.fn(),
    ...over,
  }
  const qc = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={qc}>
      <NewViewDialog {...props} />
    </QueryClientProvider>
  )
  return props
}

const nameBox = () => screen.getByPlaceholderText("Core row · dc1")
const create = () => screen.getByRole("button", { name: "Create" })

beforeEach(() => {
  apiMock.mockReset()
  toastMock.mockReset()
  apiMock.mockImplementation((_path, init) => {
    const body = JSON.parse(String(init?.body)) as {
      name: string
      state: TopologyViewState
    }
    return Promise.resolve({
      id: "v1",
      numid: 1,
      name: body.name,
      state: body.state,
      created_at: "2026-09-27T10:00:00Z",
      updated_at: "2026-09-27T10:00:00Z",
    })
  })
})
afterEach(cleanup)

describe("NewViewDialog", () => {
  it("creates a blank view by name", async () => {
    const props = renderDialog()
    expect(create()).toHaveProperty("disabled", true)
    fireEvent.change(nameBox(), { target: { value: "  Fabric  " } })
    fireEvent.click(create())
    await waitFor(() => expect(props.onCreated).toHaveBeenCalled())
    const [path, init] = apiMock.mock.calls[0]
    expect(path).toBe("/api/topology-views/")
    expect(init?.method).toBe("POST")
    expect(JSON.parse(String(init?.body))).toEqual({
      name: "Fabric",
      state: BLANK,
    })
    expect(props.stateFor).toHaveBeenCalledWith("blank")
    expect(vi.mocked(props.onCreated).mock.calls[0][1]).toBe("blank")
    expect(props.onOpenChange).toHaveBeenCalledWith(false)
  })

  it("takes this map's devices when asked", async () => {
    const props = renderDialog()
    fireEvent.change(nameBox(), { target: { value: "Here" } })
    fireEvent.click(screen.getByRole("button", { name: /This map/ }))
    fireEvent.click(create())
    await waitFor(() => expect(props.onCreated).toHaveBeenCalled())
    expect(JSON.parse(String(apiMock.mock.calls[0][1]?.body)).state).toEqual(
      MAP
    )
  })

  it(`refuses This map above ${MAX_VIEW_DEVICES.toLocaleString("en")} devices`, () => {
    renderDialog({ mapCount: MAX_VIEW_DEVICES + 1 })
    fireEvent.change(nameBox(), { target: { value: "Everything" } })
    fireEvent.click(screen.getByRole("button", { name: /This map/ }))
    expect(create()).toHaveProperty("disabled", true)
    expect(screen.getByText(/narrow the filters first/)).toBeTruthy()
    // Blank is still fine.
    fireEvent.click(screen.getByRole("button", { name: "Blank" }))
    expect(create()).toHaveProperty("disabled", false)
  })

  it("says a name is taken, before and after asking the server", async () => {
    const props = renderDialog()
    fireEvent.change(nameBox(), { target: { value: "Core row" } })
    fireEvent.click(create())
    expect(
      screen.getByText("A view with this name already exists.")
    ).toBeTruthy()
    expect(apiMock).not.toHaveBeenCalled()
    // Someone else took it meanwhile: the database refuses with 409.
    const { ApiError } = await import("@/lib/api")
    apiMock.mockRejectedValueOnce(new ApiError(409, { detail: "conflict" }))
    fireEvent.change(nameBox(), { target: { value: "Edge" } })
    fireEvent.click(create())
    await screen.findByText("A view with this name already exists.")
    expect(props.onCreated).not.toHaveBeenCalled()
    expect(toastMock).not.toHaveBeenCalled()
  })
})
