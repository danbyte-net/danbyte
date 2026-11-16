/**
 * Model anchor names against component template names - the twin of
 * api/anchor_names.py (`anchor-names.cases.json` holds cases both test
 * suites run).
 *
 * A model is authored as the first stack member: `port:GigabitEthernet1/0/1`
 * matches the template `GigabitEthernet{position}/0/1` (`{position}` as 1,
 * `{position:N}` as N). Only a leading `{position}` - the member segment,
 * its prefix without a digit - counts. The same string always wins; several
 * names of the same authored spelling are ambiguous and match nothing.
 */

const LEADING_POSITION = /^([^\d{}]*)\{position(?::(\d+))?\}/

/** `name` as a model authored as the first stack member spells it. */
export function authored(name: string): string {
  const m = LEADING_POSITION.exec(name)
  if (!m) return name
  const first = m[2] as string | undefined
  return `${m[1]}${first ?? "1"}${name.slice(m[0].length)}`
}

export class NameMatcher {
  readonly names: string[]
  private readonly exact: Set<string>
  private readonly forms = new Map<string, string[]>()

  constructor(names: Iterable<string>) {
    this.names = [...new Set(names)]
    this.exact = new Set(this.names)
    for (const n of this.names) {
      const key = authored(n)
      const row = this.forms.get(key)
      if (row) row.push(n)
      else this.forms.set(key, [n])
    }
  }

  /** The names `anchor` matches: itself when it is one, else every name of
   * the same authored spelling. */
  candidates(anchor: string): string[] {
    if (this.exact.has(anchor)) return [anchor]
    return [...(this.forms.get(authored(anchor)) ?? [])]
  }

  /** The one name `anchor` matches, or null (none, or ambiguous). */
  resolve(anchor: string): string | null {
    const found = this.candidates(anchor)
    return found.length === 1 ? found[0] : null
  }
}
