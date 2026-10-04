/** Object types on a permission, between the stored list and the form.
 *
 *  `"*"` ("All object types") reaches every type except users, groups and
 *  permissions - the registry's `wildcard_excluded`. A grant reaches those
 *  only by naming them, so the Administrator grant is stored as
 *  `["*", "user", "group", "objectpermission"]`, and the form must write
 *  exactly that back. Pure so the round trip is testable. */

export const WILDCARD = "*"

export interface TypesState {
  allTypes: boolean
  /** Named types. With the wildcard on, only the ones it does not reach
   *  mean anything, but whatever the grant stored is kept. */
  picked: string[]
}

/** Form state from a grant's stored object types. */
export function typesToState(objectTypes: readonly string[]): TypesState {
  return {
    allTypes: objectTypes.includes(WILDCARD),
    picked: objectTypes.filter((t) => t !== WILDCARD),
  }
}

/** The stored object types from form state. Nothing is filtered: a grant
 *  that came in naming the excluded types leaves naming them, even when the
 *  registry failed to load. */
export function stateToTypes({ allTypes, picked }: TypesState): string[] {
  return allTypes ? [WILDCARD, ...picked] : [...picked]
}

/** Picks kept when "All object types" is switched on: the wildcard covers
 *  the rest, so only the types it does not reach stay named. */
export function picksUnderWildcard(
  picked: readonly string[],
  excluded: readonly string[]
): string[] {
  return picked.filter((t) => excluded.includes(t))
}
