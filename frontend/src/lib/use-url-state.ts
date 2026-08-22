import { useNavigate, useSearch } from "@tanstack/react-router"

/**
 * URL-backed page state - the non-tab half of what [[use-url-tab]] does for
 * `?tab=`.
 *
 * A control kept in `useState` is unshareable and forgotten: reload, and it
 * snaps back to its default; send someone the link, and they see something
 * else. These hooks make the URL the source of truth instead, so a page's
 * settings survive a reload, travel in a link, work with browser back/forward,
 * and get captured by a bookmark (bookmarks store the query string verbatim).
 *
 * They are drop-in replacements for `useState`, so a page adopting them keeps
 * its shape:
 *
 *   const [color, setColor] = useUrlEnum("color", "cable", COLOR_MODES)
 *   const [site, setSite] = useUrlText("site")
 *
 * Two rules make the URLs readable:
 *
 * - the default value is written as **no param at all**, so a page on its
 *   defaults has a clean address;
 * - a value the page doesn't recognise reads back as the default rather than
 *   throwing, so a hand-typed or stale param can never break the page.
 *
 * `fallback` is a plain value, so a caller can layer its own precedence on top
 * (a saved view's setting, then a stored personal default, then the hard
 * default) simply by computing what it passes in.
 */

interface ParamSpec<T> {
  key: string
  /** Search value → value. Return `undefined` to reject and use the fallback.
   * The input is `unknown`, NOT string: a route's `validateSearch` may have
   * already coerced the param (a flag to boolean, a depth to number), and a
   * hook that only reads strings silently falls back on such routes - the
   * checkbox that "can't be unticked" bug. */
  parse: (raw: unknown) => T | undefined
  /** Value → URL string, or `undefined` to drop the param. */
  format: (value: T) => string | undefined
  fallback: T
  /** Same value as the fallback → drop the param (clean default URLs). */
  isDefault: (value: T) => boolean
  /** Replace the history entry instead of pushing one (typing, sliders). */
  replace?: boolean
}

function useUrlParam<T>(spec: ParamSpec<T>): [T, (value: T) => void] {
  const navigate = useNavigate()
  // strict:false → the hook works on any route, whether or not that route
  // declares the param in its own validateSearch.
  const search = useSearch({ strict: false }) as Record<string, unknown>
  const raw = search[spec.key]
  const parsed =
    raw === undefined || raw === null ? undefined : spec.parse(raw)
  const value = parsed === undefined ? spec.fallback : parsed

  const set = (next: T) => {
    void navigate({
      to: ".",
      replace: spec.replace ?? false,
      // A functional updater, so setting one param never drops the others.
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        [spec.key]: spec.isDefault(next) ? undefined : spec.format(next),
      }),
    })
  }
  return [value, set]
}

/**
 * Write several params in one navigation.
 *
 * Calling two setters in the same tick does NOT work: each builds its update
 * from the URL as it is *now*, so the second silently discards the first.
 * Compound transitions - applying a saved view, changing a filter that also
 * has to clear something else - must go through one call.
 *
 *   patch({ site: "x", view: undefined, devices: undefined })
 *
 * `undefined` removes a param, exactly as in the single-value hooks.
 */
export function useUrlPatch(): (
  values: Record<string, string | undefined>,
  opts?: { replace?: boolean }
) => void {
  const navigate = useNavigate()
  return (values, opts) => {
    void navigate({
      to: ".",
      replace: opts?.replace ?? false,
      search: (prev: Record<string, unknown>) => ({ ...prev, ...values }),
    })
  }
}

/** One of a fixed set of strings (`?color=speed`). */
export function useUrlEnum<T extends string>(
  key: string,
  fallback: T,
  valid: readonly T[],
  opts?: { replace?: boolean }
): [T, (value: T) => void] {
  return useUrlParam<T>({
    key,
    parse: (raw) =>
      typeof raw === "string" && valid.includes(raw as T)
        ? (raw as T)
        : undefined,
    format: (v) => v,
    fallback,
    isDefault: (v) => v === fallback,
    replace: opts?.replace,
  })
}

/** Free text or an opaque id (`?site=<uuid>`, `?q=core`). The default is the
 * empty string, i.e. an absent param - which is also how "no filter" reads. */
export function useUrlText(
  key: string,
  fallback = "",
  opts?: { replace?: boolean }
): [string, (value: string) => void] {
  return useUrlParam<string>({
    key,
    parse: (raw) => (typeof raw === "string" ? raw : undefined),
    format: (v) => v,
    fallback,
    isDefault: (v) => v === fallback,
    replace: opts?.replace,
  })
}

/** A toggle written as `1` / `0`, present only when it differs from the
 * default - `?panels=1` on a page whose panels are hidden by default. */
export function useUrlFlag(
  key: string,
  fallback: boolean
): [boolean, (value: boolean) => void] {
  return useUrlParam<boolean>({
    key,
    parse: (raw) =>
      raw === true || raw === "1" || raw === "true"
        ? true
        : raw === false || raw === "0" || raw === "false"
          ? false
          : undefined,
    format: (v) => (v ? "1" : "0"),
    fallback,
    isDefault: (v) => v === fallback,
  })
}

/** A whole number, clamped to its range (`?depth=3`). */
export function useUrlInt(
  key: string,
  fallback: number,
  range?: { min?: number; max?: number }
): [number, (value: number) => void] {
  const clamp = (n: number) =>
    Math.min(range?.max ?? Infinity, Math.max(range?.min ?? -Infinity, n))
  return useUrlParam<number>({
    key,
    parse: (raw) => {
      if (typeof raw !== "string" && typeof raw !== "number") return undefined
      const n = Number(raw)
      return Number.isFinite(n) ? clamp(Math.round(n)) : undefined
    },
    format: (v) => String(clamp(Math.round(v))),
    fallback,
    isDefault: (v) => clamp(Math.round(v)) === fallback,
  })
}

/**
 * A list of ids (`?devices=a,b,c`). `null` means the param is absent, which is
 * different from an empty list: `?devices=` is a deliberate empty set (the
 * topology builder's empty map), and the two must round-trip separately.
 */
export function useUrlCsv(
  key: string,
  fallback: string[] | null = null
): [string[] | null, (value: string[] | null) => void] {
  const same = (a: string[] | null, b: string[] | null) =>
    a === null || b === null ? a === b : a.join(",") === b.join(",")
  return useUrlParam<string[] | null>({
    key,
    parse: (raw) =>
      typeof raw === "string" ? raw.split(",").filter(Boolean) : undefined,
    format: (v) => (v === null ? undefined : v.join(",")),
    fallback,
    isDefault: (v) => same(v, fallback),
  })
}
