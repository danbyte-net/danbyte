import { createFileRoute, Outlet } from "@tanstack/react-router"

// Layout-only route for the /prefixes branch. The list view lives in
// prefixes.index.tsx; the detail in prefixes.$id.tsx. This file just
// owns the Outlet so the router can render children inside it.
export const Route = createFileRoute("/prefixes")({
  component: () => <Outlet />,
})
