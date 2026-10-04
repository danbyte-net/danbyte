import { beforeEach, describe, expect, it, vi } from "vitest"

import { ApiError } from "@/lib/api"
import {
  BatchFailure,
  askInBatches,
  batchCount,
  batchStoppedToast,
  batches,
  runBatches,
  sumCounts,
  sumOf,
} from "./bulk-batches"
import type { BatchProgress } from "./bulk-batches"

// A bulk call takes at most so many ids (#286): a bigger selection goes as
// consecutive batches, one call at a time, and a failure part-way says what
// went through and what did not.

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }))
vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }))

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
