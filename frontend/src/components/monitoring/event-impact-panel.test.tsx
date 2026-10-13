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
import type { MaintenanceEvent } from "@/lib/api"
import type { CfObjectPickerProps } from "@/components/cf-object-picker"
import { EventImpactPanel } from "./event-impact-panel"

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
          value: "circuit",
          label: "Circuits",
          endpoint: "/api/circuits/",
          label_field: "cid",
          picker: false,
          route: null,
        },
      ],
    },
  }),
}))
// Radix selects stand in as native ones, labelled like the real fields.
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
vi.mock("@/components/cf-object-picker", () => ({
  CfObjectPicker: (props: CfObjectPickerProps) => {
    pickerProps.current = props
    return (
      <button
        type="button"
        onClick={() =>
          props.onPickMany?.([
            { id: "c1", label: "CID-1" },
            { id: "c2", label: "CID-2" },
          ])
        }
      >
        tick two
      </button>
    )
  },
}))
vi.mock("@/components/planning/object-chip", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ObjectRow: () => <div />,
}))

const apiMock = vi.mocked(api)

const event = {
  id: "e1",
  impacts: [
    {
      id: "i0",
      object_type: "api.circuit",
      object_id: "c0",
      level: "outage",
    },
  ],
} as unknown as MaintenanceEvent

function renderPanel() {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <EventImpactPanel event={event} />
    </QueryClientProvider>
  )
  fireEvent.click(screen.getByRole("button", { name: /Mark impact/ }))
  fireEvent.change(screen.getByLabelText("Object type"), {
    target: { value: "circuit" },
  })
  fireEvent.change(screen.getByLabelText("Impact level"), {
    target: { value: "degraded" },
  })
}

const posted = () =>
  apiMock.mock.calls
    .filter(([, init]) => init?.method === "POST")
    .map(([, init]) => JSON.parse(String(init?.body)))

beforeEach(() => {
  apiMock.mockReset()
  apiMock.mockImplementation(() => Promise.resolve({}))
  toastSuccess.mockReset()
  toastError.mockReset()
})
afterEach(cleanup)

describe("EventImpactPanel multi-pick", () => {
  it("marks every ticked object at the chosen level", async () => {
    renderPanel()
    expect(pickerProps.current?.excludeIds).toEqual(["c0"])
    fireEvent.click(screen.getByRole("button", { name: "tick two" }))
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled())
    expect(posted()).toEqual([
      {
        event: "e1",
        object_type: "circuit",
        object_id: "c1",
        level: "degraded",
      },
      {
        event: "e1",
        object_type: "circuit",
        object_id: "c2",
        level: "degraded",
      },
    ])
    expect(toastSuccess).toHaveBeenCalledWith("Marked 2 objects")
  })

  it("reports a refusal without dropping the rest", async () => {
    apiMock.mockImplementation((_url, init) =>
      String(init?.body).includes('"c1"')
        ? Promise.reject(new ApiError(400, { detail: "Already marked." }))
        : Promise.resolve({})
    )
    renderPanel()
    fireEvent.click(screen.getByRole("button", { name: "tick two" }))
    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(posted()).toHaveLength(2)
    expect(toastError).toHaveBeenCalledWith(
      "Marked 1 of 2 objects, 1 refused",
      {
        description: "Already marked.",
      }
    )
  })
})
