// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ApiError } from "@/lib/api"
import { mergeDeleteAnswers, SafeBulkDeleteBar } from "./safe-bulk-delete-bar"
import type { SafeBulkDeleteResult } from "./safe-bulk-delete-bar"

const { apiMock, toastMock } = vi.hoisted(() => ({
  apiMock: vi.fn<(path: string, init?: RequestInit) => Promise<unknown>>(),
  toastMock: { success: vi.fn(), error: vi.fn() },
}))
vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<object>()),
  api: apiMock,
}))
vi.mock("sonner", () => ({ toast: toastMock }))

afterEach(cleanup)

const answer = (o: Partial<SafeBulkDeleteResult>): SafeBulkDeleteResult => ({
  deleted: 1,
  deleted_ids: ["a"],
  skipped: [],
  impact: [],
  released: [],
  dry_run: true,
  ...o,
})

const rows = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `r${i}` }))

function renderBar(
  extra: Partial<Parameters<typeof SafeBulkDeleteBar>[0]> = {}
) {
  const qc = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  })
  const onCleared = vi.fn()
  render(
    <QueryClientProvider client={qc}>
      <SafeBulkDeleteBar
        selected={[{ id: "a" }, { id: "b" }]}
        endpoint="/api/virtual-chassis/"
        noun={["virtual chassis", "virtual chassis"]}
        invalidate={[["virtual-chassis"]]}
        onCleared={onCleared}
        {...extra}
      />
    </QueryClientProvider>
  )
  return onCleared
}

/** The ids of every call so far, and whether it was a dry run. */
const sent = () =>
  apiMock.mock.calls.map(([, init]) => {
    const body = JSON.parse(String(init?.body)) as {
      ids: string[]
      dry_run?: boolean
    }
    return { n: body.ids.length, dry: !!body.dry_run, first: body.ids[0] }
  })

describe("SafeBulkDeleteBar", () => {
  beforeEach(() => {
    apiMock.mockReset()
    toastMock.success.mockReset()
    toastMock.error.mockReset()
  })

  it("asks first what would go, what is released and what is kept", async () => {
    apiMock.mockResolvedValueOnce(
      answer({
        released: [{ label: "member devices", count: 3 }],
        skipped: [{ id: "b", name: "stack-2", reason: "In use: 1 circuit." }],
      })
    )
    renderBar()
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }))
    expect(await screen.findByText("3 member devices")).toBeTruthy()
    expect(screen.getByText("stack-2")).toBeTruthy()
    const [url, init] = apiMock.mock.calls[0]
    expect(url).toBe("/api/virtual-chassis/bulk-delete/")
    expect(JSON.parse(String(init?.body))).toEqual({
      ids: ["a", "b"],
      dry_run: true,
    })
    expect(screen.getByRole("button", { name: "Delete 1" })).toBeTruthy()
  })

  it("deletes for real, then clears the selection", async () => {
    apiMock
      .mockResolvedValueOnce(answer({}))
      .mockResolvedValueOnce(answer({ dry_run: false }))
    const onCleared = renderBar()
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }))
    fireEvent.click(await screen.findByRole("button", { name: "Delete 1" }))
    await vi.waitFor(() => expect(onCleared).toHaveBeenCalled())
    expect(JSON.parse(String(apiMock.mock.calls[1][1]?.body))).toEqual({
      ids: ["a", "b"],
    })
  })

  it("carries extra actions, and Delete only when allowed", () => {
    renderBar({
      actions: <button type="button">Edit</button>,
      canDelete: false,
    })
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: /Delete/ })).toBeNull()
  })
})

