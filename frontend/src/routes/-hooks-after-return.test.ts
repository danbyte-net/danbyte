import { readFileSync } from "node:fs"
import { globSync } from "node:fs"
import { describe, expect, it } from "vitest"

/** No React hook may sit below an early return.
 *
 * React counts hooks per render. A component that returns early while loading
 * and *then* calls `useMemo` runs fewer hooks on the first render than on the
 * second, and React kills the page with "rendered more hooks than during the
 * previous render" (minified error #310). It is a blank screen, not a warning.
 *
 * This exists because that shipped: the DNS name page had its tabs `useMemo`
 * below an `isLoading` return, and nothing caught it - the crash needs the
 * component *rendered*, and route components have no render tests. A static
 * check costs nothing and covers every route and component at once.
 *
 * Scoped by indentation, which works because prettier formats this codebase:
 * a top-level component body is at two spaces, and hooks inside nested
 * callbacks (a table `cell`, a `map`) are deeper and correctly ignored.
 */
const HOOK = /^ {2}(?:const .*= )?(use[A-Z]\w*)\(/
const RETURN = /^ {2}(?:if \(.*\)\s*)?return\b/
const FN_START = /function \w+\s*\(/

function violations(file: string): string[] {
  const out: string[] = []
  let afterReturn = false
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, i) => {
      // A new function body, or the end of one, resets the scope.
      if (FN_START.test(line) || line.startsWith("}")) afterReturn = false
      else if (RETURN.test(line)) afterReturn = true
      else if (afterReturn) {
        const m = HOOK.exec(line)
        if (m) {
          out.push(`${file}:${i + 1} calls ${m[1]}() after an early return`)
          afterReturn = false // one report per function is enough
        }
      }
    })
  return out
}

describe("hook order", () => {
  it("no component calls a hook after an early return", () => {
    const files = [
      ...globSync("src/routes/**/*.tsx"),
      ...globSync("src/components/**/*.tsx"),
    ].filter((f) => !f.endsWith(".test.tsx"))
    expect(files.length).toBeGreaterThan(50) // the glob actually matched
    expect(files.flatMap(violations)).toEqual([])
  })
})
