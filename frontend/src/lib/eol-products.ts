import type { EolProductRow, EolSuggestion } from "@/lib/api"
import type { ComboboxOption } from "@/components/ui/combobox"

/** The source key of a tenant's own end-of-life products. */
export const CUSTOM_SOURCE = "custom"

/** A product's picker value: its source and name - a custom product may
 * share its name with a fetched one. */
export function productKey(source: string, name: string): string {
  return `${source}:${name}`
}

/** The `{source, product}` a picker value names. */
export function splitProductKey(key: string): {
  source: string
  product: string
} {
  const i = key.indexOf(":")
  return { source: key.slice(0, i), product: key.slice(i + 1) }
}

/** Picker rows: the subject's suggestions first, then the tenant's own
 * products, then the fetched catalog - the custom ones chipped `Custom`. */
export function eolProductOptions(
  results: EolProductRow[],
  suggestions: EolSuggestion[]
): ComboboxOption[] {
  const custom = (source: string) => source === CUSTOM_SOURCE
  const suggested = new Set(
    suggestions.map((s) => productKey(s.source, s.name))
  )
  const rest = results.filter(
    (p) => !suggested.has(productKey(p.source, p.name))
  )
  const option = (
    p: { source: string; name: string; label: string },
    group: string
  ): ComboboxOption => ({
    value: productKey(p.source, p.name),
    label: p.label || p.name,
    group,
    hint: p.name,
    chip: custom(p.source) ? "Custom" : undefined,
  })
  return [
    ...suggestions.map((s) => option(s, "Suggested")),
    ...rest
      .filter((p) => custom(p.source))
      .map((p) => option(p, "Custom products")),
    ...rest
      .filter((p) => !custom(p.source))
      .map((p) => option(p, "All products")),
  ]
}
