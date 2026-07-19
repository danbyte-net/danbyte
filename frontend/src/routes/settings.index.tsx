import { createFileRoute, Link } from "@tanstack/react-router"

import { useMe } from "@/lib/use-me"

// Landing page at exactly /settings.
export const Route = createFileRoute("/settings/")({ component: SettingsIndex })

function SettingsIndex() {
  const { canManage, canManageDeployment } = useMe()
  return (
    <div className="max-w-5xl space-y-4">
      <p className="text-sm text-muted-foreground">
        Manage how Danbyte looks and behaves for you.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Link
          to="/settings/preferences"
          className="rounded-lg border border-border p-4 hover:bg-muted/40"
        >
          <div className="text-sm font-semibold">Preferences</div>
          <p className="mt-1 text-xs text-muted-foreground">
            Your saved table layouts — reset a table to the tenant default.
          </p>
        </Link>
        {canManage && (
          <Link
            to="/settings/tenant"
            className="rounded-lg border border-border p-4 hover:bg-muted/40"
          >
            <div className="text-sm font-semibold">This tenant</div>
            <p className="mt-1 text-xs text-muted-foreground">
              Per-tenant overrides — UI policy, sharing, email relay, and the
              tenant's own directory.
            </p>
          </Link>
        )}
        {canManageDeployment && (
          <Link
            to="/settings/admin"
            className="rounded-lg border border-border p-4 hover:bg-muted/40"
          >
            <div className="text-sm font-semibold">Deployment</div>
            <p className="mt-1 text-xs text-muted-foreground">
              Install-wide defaults — deployment name, global email/LDAP,
              updates, sharing policy.
            </p>
          </Link>
        )}
      </div>
    </div>
  )
}
