// Parent/child tree flattening for hierarchy tables (locations, regions):
// depth-first order (children grouped under their parent, siblings by name)
// with a `_depth` for the name cell's indent markers. A row whose parent is
// filtered out (or paginated away) surfaces at the root instead of dangling.

export interface ParentRef {
  id: string
}

export type Nested<T> = T & { _depth: number }

export function nestByParent<
  T extends { id: string; name: string; parent?: ParentRef | null },
>(rows: T[]): Nested<T>[] {
  const byParent = new Map<string | null, T[]>()
  const ids = new Set(rows.map((r) => r.id))
  for (const r of rows) {
    const key = r.parent && ids.has(r.parent.id) ? r.parent.id : null
    const bucket = byParent.get(key)
    if (bucket) bucket.push(r)
    else byParent.set(key, [r])
  }
  for (const bucket of byParent.values())
    bucket.sort((a, b) => a.name.localeCompare(b.name))

  const out: Nested<T>[] = []
  const walk = (parentId: string | null, depth: number) => {
    for (const r of byParent.get(parentId) ?? []) {
      out.push({ ...r, _depth: depth })
      walk(r.id, depth + 1)
    }
  }
  walk(null, 0)
  return out
}
