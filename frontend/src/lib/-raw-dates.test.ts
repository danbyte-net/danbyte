import { globSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

/** No screen formats a date on its own.
 *
 * `new Date(x).toLocaleString()` renders in the BROWSER's timezone. The
 * viewer's timezone is a setting (user → tenant → deployment, resolved on
 * the server and read from `/api/me/`), so a raw call shows a different
 * instant from every other screen - an hour off, or a day, while an
 * operator correlates a job against a device log.
 *
 * This exists because it drifted: 28 call sites across 16 files had grown
 * back beside 107 that used the helpers (#213). Reach for `TimeCell`, the
 * `useDateFormat()` hook, or the plain helpers in `lib/datetime.ts` -
 * `formatCustom` takes Intl options of your own for a chart axis.
 *
 * `datetime.ts` itself is exempt: it is the one place that may format.
 */
const RAW_DATE =
  /new Date\([^)]*\)\s*\.\s*toLocale(String|DateString|TimeString)\(/

function violations(file: string): string[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .map((line, i) => (RAW_DATE.test(line) ? `${file}:${i + 1}` : ""))
    .filter(Boolean)
}

describe("date formatting", () => {
  it("goes through the shared helpers, never the browser's timezone", () => {
    const files = [
      ...globSync("src/routes/**/*.{ts,tsx}"),
      ...globSync("src/components/**/*.{ts,tsx}"),
      ...globSync("src/lib/**/*.{ts,tsx}"),
    ].filter(
      (f) =>
        !f.includes(".test.") &&
        !f.endsWith("src/lib/datetime.ts") &&
        !f.endsWith("src/lib/time.ts")
    )
    expect(files.length).toBeGreaterThan(50) // the glob actually matched
    expect(files.flatMap(violations)).toEqual([])
  })
})
