import { beforeEach, describe, expect, it, vi } from "vitest"

import { ApiError } from "@/lib/api"
import {
  BatchFailure,
  askInBatches,
  batchCount,
  batchStoppedToast,
  batches,
  eachCall,
  eachCallToast,
  runBatches,
  sumCounts,
  sumOf,
} from "./bulk-batches"
import type { BatchProgress } from "./bulk-batches"

// A bulk call takes at most so many ids (#286): a bigger selection goes as
// consecutive batches, one call at a time, and a failure part-way says what
// went through and what did not.

const { toastError, toastSuccess } = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}))
vi.mock("sonner", () => ({
  toast: { error: toastError, success: toastSuccess },
}))

const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`)

describe("batches", () => {
  it("splits in order, the last batch taking what is left", () => {
    expect(batches(["a", "b", "c", "d", "e"], 2)).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e"],
    ])
    const parts = batches(ids(2500), 1000)
    expect(parts.map((p) => p.length)).toEqual([1000, 1000, 500])
    expect(parts.flat()).toEqual(ids(2500))
  })

  it("keeps a selection that fits in one batch", () => {
    expect(batches(ids(1000), 1000)).toEqual([ids(1000)])
    expect(batches([], 1000)).toEqual([])
  })

  it("refuses a size that would never finish", () => {
    expect(() => batches(["a"], 0)).toThrow(RangeError)
    expect(() => batches(["a"], 1.5)).toThrow(RangeError)
  })

  it("counts the calls a selection takes", () => {
    expect(batchCount(1, 1000)).toBe(1)
    expect(batchCount(1000, 1000)).toBe(1)
    expect(batchCount(1001, 1000)).toBe(2)
    expect(batchCount(4500, 2000)).toBe(3)
  })
})

describe("runBatches", () => {
  it("sends one batch at a time and answers in order, telling each batch", async () => {
    const progress: BatchProgress[] = []
    let inFlight = 0
    let most = 0
    const sent: number[] = []
    const answers = await runBatches(
      ids(2500),
      1000,
      async (part) => {
        inFlight += 1
        most = Math.max(most, inFlight)
        sent.push(part.length)
        await Promise.resolve()
        inFlight -= 1
        return part.length
      },
      (p) => progress.push(p)
    )
    expect(answers).toEqual([1000, 1000, 500])
    expect(sent).toEqual([1000, 1000, 500])
    expect(most).toBe(1)
    expect(progress).toEqual([
      { batch: 1, of: 3 },
      { batch: 2, of: 3 },
      { batch: 3, of: 3 },
    ])
  })

  it("stops at a failed batch and says what went through", async () => {
    const refused = new ApiError(400, { ids: ["Not today."] })
    const call = vi
      .fn<(part: string[]) => Promise<{ deleted: number }>>()
      .mockResolvedValueOnce({ deleted: 990 })
      .mockRejectedValueOnce(refused)
      .mockResolvedValueOnce({ deleted: 500 })
    const all = ids(2500)
    const err = await runBatches(all, 1000, call).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BatchFailure)
    const failure = err as BatchFailure<string, { deleted: number }>
    expect(failure.results).toEqual([{ deleted: 990 }])
    expect(failure.done).toEqual(all.slice(0, 1000))
    expect(failure.rest).toEqual(all.slice(1000))
    expect(failure.batch).toBe(2)
    expect(failure.of).toBe(3)
    expect(failure.cause).toBe(refused)
    // The batch after the failed one is never sent.
    expect(call).toHaveBeenCalledTimes(2)
  })

  it("throws a failed first batch's own error: nothing was done", async () => {
    const refused = new ApiError(403, { detail: "No." })
    const call = vi.fn(() => Promise.reject(refused))
    await expect(runBatches(ids(2500), 1000, call)).rejects.toBe(refused)
    expect(call).toHaveBeenCalledTimes(1)
  })
})

describe("askInBatches", () => {
  it("answers every batch, and a failed one with its own error", async () => {
    expect(
      await askInBatches(ids(1500), 1000, async (part) => part.length)
    ).toEqual([1000, 500])
    const refused = new ApiError(400, { ids: ["Not today."] })
    const call = vi
      .fn<(part: string[]) => Promise<number>>()
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(refused)
    await expect(askInBatches(ids(1500), 1000, call)).rejects.toBe(refused)
  })
})

describe("adding answers up", () => {
  it("sums counts per label, one line each, in label order", () => {
    expect(
      sumCounts([
        [
          { label: "circuit terminations", count: 2 },
          { label: "cables", count: 1 },
        ],
        [],
        [{ label: "circuit terminations", count: 3 }],
      ])
    ).toEqual([
      { label: "cables", count: 1 },
      { label: "circuit terminations", count: 5 },
    ])
    expect(sumCounts([])).toEqual([])
  })

  it("sums one number over the answers", () => {
    expect(sumOf([{ n: 2 }, { n: 3 }], (a) => a.n)).toBe(5)
    expect(sumOf([], () => 1)).toBe(0)
  })
})

describe("batchStoppedToast", () => {
  beforeEach(() => toastError.mockReset())

  it("says how far it got, with the server's reason under it", () => {
    const failure = new BatchFailure<string, number>({
      results: [1],
      done: ["a"],
      rest: ["b"],
      batch: 2,
      of: 2,
      cause: new ApiError(400, { ids: ["At most 1000 ids per call."] }),
    })
    batchStoppedToast("Deleted 1 of 2 circuits.", failure)
    expect(toastError).toHaveBeenCalledWith("Deleted 1 of 2 circuits.", {
      description: "ids: At most 1000 ids per call.",
    })
  })
})

// A multi-pick with no bulk endpoint behind it sends one call per object:
// every one is tried, and the answer says which went through.
describe("eachCall", () => {
  it("tries every item and splits the answer, in the order given", async () => {
    const refused = new ApiError(400, { object_id: ["Already linked."] })
    const result = await eachCall(["a", "b", "c", "d"], (x) =>
      x === "b" || x === "d" ? Promise.reject(refused) : Promise.resolve(x)
    )
    expect(result.done).toEqual(["a", "c"])
    expect(result.failed).toEqual([
      { item: "b", cause: refused },
      { item: "d", cause: refused },
    ])
  })

  it("keeps at most `parallel` calls in flight", async () => {
    let inFlight = 0
    let peak = 0
    const result = await eachCall(
      ids(9),
      async () => {
        inFlight++
        peak = Math.max(peak, inFlight)
        await new Promise((r) => setTimeout(r, 1))
        inFlight--
      },
      3
    )
    expect(peak).toBe(3)
    expect(result.done).toHaveLength(9)
  })

  it("runs one at a time by default", async () => {
    const order: string[] = []
    await eachCall(["a", "b"], async (x) => {
      order.push(`start ${x}`)
      await Promise.resolve()
      order.push(`end ${x}`)
    })
    expect(order).toEqual(["start a", "end a", "start b", "end b"])
  })

  it("answers an empty list without calling", async () => {
    const call = vi.fn()
    expect(await eachCall([], call)).toEqual({ done: [], failed: [] })
    expect(call).not.toHaveBeenCalled()
  })
})

describe("eachCallToast", () => {
  beforeEach(() => {
    toastError.mockReset()
    toastSuccess.mockReset()
  })
  const what = (n: number) => `${n} object${n === 1 ? "" : "s"}`

  it("counts a clean run", () => {
    eachCallToast({ done: ["a", "b"], failed: [] }, "Linked", what)
    expect(toastSuccess).toHaveBeenCalledWith("Linked 2 objects")
  })

  it("says how many went through, with the first refusal under it", () => {
    eachCallToast(
      {
        done: ["a"],
        failed: [
          { item: "b", cause: new ApiError(403, { detail: "No." }) },
          { item: "c", cause: new ApiError(400, { detail: "Nope." }) },
        ],
      },
      "Linked",
      what
    )
    expect(toastError).toHaveBeenCalledWith(
      "Linked 1 of 3 objects, 2 refused",
      {
        description: "No.",
      }
    )
  })

  it("says nothing went through when every call was refused", () => {
    eachCallToast(
      {
        done: [],
        failed: [{ item: "a", cause: new ApiError(403, { detail: "No." }) }],
      },
      "Linked",
      what
    )
    expect(toastError).toHaveBeenCalledWith("Nothing linked", {
      description: "No.",
    })
  })
})
