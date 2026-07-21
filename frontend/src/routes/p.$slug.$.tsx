import { createFileRoute, useParams } from "@tanstack/react-router"

import { usePluginUi, resolvePluginPage } from "@/lib/plugins"
import { PluginPageView } from "@/components/plugin-page"
import { EmptyState } from "@/components/empty-state"
import { QueryError } from "@/components/query-error"

// Reserved catch-all for server-driven plugin pages: /p/<slug>/<splat>. The
// page spec (columns/fields/tabs/endpoint) comes from /api/plugins/ui/, so a
// plugin never ships frontend code or triggers a rebuild.
export const Route = createFileRoute("/p/$slug/$")({
  component: PluginRoute,
})

function PluginRoute() {
  const { slug, _splat } = useParams({ from: "/p/$slug/$" })
  const ui = usePluginUi()

  if (ui.isLoading) {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>
  }
  if (ui.isError) {
    return (
      <div className="p-6">
        <QueryError error={ui.error} />
      </div>
    )
  }

  const match = resolvePluginPage(ui.data?.pages ?? [], slug, _splat ?? "")
  if (!match) {
    return (
      <div className="p-6">
        <EmptyState title="Page not found">
          This plugin page isn't available — the plugin may be disabled for this
          tenant.
        </EmptyState>
      </div>
    )
  }

  return <PluginPageView page={match.page} id={match.id} />
}
