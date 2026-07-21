import {
  createFileRoute,
  Link,
  Outlet,
  useRouterState,
} from "@tanstack/react-router"

import { useMe } from "@/lib/use-me"

// Layout for the /settings branch: a left subnav (User / Admin sections) and
// an Outlet for the active page.
export const Route = createFileRoute("/settings")({ component: SettingsLayout })

const linkCls =
  "block rounded px-2 py-1 text-sm text-muted-foreground hover:bg-muted/50 hover:text-foreground"
const activeLinkCls =
  "block rounded px-2 py-1 text-sm font-medium bg-muted text-foreground"

type NavItem = { to: string; label: string }
type NavSection = {
  title: string
  gate: "none" | "site" | "tenant" | "deployment"
  items: NavItem[]
}

// Two admin tiers: "This tenant" (can_manage_admin in the active tenant —
// overrides inherit from the deployment defaults until enabled) and
// "Deployment" (superuser / global users.manage — affects every tenant).
const SECTIONS: NavSection[] = [
  {
    title: "User",
    gate: "none",
    items: [{ to: "/settings/preferences", label: "Preferences" }],
  },
  {
    // Per-site settings — local IT manages its own site (gated by the
    // tenant's allow switch + site-admin qualification, me.settings_sites).
    title: "This site",
    gate: "site",
    items: [{ to: "/settings/site", label: "Email" }],
  },
  {
    title: "This tenant",
    gate: "tenant",
    items: [
      { to: "/settings/tenant", label: "General" },
      { to: "/settings/floorplan", label: "Floor plans" },
      { to: "/settings/monitoring", label: "Monitoring" },
      { to: "/settings/tenant-email", label: "Email" },
      { to: "/settings/tenant-ldap", label: "Directory (LDAP)" },
      { to: "/settings/snmp", label: "SNMP profiles" },
    ],
  },
  {
    title: "Deployment",
    gate: "deployment",
    items: [
      { to: "/settings/admin", label: "General" },
      { to: "/settings/updates", label: "Updates" },
      { to: "/settings/plugins", label: "Plugins & services" },
      { to: "/settings/email", label: "Email & Delivery" },
      { to: "/settings/ldap", label: "Directory (LDAP)" },
    ],
  },
]

function SettingsLayout() {
  const { me, canManage, canManageDeployment } = useMe()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  // Highlight the settings page you're on.
  const cls = (href: string) => (pathname === href ? activeLinkCls : linkCls)
  const settingsSites = me.settings_sites ?? []
  const hasSiteSettings =
    settingsSites === "all"
      ? canManage // admins use "This tenant"; "all" alone would be redundant
      : settingsSites.length > 0
  const sections = SECTIONS.filter(
    (s) =>
      s.gate === "none" ||
      (s.gate === "site" && hasSiteSettings) ||
      (s.gate === "tenant" && canManage) ||
      (s.gate === "deployment" && canManageDeployment)
  )
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 [scrollbar-width:none] items-center gap-3 overflow-x-auto border-b border-border px-4 lg:px-6 [&::-webkit-scrollbar]:hidden [&>*]:shrink-0">
        <h1 className="text-base font-semibold">Settings</h1>
        {/* Mobile: horizontal scrollable tab strip (the sidebar is lg-only). */}
        <nav className="flex items-center gap-1 lg:hidden">
          {sections
            .flatMap((s) => s.items)
            .map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className={
                  "shrink-0 rounded px-2.5 py-1 text-sm whitespace-nowrap " +
                  (pathname === item.to
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground")
                }
              >
                {item.label}
              </Link>
            ))}
        </nav>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="hidden h-full w-56 shrink-0 flex-col gap-4 overflow-y-auto border-r border-border bg-background p-4 lg:flex">
          <nav className="space-y-4">
            {sections.map((section) => (
              <div key={section.title}>
                <h3 className="mb-1.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">
                  {section.title}
                </h3>
                <ul className="space-y-0.5">
                  {section.items.map((item) => (
                    <li key={item.to}>
                      <Link to={item.to} className={cls(item.to)}>
                        {item.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        </aside>
        <div className="flex-1 overflow-auto p-4 lg:p-6">
          <Outlet />
        </div>
      </div>
    </div>
  )
}
