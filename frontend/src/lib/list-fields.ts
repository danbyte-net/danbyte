import { useQuery } from "@tanstack/react-query"

import { api, DEFAULT_DEVICE_FIELD_VISIBILITY } from "@/lib/api"
import type { CustomFieldType, DeviceFieldVisibility } from "@/lib/api"

// The list-column catalog (GET /api/list-fields/?path=…, #243): every field a
// list's rows carry, described well enough to render a column for it. The
// backend derives it from the list serializer, so a field added to a list
// appears in its table's Columns menu without touching the SPA.

export type ListFieldKind =
  | "text"
  | "longtext"
  | "ip"
  | "number"
  | "bool"
  | "choice"
  | "date"
  | "datetime"
  | "color"
  | "object"
  | "objects"
  | "tags"
  | "auto"

export interface ListField {
  /** Dotted path into a row - also the column id. */
  key: string
  label: string
  kind: ListFieldKind
  group: "fields" | "related"
  /** Where the value sits when it is not at `key` (`config_template.resolved`). */
  path?: string
  /** `app.model` an object points at - mapped to a route by the SPA. */
  related?: string
  /** The parent's label for a nested field ("Site" for `site.region`). */
  via?: string
  options?: { value: string; label: string }[]
  /** A /api/dcim/choices/ list key, for long taxonomies. */
  choices?: string
  /** The device-field switch (Settings → Device fields) that hides it. */
  setting?: keyof DeviceFieldVisibility
}

/** A custom-field definition as the catalog serves it - the subset a column
 * needs, readable by anyone who can read the list. */
export interface ListCustomField {
  key: string
  label: string
  type: CustomFieldType
  choices: string[]
  related_model: string
  weight: number
  group: string | null
  group_name: string | null
  group_weight: number | null
}

export interface ListFieldCatalog {
  path: string
  model: string | null
  slug: string | null
  cf_model: string | null
  fields: ListField[]
  custom_fields: ListCustomField[]
}

/** The catalog for one list endpoint. Cached for ten minutes: it changes with
 * the code and with custom-field definitions, and saving a definition
 * invalidates `["list-fields"]`. */
export function useListFields(path: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ["list-fields", path],
    queryFn: () =>
      api<ListFieldCatalog>(
        `/api/list-fields/?${new URLSearchParams({ path: path ?? "" })}`
      ),
    enabled: enabled && !!path,
    staleTime: 10 * 60_000,
    retry: false,
  })
}

/** Admin-controlled device-field visibility, shared with the device form and
 * detail page (same query key, so saving the settings refreshes all three). */
export function useDeviceFieldVisibility(
  enabled = true
): DeviceFieldVisibility {
  const q = useQuery({
    queryKey: ["device-field-visibility"],
    queryFn: () => api<DeviceFieldVisibility>("/api/device-fields/"),
    enabled,
    staleTime: 10 * 60_000,
    retry: false,
  })
  return q.data ?? DEFAULT_DEVICE_FIELD_VISIBILITY
}
