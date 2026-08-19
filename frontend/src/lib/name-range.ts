/**
 * One `[a-b]` range in a component name expands to that many components, so
 * "Disk[1-5]" creates Disk1 … Disk5 in a single submit. Any other text is
 * left alone, which keeps a literal name like "Disk[1-5]" impossible but
 * every ordinary name unaffected.
 *
 * Shared by the device-type template dialog and every device-page component
 * dialog, so multi-add means the same thing everywhere.
 */
export const NAME_RANGE_RE = /\[(\d+)-(\d+)\]/

/** Refuse to fan out beyond this in one submit - a typo like [1-99999]
 * shouldn't try to create 99k rows. */
export const RANGE_CAP = 128

/**
 * "Disk[1-5]" → ["Disk1", …, "Disk5"]. Returns `[name]` unchanged when there
 * is no range, the bounds are reversed or unparseable, or the span exceeds
 * {@link RANGE_CAP} - callers can then treat it as a plain single name.
 */
export function expandNameRange(name: string): string[] {
  const m = name.match(NAME_RANGE_RE)
  if (!m) return [name]
  const lo = Number(m[1])
  const hi = Number(m[2])
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo) return [name]
  if (hi - lo + 1 > RANGE_CAP) return [name]
  const out: string[] = []
  for (let i = lo; i <= hi; i++)
    out.push(name.replace(NAME_RANGE_RE, String(i)))
  return out
}

/** True when the name carries a range that {@link expandNameRange} will act
 * on - for showing a "creates N" hint before the user submits. */
export function hasNameRange(name: string): boolean {
  return expandNameRange(name).length > 1
}

/**
 * Run one create per expanded name, in order. Sequential on purpose: the
 * server enforces name uniqueness per device, so a clash partway through a
 * range reports the name that clashed instead of an unordered pile of
 * rejections. Whatever was created before the failure stays created.
 */
export async function createEach<T>(
  names: string[],
  post: (name: string) => Promise<T>
): Promise<{ last: T; count: number }> {
  let last!: T
  for (const name of names) last = await post(name)
  return { last, count: names.length }
}
