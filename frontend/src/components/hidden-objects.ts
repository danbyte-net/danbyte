import { useCallback, useEffect, useState } from "react"

/**
 * What a map's eye toggles have switched off, by group key.
 *
 * Kept as the group keys a sidebar shows (a role name, a tile type id, a
 * site id) rather than resolved object ids: hiding "Access Point" means the
 * role, so a device that gains it tomorrow stays hidden too. Which keys a map
 * has is the map's business; the site map, the floor plan and the topology
 * map each declare their own, and share the helpers here so hiding reads and
 * behaves the same on all three.
 */
export type HiddenSet<TKey extends string> = Record<TKey, string[]>

export function emptyHidden<TKey extends string>(
  keys: readonly TKey[]
): HiddenSet<TKey> {
  return Object.fromEntries(
    keys.map((k) => [k, []])
  ) as unknown as HiddenSet<TKey>
}

export function hiddenCount(h: HiddenSet<string>): number {
  return Object.values(h).reduce((n, list) => n + list.length, 0)
}

export function isHidden<TKey extends string>(
  h: HiddenSet<TKey>,
  key: TKey,
  value: string
): boolean {
  return h[key].includes(value)
}

/** The set with `value` shown or hidden under `key` - a new object, the
 * old one untouched, so it slots into a state setter. */
export function setHidden<TKey extends string>(
  h: HiddenSet<TKey>,
  key: TKey,
  value: string,
  hidden: boolean
): HiddenSet<TKey> {
  const list = h[key]
  if (hidden === list.includes(value)) return h
  return {
    ...h,
    [key]: hidden ? [...list, value] : list.filter((v) => v !== value),
  }
}

/** A stored set brought up to the map's current keys: unknown keys dropped,
 * missing ones empty, non-lists ignored. Tolerates the old flat-list shape
 * a map may have saved before it had groups (`legacyKey` says which group
 * that list was). */
export function normalizeHidden<TKey extends string>(
  raw: unknown,
  keys: readonly TKey[],
  legacyKey?: TKey
): HiddenSet<TKey> {
  const out = emptyHidden(keys)
  if (Array.isArray(raw)) {
    if (legacyKey) out[legacyKey] = raw.filter((v) => typeof v === "string")
    return out
  }
  if (!raw || typeof raw !== "object") return out
  for (const k of keys) {
    const v = (raw as Record<string, unknown>)[k]
    if (Array.isArray(v)) out[k] = v.filter((x) => typeof x === "string")
  }
  return out
}

/** A hidden set remembered per browser under `storageKey`. */
export function useStoredHidden<TKey extends string>(
  storageKey: string,
  keys: readonly TKey[],
  legacyKey?: TKey
): [HiddenSet<TKey>, (next: HiddenSet<TKey>) => void] {
  const [hidden, setHiddenState] = useState<HiddenSet<TKey>>(() => {
    try {
      return normalizeHidden(
        JSON.parse(localStorage.getItem(storageKey)!),
        keys,
        legacyKey
      )
    } catch {
      return emptyHidden(keys)
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(hidden))
    } catch {
      /* storage full or blocked - the session still works */
    }
  }, [storageKey, hidden])
  const set = useCallback((next: HiddenSet<TKey>) => setHiddenState(next), [])
  return [hidden, set]
}
