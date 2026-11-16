import type { ModuleTypeOption } from "@/lib/api"

export interface ModuleTypePick {
  value: string
  label: string
  group?: string
}

const label = (t: ModuleTypeOption) =>
  t.part_number ? `${t.name} (${t.part_number})` : t.name

/** The heading over everything a first group leaves. */
export const ALL_MODULE_TYPES = "All module types"

/**
 * The install picker's module types, a first group then the rest under
 * "All module types": the bay's suggestions (part numbers, compared trimmed
 * and case-insensitively) under "Suggested"; failing those, the chassis
 * manufacturer's types (`ownMake`, headed `makeName`). Neither: one list.
 */
export function moduleTypePicks(
  types: readonly ModuleTypeOption[],
  suggested: readonly string[] | undefined,
  ownMake?: readonly ModuleTypeOption[] | null,
  makeName = "Chassis manufacturer"
): ModuleTypePick[] {
  const wanted = new Set(
    (suggested ?? []).map((p) => p.trim().toLowerCase()).filter(Boolean)
  )
  const own = new Set((ownMake ?? []).map((t) => t.id))
  let first: (t: ModuleTypeOption) => boolean = (t) =>
    !!t.part_number && wanted.has(t.part_number.trim().toLowerCase())
  let heading = "Suggested"
  if (!types.some(first)) {
    first = (t) => own.has(t.id)
    heading = makeName
  }
  if (!types.some(first))
    return types.map((t) => ({ value: t.id, label: label(t) }))
  return [
    ...types
      .filter(first)
      .map((t) => ({ value: t.id, label: label(t), group: heading })),
    ...types
      .filter((t) => !first(t))
      .map((t) => ({ value: t.id, label: label(t), group: ALL_MODULE_TYPES })),
  ]
}
