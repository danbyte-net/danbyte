import type { Row } from "@tanstack/react-table"

/** Natural ("human") order for names with numbers in them (#244): "DIMM 2"
 * before "DIMM 10", "Ethernet1/2" before "Ethernet1/10", where a plain string
 * compare reads 1, 10, 11, 2. Case and accents do not matter. The backend
 * orders lists the same way (the natural_sort collation, root order), so a
 * table sorted here agrees with the order the API sent. The locale is pinned:
 * the browser's own would move names per language (Danish sorts "Aalborg"
 * after "Z"), and "und" falls back to the browser's. */
const collator = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
})

/** Compare two labels in natural order; null and undefined read as "". */
export function naturalCompare(
  a: string | null | undefined,
  b: string | null | undefined
): number {
  return collator.compare(a ?? "", b ?? "")
}

/** A comparator for `Array.sort` that orders items by a label:
 * `rows.sort(byNatural((r) => r.name))`. */
export function byNatural<T>(
  label: (item: T) => string | null | undefined
): (a: T, b: T) => number {
  return (a, b) => naturalCompare(label(a), label(b))
}

/** Any two cell values: text in natural order, numbers and dates by value,
 * anything else by `<` - TanStack's "basic" - so a numeric column sorts as
 * it always did. */
export function compareValues(a: unknown, b: unknown): number {
  const text = (v: unknown) => typeof v === "string" || v == null
  const str = (v: unknown) => (typeof v === "string" ? v : "")
  if (text(a) && text(b) && (typeof a === "string" || typeof b === "string"))
    return naturalCompare(str(a), str(b))
  if (a instanceof Date || b instanceof Date) {
    const x = a instanceof Date ? a.getTime() : a
    const y = b instanceof Date ? b.getTime() : b
    return compareBasic(x, y)
  }
  return compareBasic(a, b)
}

function compareBasic(a: unknown, b: unknown): number {
  if (a === b) return 0
  return (a as number) > (b as number) ? 1 : -1
}

/** The DataTable's default sorting function: every column that does not set
 * its own `sortingFn` sorts its values with `compareValues`. */
export function naturalSortingFn<T>(
  rowA: Row<T>,
  rowB: Row<T>,
  columnId: string
): number {
  return compareValues(rowA.getValue(columnId), rowB.getValue(columnId))
}
