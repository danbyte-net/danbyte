import { createFileRoute } from "@tanstack/react-router"

import { useMe } from "@/lib/use-me"
import { useUrlEnum } from "@/lib/use-url-state"
import { openingScope } from "@/lib/settings-catalog"
import { SegmentedTabs } from "@/components/segmented-tabs"
import {
  DEPLOYMENT_LDAP,
  LdapDirectory,
  TENANT_LDAP,
} from "@/components/settings/ldap-directory"
import { SettingsHeader } from "@/components/settings/settings-card"

export const Route = createFileRoute("/settings/directory")({
  component: DirectoryPage,
})

const SCOPES = ["deployment", "tenant"] as const
type Scope = (typeof SCOPES)[number]

/** LDAP / Active Directory, at both scopes.
 *
 * One page instead of two (#51). The deployment directory serves every
 * tenant's logins; a tenant directory provisions accounts owned by that
 * tenant and may only map to groups narrowed to it. The form is identical -
 * it always was, since both old routes were shims over `LdapDirectory` - so
 * the scope belongs on the page rather than in the sidebar. */
function DirectoryPage() {
  const { canManage, canManageDeployment, isLoading } = useMe()
  const allowed = SCOPES.filter((s) =>
    s === "deployment" ? canManageDeployment : canManage
  )
  const [scope, setScope] = useUrlEnum<Scope>(
    "scope",
    openingScope("directory", allowed) ?? "tenant",
    SCOPES
  )

  if (isLoading)
    return <p className="text-sm text-muted-foreground">Loading…</p>
  if (allowed.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        Tenant admin required to manage a directory.
      </p>
    )

  // A scope you can't manage in the URL lands you on one you can, rather
  // than on a page that refuses to explain itself.
  const active = allowed.includes(scope) ? scope : allowed[0]

  return (
    <div className="space-y-4">
      <SettingsHeader title="Directory">
        LDAP and Active Directory sign-in, group mapping, and who a login
        provisions an account for.
      </SettingsHeader>

      {allowed.length > 1 && (
        <SegmentedTabs
          items={[
            { value: "deployment", label: "Deployment" },
            { value: "tenant", label: "This tenant" },
          ]}
          value={active}
          onValueChange={setScope}
          className="mb-4"
        />
      )}

      {active === "deployment" ? (
        <LdapDirectory key="deployment" endpoints={DEPLOYMENT_LDAP} />
      ) : (
        <LdapDirectory key="tenant" endpoints={TENANT_LDAP} tenantMode />
      )}
    </div>
  )
}
