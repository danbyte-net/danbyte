import { createFileRoute } from "@tanstack/react-router"

import { useMe } from "@/lib/use-me"
import {
  LdapDirectory,
  TENANT_LDAP,
} from "@/components/settings/ldap-directory"

export const Route = createFileRoute("/settings/tenant-ldap")({
  component: TenantLdapPage,
})

// This TENANT's own directory. Logins routed here (via the chain or a login
// domain) provision accounts owned by the tenant and grant membership to it
// only; mappings may only target groups narrowed to this tenant.
function TenantLdapPage() {
  const { canManage, isLoading } = useMe()
  if (isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (!canManage)
    return (
      <p className="text-sm text-muted-foreground">Tenant admin required.</p>
    )
  return <LdapDirectory endpoints={TENANT_LDAP} tenantMode />
}
