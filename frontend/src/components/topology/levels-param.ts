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
