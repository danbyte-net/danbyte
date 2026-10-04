import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

// The three hardware catalogs open one devicetype-library dialog. The device
// type list once labelled it "Import CSV" while module and rack types said
// "Import from library" - CSV round-trips live in Import / Export. Pin the
// shared label and its slot (right after Import / Export, before Add) so the
// headers stay alike.

const ROUTES_DIR = dirname(fileURLToPath(import.meta.url))
const PAGES = [
  ["device-types.index.tsx", "Add device type"],
  ["module-types.index.tsx", "Add module type"],
  ["rack-types.index.tsx", "Add rack type"],
] as const

describe("catalog library import label", () => {
  for (const [file, addLabel] of PAGES) {
    const src = readFileSync(join(ROUTES_DIR, file), "utf8")

    it(`${file} offers "Import from library"`, () => {
      expect(src).toMatch(/>\s*Import from library\s*</)
      expect(src).toContain("<DeviceTypeImportDialog")
      expect(src).not.toMatch(/Import CSV/)
    })

    it(`${file} places it after Import / Export and before ${addLabel}`, () => {
      const io = src.indexOf("<TableActions")
      const lib = src.search(/>\s*Import from library\s*</)
      const add = src.indexOf(addLabel)
      expect(io).toBeGreaterThan(-1)
      expect(lib).toBeGreaterThan(io)
      expect(add).toBeGreaterThan(lib)
    })
  }
})
