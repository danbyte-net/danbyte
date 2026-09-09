import {
  createFileRoute,
  Link,
  Outlet,
  useRouterState,
} from "@tanstack/react-router"

import { usePageTitle } from "@/lib/page-title"
import {
  groupedPages,
  SETTINGS_PAGES,
  visiblePages,
} from "@/lib/settings-catalog"
import { useSettingsScopes } from "@/components/settings/use-settings-scopes"

// Layout for the /settings branch: a left subnav grouped by subject, and an
// Outlet for the active page. This rail and the hub at /settings render the
// same catalog (#51), so a page cannot appear in one and be missing from the
// other, and neither has an opinion about which admin tier owns a setting -
// that is a scope switch on the page.
export const Route = createFileRoute("/settings")({ component: SettingsLayout })

const linkCls =
  "block rounded px-2 py-1 text-sm text-muted-foreground hover:bg-muted/50 hover:text-foreground"
const activeLinkCls =
  "block rounded px-2 py-1 text-sm font-medium bg-muted text-foreground"

function SettingsLayout() {
  const held = useSettingsScopes()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  // One place titles the tab for every child page, so no settings page
  // carries its own usePageTitle call.
  usePageTitle(
    SETTINGS_PAGES.find((p) => pathname === p.to)?.label ?? "Settings"
  )

  const groups = groupedPages(visiblePages(held))
  const cls = (href: string) => (pathname === href ? activeLinkCls : linkCls)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 [scrollbar-width:none] items-center gap-3 overflow-x-auto border-b border-border px-4 lg:px-6 [&::-webkit-scrollbar]:hidden [&>*]:shrink-0">
        <Link to="/settings" className="text-base font-semibold">
          Settings
        </Link>
        {/* Mobile: horizontal scrollable strip (the sidebar is lg-only). */}
        <nav className="flex items-center gap-1 lg:hidden">
          {groups
            .flatMap((g) => g.pages)
            .map((page) => (
              <Link
                key={page.key}
                to={page.to}
                className={
                  "shrink-0 rounded px-2.5 py-1 text-sm whitespace-nowrap " +
                  (pathname === page.to
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground")
                }
              >
                {page.label}
              </Link>
            ))}
        </nav>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="hidden h-full w-56 shrink-0 flex-col gap-4 overflow-y-auto border-r border-border bg-background p-4 lg:flex">
          <nav className="space-y-4">
            {groups.map((group) => (
              <div key={group.key}>
                <h3 className="mb-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                  {group.label}
                </h3>
                <ul className="space-y-0.5">
                  {group.pages.map((page) => (
                    <li key={page.key}>
                      <Link to={page.to} className={cls(page.to)}>
                        {page.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </aside>
        <div className="min-h-0 flex-1 overflow-auto p-4 lg:p-6">
          <Outlet />
        </div>
      </div>
    </div>
  )
}
