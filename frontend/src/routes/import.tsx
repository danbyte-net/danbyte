import {
  createFileRoute,
  Outlet,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router"

import { SegmentedTabs } from "@/components/segmented-tabs"

// Layout for the /import branch: a header with a Files | NetBox tab strip and
// an Outlet. The CSV/JSON importer lives in import.index.tsx; the NetBox
// instance migration in import.netbox.tsx.
export const Route = createFileRoute("/import")({ component: ImportLayout })

const TABS = [
  { value: "/import", label: "Files (CSV/JSON)" },
  { value: "/import/netbox", label: "NetBox" },
] as const

function ImportLayout() {
  const navigate = useNavigate()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const active = pathname.startsWith("/import/netbox")
    ? "/import/netbox"
    : "/import"

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-4 border-b border-border px-4 lg:px-6">
        <h1 className="text-base font-semibold">Import</h1>
        <SegmentedTabs
          items={TABS}
          value={active}
          onValueChange={(v) => navigate({ to: v })}
        />
      </header>
      <Outlet />
    </div>
  )
}
