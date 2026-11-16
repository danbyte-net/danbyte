/**
 * Model anchor names against component template names - the twin of
 * api/anchor_names.py (`anchor-names.cases.json` holds cases both test
 * suites run).
 *
 * A model is authored as the first stack member: `port:GigabitEthernet1/0/1`
 * matches the template `GigabitEthernet{position}/0/1` (`{position}` as 1,
 * `{position:N}` as N). Only a leading `{position}` - the member segment,
 * its prefix without a digit - counts. The same string always wins, then
 * the authored spelling, then that spelling with the interface family
 * written either way (`Gi1/0/1` is `GigabitEthernet1/0/1`). Several names
 * at one step are ambiguous and match nothing.
 */

const LEADING_POSITION = /^([^\d{}]*)\{position(?::(\d+))?\}/

/** `name` as a model authored as the first stack member spells it. */
export function authored(name: string): string {
  const m = LEADING_POSITION.exec(name)
  if (!m) return name
  const first = m[2] as string | undefined
  return `${m[1]}${first ?? "1"}${name.slice(m[0].length)}`
}

/** Interface families and their short spellings, lower-case - the same
 * table as api/anchor_names.py INTERFACE_ABBREVIATIONS. */
export const INTERFACE_ABBREVIATIONS: Readonly<
  Record<string, readonly string[]>
> = {
  fastethernet: ["fa"],
  gigabitethernet: ["gi", "gig"],
  twogigabitethernet: ["tw", "twogige"],
  fivegigabitethernet: ["fi", "fivegige"],
  tengigabitethernet: ["te", "tengige"],
  twentyfivegige: ["twe", "twentyfivegigabitethernet"],
  fortygigabitethernet: ["fo", "fortygige"],
  hundredgige: ["hu", "hundredgigabitethernet", "hundredgigethernet"],
  appgigabitethernet: ["ap"],
  "port-channel": ["po", "portchannel"],
  ethernet: ["eth", "et"],
  management: ["mgmt", "ma"],
}

const FAMILY = new Map<string, string>(
  Object.entries(INTERFACE_ABBREVIATIONS).flatMap(([k, v]) =>
    [k, ...v].map((s) => [s, k] as [string, string])
  )
)
const PREFIX = /^([A-Za-z][A-Za-z-]*)\s?(?=[\d{])/

/** `name` with a known interface family prefix in its long, lower-case
 * spelling (`Gi1/0/1` → `gigabitethernet1/0/1`); any other name as is.
 * Only the prefix: the numbers must still agree exactly. */
export function longForm(name: string): string {
  const m = PREFIX.exec(name)
  const family = m ? FAMILY.get(m[1].toLowerCase()) : undefined
  if (!m || family === undefined) return name
  return family + name.slice(m[0].length)
}

function push(map: Map<string, string[]>, key: string, name: string) {
  const row = map.get(key)
  if (!row) map.set(key, [name])
  else if (!row.includes(name)) row.push(name)
}

export class NameMatcher {
  readonly names: string[]
  private readonly exact: Set<string>
  private readonly forms = new Map<string, string[]>()
  private readonly longs = new Map<string, string[]>()

  constructor(names: Iterable<string>) {
    this.names = [...new Set(names)]
    this.exact = new Set(this.names)
    for (const n of this.names) {
      const key = authored(n)
      push(this.forms, key, n)
      push(this.longs, longForm(key), n)
    }
  }

  /** The names `anchor` matches: itself when it is one, else every name of
   * the same authored spelling, else of that spelling with the interface
   * family written either way. */
  candidates(anchor: string): string[] {
    if (this.exact.has(anchor)) return [anchor]
    const spelled = authored(anchor)
    const found = this.forms.get(spelled)
    if (found?.length) return [...found]
    return [...(this.longs.get(longForm(spelled)) ?? [])]
  }

  /** The one name `anchor` matches, or null (none, or ambiguous). */
  resolve(anchor: string): string | null {
    const found = this.candidates(anchor)
    return found.length === 1 ? found[0] : null
  }
}
