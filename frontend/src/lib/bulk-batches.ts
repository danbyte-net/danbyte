// Bulk calls in batches (#286). The server takes only so many ids per call -
// `MAX_IDS` in api/bulk_delete.py, `MAX_BULK_MACS` in api/mac_bulk.py - and
// "Select all N" has no such bound, so a bulk bar sends a bigger selection as
// consecutive calls of at most that many and adds the answers up: the dry run
// behind a confirmation as well as the write it confirms.
//
// One call at a time, in order. A batch that fails ends the run: the batches
// before it stand, the ones after it are never sent, and the caller learns
// which is which (`BatchFailure`), so nothing is half done without saying so.
// Only actions that are safe to repeat run in batches - delete, edit, add -
// so pressing the button again finishes what a failure left.

import { toast } from "sonner"

import { apiErrorMessage } from "@/lib/api"

/** Ids per bulk call: `MAX_IDS` in api/bulk_delete.py. The safe bulk deletes,
 * prefixes, device types and the component bulk calls all take this many. */
export const IDS_PER_CALL = 1000

/** MAC values per `/api/macs/bulk-remove/` call: `MAX_BULK_MACS` in
 * api/mac_bulk.py. */
export const MACS_PER_CALL = 2000

/** Objects per `/api/monitoring/sla-members/bulk-add/` call
 * (monitoring/sla_api.py). */
export const SLA_MEMBERS_PER_CALL = 1000

/** `items` in consecutive runs of at most `size`, in order. */
export function batches<TItem>(
  items: readonly TItem[],
  size: number
): TItem[][] {
  if (!Number.isInteger(size) || size < 1)
    throw new RangeError(`A batch size is a whole number from 1, not ${size}.`)
  const out: TItem[][] = []
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size))
  return out
}

/** How many calls `count` items take, `size` at a time. */
export function batchCount(count: number, size: number): number {
  return Math.ceil(count / size)
}

/** The batch on its way, counted from 1, and how many the run takes. */
export interface BatchProgress {
  batch: number
  of: number
}

/** A run that stopped part-way: the batches before `batch` went through,
 * `batch` failed with `cause`, and the ones after it were never sent. */
export class BatchFailure<TItem, TAnswer> extends Error {
  /** The answers of the batches that went through, in order. */
  readonly results: TAnswer[]
  /** The items those batches carried. */
  readonly done: TItem[]
  /** The items of the failed batch and of every batch after it. */
  readonly rest: TItem[]
  /** The batch that failed, counted from 1. */
  readonly batch: number
  /** How many batches the run had. */
  readonly of: number

  constructor(run: {
    results: TAnswer[]
    done: TItem[]
    rest: TItem[]
    batch: number
    of: number
    cause: unknown
  }) {
    super(`Stopped at batch ${run.batch} of ${run.of}.`, { cause: run.cause })
    this.name = "BatchFailure"
    this.results = run.results
    this.done = run.done
    this.rest = run.rest
    this.batch = run.batch
    this.of = run.of
  }
}

/**
 * `call` for each batch of `items`, `size` at a time, one after the other;
 * every batch's answer, in order. `onProgress` hears of each batch as it
 * goes out.
 *
 * A failing first batch throws its own error: nothing was done, as when the
 * selection went in one call. A later one throws a {@link BatchFailure} that
 * holds what went through before it.
 */
export async function runBatches<TItem, TAnswer>(
  items: readonly TItem[],
  size: number,
  call: (batch: TItem[]) => Promise<TAnswer>,
  onProgress?: (progress: BatchProgress) => void
): Promise<TAnswer[]> {
  const parts = batches(items, size)
  const results: TAnswer[] = []
  for (const [i, part] of parts.entries()) {
    onProgress?.({ batch: i + 1, of: parts.length })
    try {
      results.push(await call(part))
    } catch (cause) {
      if (i === 0) throw cause
      throw new BatchFailure<TItem, TAnswer>({
        results,
        done: items.slice(0, i * size),
        rest: items.slice(i * size),
        batch: i + 1,
        of: parts.length,
        cause,
      })
    }
  }
  return results
}

/** {@link runBatches} for a dry run. Nothing is written, so a batch that fails
 * throws its own error wherever it falls. */
export async function askInBatches<TItem, TAnswer>(
  items: readonly TItem[],
  size: number,
  call: (batch: TItem[]) => Promise<TAnswer>
): Promise<TAnswer[]> {
  try {
    return await runBatches(items, size, call)
  } catch (err) {
    throw err instanceof BatchFailure ? err.cause : err
  }
}

/** One number added up over every answer. */
export function sumOf<TAnswer>(
  answers: readonly TAnswer[],
  pick: (answer: TAnswer) => number
): number {
  return answers.reduce((n, a) => n + pick(a), 0)
}

export interface LabelCount {
  label: string
  count: number
}

/** `{label, count}` lists added up across answers - what goes with the rows
 * of a delete, say: one line per label, in label order as the server sends
 * them. */
export function sumCounts(
  lists: readonly (readonly LabelCount[])[]
): LabelCount[] {
  const total = new Map<string, number>()
  for (const list of lists)
    for (const { label, count } of list)
      total.set(label, (total.get(label) ?? 0) + count)
  return [...total]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([label, count]) => ({ label, count }))
}

/** The toast for a run that stopped part-way: `summary` says how far it got,
 * and the reason the failed batch was refused goes under it. */
export function batchStoppedToast(
  summary: string,
  failure: BatchFailure<unknown, unknown>
): void {
  toast.error(summary, { description: apiErrorMessage(failure.cause) })
}
