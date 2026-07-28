// Object types a contact can be attached to (mirrors CONTACTABLE_TYPES in
// api/models.py). Maps the `app.model` label to a friendly name + the SPA
// detail route, so the contact detail page and the per-object ContactsPanel
// share one source of truth.
export interface ContactObjectType {
  label: string
  /** SPA detail route, or null if that object has no detail page yet. */
  route: string | null
}

// Typed with `| undefined` on purpose: an assignment written by a newer
// backend (or an older SPA build) can carry an object_type this map doesn't
// know, and callers must handle the miss rather than read through it.
export const CONTACT_OBJECT_TYPES: Record<
  string,
  ContactObjectType | undefined
> = {
  "api.site": { label: "Site", route: "/sites/$id" },
  "api.device": { label: "Device", route: "/devices/$id" },
  "api.virtualmachine": {
    label: "Virtual machine",
    route: "/virtual-machines/$id",
  },
  "api.cluster": { label: "Cluster", route: "/clusters/$id" },
  "api.rack": { label: "Rack", route: "/racks/$id" },
  "api.prefix": { label: "Prefix", route: "/prefixes/$id" },
  "api.circuit": { label: "Circuit", route: "/circuits/$id" },
  "core.tenant": { label: "Tenant", route: "/tenants/$id" },
}

export function contactObjectLabel(objectType: string): string {
  return CONTACT_OBJECT_TYPES[objectType]?.label ?? objectType
}
