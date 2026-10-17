import { globSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

/** Object fields are searchable (#276).
 *
 * A field that picks a row of another table - site, location, VRF, role,
 * tenant, interface - uses the searchable FormCombobox / Combobox (or an
 * ObjectPicker preset), never the plain FormSelect: a list of objects grows
 * past what scrolling handles, and the forms that still used the plain
 * select were the ones operators could not search.
 *
 * FormSelect stays for fixed choice lists (units, modes, enums). The probe
 * flags a FormSelect whose options are built from query rows: `.results` or
 * an option `value` taken from a row's `.id`. A list built from a module
 * constant (`AFI_SAFI.map(…)`) is a fixed choice list, whatever its keys.
 */

/** Each `<FormSelect …/>` element in a source file, with its line. */
function formSelects(src: string): { line: number; block: string }[] {
  const out: { line: number; block: string }[] = []
  let from = 0
  for (;;) {
    const start = src.indexOf("<FormSelect", from)
    if (start < 0) return out
    let depth = 0
    let j = start
    while (j < src.length) {
      const c = src[j]
      if (c === "{") depth++
      else if (c === "}") depth--
      else if (depth === 0 && src.startsWith("/>", j)) break
      j++
    }
    out.push({
      line: src.slice(0, start).split("\n").length,
      block: src.slice(start, j),
    })
    from = j
  }
}

const OBJECT_ROWS = /\.results\b|value:\s*(String\()?\w+\.id\b/
const CONSTANT_LIST = /^options=\{\s*[A-Z][A-Z0-9_]*\b/

export function objectSelectViolations(file: string, src: string): string[] {
  return formSelects(src)
    .filter(({ block }) => {
      const options = block.slice(block.indexOf("options="))
      return !CONSTANT_LIST.test(options) && OBJECT_ROWS.test(options)
    })
    .map(({ line }) => `${file}:${line}`)
}

describe("object fields", () => {
  it("flags a FormSelect fed with query rows", () => {
    const src = [
      "<FormSelect",
      '  label="Site"',
      "  options={(sites.data?.results ?? []).map((s) => ({",
      "    value: s.id,",
      "    label: s.name,",
      "  }))}",
      "/>",
      '<FormSelect label="Unit" options={UNITS} />',
      "<FormSelect options={AFI.map((a) => ({ value: a.id, label: a.n }))} />",
    ].join("\n")
    expect(objectSelectViolations("x.tsx", src)).toEqual(["x.tsx:1"])
  })

  it("never use the plain FormSelect", () => {
    const files = [
      ...globSync("src/routes/**/*.tsx"),
      ...globSync("src/components/**/*.tsx"),
    ].filter((f) => !f.includes(".test.") && !f.endsWith("routeTree.gen.ts"))
    const bad = files.flatMap((f) =>
      objectSelectViolations(f, readFileSync(f, "utf8"))
    )
    expect(bad).toEqual([])
  })
})
