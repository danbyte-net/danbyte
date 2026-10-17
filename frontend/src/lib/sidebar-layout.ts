// The personal sidebar layout (#285): which sections and entries a user has
// hidden, and the order they put sections (and entries within a section) in.
//
// Stored server-side as the `sidebar` user preference (auth_api.sidebar_prefs).
// Only ids are saved, never a snapshot of the menu: the layout is merged over
// the menu the app ships, so a page added in a later release appears for
// everyone - in its shipped position, shown - instead of staying hidden.
// Hiding is a menu convenience only; routes and permissions are unaffected.

export interface SidebarLayout {
  v: 1
  /** Section ids in the user's order. */
  order: string[]
  /** Hidden section ids and entry ids (entry id = its URL). */
  hidden: string[]
  /** Section id → entry ids in the user's order. */
  items: Record<string, string[]>
}

export const EMPTY_LAYOUT: SidebarLayout = {
  v: 1,
  order: [],
  hidden: [],
  items: {},
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []

/** A stored value as a layout, or null when there is none (or it is not one
 * this client understands - the menu then shows as shipped). */
export function parseLayout(raw: unknown): SidebarLayout | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  if (r.v !== 1) return null
  const items: Record<string, string[]> = {}
  if (r.items && typeof r.items === "object" && !Array.isArray(r.items)) {
    for (const [k, v] of Object.entries(r.items)) items[k] = strings(v)
  }
  return { v: 1, order: strings(r.order), hidden: strings(r.hidden), items }
}

/**
 * The shipped ids in the saved order. Ids the saved order does not know
 * (pages added since it was saved) keep their shipped place: each lands right
 * after the shipped id before it, or first when nothing precedes it. Saved
 * ids that no longer exist are dropped.
 */
export function mergeOrder(shipped: string[], saved: string[]): string[] {
  const known = new Set(shipped)
  const out = saved.filter((id, i) => known.has(id) && saved.indexOf(id) === i)
  const placed = new Set(out)
  shipped.forEach((id, i) => {
    if (placed.has(id)) return
    let at = 0
    for (let j = i - 1; j >= 0; j--) {
      const k = out.indexOf(shipped[j])
      if (k >= 0) {
        at = k + 1
        break
      }
    }
    out.splice(at, 0, id)
    placed.add(id)
  })
  return out
}

export interface LayoutItem {
  id: string
}
export interface LayoutCluster<TItem extends LayoutItem = LayoutItem> {
  label?: string
  items: TItem[]
}
export interface LayoutSection<TItem extends LayoutItem = LayoutItem> {
  id: string
  clusters: LayoutCluster<TItem>[]
}

/** Sections and entries in the layout's order, hidden ones included - what
 * the Preferences editor lists. Entries reorder inside their cluster only, so
 * a sub-heading never ends up over another cluster's pages. */
export function orderSections<
  TItem extends LayoutItem,
  TSection extends LayoutSection<TItem>,
>(sections: TSection[], layout: SidebarLayout | null): TSection[] {
  if (!layout) return sections
  const byId = new Map(sections.map((s) => [s.id, s]))
  return mergeOrder(
    sections.map((s) => s.id),
    layout.order
  ).map((id) => {
    const section = byId.get(id)!
    const saved = layout.items[id] as string[] | undefined
    if (!saved?.length) return section
    return {
      ...section,
      clusters: section.clusters.map((c) => {
        const byItem = new Map(c.items.map((i) => [i.id, i]))
        return {
          ...c,
          items: mergeOrder(
            c.items.map((i) => i.id),
            saved
          ).map((iid) => byItem.get(iid)!),
        }
      }),
    }
  })
}

/** The menu to render: ordered, with hidden sections and entries dropped, and
 * any cluster or section left empty dropped too. */
export function resolveSidebar<
  TItem extends LayoutItem,
  TSection extends LayoutSection<TItem>,
>(sections: TSection[], layout: SidebarLayout | null): TSection[] {
  const ordered = orderSections<TItem, TSection>(sections, layout)
  if (!layout || layout.hidden.length === 0) return ordered
  const hidden = new Set(layout.hidden)
  return ordered
    .filter((s) => !hidden.has(s.id))
    .map((s) => ({
      ...s,
      clusters: s.clusters
        .map((c) => ({ ...c, items: c.items.filter((i) => !hidden.has(i.id)) }))
        .filter((c) => c.items.length > 0),
    }))
    .filter((s) => s.clusters.length > 0)
}

/** The layout with `id` shown or hidden. Ids not on the current menu (a page
 * the user cannot see right now) are kept as they were. */
export function setHidden(
  layout: SidebarLayout | null,
  id: string,
  hide: boolean
): SidebarLayout {
  const base = layout ?? EMPTY_LAYOUT
  const rest = base.hidden.filter((h) => h !== id)
  return { ...base, hidden: hide ? [...rest, id] : rest }
}

/** The layout with sections in `order`. */
export function setSectionOrder(
  layout: SidebarLayout | null,
  order: string[]
): SidebarLayout {
  return { ...(layout ?? EMPTY_LAYOUT), order }
}

/** The layout with one section's entries in `order`. */
export function setItemOrder(
  layout: SidebarLayout | null,
  sectionId: string,
  order: string[]
): SidebarLayout {
  const base = layout ?? EMPTY_LAYOUT
  return { ...base, items: { ...base.items, [sectionId]: order } }
}
