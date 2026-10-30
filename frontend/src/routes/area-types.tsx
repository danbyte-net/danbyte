import { createFileRoute, Outlet } from "@tanstack/react-router"

// Layout-only route for the /area-types branch (Organization →
// Area types). The list lives in area-types.index.tsx.
export const Route = createFileRoute("/area-types")({
  component: () => <Outlet />,
})
