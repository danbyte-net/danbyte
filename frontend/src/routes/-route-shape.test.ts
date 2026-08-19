import { readdirSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

// ─── The route-shape audit ───────────────────────────────────────────────
//
// Lives in `routes/` on purpose - next to the thing it guards, so it is seen
// when routes are added. The leading `-` is TanStack Router's
// `routeFileIgnorePrefix`, which keeps the generator from turning this test
// into a route of its own.
//
// Two rules that have each already cost us something, encoded so the next
// entity added can't repeat them silently.
//
// 1. An entity you can create or edit must be openable. Fourteen entities
//    shipped with `index` + `new` + `$id_/edit` and no `$id` route, so the only
//    way to reach one was to click Edit - and every one of them was in
//    AUDITED_MODELS, meaning Danbyte had been recording a ChangeLog into a
//    History tab that did not exist.
//
// 2. An edit route is named `$id_.edit`, never `$id.edit`. TanStack's file
//    router treats `foo.$id.tsx` as the *layout parent* of `foo.$id.edit.tsx`,
//    so adding a detail page next to a dot-named edit route makes the edit URL
//    render the detail component - which has no <Outlet/>, so the form silently
//    never appears. It typechecks and it builds. `floor-tile-types` shipped
//    that way and was renamed in e17e125; the underscore opts the child out of
//    the layout nesting and leaves the URL unchanged.

const ROUTES_DIR = dirname(fileURLToPath(import.meta.url))

/** Path prefixes that are not "an object with rows you open by id". Their
 * `new`/`edit` routes act on something addressed another way, so requiring a
 * `$id` detail page for them would be noise. Everything else must have one. */
const NON_OBJECT_PREFIXES = new Set([
  // RBAC/account administration - these live inside Settings and are edited in
  // place from their own list; there is no per-record operator page to open.
  "users",
  "groups",
  "permissions",
  // Not entity prefixes at all: singleton screens and tools.
  "settings",
  "import",
  "topology",
])

/**
 * Entities that genuinely still lack a detail page. This list is asserted to
 * match *exactly*, so it can't quietly grow: adding an entity here is a
 * deliberate act, and closing a gap fails the test until the entry is removed.
 * All four are in AUDITED_MODELS, so each is currently logging history that
 * has nowhere to render.
 */
const KNOWN_MISSING = new Set([
  "alert-rules", // monitoring.AlertRule
  "channels", // monitoring.NotificationChannel
  "maintenance", // monitoring.MaintenanceEvent - edit page carries the impacts panel
  "silences", // monitoring.Silence
  "webhooks", // integrations.Webhook
])

interface Entity {
  prefix: string
  segments: string[]
  files: string[]
}

function readEntities(): Map<string, Entity> {
  const entities = new Map<string, Entity>()
  for (const file of readdirSync(ROUTES_DIR)) {
    if (!file.endsWith(".tsx")) continue
    if (file.endsWith(".test.tsx")) continue
    if (file.startsWith("__")) continue
    const stem = file.slice(0, -".tsx".length)
    const [prefix, ...rest] = stem.split(".")
    const entity = entities.get(prefix) ?? {
      prefix,
      segments: [],
      files: [],
    }
    entity.segments.push(rest.join("."))
    entity.files.push(file)
    entities.set(prefix, entity)
  }
  return entities
}

const ENTITIES = readEntities()

const isEditSegment = (s: string) => s === "edit" || s.endsWith(".edit")
const hasNewOrEdit = (e: Entity) =>
  e.segments.some((s) => s === "new" || s.endsWith(".new") || isEditSegment(s))

describe("route shape: every editable entity is openable", () => {
  it("no entity has new/edit without a $id detail route", () => {
    const missing = [...ENTITIES.values()]
      .filter(
        (e) =>
          !NON_OBJECT_PREFIXES.has(e.prefix) &&
          hasNewOrEdit(e) &&
          !e.segments.includes("$id")
      )
      .map((e) => e.prefix)
      .sort()

    // Anything outside the acknowledged list is a *new* regression: someone
    // added `foo.new.tsx` / `foo.$id_.edit.tsx` without `foo.$id.tsx`.
    expect(missing).toEqual([...KNOWN_MISSING].sort())
  })

  it("the acknowledged-gap list has no stale entries", () => {
    for (const prefix of KNOWN_MISSING) {
      const entity = ENTITIES.get(prefix)
      expect(
        entity,
        `${prefix} is listed but has no routes at all`
      ).toBeDefined()
      expect(
        entity!.segments.includes("$id"),
        `${prefix} now has a $id route - drop it from KNOWN_MISSING`
      ).toBe(false)
    }
  })

  it("the non-object allowlist has no stale entries", () => {
    for (const prefix of NON_OBJECT_PREFIXES) {
      expect(
        ENTITIES.has(prefix),
        `${prefix} is allow-listed but has no routes - drop it`
      ).toBe(true)
    }
  })
})

describe("route shape: edit routes opt out of layout nesting", () => {
  it("uses $id_.edit, never $id.edit", () => {
    const offenders = [...ENTITIES.values()]
      .flatMap((e) => e.files)
      // `foo.$id.edit.tsx` - the dot form. `foo.$id_.edit.tsx` is correct.
      .filter((f) => f.includes(".$id.edit."))
      .sort()

    expect(offenders).toEqual([])
  })
})
