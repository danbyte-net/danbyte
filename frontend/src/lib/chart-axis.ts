/** A time axis keyed on each row's unique timestamp but drawn with its
 * formatted label. Keying a category axis on the label itself breaks as soon
 * as two rows share one ("Thu 03:00" a week apart): recharts matches the
 * hover and the click to the first of them. */
export function labelTicks<TRow extends { label: string }>(
  rows: TRow[],
  key: keyof TRow
): (value: unknown) => string {
  const byKey = new Map(rows.map((r) => [String(r[key]), r.label]))
  return (value) => byKey.get(String(value)) ?? String(value)
}
