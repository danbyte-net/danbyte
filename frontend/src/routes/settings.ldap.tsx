import { createFileRoute } from "@tanstack/react-router"

import { useMe } from "@/lib/use-me"
import {
  DEPLOYMENT_LDAP,
  LdapDirectory,
} from "@/components/settings/ldap-directory"

export const Route = createFileRoute("/settings/ldap")({
  component: LdapSettingsPage,
})

// The DEPLOYMENT directory — every tenant's logins may try it. Tenant-specific
// directories live under Settings → This tenant → Directory.
function LdapSettingsPage() {
  const { canManageDeployment, isLoading } = useMe()
  if (isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (!canManageDeployment)
    return (
      <p className="text-sm text-muted-foreground">
        Deployment admin required — this directory serves the whole install.
        Tenant directory overrides live under{" "}
        <span className="font-mono">Settings → This tenant → Directory</span>.
      </p>
    )
  return <LdapDirectory endpoints={DEPLOYMENT_LDAP} />
}
