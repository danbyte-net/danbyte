import { ApiError } from "@/lib/api"

// Pretty error renderer for useQuery failures.
//
// 403 (authenticated but lacks the RBAC permission for this object/action)
// is the common case now that login is forced — show the permission message,
// not a "sign in" CTA. A genuine 401 (session expired) is normally caught by
// the root auth gate, which redirects to /login; if one still surfaces here we
// point at /login, never the Django /admin/.
export function QueryError({ error }: { error: unknown }) {
  const status = error instanceof ApiError ? error.status : undefined
  if (status === 403) {
    return (
      <div className="rounded-md border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
        <p className="mb-2 font-medium text-foreground">
          You don't have permission to view this.
        </p>
        <p className="text-xs text-muted-foreground">
          API said: {(error as Error)?.message ?? "Permission denied"}
        </p>
      </div>
    )
  }
  if (status === 401) {
    return (
      <div className="rounded-md border border-border bg-muted/30 p-4 text-sm text-muted-foreground">
        <p className="mb-2 font-medium text-foreground">
          Your session has expired.
        </p>
        <p>
          <a className="text-primary underline" href="/login">
            Sign in again
          </a>{" "}
          to continue.
        </p>
      </div>
    )
  }
  return (
    <p className="text-sm text-destructive">
      Failed to load: {(error as Error)?.message ?? "Unknown error"}
    </p>
  )
}
