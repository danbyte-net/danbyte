import { createFileRoute, Link } from "@tanstack/react-router"

import { groupedPages, visiblePages } from "@/lib/settings-catalog"
import { useSettingsScopes } from "@/components/settings/use-settings-scopes"

// The hub at exactly /settings.
export const Route = createFileRoute("/settings/")({ component: SettingsIndex })

/** Every settings page you can reach, grouped by subject (#51).
 *
 * This replaced three link tiles that named admin tiers - Preferences, This
 * tenant, Deployment - which told you who owns a setting but never where it
 * is. Groups are what a setting is about; the tier lives on the page as a
 * scope switch. */
function SettingsIndex() {
  const held = useSettingsScopes()
  const groups = groupedPages(visiblePages(held))

  return (
    <div className="max-w-5xl space-y-7">
      {groups.map((group) => (
        <section key={group.key} className="space-y-2">
          <h2 className="border-b border-border pb-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
            {group.label}
          </h2>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {group.pages.map((page) => {
              const Icon = page.icon
              return (
                <Link
                  key={page.key}
                  to={page.to}
                  className="flex items-start gap-2.5 rounded-lg border border-border bg-card p-3 hover:bg-muted/40"
                >
                  <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                    <Icon className="size-3.5" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium">
                      {page.label}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {page.description}
                    </span>
                  </span>
                </Link>
              )
            })}
          </div>
        </section>
      ))}
    </div>
  )
}
