import type { SlaCheckGroup, SlaMemberFigure, SlaStackFold } from "@/lib/api"

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

/** The rows Remove acts on. A folded stack gives up only its rows that are
 * still in (`current`): removing a row that already left deletes it, and its
 * history and exclusions with it. A single row goes as it always has. */
export function removableRowIds(
  m: Pick<SlaMemberFigure, "member_id" | "member_ids">,
  current: ReadonlySet<string>
): string[] {
  const ids = memberRowIds(m)
  return ids.length > 1 ? ids.filter((id) => current.has(id)) : ids
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

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/** What a group's selector matches, for its card: "2 roles · 1 type". */
export function selectorSummary(
  g: Pick<
    SlaCheckGroup,
    | "use_selector"
    | "match_sites"
    | "match_roles"
    | "match_device_types"
    | "match_platforms"
    | "match_tags"
    | "match_name"
  >
): string {
  if (!g.use_selector) return "Off"
  const parts = [
    g.match_sites.length && count(g.match_sites.length, "site", "sites"),
    g.match_roles.length && count(g.match_roles.length, "role", "roles"),
    g.match_device_types.length &&
      count(g.match_device_types.length, "type", "types"),
    g.match_platforms.length &&
      count(g.match_platforms.length, "platform", "platforms"),
    g.match_tags.length && count(g.match_tags.length, "tag", "tags"),
    g.match_name && g.match_name,
  ].filter(Boolean)
  return parts.length ? parts.join(" · ") : "Matches nothing"
}

/** The group's selector fields that are set, by label - they narrow any
 * role or type added to it. */
export function selectorFieldsSet(
  g: Pick<
    SlaCheckGroup,
    | "match_sites"
    | "match_roles"
    | "match_device_types"
    | "match_platforms"
    | "match_tags"
    | "match_name"
  >,
  except: "roles" | "types"
): string[] {
  return [
    g.match_sites.length ? "Sites" : "",
    except !== "roles" && g.match_roles.length ? "Roles" : "",
    except !== "types" && g.match_device_types.length ? "Device types" : "",
    g.match_platforms.length ? "Platforms" : "",
    g.match_tags.length ? "Tags" : "",
    g.match_name ? "Name" : "",
  ].filter(Boolean)
}

/** Whether adding a first role (or type) to a selector that already matches
 * on other fields drops the devices it matches now that lack it: the fields
 * are AND'd, values within one field OR'd. */
export function selectorShrinks(
  g: Pick<
    SlaCheckGroup,
    | "use_selector"
    | "match_sites"
    | "match_roles"
    | "match_device_types"
    | "match_platforms"
    | "match_tags"
    | "match_name"
  >,
  kind: "roles" | "types"
): boolean {
  const own = kind === "roles" ? g.match_roles : g.match_device_types
  return (
    g.use_selector && own.length === 0 && selectorFieldsSet(g, kind).length > 0
  )
}
