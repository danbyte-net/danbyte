/**
 * The Levels organiser as one URL parameter.
 *
 * A tiered map looks nothing like the structural one, so a link that drops the
 * tiers doesn't show the recipient what the sender was looking at. The three
 * pieces of Levels state - the role order, which roles are bonded to the level
 * above, and each level's extra distance - encode into a single readable
 * param:
 *
 *   levels=Firewall|Core%20switch+|Distribution:2|Access
 *
 * `+` = bonded to the level above, `:n` = distance step. Role names are
 * percent-encoded per item, which is what keeps a role called `Core|Edge`
 * (or one with a `:` or `+` in it) from breaking the split.
 */

export interface LevelsState {
  order: string[]
  bonds: string[]
  distance: Record<string, number>
}

export const EMPTY_LEVELS: LevelsState = { order: [], bonds: [], distance: {} }

/** "No tiers" needs a spelling of its own: when a saved view HAS tiers, the
 * link that turns them off has to say so - an absent param would just inherit
 * the view's tiers again. */
export const NO_LEVELS = "none"

export function formatLevels(s: LevelsState): string {
  if (!s.order.length) return NO_LEVELS
  return s.order
    .map((name) => {
      const d = s.distance[name] ?? 0
      return (
        encodeURIComponent(name) +
        (s.bonds.includes(name) ? "+" : "") +
        (d > 0 ? `:${d}` : "")
      )
    })
    .join("|")
}

export function parseLevels(raw: string): LevelsState | undefined {
  if (!raw) return undefined
  if (raw === NO_LEVELS) return EMPTY_LEVELS
  const order: string[] = []
  const bonds: string[] = []
  const distance: Record<string, number> = {}
  for (const item of raw.split("|")) {
    if (!item) continue
    let rest = item
    let dist = 0
    // Distance suffix first - it is always last. A `:` inside a role name
    // arrives as %3A (encodeURIComponent escapes it), so a trailing
    // ":<digits>" can only ever be the marker this writer produced.
    const m = /:(\d+)$/.exec(rest)
    if (m) {
      dist = Number(m[1])
      rest = rest.slice(0, m.index)
    }
    const bonded = rest.endsWith("+")
    if (bonded) rest = rest.slice(0, -1)
    let name: string
    try {
      name = decodeURIComponent(rest)
    } catch {
      name = rest // malformed escape - take it literally rather than throw
    }
    if (!name || order.includes(name)) continue
    order.push(name)
    if (bonded) bonds.push(name)
    if (dist > 0) distance[name] = dist
  }
  return order.length ? { order, bonds, distance } : undefined
}

/** True when the two describe the same tier setup (used to decide whether the
 * URL needs the param at all - a state matching the fallback is written as no
 * param, like every other URL-backed control). */
export function sameLevels(a: LevelsState, b: LevelsState): boolean {
  return formatLevels(a) === formatLevels(b)
}

/** Every role a graph shows, ranked into layout tiers.
 *
 * The organiser lists every role on the map: the saved order first, then any
 * role that isn't in it yet, appended - and it numbers each of those rows as
 * its own level. The canvas only ever received the SAVED order though, and
 * ranked everything else `last`, so roles the panel showed as levels 6, 7 and
 * 8 were all drawn in one row. On a big estate that's most of the map.
 *
 * So the appended roles are ranked here exactly as the organiser appends
 * them - `rolesInGraph` order, not alphabetical - and the two agree.
 *
 * `fallback` is the tier for a device with no role at all.
 */
export function roleTiers(
  rolesInGraph: string[],
  groups: string[][]
): { rank: Map<string, number>; fallback: number } {
  const rank = new Map<string, number>()
  groups.forEach((group, i) => group.forEach((name) => rank.set(name, i)))
  const extras = [...new Set(rolesInGraph)].filter((name) => !rank.has(name))
  extras.forEach((name, i) => rank.set(name, groups.length + i))
  return { rank, fallback: groups.length + extras.length }
}

/** What a tiered layout needs: each device's level and each level's
 * main-axis offset. */
export interface GraphLevels {
  /** Node id → level index. Patch panels are left out: they sit between
   * the cables they join, not on a tier. */
  levels: Map<string, number>
  /** Main-axis coordinate of each level, from the Levels distances. */
  mainOffsets: number[]
}

/**
 * The Levels organiser applied to a graph's devices. `groups` is the
 * resolved order (`resolveLevels`); `distance` the extra gap above a
 * level, keyed by its first role.
 */
export function graphLevels(
  nodes: readonly {
    id: string
    data: { role?: { name: string; is_patch_panel?: boolean } | null }
  }[],
  groups: string[][],
  direction: "LR" | "TB" | undefined,
  distance: Record<string, number> | undefined
): GraphLevels {
  const { rank, fallback: last } = roleTiers(
    nodes
      .filter((n) => n.data.role && !n.data.role.is_patch_panel)
      .map((n) => n.data.role!.name),
    groups
  )
  const levels = new Map<string, number>()
  for (const n of nodes) {
    if (n.data.role?.is_patch_panel) continue
    levels.set(n.id, rank.get(n.data.role?.name ?? "") ?? last)
  }
  // A level's gap comes from the distance step of its FIRST role (bonded
  // roles share the level, so they share its gap).
  const base = direction === "TB" ? 200 : 360
  const mult = [0.6, 0.8, 1, 1.4, 2] // 5 distance steps
  const gapOf = (role: string) => base * mult[distance?.[role] ?? 2]
  const mainOffsets = [0]
  for (let i = 1; i <= last; i++)
    mainOffsets[i] = mainOffsets[i - 1] + gapOf(groups[i]?.[0] ?? "")
  return { levels, mainOffsets }
}

/**
 * Resolve the role order + bonds into levels: `[[role, …], …]`.
 *
 * A role listed in `bonds` shares the level of the role directly above it, so
 * several roles can occupy one level (core switches beside routers, say). The
 * first role can never be bonded - there's nothing above it.
 *
 * Shared by the organiser, the canvas and the Diagram's builder (which
 * runs in a worker), so the popover and the layout can't disagree.
 */
export function resolveLevels(order: string[], bonds: string[]): string[][] {
  const out: string[][] = []
  order.forEach((name, i) => {
    if (i > 0 && bonds.includes(name) && out.length)
      out[out.length - 1].push(name)
    else out.push([name])
  })
  return out
}
