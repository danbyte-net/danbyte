// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react"
import { flexRender } from "@tanstack/react-table"
import type { CellContext } from "@tanstack/react-table"
import { afterEach, describe, expect, it } from "vitest"

import type { TextVersion } from "@/lib/api"
import { buildTextVersionColumns } from "./text-version-columns"
import type { TextVersionColumnId } from "./text-version-columns"

// A version row of a template or script body (#465): the hash, size and line
// count of a kept text, and a warning badge where the change log kept none.

function version(patch: Partial<TextVersion> = {}): TextVersion {
  return {
    id: "v1",
    at: "2026-11-01T10:00:00Z",
    by: "alice",
    action: "update",
    cause: "",
    text_kept: true,
    sha256: "0123456789abcdef".repeat(4),
    size: 2048,
    lines: 12,
    ...patch,
  }
}

function cell(id: TextVersionColumnId, row: TextVersion) {
  const col = buildTextVersionColumns().find((c) => c.id === id)
  if (!col) throw new Error(`no ${id} column`)
  const ctx = { row: { original: row } } as unknown as CellContext<
    TextVersion,
    unknown
  >
  return render(<div>{flexRender(col.cell, ctx)}</div>).container
}

afterEach(cleanup)

describe("text version columns", () => {
  it("lists the columns in order, with a picker when asked", () => {
    expect(buildTextVersionColumns().map((c) => c.id)).toEqual([
      "at",
      "by",
      "lines",
      "size",
      "sha",
      "cause",
    ])
    expect(buildTextVersionColumns({ selection: true })[0].id).toBe("select")
  })

  it("shows a short hash, the size and lines of a kept text", () => {
    expect(cell("sha", version()).textContent).toBe("0123456789ab")
    expect(cell("size", version()).textContent).toBe("2.0 KB")
    expect(cell("lines", version()).textContent).toBe("12")
  })

  it("flags a version whose text was not kept", () => {
    const row = version({
      text_kept: false,
      sha256: null,
      size: null,
      lines: null,
    })
    const badge = cell("sha", row).querySelector("[data-slot=badge]")
    expect(badge?.textContent).toBe("Text not kept")
    expect(cell("size", row).textContent).toBe("-")
  })

  it("names a save without a user as the system", () => {
    expect(cell("by", version({ by: "" })).textContent).toBe("system")
  })
})
