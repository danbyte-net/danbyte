// Audited object types (`app.model` labels, mirroring AUDITED_MODELS in
// audit/apps.py) → the SPA detail route, so the audit log and the changelog
// detail page can deep-link back to the object that changed. Only models with
// a `$id` detail route are listed; anything else renders as plain text.
export const OBJECT_DETAIL_ROUTES: Record<string, string> = {
  "api.aggregate": "/aggregates/$id",
  "api.asn": "/asns/$id",
  "api.cable": "/cables/$id",
  "api.cluster": "/clusters/$id",
  "api.clustergroup": "/cluster-groups/$id",
  "api.clustertype": "/cluster-types/$id",
  "api.contact": "/contacts/$id",
  "api.device": "/devices/$id",
  "api.devicerole": "/device-roles/$id",
  "api.devicetype": "/device-types/$id",
  "api.fhrpgroup": "/fhrp-groups/$id",
  "api.interface": "/interfaces/$id",
  "api.ipaddress": "/ips/$id",
  "api.iprange": "/ip-ranges/$id",
  "api.iprole": "/ip-roles/$id",
  // Renamed model: rows written as api.IPStatus predate api.Status.
  "api.ipstatus": "/statuses/$id",
  "api.status": "/statuses/$id",
  "api.location": "/locations/$id",
  "api.manufacturer": "/manufacturers/$id",
  "api.platform": "/platforms/$id",
  "api.prefix": "/prefixes/$id",
  "api.rack": "/racks/$id",
  "api.rackrole": "/rack-roles/$id",
  "api.racktype": "/rack-types/$id",
  "api.rir": "/rirs/$id",
  "api.routetarget": "/route-targets/$id",
  "api.service": "/services/$id",
  "api.servicetemplate": "/service-templates/$id",
  "api.site": "/sites/$id",
  "api.virtualmachine": "/virtual-machines/$id",
  "api.vlan": "/vlans/$id",
  "api.vlangroup": "/vlan-groups/$id",
  "api.vrf": "/vrfs/$id",
  "compliance.compliancerule": "/compliance-rules/$id",
  "core.tag": "/tags/$id",
  "core.tenant": "/tenants/$id",
  "customization.customfield": "/custom-fields/$id",
}

// Audited types with no $id detail page but a list page that shows them -
// the change log links there instead of rendering plain text.
export const OBJECT_LIST_ROUTES: Record<string, string> = {
  "api.portreservation": "/port-reservations",
}

/** List-page fallback for an audited type without a detail route. */
export function objectListRoute(objectType: string): string | undefined {
  return OBJECT_LIST_ROUTES[objectType]
}

/** Detail route for an audited object type, or undefined when it has none
 * (or the object was deleted - callers should skip the link on deletes). */
export function objectDetailRoute(objectType: string): string | undefined {
  return OBJECT_DETAIL_ROUTES[objectType]
}

/** `/devices/<uuid>` → `{ objectType: "api.device", id }`, by inverting the
 * detail-route table. Null on anything that isn't an object detail page. */
export function objectForPath(
  pathname: string
): { objectType: string; id: string } | null {
  const m = pathname.match(/^\/([a-z-]+)\/([0-9a-fA-F-]{36})\/?$/)
  if (!m) return null
  const route = `/${m[1]}/$id`
  for (const [label, to] of Object.entries(OBJECT_DETAIL_ROUTES)) {
    if (to === route) return { objectType: label, id: m[2] }
  }
  return null
}
