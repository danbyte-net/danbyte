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
import { CableForm } from "./cable-form"

const { apiMock, saveMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  saveMock: vi.fn(),
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof Api>()),
  api: apiMock,
}))
vi.mock("@/lib/save-object", () => ({
  useSaveObject: () => saveMock,
  usePlanTarget: () => null,
}))
// The pickers are covered on their own; here an end is just its port ids.
vi.mock("@/components/cable-endpoint-picker", () => ({
  CableEndpointPicker: ({
    label,
    value,
  }: {
    label: string
    value: { id: string }[]
  }) => (
    <output data-testid={`end-${label}-${value.length}`}>
      {value.map((v) => v.id).join(",") || "none"}
    </output>
  ),
}))
vi.mock("@/components/custom-field-inputs", () => ({
  CustomFieldInputs: () => null,
}))

afterEach(cleanup)

const page = <T,>(results: T[]) => ({ count: results.length, results })

const term = (id: string, name: string, device: string) => ({
  kind: "interface" as const,
  id,
  name,
  device: { id: device, name: device },
})

function cable(id: string, a: string, b: string) {
  const n = (x: string) => x.replace(/^[a-z]+/, "")
  return {
    id,
    a_terminations: [term(a, `Gi1/0/${n(a)}`, "sw1")],
    b_terminations: [term(b, `Eth1/${n(b)}`, "sw2")],
  }
}

function renderForm(onSaved = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={qc}>
      <CableForm
        initialA={[{ kind: "interface", id: "g1" }]}
        initialB={[{ kind: "interface", id: "e1" }]}
        onSaved={onSaved}
        onCancel={vi.fn()}
      />
    </QueryClientProvider>
  )
  return onSaved
}

describe("CableForm - save and add another (#454)", () => {
  beforeEach(() => {
    apiMock.mockReset()
    saveMock.mockReset()
    apiMock.mockImplementation((path: string) => {
      if (path.startsWith("/api/interfaces/?device=sw1"))
        return Promise.resolve(
          page([
            { id: "g2", name: "Gi1/0/2", cable: null },
            { id: "g1", name: "Gi1/0/1", cable: { id: "c1" } },
            { id: "g3", name: "Gi1/0/3", cable: null },
          ])
        )
      if (path.startsWith("/api/interfaces/?device=sw2"))
        return Promise.resolve(
          page([
            { id: "e1", name: "Eth1/1", cable: { id: "c1" } },
            { id: "e2", name: "Eth1/2", cable: null },
          ])
        )
      if (path.startsWith("/api/")) return Promise.resolve(page([]))
      return new Promise(() => {})
    })
  })

  it("keeps the dialog open and moves both ends to the next free port", async () => {
    saveMock.mockResolvedValueOnce(cable("c1", "g1", "e1"))
    const onSaved = renderForm()
    expect(screen.getAllByRole("status").map((el) => el.textContent)).toEqual([
      "g1",
      "e1",
    ])

    fireEvent.click(
      screen.getByRole("button", { name: "Save and add another" })
    )

    expect(await screen.findByText("1 cable added")).toBeTruthy()
    await waitFor(() =>
      expect(screen.getAllByRole("status").map((el) => el.textContent)).toEqual(
        ["g2", "e2"]
      )
    )
    expect(onSaved).not.toHaveBeenCalled()
    expect(saveMock.mock.calls[0][0].payload).toMatchObject({
      a: [{ kind: "interface", id: "g1" }],
      b: [{ kind: "interface", id: "e1" }],
    })
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy()
  })

  it("Ctrl+Enter adds another; Enter saves and closes", async () => {
    saveMock
      .mockResolvedValueOnce(cable("c1", "g1", "e1"))
      .mockResolvedValueOnce(cable("c2", "g2", "e2"))
    const onSaved = renderForm()
    const form = document.querySelector("form")!

    fireEvent.keyDown(form, { key: "Enter", ctrlKey: true })
    expect(await screen.findByText("1 cable added")).toBeTruthy()
    expect(onSaved).not.toHaveBeenCalled()

    await waitFor(() =>
      expect(screen.getAllByRole("status")[0].textContent).toBe("g2")
    )
    fireEvent.keyDown(form, { key: "Enter" })
    fireEvent.submit(form)
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
  })

  it("undo deletes a cable made in this sitting", async () => {
    saveMock.mockResolvedValueOnce(cable("c1", "g1", "e1"))
    renderForm()
    fireEvent.click(
      screen.getByRole("button", { name: "Save and add another" })
    )
    await screen.findByText("1 cable added")
    fireEvent.click(screen.getByRole("button", { name: "Undo" }))
    await waitFor(() =>
      expect(apiMock).toHaveBeenCalledWith("/api/cables/c1/", {
        method: "DELETE",
      })
    )
    await waitFor(() => expect(screen.queryByText("1 cable added")).toBeNull())
  })
})
