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
  "api.ipstatus": "/statuses/$id",
  "api.location": "/locations/$id",
  "api.manufacturer": "/manufacturers/$id",
  "api.platform": "/platforms/$id",
  "api.prefix": "/prefixes/$id",
  "api.rack": "/racks/$id",
  "api.rackrole": "/rack-roles/$id",
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

/** Detail route for an audited object type, or undefined when it has none
 * (or the object was deleted — callers should skip the link on deletes). */
export function objectDetailRoute(objectType: string): string | undefined {
  return OBJECT_DETAIL_ROUTES[objectType]
}
