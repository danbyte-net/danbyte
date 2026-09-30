import type { SlaMemberFigure, SlaStackFold } from "@/lib/api"

// Pure helpers for an agreement's member rows. A switch stack can stand for
// several member rows at once (its chassis and the devices folded into it),
// so every reader goes through these instead of `member_id` alone.

/** "via sw1-2, sw1-3" - the devices folded into a stack's row, three at
 * most, then "+n". Null for a row that stands for one object. */
export function viaText(via: SlaStackFold["via"]): string | null {
  if (!via?.length) return null
  const names = via
    .slice(0, 3)
    .map((v) => v.name)
    .join(", ")
  return via.length > 3 ? `via ${names} +${via.length - 3}` : `via ${names}`
}

/** Every member row behind a figure's row. Older stored periods have no
 * `member_ids`; a selector match has no row at all. */
export function memberRowIds(
  m: Pick<SlaMemberFigure, "member_id" | "member_ids">
): string[] {
  return m.member_ids ?? (m.member_id ? [m.member_id] : [])
}

/** Names for the Exclusions tab: `table` names every member row, a folded
 * stack's too; `options` offers each figure row once, by the row an
 * exclusion is written against (it then excuses the whole stack). */
export function exclusionMembers(members: SlaMemberFigure[]): {
  table: Map<string, string>
  options: { id: string; name: string }[]
} {
  const table = new Map<string, string>()
  const options: { id: string; name: string }[] = []
  for (const m of members) {
    for (const id of memberRowIds(m)) table.set(id, m.name)
    if (m.member_id) options.push({ id: m.member_id, name: m.name })
  }
  return { table, options }
}
