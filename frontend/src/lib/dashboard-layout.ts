/** Dashboard layout: shapes, migration and clamping - pure functions only.
 *
 * The dashboard grid (react-grid-layout) works in cell units on a 6-column
 * grid. A widget is `{id, x, y, w, h}`; per-widget defaults and min/max come
 * from the catalog and are passed in, never imported - this module stays
 * dependency-free so it is trivially unit-testable.
 *
 * Persisted shape is versioned: `{v: 2, items: [...]}`. Version 1 was a flat
 * array of widget ids (order-only masonry); it still exists in localStorage
 * and in tenants' saved defaults, so `normalizeLayout` accepts both forever -
 * a format change must upgrade old users in place, not silently reset them.
 */

export const GRID_COLS = 6
export const ROW_HEIGHT = 112

export type Span = { w: number; h: number }

export type WidgetMeta = {
  span: Span
  min: Span
  max: Span
}

export type DashItem = {
  id: string
  x: number
  y: number
  w: number
  h: number
}

export type LayoutV2 = { v: 2; items: DashItem[] }

const clampNum = (v: number, lo: number, hi: number) =>
  Math.min(Math.max(Math.round(v), lo), hi)

/** Clamp one item's span to its widget's constraints and the grid width. */
export function clampItem(item: DashItem, meta: WidgetMeta): DashItem {
  const w = clampNum(item.w, meta.min.w, Math.min(meta.max.w, GRID_COLS))
  const h = clampNum(item.h, meta.min.h, meta.max.h)
  const x = clampNum(item.x, 0, GRID_COLS - w)
  const y = Math.max(0, Math.round(item.y))
  return { id: item.id, x, y, w, h }
}

/** Flow ids onto the grid with their default spans - the v1 migration.
 *
 * Simple shelf packing: left to right, new row when a widget doesn't fit.
 * react-grid-layout compacts vertically afterwards, so the exact y values
 * only need to preserve ORDER, not be gap-free.
 */
export function placeIds(
  ids: string[],
  metaOf: (id: string) => WidgetMeta | undefined
): DashItem[] {
  const out: DashItem[] = []
  let x = 0
  let y = 0
  let rowH = 0
  for (const id of ids) {
    const meta = metaOf(id)
    if (!meta) continue
    const w = Math.min(meta.span.w, GRID_COLS)
    const h = meta.span.h
    if (x + w > GRID_COLS) {
      x = 0
      y += rowH
      rowH = 0
    }
    out.push({ id, x, y, w, h })
    x += w
    rowH = Math.max(rowH, h)
  }
  return out
}

/** Flow ids onto the grid, preferring a curated template's geometry.

 * A v1 layout (and an old tenant default) is only an id LIST - naive shelf
 * packing of default spans produces rows full of holes. Ids the curated
 * template knows keep its hand-placed positions; only ids it doesn't know
 * are shelf-packed below. Vertical compaction closes what gaps remain.
 */
export function placeIdsCurated(
  ids: string[],
  curated: DashItem[],
  metaOf: (id: string) => WidgetMeta | undefined
): DashItem[] {
  const wanted = new Set(ids)
  const out = curated.filter((c) => wanted.has(c.id) && metaOf(c.id))
  const placed = new Set(out.map((c) => c.id))
  const rest = ids.filter((id) => !placed.has(id))
  const bottom = out.reduce((m, c) => Math.max(m, c.y + c.h), 0)
  for (const it of placeIds(rest, metaOf)) {
    out.push({ ...it, y: it.y + bottom })
  }
  return out
}

/** Parse anything a layout might have been stored as, or null to fall back.
 *
 * Unknown widget ids are dropped (a widget removed from the catalog must not
 * wedge everyone's dashboard), and every span re-clamps against the current
 * catalog constraints - they may have tightened since the layout was saved.
 */
export function normalizeLayout(
  raw: unknown,
  metaOf: (id: string) => WidgetMeta | undefined,
  curated?: DashItem[]
): DashItem[] | null {
  if (Array.isArray(raw)) {
    // v1: a flat array of widget ids.
    const ids = raw.filter((x): x is string => typeof x === "string" && !!metaOf(x))
    if (!ids.length) return null
    return curated ? placeIdsCurated(ids, curated, metaOf) : placeIds(ids, metaOf)
  }
  if (raw && typeof raw === "object" && (raw as { v?: unknown }).v === 2) {
    const items = (raw as { items?: unknown }).items
    if (!Array.isArray(items)) return null
    const out: DashItem[] = []
    for (const it of items) {
      if (!it || typeof it !== "object") continue
      const { id, x, y, w, h } = it as Record<string, unknown>
      if (typeof id !== "string") continue
      const meta = metaOf(id)
      if (!meta) continue
      out.push(
        clampItem(
          {
            id,
            x: typeof x === "number" ? x : 0,
            y: typeof y === "number" ? y : 0,
            w: typeof w === "number" ? w : meta.span.w,
            h: typeof h === "number" ? h : meta.span.h,
          },
          meta
        )
      )
    }
    return out.length ? out : null
  }
  return null
}

/** Our items → react-grid-layout's shape, constraints attached. */
export function toRglLayout(
  items: DashItem[],
  metaOf: (id: string) => WidgetMeta | undefined
) {
  return items.map((it) => {
    const meta = metaOf(it.id)
    return {
      i: it.id,
      x: it.x,
      y: it.y,
      w: it.w,
      h: it.h,
      minW: meta?.min.w,
      minH: meta?.min.h,
      maxW: meta?.max.w,
      maxH: meta?.max.h,
    }
  })
}

/** react-grid-layout's shape → ours (persisting after a drag/resize). */
export function fromRglLayout(
  layout: readonly { i: string; x: number; y: number; w: number; h: number }[]
): DashItem[] {
  return layout.map((l) => ({ id: l.i, x: l.x, y: l.y, w: l.w, h: l.h }))
}
