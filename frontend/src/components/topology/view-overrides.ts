/** Params that describe the map itself - everything except the saved-view
 * id. Applying (or clearing) a view clears them all, so a stale one never
 * rides into the view that is opened next. */
export const OVERRIDE_KEYS = [
  "tab",
  "site",
  "location",
  "role",
  "status",
  "tag",
  "panels",
  "group",
  "dir",
  "color",
  "cables",
  "mode",
  "face",
  "anchor",
  "line",
  "labels",
  "lag",
  "levels",
  "device",
  "depth",
  "devices",
  "q",
  "vlangroup",
  "vms",
] as const

/** Overrides that are not edits of the view: typing in Find on map only
 * dims cards, and Save never stores it. */
const NOT_EDITS: ReadonlySet<string> = new Set(["q"])

/** The URL carries an override that changes the applied view - what the
 * toolbar's "Edited" reports alongside unsaved document edits. */
export function overridesView(search: Record<string, unknown>): boolean {
  return OVERRIDE_KEYS.some((k) => !NOT_EDITS.has(k) && search[k] !== undefined)
}