// "Select all" past what one call takes (#286): the dry run and the delete
// go 1000 ids at a time, the previews add up to one, the button shows the
// batch on its way, and a failure part-way says how far it got.
describe("SafeBulkDeleteBar over more rows than one call takes", () => {
  const previews = [
    answer({
      deleted: 1000,
      impact: [{ label: "circuit terminations", count: 2 }],
    }),
    answer({
      deleted: 999,
      impact: [{ label: "circuit terminations", count: 1 }],
      released: [{ label: "member devices", count: 3 }],
      skipped: [{ id: "r1500", name: "stack-7", reason: "In use: 1 circuit." }],
    }),
    answer({ deleted: 500 }),
  ]

  let held: (() => void) | null = null
  beforeEach(() => {
    apiMock.mockReset()
    toastMock.success.mockReset()
    toastMock.error.mockReset()
    held = null
  })

  /** Dry runs answer `previews`; real batches answer `run`, in turn. */
  function serve(run: (batch: number) => Promise<unknown>) {
    let dry = 0
    let real = 0
    apiMock.mockImplementation((_path, init) => {
      const body = JSON.parse(String(init?.body)) as { dry_run?: boolean }
      if (body.dry_run) return Promise.resolve(previews[dry++])
      return run(++real)
    })
  }

  async function openDialog() {
    const onCleared = renderBar({ selected: rows(2500) })
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }))
    await screen.findByText("2499 virtual chassis will be deleted.")
    return onCleared
  }

  it("asks in batches and shows one preview", async () => {
    serve(() => Promise.resolve(answer({ dry_run: false })))
    await openDialog()
    expect(sent()).toEqual([
      { n: 1000, dry: true, first: "r0" },
      { n: 1000, dry: true, first: "r1000" },
      { n: 500, dry: true, first: "r2000" },
    ])
    // One line per kind of row that goes along, summed over the batches.
    expect(screen.getByText("3 circuit terminations")).toBeTruthy()
    expect(screen.getByText("3 member devices")).toBeTruthy()
    expect(screen.getByText("stack-7")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Delete 2499" })).toBeTruthy()
  })

  it("deletes batch by batch with the batch on its way on the button", async () => {
    serve((batch) => {
      const done = Promise.resolve(
        answer({ ...previews[batch - 1], dry_run: false })
      )
      if (batch !== 2) return done
      return new Promise((resolve) => {
        held = () => resolve(done)
      })
    })
    const onCleared = await openDialog()
    fireEvent.click(screen.getByRole("button", { name: "Delete 2499" }))
    expect(
      await screen.findByRole("button", { name: "Deleting… 2 / 3" })
    ).toBeTruthy()
    expect(sent().filter((c) => !c.dry)).toHaveLength(2)
    held?.()
    await vi.waitFor(() => expect(onCleared).toHaveBeenCalled())
    expect(sent().filter((c) => !c.dry)).toEqual([
      { n: 1000, dry: false, first: "r0" },
      { n: 1000, dry: false, first: "r1000" },
      { n: 500, dry: false, first: "r2000" },
    ])
    expect(toastMock.success).toHaveBeenCalledWith(
      "Deleted 2499 virtual chassis. 1 still in use, kept."
    )
  })

  it("stops at a failed batch, says how far it got and keeps the rest selected", async () => {
    serve((batch) =>
      batch === 2
        ? Promise.reject(new ApiError(503, { detail: "Try again later." }))
        : Promise.resolve(answer({ dry_run: false, deleted: 1000 }))
    )
    const onCleared = await openDialog()
    fireEvent.click(screen.getByRole("button", { name: "Delete 2499" }))
    await vi.waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith(
        "Deleted 1000 of 2500 virtual chassis.",
        { description: "Try again later." }
      )
    )
    // The third batch never went, the dialog closed, the selection stays.
    expect(sent().filter((c) => !c.dry)).toHaveLength(2)
    await vi.waitFor(() =>
      expect(
        screen.queryByText("2499 virtual chassis will be deleted.")
      ).toBeNull()
    )
    expect(onCleared).not.toHaveBeenCalled()
    expect(toastMock.success).not.toHaveBeenCalled()
  })

  it("keeps the dialog for another try when the first batch fails", async () => {
    serve(() =>
      Promise.reject(new ApiError(503, { detail: "Try again later." }))
    )
    const onCleared = await openDialog()
    fireEvent.click(screen.getByRole("button", { name: "Delete 2499" }))
    await vi.waitFor(() =>
      expect(toastMock.error).toHaveBeenCalledWith("Try again later.")
    )
    expect(sent().filter((c) => !c.dry)).toHaveLength(1)
    expect(screen.getByRole("button", { name: "Delete 2499" })).toBeTruthy()
    expect(onCleared).not.toHaveBeenCalled()
  })
})

