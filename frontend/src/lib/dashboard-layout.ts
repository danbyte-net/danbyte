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
  /** Per-instance widget settings (e.g. which floor plan to show). */
  config?: Record<string, unknown>
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

/** Pack sized blocks onto the grid with NO horizontal holes.
 *
 * Greedy skyline packing: each block lands at the lowest spot (leftmost on
 * ties) where its width fits. Order is preserved as reading order, so a
 * curated sequence still reads the way it was designed - but any SUBSET of
 * widgets packs dense. This replaced two earlier attempts (shelf packing,
 * then curated fixed positions) that both left holes whenever the widget
 * set didn't match the template exactly.
 */
export function packItems(
  blocks: { id: string; w: number; h: number; config?: Record<string, unknown> }[]
): DashItem[] {
  const heights = new Array(GRID_COLS).fill(0)
  const out: DashItem[] = []
  for (const b of blocks) {
    const w = Math.min(Math.max(1, b.w), GRID_COLS)
    let bestX = 0
    let bestY = Infinity
    for (let x = 0; x + w <= GRID_COLS; x++) {
      const y = Math.max(...heights.slice(x, x + w))
      if (y < bestY) {
        bestY = y
        bestX = x
      }
    }
    out.push({ id: b.id, x: bestX, y: bestY, w, h: b.h, ...(b.config ? { config: b.config } : {}) })
    for (let x = bestX; x < bestX + w; x++) heights[x] = bestY + b.h
  }
  return out
}

/** Flow ids onto the grid with their default spans - the v1 migration. */
export function placeIds(
  ids: string[],
  metaOf: (id: string) => WidgetMeta | undefined
): DashItem[] {
  return packItems(
    ids
      .map((id) => ({ id, meta: metaOf(id) }))
      .filter((x): x is { id: string; meta: WidgetMeta } => !!x.meta)
      .map(({ id, meta }) => ({
        id,
        w: Math.min(meta.span.w, GRID_COLS),
        h: meta.span.h,
      }))
  )
}

/** Lay an id list out using the curated template's SIZES and ORDER.
 *
 * Positions are re-packed rather than copied: a tenant default that lacks
 * some template widgets must not inherit the holes their absence leaves.
 * Ids the template doesn't know append after it with their default spans.
 */
export function placeIdsCurated(
  ids: string[],
  curated: DashItem[],
  metaOf: (id: string) => WidgetMeta | undefined
): DashItem[] {
  const wanted = new Set(ids)
  const known = curated.filter((c) => wanted.has(c.id) && metaOf(c.id))
  const placed = new Set(known.map((c) => c.id))
  const rest = ids
    .filter((id) => !placed.has(id))
    .map((id) => ({ id, meta: metaOf(id) }))
    .filter((x): x is { id: string; meta: WidgetMeta } => !!x.meta)
    .map(({ id, meta }) => ({
      id,
      w: Math.min(meta.span.w, GRID_COLS),
      h: meta.span.h,
    }))
  return packItems([
    ...known.map((c) => ({ id: c.id, w: c.w, h: c.h })),
    ...rest,
  ])
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
      const clamped = clampItem(
        {
          id,
          x: typeof x === "number" ? x : 0,
          y: typeof y === "number" ? y : 0,
          w: typeof w === "number" ? w : meta.span.w,
          h: typeof h === "number" ? h : meta.span.h,
        },
        meta
      )
      const config = (it as { config?: unknown }).config
      if (config && typeof config === "object" && !Array.isArray(config)) {
        clamped.config = config as Record<string, unknown>
      }
      out.push(clamped)
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
