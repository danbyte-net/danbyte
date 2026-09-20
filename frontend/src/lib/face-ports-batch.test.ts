import { beforeEach, describe, expect, it, vi } from "vitest"

const calls: string[] = []
vi.mock("@/lib/api", () => ({
  api: vi.fn(async (path: string) => {
    calls.push(path)
    const ids = new URL(path, "http://x").searchParams.get("ids")!.split(",")
    const out: Record<string, unknown> = {}
    for (const id of ids)
      if (id !== "missing") out[id] = { front: [{ name: id }], rear: [] }
    return out
  }),
}))

import { fetchFacePortsBatched } from "./face-ports-batch"

describe("fetchFacePortsBatched", () => {
  beforeEach(() => {
    calls.length = 0
  })

  it("folds requests made in one window into one call and answers each", async () => {
    const [a, b, c] = await Promise.all([
      fetchFacePortsBatched("a"),
      fetchFacePortsBatched("b"),
      fetchFacePortsBatched("a"),
    ])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain("ids=a,b")
    expect(a.front[0]).toEqual({ name: "a" })
    expect(b.front[0]).toEqual({ name: "b" })
    expect(c).toBe(a)
  })

  it("rejects a device the endpoint did not return", async () => {
    await expect(fetchFacePortsBatched("missing")).rejects.toThrow("missing")
  })
})
