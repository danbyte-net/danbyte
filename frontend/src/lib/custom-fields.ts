import { useQuery } from "@tanstack/react-query"

import { api, type CustomField, type CustomFieldType } from "@/lib/api"

// ─── Registry meta (served by the backend, plugin-extensible) ───────────────

export interface ReferenceModelMeta {
  value: string
  label: string
  endpoint: string
  label_field: string
  picker: boolean
  route: string | null
}

export interface CustomizationMeta {
  /** What a field can attach to — auto-derived from CustomFieldsMixin. */
  models: { value: string; label: string }[]
  /** What an object-reference field can point at. */
  reference_models: ReferenceModelMeta[]
}

export function useCustomizationMeta() {
  return useQuery({
    queryKey: ["customization-meta"],
    queryFn: () => api<CustomizationMeta>("/api/customization/meta/"),
    staleTime: 10 * 60_000,
  })
}

// A render section: ungrouped fields under a default "Custom fields" heading,
// then each CustomFieldGroup by weight. Backward-compatible — with no groups
// defined, every field lands in the single ungrouped section (one heading, as
// before). The API already orders fields within a group by (weight, label).
export const UNGROUPED_KEY = "__ungrouped__"

export interface CustomFieldSection {
  key: string
  title: string
  collapsed: boolean
  fields: CustomField[]
}

export function groupCustomFields(defs: CustomField[]): CustomFieldSection[] {
  const ungrouped: CustomField[] = []
  const byGroup = new Map<string, CustomFieldSection & { weight: number }>()
  for (const d of defs) {
    if (!d.group) {
      ungrouped.push(d)
      continue
    }
    let s = byGroup.get(d.group)
    if (!s) {
      s = {
        key: d.group,
        title: d.group_name ?? "Group",
        collapsed: !!d.group_collapsed,
        weight: d.group_weight ?? 0,
        fields: [],
      }
      byGroup.set(d.group, s)
    }
    s.fields.push(d)
  }
  const groups = [...byGroup.values()].sort(
    (a, b) => a.weight - b.weight || a.title.localeCompare(b.title)
  )
  const sections: CustomFieldSection[] = []
  if (ungrouped.length)
    sections.push({
      key: UNGROUPED_KEY,
      title: "Custom fields",
      collapsed: false,
      fields: ungrouped,
    })
  for (const g of groups)
    sections.push({
      key: g.key,
      title: g.title,
      collapsed: g.collapsed,
      fields: g.fields,
    })
  return sections
}

// Field data types — mirrors customization/models.py CUSTOM_FIELD_TYPES.
export const CUSTOM_FIELD_TYPES: { value: CustomFieldType; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "textarea", label: "Text (multi-line)" },
  { value: "integer", label: "Integer" },
  { value: "decimal", label: "Decimal" },
  { value: "boolean", label: "Boolean" },
  { value: "date", label: "Date" },
  { value: "url", label: "URL" },
  { value: "select", label: "Selection" },
  { value: "multiselect", label: "Multiple selection" },
  { value: "object", label: "Object reference" },
]

// Types that require a list of choices.
export const CHOICE_TYPES: CustomFieldType[] = ["select", "multiselect"]

// Domain models a custom field can attach to — mirrors
// customization/models.py CUSTOMIZABLE_MODELS.
export const CUSTOMIZABLE_MODELS: { value: string; label: string }[] = [
  { value: "prefix", label: "Prefixes" },
  { value: "ipaddress", label: "IP addresses" },
  { value: "vrf", label: "VRFs" },
  { value: "vlan", label: "VLANs" },
  { value: "zone", label: "Zones" },
  { value: "site", label: "Sites" },
  { value: "device", label: "Devices" },
  { value: "devicetype", label: "Device types" },
  { value: "devicerole", label: "Device roles" },
  { value: "routetarget", label: "Route targets" },
  { value: "cable", label: "Cables" },
  { value: "macaddress", label: "MAC addresses" },
]

const TYPE_LABELS = Object.fromEntries(
  CUSTOM_FIELD_TYPES.map((t) => [t.value, t.label])
) as Record<string, string>
const MODEL_LABELS = Object.fromEntries(
  CUSTOMIZABLE_MODELS.map((m) => [m.value, m.label])
) as Record<string, string>

export const fieldTypeLabel = (t: string): string => TYPE_LABELS[t] ?? t
export const modelLabel = (m: string): string => MODEL_LABELS[m] ?? m
