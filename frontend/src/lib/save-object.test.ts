import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import { PLAN_CAPABLE, isPlanCapable } from "./save-object"

/**
 * The guard that makes migrating ~70 forms verifiable instead of hopeful.
 *
 * Planning reuses the real edit forms, which means every form must route its
 * write through `useSaveObject`. A form that still calls `api()` with PATCH/POST
 * directly would, in plan mode, change the live object while the banner promised
 * nothing would be written. `PLAN_CAPABLE` keeps un-migrated types unreachable,
 * and this test keeps the two facts honest:
 *
 *  1. every type listed as plan-capable has actually been migrated, and
 *  2. the list of not-yet-migrated forms only ever shrinks.
 */

const SRC = join(import.meta.dirname ?? __dirname, "..")

/** Files whose direct writes are NOT single-object saves, so they never belong
 *  to a form's plan path: bulk endpoints, reconcile/sync actions, deploys,
 *  imports, and the save helper itself. */
const NOT_OBJECT_SAVES = [
  "component-bulk-bar.tsx",
  "save-object.ts",
  "bulk-edit",
  "bulk.tsx",
  "table-io.tsx",
]

/** The last files whose PATCH/POST is **not** an object edit form, so no plan
 *  path leads to them. Kept as an explicit list rather than a pattern so a new
 *  form that writes directly still fails the test below.
 *
 *  The assertion is **directional**: the scan must be a SUBSET of this list, so
 *  migrating a form needs no edit here (the scan just shrinks). */
const UNMIGRATED_FORMS = new Set<string>([
  // Multi-step wizards: they create several objects in sequence, which is not a
  // single-object save and has no meaning as one planned change.
  "components/automation-target-wizard.tsx",
  "components/onboarding-wizard.tsx",
  // Direct manipulation, not a form: dragging a device in the 3D scene and
  // editing floor-plan tiles both write positions as you move things.
  "components/floorplan3d/scene.tsx",
  "routes/floorplans.$id.tsx",
  // Uploads a file to a generic attachment endpoint.
  "components/object-documents.tsx",
  // Row action, not the object's form: flips `monitored` on one service.
  "routes/services.$id.tsx",
  // Deployment settings, not a domain object.
  "routes/settings.sso.tsx",
  // External-sync writes: saving pushes to a live Windows server over WinRM
  // (Add/Set/Remove-DhcpServerv4Reservation, Add-DhcpServerv4Scope) — replaying
  // one later as a planned change can't honour that contract, so these stay
  // direct on purpose. The DNS zone dialog is the sibling authoring flow and
  // stays with them.
  "components/integrations/dhcp-reservation-dialog.tsx",
  "components/integrations/dhcp-scope-dialog.tsx",
  "components/integrations/dns-zone-dialog.tsx",
  "components/integrations/windows-connection-dialog.tsx",
])

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.tsx"))
      out.push(full)
  }
  return out
}

/** Files that look like a single-object create/update write. */
function formsWritingDirectly(): string[] {
  const hits: string[] = []
  for (const file of walk(SRC)) {
    if (NOT_OBJECT_SAVES.some((skip) => file.includes(skip))) continue
    if (file.includes("routeTree.gen.ts")) continue
    const src = readFileSync(file, "utf8")
    const looksLikeForm =
      /onSaved|FormFooter|useFieldErrors/.test(src) ||
      /-form\.tsx$|-dialog\.tsx$/.test(file)
    if (!looksLikeForm) continue
    // A write to a plain object endpoint: /api/<things>/ or /api/<things>/<id>/
    const writes =
      /method:\s*"(PATCH|POST)"/.test(src) &&
      /api<[^>]*>\(\s*[`"]\/api\/[a-z-]+\/(\$\{[^}]+\}\/)?[`"]/.test(src)
    if (writes && !src.includes("useSaveObject")) {
      hits.push(file.slice(SRC.length + 1))
    }
  }
  return hits.sort()
}

describe("plan-capable forms", () => {
  it("only lists types whose forms go through useSaveObject", () => {
    // Each plan-capable type must have a migrated form. Spot-check by file:
    // the type's form is the one that names the type in a saveObject call.
    const migrated = new Set<string>()
    for (const file of walk(SRC)) {
      const src = readFileSync(file, "utf8")
      if (!src.includes("useSaveObject")) continue
      for (const m of src.matchAll(/objectType:\s*"([^"]+)"/g)) {
        migrated.add(m[1])
      }
      // A dialog shared by two kinds keeps its types in a lookup map rather than
      // inline (console ports vs console server ports), so also count any
      // app-label literal in a file that routes writes through the helper.
      for (const m of src.matchAll(
        /"((?:api|core|auth|auth_api|customization|integrations)\.[a-z]+)"/g
      )) {
        migrated.add(m[1])
      }
    }
    const claimed = [...PLAN_CAPABLE].sort()
    const missing = claimed.filter((t) => !migrated.has(t))
    expect(
      missing,
      "PLAN_CAPABLE names a type with no migrated form — plan mode would " +
        "write to the live object"
    ).toEqual([])
  })

  it("never introduces a new form that writes directly", () => {
    const unexpected = formsWritingDirectly().filter(
      (f) => !UNMIGRATED_FORMS.has(f)
    )
    expect(
      unexpected,
      "This form writes straight to the API. Route it through useSaveObject " +
        "so planning can reuse it — see any *-form.tsx for the pattern."
    ).toEqual([])
  })

  it("isPlanCapable is exact, not prefix-matched", () => {
    expect(isPlanCapable("api.device")).toBe(true)
    // Excluded on purpose — a cable's payload is termination arrays, not fields.
    expect(isPlanCapable("api.cable")).toBe(false)
    expect(isPlanCapable("api.dev")).toBe(false)
    expect(isPlanCapable("")).toBe(false)
  })
})
