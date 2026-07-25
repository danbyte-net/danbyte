import { dash } from "@/components/cells/dash"

// Shared vocabulary for "a column that renders a count".
//
// Zero is genuinely ambiguous in this app, which is why the knob exists: on a
// list page that also facets on "has prefixes", a zero row is nothing to look
// at, so it reads `—`. On an embedded pane that counts the members of the thing
// you're looking at, zero IS the answer, so it reads `0`.
//
// It lives here rather than in each column factory because two factories were
// written independently and reached for the same idea under the same name with
// different shapes — one took `"dash" | "number"`, the other a bare boolean.
// A knob that means two things is the inconsistency these factories exist to
// remove, so there is one type and one renderer.

export type ZeroCounts = "dash" | "number"

/** Render a count, or `—` when it's zero and the caller wants zeros hidden. */
export function countCell(n: number, zero: ZeroCounts = "dash") {
  return zero === "number" || n > 0 ? (
    <span className="num text-xs">{n}</span>
  ) : (
    dash
  )
}
