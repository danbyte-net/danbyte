// Object types a certificate can be assigned to (the generic `object_type`
// label + `object_id` target the CertificateAssignment serializer accepts and
// the cert-drift resolver walks). Maps the `app.model` label to a friendly name
// and its SPA detail route, so the cert detail's Assignments tab and the
// per-object CertificatesPanel share one source of truth for how a target reads.

export interface CertificateObjectType {
  label: string
  /** SPA detail route, or null if that object has no detail page. */
  route: string | null
}

// Typed with `| undefined`: an assignment written by a newer backend can carry
// an object_type this map doesn't know, and callers must handle the miss rather
// than read through it.
export const CERTIFICATE_OBJECT_TYPES: Record<
  string,
  CertificateObjectType | undefined
> = {
  "api.device": { label: "Device", route: "/devices/$id" },
  "api.virtualmachine": {
    label: "Virtual machine",
    route: "/virtual-machines/$id",
  },
  "api.ipaddress": { label: "IP address", route: "/ips/$id" },
  "api.service": { label: "Service", route: null },
}

export function certificateObjectLabel(objectType: string): string {
  return CERTIFICATE_OBJECT_TYPES[objectType]?.label ?? objectType
}