describe("mergeDeleteAnswers", () => {
  it("adds the rows up and keeps every batch's kept rows", () => {
    const merged = mergeDeleteAnswers([
      answer({
        deleted: 2,
        deleted_ids: ["a", "b"],
        impact: [{ label: "cables", count: 1 }],
      }),
      answer({
        deleted: 1,
        deleted_ids: ["c"],
        skipped: [{ id: "d", name: "d", reason: "In use: 1 circuit." }],
        impact: [{ label: "cables", count: 2 }],
        released: undefined,
      }),
    ])
    expect(merged).toEqual({
      deleted: 3,
      deleted_ids: ["a", "b", "c"],
      skipped: [{ id: "d", name: "d", reason: "In use: 1 circuit." }],
      impact: [{ label: "cables", count: 3 }],
      released: [],
      notes: [],
      dry_run: true,
    })
  })

  it("keeps every batch's notes", () => {
    const note = (id: string) => ({
      id,
      name: id,
      label: "Cabled",
      detail: "pdu",
    })
    const merged = mergeDeleteAnswers([
      answer({ notes: [note("a")] }),
      answer({}),
      answer({ notes: [note("c")] }),
    ])
    expect(merged.notes).toEqual([note("a"), note("c")])
  })
})

// Power panels and feeds (#313): rows that go but are worth naming, and a
// choice the delete can take - a panel's feeds along with it.
describe("SafeBulkDeleteBar notes and option", () => {
  beforeEach(() => {
    apiMock.mockReset()
    toastMock.success.mockReset()
    toastMock.error.mockReset()
  })

  const option = { key: "with_feeds", label: "Delete their feeds too" }
  const bodies = () =>
    apiMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))

  it("names the noted rows under their label", async () => {
    apiMock.mockResolvedValueOnce(
      answer({
        notes: [
          { id: "a", name: "Feed A", label: "Cabled", detail: "pdu-1 PSU1" },
        ],
      })
    )
    renderBar()
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }))
    expect(await screen.findByText("Cabled")).toBeTruthy()
    expect(screen.getByText("Feed A")).toBeTruthy()
    expect(screen.getByText("pdu-1 PSU1")).toBeTruthy()
  })

  it("offers the option only once a row is kept", async () => {
    apiMock.mockResolvedValueOnce(answer({}))
    renderBar({ option })
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }))
    await screen.findByRole("button", { name: "Delete 1" })
    expect(screen.queryByText("Delete their feeds too")).toBeNull()
  })

  it("asks again with the option ticked and deletes with it", async () => {
    const kept = { id: "b", name: "MDB-1", reason: "In use: 2 power feeds." }
    apiMock
      .mockResolvedValueOnce(answer({ skipped: [kept] }))
      .mockResolvedValueOnce(answer({ deleted: 2, deleted_ids: ["a", "b"] }))
      .mockResolvedValueOnce(answer({ deleted: 2, dry_run: false }))
    const onCleared = renderBar({ option })
    fireEvent.click(screen.getByRole("button", { name: /Delete/ }))
    fireEvent.click(await screen.findByRole("checkbox", { name: option.label }))
    fireEvent.click(await screen.findByRole("button", { name: "Delete 2" }))
    await vi.waitFor(() => expect(onCleared).toHaveBeenCalled())
    expect(bodies()).toEqual([
      { ids: ["a", "b"], dry_run: true },
      { ids: ["a", "b"], dry_run: true, with_feeds: true },
      { ids: ["a", "b"], with_feeds: true },
    ])
  })
})
