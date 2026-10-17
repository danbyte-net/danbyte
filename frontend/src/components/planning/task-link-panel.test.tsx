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

import { ApiError, api } from "@/lib/api"
import type { PlanningTaskLink } from "@/lib/api"
import type { CfObjectPickerProps } from "@/components/cf-object-picker"
import { TaskLinkPanel } from "./task-link-panel"

const { toastSuccess, toastError, pickerProps } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  pickerProps: { current: null as CfObjectPickerProps | null },
}))

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  api: vi.fn(() => Promise.resolve({})),
}))
vi.mock("sonner", () => ({
  toast: { success: toastSuccess, error: toastError },
}))
vi.mock("@/lib/custom-fields", () => ({
  useCustomizationMeta: () => ({
    data: {
      reference_models: [
        {
          value: "device",
          label: "Devices",
          endpoint: "/api/devices/",
          label_field: "name",
          picker: true,
          route: null,
        },
      ],
    },
  }),
}))
// The type select is a Radix popover; a native select drives it here.
vi.mock("@/components/forms", () => ({
  FormSelect: ({
    label,
    value,
    onChange,
    options,
  }: {
    label: string
    value: string | null
    onChange: (v: string | null) => void
    options: { value: string; label: string }[]
  }) => (
    <select
      aria-label={label}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value || null)}
    >
      <option value="" />
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}))
// The picker itself is ObjectPicker's business; this stands in for its
// multi-pick hand-over.
vi.mock("@/components/cf-object-picker", () => ({
  CfObjectPicker: (props: CfObjectPickerProps) => {
    pickerProps.current = props
    return (
      <button
        type="button"
        onClick={() =>
          props.onPickMany?.([
            { id: "d1", label: "sw-1" },
            { id: "d2", label: "sw-2" },
            { id: "d3", label: "sw-3" },
          ])
        }
      >
        tick three
      </button>
    )
  },
}))
vi.mock("./linked-device-card", () => ({ LinkedDeviceCard: () => <div /> }))
vi.mock("./plan-actions", () => ({ PlanActions: () => null }))
vi.mock("./object-chip", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ObjectRow: () => <div />,
}))

const apiMock = vi.mocked(api)

const link = (objectId: string): PlanningTaskLink => ({
  id: `l-${objectId}`,
  task: "t1",
  object_type: "api.device",
  object_id: objectId,
  note: "",
})

function renderPanel(links: PlanningTaskLink[] = []) {
  const qc = new QueryClient()
  const invalidate = vi.spyOn(qc, "invalidateQueries")
  render(
    <QueryClientProvider client={qc}>
      <TaskLinkPanel taskId="t1" boardId="b1" links={links} canEdit />
    </QueryClientProvider>
  )
  fireEvent.click(screen.getByRole("button", { name: /Link object/ }))
  fireEvent.change(screen.getByLabelText("Object type"), {
    target: { value: "device" },
  })
  return { invalidate }
}

const postedIds = () =>
  apiMock.mock.calls
    .filter(
      ([url, init]) => url === "/api/planning/links/" && init?.method === "POST"
    )
    .map(([, init]) => JSON.parse(String(init?.body)))

beforeEach(() => {
  apiMock.mockReset()
  apiMock.mockImplementation(() => Promise.resolve({}))
  toastSuccess.mockReset()
  toastError.mockReset()
  pickerProps.current = null
})
afterEach(cleanup)

describe("TaskLinkPanel multi-pick", () => {
  it("offers the picker in bulk mode, leaving out what is already linked", () => {
    renderPanel([link("d0"), { ...link("p1"), object_type: "api.prefix" }])
    expect(pickerProps.current?.onPickMany).toBeTypeOf("function")
    expect(pickerProps.current?.excludeIds).toEqual(["d0"])
  })

  it("links every ticked object and says so once", async () => {
    const { invalidate } = renderPanel()
    fireEvent.click(screen.getByRole("button", { name: "tick three" }))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled())
    expect(postedIds()).toEqual([
      { task: "t1", object_type: "device", object_id: "d1" },
      { task: "t1", object_type: "device", object_id: "d2" },
      { task: "t1", object_type: "device", object_id: "d3" },
    ])
    expect(toastSuccess).toHaveBeenCalledTimes(1)
    expect(toastSuccess).toHaveBeenCalledWith("Linked 3 objects")
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["planning-task", "t1"],
    })
    // A clean run closes the form.
    expect(screen.queryByLabelText("Object type")).toBeNull()
  })

  it("keeps the rest when one link is refused, and stays open", async () => {
    apiMock.mockImplementation((_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"))
      return body.object_id === "d2"
        ? Promise.reject(
            new ApiError(403, {
              detail: "You can't link an object you can't view.",
            })
          )
        : Promise.resolve({})
    })
    const { invalidate } = renderPanel()
    fireEvent.click(screen.getByRole("button", { name: "tick three" }))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(postedIds()).toHaveLength(3)
    expect(toastSuccess).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalledWith(
      "Linked 2 of 3 objects, 1 refused",
      {
        description: "You can't link an object you can't view.",
      }
    )
    expect(invalidate).toHaveBeenCalled()
    expect(screen.getByLabelText("Object type")).toBeTruthy()
  })
})
