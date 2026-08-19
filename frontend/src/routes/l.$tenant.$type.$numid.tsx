import { Navigate, createFileRoute, useParams } from "@tanstack/react-router"
import { useQuery } from "@tanstack/react-query"

import { api } from "@/lib/api"
import { objectDetailRoute } from "@/lib/object-routes"
import { QueryError } from "@/components/query-error"

export const Route = createFileRoute("/l/$tenant/$type/$numid")({
  component: ShortLinkRedirect,
})

interface Resolved {
  object_type: string
  id: string
  tenant: { id: string; name: string; slug: string }
  switched: boolean
}

/**
 * Short-link resolver for label QR codes: `/l/<tenant>/<type>/<numid>` looks up
 * the object by its per-tenant human number and opens the real detail page.
 * Encoding this instead of the full UUID keeps a printed QR small, and the
 * tenant segment makes it unambiguous - the resolver switches the session to
 * that tenant (view-scoped, so it only switches when the user may see the
 * object). When the tenant actually changed we do a full-page navigation so the
 * SPA reloads its caches under the new tenant; otherwise an in-app redirect.
 */
function ShortLinkRedirect() {
  const { tenant, type, numid } = useParams({ from: "/l/$tenant/$type/$numid" })
  const q = useQuery({
    queryKey: ["resolve", tenant, type, numid],
    queryFn: () =>
      api<Resolved>(
        `/api/resolve/?tenant=${encodeURIComponent(tenant)}` +
          `&type=${encodeURIComponent(type)}&numid=${encodeURIComponent(numid)}`
      ),
    retry: false,
  })

  if (q.isError)
    return (
      <div className="p-6">
        <QueryError error={q.error} />
      </div>
    )
  if (q.data) {
    const route = objectDetailRoute(q.data.object_type)
    if (!route)
      return (
        <p className="p-6 text-sm text-muted-foreground">
          This object type has no detail page.
        </p>
      )
    if (q.data.switched) {
      // Active tenant changed - hard-navigate so the SPA clears tenant-scoped
      // caches and loads the object in the right context.
      window.location.assign(route.replace("$id", q.data.id))
      return (
        <p className="p-6 text-sm text-muted-foreground">
          Switching to {q.data.tenant.name}…
        </p>
      )
    }
    return <Navigate to={route} params={{ id: q.data.id }} replace />
  }
  return <p className="p-6 text-sm text-muted-foreground">Opening…</p>
}
