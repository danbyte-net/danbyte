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

/** Forms still writing directly. Each entry is a form yet to be migrated onto
 *  `useSaveObject`; its object type must therefore stay OUT of PLAN_CAPABLE.
 *
 *  The assertion is **directional**: the scan must be a SUBSET of this list. A
 *  migration therefore needs no edit here (the scan just shrinks), which is what
 *  lets several people migrate different domains without fighting over this
 *  file — while a brand-new form that writes directly still fails the test. */
const UNMIGRATED_FORMS = new Set<string>([
  // The E3 worklist, produced by this very scan. Every entry is a form that
  // still writes directly, so its object type must stay out of PLAN_CAPABLE.
  // Delete lines as forms migrate; a new form should be born migrated.
  "components/aggregate-form.tsx",
  "components/asn-form.tsx",
  "components/assign-ip-dialog.tsx",
  "components/automation-target-form.tsx",
  "components/automation-target-wizard.tsx",
  "components/cable-form.tsx",
  "components/circuit-form.tsx",
  "components/circuit-termination-dialog.tsx",
  "components/circuit-type-form.tsx",
  "components/cluster-form.tsx",
  "components/cluster-group-form.tsx",
  "components/cluster-type-form.tsx",
  "components/config-context-form.tsx",
  "components/contact-form.tsx",
  "components/contact-group-form.tsx",
  "components/contact-role-form.tsx",
  "components/custom-field-form.tsx",
  "components/custom-field-group-form.tsx",
  "components/device-inventory-pane.tsx",
  "components/device-modules-pane.tsx",
  "components/device-role-form.tsx",
  "components/device-type-form.tsx",
  "components/device-type-services-section.tsx",
  "components/export-template-form.tsx",
  "components/fhrp-group-form.tsx",
  "components/floor-plan-form.tsx",
  "components/floor-tile-type-form.tsx",
  "components/floorplan3d/scene.tsx",
  "components/front-port-form.tsx",
  "components/group-form.tsx",
  "components/ip-form.tsx",
  "components/ip-range-form.tsx",
  "components/ip-role-form.tsx",
  "components/ip-status-form.tsx",
  "components/ipsec-profile-form.tsx",
  "components/location-form.tsx",
  "components/mac-object-dialog.tsx",
  "components/manufacturer-form.tsx",
  "components/module-type-form.tsx",
  "components/object-documents.tsx",
  "components/onboarding-wizard.tsx",
  "components/permission-form.tsx",
  "components/platform-form.tsx",
  "components/platform-group-form.tsx",
  "components/power-feed-form.tsx",
  "components/power-outlet-dialog.tsx",
  "components/power-panel-form.tsx",
  "components/power-port-dialog.tsx",
  "components/prefix-form.tsx",
  "components/provider-form.tsx",
  "components/provider-network-form.tsx",
  "components/rack-form.tsx",
  "components/rack-role-form.tsx",
  "components/rack-type-form.tsx",
  "components/rear-port-form.tsx",
  "components/region-form.tsx",
  "components/rir-form.tsx",
  "components/rt-form.tsx",
  "components/service-template-form.tsx",
  "components/services-pane.tsx",
  "components/site-assign-prefix-dialog.tsx",
  "components/site-form.tsx",
  "components/tag-form.tsx",
  "components/tenant-form.tsx",
  "components/tenant-groups-section.tsx",
  "components/tunnel-form.tsx",
  "components/tunnel-group-form.tsx",
  "components/tunnel-termination-dialog.tsx",
  "components/user-form.tsx",
  "components/vc-add-member-dialog.tsx",
  "components/vc-membership-dialog.tsx",
  "components/virtual-chassis-form.tsx",
  "components/vlan-form.tsx",
  "components/vlan-group-form.tsx",
  "components/vm-form.tsx",
  "components/vm-interfaces-pane.tsx",
  "components/vrf-form.tsx",
  "components/webhook-form.tsx",
  "components/wireless-lan-form.tsx",
  "components/wlan-group-form.tsx",
  "components/zone-form.tsx",
  "routes/floorplans.$id.tsx",
  "routes/module-types.$id.tsx",
  "routes/rack-types.$id.tsx",
  "routes/services.$id.tsx",
  "routes/settings.sso.tsx",
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
    expect(isPlanCapable("api.devicetype")).toBe(false)
    expect(isPlanCapable("")).toBe(false)
  })
})
